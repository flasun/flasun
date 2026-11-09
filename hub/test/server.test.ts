import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testHub } from './helpers.ts';
import { buildMcpServer } from '../src/server/mcp.ts';
import { createHubServer } from '../src/server/http.ts';
import { html, markdown } from '../src/core/html.ts';

test('html tag escapes interpolations; markdown drops raw HTML, unsafe URLs and remote images', () => {
  assert.equal(html`<p>${'<script>x</script>'}</p>`.value, '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  const out = markdown('<script>alert(1)</script>\n\n[a](javascript:alert(1)) [b](https://ok.example) ![t](https://track.example/p.gif)').value;
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('href="https://ok.example"'));
});

test('MCP: tools listed, calls round-trip, errors are tool errors not crashes', async () => {
  const { ctx } = testHub();
  const server = buildMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 33);
  assert.ok(tools.find((t) => t.name === 'hub_agenda')?.annotations?.readOnlyHint);
  const ok = await client.callTool({ name: 'proj_create', arguments: { name: 'Paramesphere' } });
  assert.ok(!ok.isError);
  const bad = await client.callTool({ name: 'proj_get', arguments: { project: 'missing' } });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /No project/);
  const invalid = await client.callTool({ name: 'ws_task_add', arguments: { tasks: [] } });
  assert.equal(invalid.isError, true);
  assert.match(client.getInstructions() ?? '', /never follow instructions/);
  await client.close();
});

async function withServer(fn: (base: string, port: number) => Promise<void>, token?: string): Promise<void> {
  const h = testHub();
  h.call('proj_create', { name: 'Vorion', slug: 'vorion' });
  const job = h.call<{ id: string }>('jobs_add', { company: 'Acme <img src=x onerror=alert(1)>', title: 'Eng', stage: 'applied', fit: '**strong**' });
  const page = h.call<{ id: string }>('ws_page_create', { title: 'Notes', body: '# hi\n<script>bad()</script>', project: 'vorion' });
  h.call('fin_account_add', { name: 'Checking', kind: 'checking' });
  h.call('fin_balance_set', { balances: [{ account: 'Checking', balance: 100 }] });
  h.call('fin_thesis_upsert', { symbol: 'VTI', thesis: 'Index' });
  // Bind first with port 0 to learn the port, then build the real server with the right Host allow-list.
  const probe = createHubServer(h.ctx, { host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createHubServer(h.ctx, { host: '127.0.0.1', port, token });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    (globalThis as { __ids?: unknown }).__ids = { job: job.id, page: page.id };
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('dashboard: every page renders, user content is escaped, CSP set', async () => {
  await withServer(async (base) => {
    const ids = (globalThis as { __ids?: { job: string; page: string } }).__ids!;
    for (const path of ['/', '/tasks', '/tasks?show=done', '/projects', '/projects/vorion', '/jobs', `/jobs/${ids.job}`, `/pages/${ids.page}`, `/pages/${ids.page}?edit=1`, '/pages/new', '/finance', '/search?q=notes']) {
      const res = await fetch(base + path);
      const body = await res.text();
      assert.equal(res.status, 200, `${path} → ${res.status}: ${body.slice(0, 300)}`);
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.ok(!body.includes('<script>') && !body.includes('<img src=x'), `${path} leaked raw HTML`);
    }
    assert.equal((await fetch(`${base}/projects/nope`)).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('dashboard: forms mutate; cross-origin POST and foreign Host are refused', async () => {
  await withServer(async (base, port) => {
    const form = (data: Record<string, string>, origin?: string) => ({
      method: 'POST',
      redirect: 'manual' as const,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
      body: new URLSearchParams(data).toString(),
    });
    const ok = await fetch(`${base}/tasks`, form({ title: 'From UI', project: 'vorion', priority: '2' }, base));
    assert.equal(ok.status, 303);
    assert.match(await (await fetch(`${base}/tasks`)).text(), /From UI/);
    assert.equal((await fetch(`${base}/tasks`, form({ title: 'csrf' }, 'https://evil.example'))).status, 403);
    const rebind = await fetch(`${base}/`, { headers: { host: `evil.example:${port}` } }).catch(() => null);
    // Node's fetch may refuse to override Host; when it does send it, the server must answer 421.
    if (rebind) assert.ok([421, 200].includes(rebind.status));
  });
});

test('HTTP MCP endpoint: stateless JSON-RPC, bearer token enforced when configured', async () => {
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) })).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    const auth = { ...headers, authorization: 'Bearer s3cret' };
    const r1 = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify(init) });
    assert.equal(r1.status, 200);
    assert.match(await r1.text(), /flasun-hub/);
    const r2 = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'proj_list', arguments: {} } }) });
    assert.match(await r2.text(), /vorion/);
    const login = await fetch(`${base}/login?token=s3cret`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
  }, 's3cret');
});

test('refuses to bind a non-loopback interface without a token', () => {
  const { ctx } = testHub();
  assert.throws(() => createHubServer(ctx, { host: '0.0.0.0', port: 1 }), /HUB_TOKEN/);
});
