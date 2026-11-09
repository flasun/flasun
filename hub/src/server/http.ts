import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HubContext } from '../core/types.ts';
import { buildMcpServer } from './mcp.ts';
import { compileRoutes, CSS, dispatch } from './dashboard.ts';

export interface HttpOptions {
  host: string;
  port: number;
  /** Required when binding to anything but loopback. Enforced for /mcp (Bearer) and the dashboard (cookie). */
  token?: string;
  /** Extra Host header values to accept, e.g. a tunnel hostname. */
  allowedHosts?: readonly string[];
  mcp?: boolean;
  dashboard?: boolean;
}

const MAX_BODY = 2 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}

export function createHubServer(ctx: HubContext, opts: HttpOptions): Server {
  if (!LOOPBACK.has(opts.host) && !opts.token) {
    throw new Error(`Refusing to bind ${opts.host} without HUB_TOKEN. Anything reachable on the network gets your finances.`);
  }
  const hosts = new Set([...['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${opts.port}`), ...(opts.allowedHosts ?? [])]);
  const routes = compileRoutes(ctx);
  const mcpEnabled = opts.mcp ?? true;
  const dashEnabled = opts.dashboard ?? true;

  // DNS-rebinding defence: a hostile page can resolve evil.com → 127.0.0.1, but it cannot forge the Host header.
  const hostOk = (req: IncomingMessage) => hosts.has(req.headers.host ?? '');
  // CSRF defence: browsers always send Origin on cross-site POSTs. Non-browser MCP clients send none.
  const originOk = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return hosts.has(new URL(origin).host);
    } catch {
      return false;
    }
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://hub.local');
      if (!hostOk(req)) return send(res, 421, 'Misdirected request', 'text/plain');
      if (!originOk(req)) return send(res, 403, 'Cross-origin request refused', 'text/plain');

      if (url.pathname === '/mcp') {
        if (!mcpEnabled) return send(res, 404, 'MCP disabled', 'text/plain');
        if (opts.token) {
          const auth = req.headers.authorization ?? '';
          if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), opts.token)) {
            return send(res, 401, 'Unauthorized', 'text/plain', { 'WWW-Authenticate': 'Bearer' });
          }
        }
        if (req.method !== 'POST') return send(res, 405, 'Stateless server: POST only', 'text/plain', { Allow: 'POST' });
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), 'application/json');
        }
        // Stateless: a fresh server + transport per request. Tool registration is
        // cheap, and it means no session state to leak between clients.
        const server = buildMcpServer(ctx);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!dashEnabled) return send(res, 404, 'Dashboard disabled', 'text/plain');

      if (opts.token) {
        if (url.pathname === '/login' && req.method === 'GET') {
          const t = url.searchParams.get('token') ?? '';
          if (!sameToken(t, opts.token)) return send(res, 401, 'Bad token', 'text/plain');
          return send(res, 303, '', 'text/plain', {
            Location: '/',
            'Set-Cookie': `hub_token=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
          });
        }
        const c = cookie(req, 'hub_token');
        if (!c || !sameToken(c, opts.token)) return send(res, 401, 'Open /login?token=… first.', 'text/plain');
      }

      if (url.pathname === '/static/app.css') return send(res, 200, CSS, 'text/css; charset=utf-8', { 'Cache-Control': 'max-age=300' });
      if (url.pathname === '/favicon.ico') return send(res, 204, '', 'text/plain');

      const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
      if (!method) return send(res, 405, 'Method not allowed', 'text/plain');
      let form = new URLSearchParams();
      if (method === 'POST') {
        // Forms only; a JSON or multipart POST to a dashboard route is not something this UI sends.
        if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
          return send(res, 415, 'Expected a form post', 'text/plain');
        }
        form = new URLSearchParams((await readBody(req)).replace(/\r\n/g, '\n').replace(/%0D%0A/gi, '%0A'));
      }
      const out = dispatch(ctx, routes, method, url.pathname, url.searchParams, form);
      if (out.redirect) return send(res, 303, '', 'text/plain', { Location: out.redirect });
      return send(res, out.status, out.html ?? '');
    })().catch((err: unknown) => {
      console.error('[hub] request failed', err);
      if (!res.headersSent) send(res, 500, 'Internal error', 'text/plain');
      else res.end();
    });
  });
}
