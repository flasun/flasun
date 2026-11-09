import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub } from './helpers.ts';
import { UserError } from '../src/core/types.ts';
import { ftsQuery } from '../src/core/context.ts';
import { agenda } from '../src/modules/hub.ts';

test('projects: create, slug resolution, log, overview pulls workspace sections', () => {
  const { call } = testHub();
  call('proj_create', { name: 'Vorion BASIS', slug: 'basis', area: 'vorion', target_on: '2026-11-12' });
  assert.throws(() => call('proj_create', { name: 'dupe', slug: 'basis' }), UserError);
  call('ws_task_add', { tasks: [{ title: 'Draft conformance suite', project: 'basis', due_on: '2026-11-08', priority: 1 }] });
  call('ws_page_create', { title: 'BASIS v0.3 notes', body: '# x', project: 'basis' });
  call('proj_log', { project: 'basis', kind: 'decision', title: 'Ship v0.3 without the ATD annex', body: 'Annex not stable.' });
  const o = call<{ log: { kind: string }[]; sections: { title: string; items: unknown[] }[] }>('proj_get', { project: 'basis' });
  assert.equal(o.log[0]?.kind, 'decision');
  assert.deepEqual(o.sections.map((s) => [s.title, s.items.length]), [['Open tasks', 1], ['Pages', 1]]);
  assert.throws(() => call('ws_task_add', { tasks: [{ title: 'x', project: 'nope' }] }), /No project "nope"/);
});

test('workspace: append, cycle guard, archive removes from search', () => {
  const { call, ctx } = testHub();
  const root = call<{ id: string }>('ws_page_create', { title: 'Root', body: 'alpha' });
  const child = call<{ id: string }>('ws_page_create', { title: 'Child', body: 'beta', parent: 'Root' });
  call('ws_page_update', { page: child.id, append: 'gamma delta' });
  const page = call<{ body: string; breadcrumb: { title: string }[] }>('ws_page_get', { page: child.id });
  assert.equal(page.body, 'beta\n\ngamma delta');
  assert.deepEqual(page.breadcrumb.map((b) => b.title), ['Root']);
  assert.throws(() => call('ws_page_update', { page: root.id, parent: child.id }), /cycle/);
  assert.throws(() => call('ws_page_update', { page: root.id, body: 'x', append: 'y' }), /not both/);
  assert.equal(ctx.index.query('gamma').length, 1);
  call('ws_page_update', { page: child.id, archived: true });
  assert.equal(ctx.index.query('gamma').length, 0);
});

test('workspace: task lifecycle and list filters', () => {
  const { call } = testHub();
  const [a] = call<{ id: string }[]>('ws_task_add', { tasks: [{ title: 'A', tags: ['Deep'] }, { title: 'B', due_on: '2026-11-10' }] });
  assert.equal(call<unknown[]>('ws_task_list', { tag: 'deep' }).length, 1);
  assert.equal(call<unknown[]>('ws_task_list', { due_before: '2026-11-10' }).length, 1);
  call('ws_task_update', { updates: [{ id: a!.id, status: 'done' }] });
  assert.equal(call<unknown[]>('ws_task_list', {}).length, 1);
  assert.equal(call<unknown[]>('ws_task_list', { status: ['done'] }).length, 1);
  assert.throws(() => call('ws_task_add', { tasks: [{ title: 'bad', due_on: '2026-13-40' }] }));
});

test('jobs: stage transitions, funnel counts skipped stages, follow-ups and stale', () => {
  const { call, setNow } = testHub('2026-10-01T10:00:00');
  const a = call<{ id: string; next_action_on: string }>('jobs_add', { company: 'Anthropic', title: 'Research Engineer', stage: 'applied', priority: 1 });
  assert.equal(a.next_action_on, '2026-10-08', 'applied roles default to a 7-day follow-up');
  const b = call<{ id: string }>('jobs_add', { company: 'anthropic', title: 'Solutions Architect', stage: 'applied' });
  call('jobs_add', { company: 'Acme', title: 'Staff Eng' }); // lead
  call('jobs_update', { id: a.id, stage: 'interview', note: 'skipped screen via referral' });
  call('jobs_update', { id: b.id, stage: 'rejected' });
  const detail = call<{ events: { kind: string }[]; next_action_on: string | null }>('jobs_get', { id: b.id });
  assert.equal(detail.events[0]?.kind, 'rejection');
  assert.equal(detail.next_action_on, null, 'closing clears the next action');

  setNow('2026-10-20T10:00:00');
  const p = call<{ counts: Record<string, number>; funnel: { stage: string; reached: number; rate_from_applied: number }[]; followups_due: unknown[]; stale: unknown[] }>('jobs_pipeline');
  assert.equal(p.counts.interview, 1);
  assert.equal(p.funnel.find((f) => f.stage === 'screen')?.reached, 1, 'applied→interview still passed screen');
  assert.equal(p.funnel.find((f) => f.stage === 'interview')?.rate_from_applied, 50);
  assert.equal(p.followups_due.length, 1);
  assert.equal(p.stale.length, 1, 'interview with no event for 19 days is stale');
  call('jobs_log', { id: a.id, kind: 'email', summary: 'Scheduling onsite', next_action: 'Prep system design', next_action_on: '2026-10-25' });
  const p2 = call<{ followups_due: unknown[]; stale: unknown[] }>('jobs_pipeline');
  assert.equal(p2.followups_due.length, 0);
  assert.equal(p2.stale.length, 0);
});

test('finance: net worth, liabilities, P/L, staleness, txn dedupe, spending excludes transfers', () => {
  const { call } = testHub();
  call('fin_account_add', { name: 'Checking', kind: 'checking' });
  call('fin_account_add', { name: 'Brokerage', kind: 'brokerage' });
  call('fin_account_add', { name: 'Amex', kind: 'credit' });
  call('fin_balance_set', { balances: [{ account: 'Checking', balance: 10_000 }, { account: 'Amex', balance: 1_234.56 }, { account: 'Brokerage', balance: 500 }] });
  call('fin_holding_set', { holdings: [{ account: 'Brokerage', symbol: 'vti', quantity: 10.5, cost_basis: 2_000 }, { account: 'Brokerage', symbol: 'BTC', quantity: 0.1 }] });
  call('fin_price_set', { prices: [{ symbol: 'VTI', price: 300 }, { symbol: 'BTC', price: 60_000, as_of: '2026-10-01' }] });
  const nw = call<{ net_cents: number; liabilities_cents: number; warnings: string[]; accounts: { holdings: { symbol: string; unrealized_cents: number | null }[] }[] }>('fin_net_worth', { record: true });
  // 10000 + 500 + 10.5*300 + 0.1*60000 − 1234.56
  assert.equal(nw.net_cents, 1_000_000 + 50_000 + 315_000 + 600_000 - 123_456);
  assert.equal(nw.liabilities_cents, 123_456);
  const vti = nw.accounts.flatMap((a) => a.holdings).find((h) => h.symbol === 'VTI');
  assert.equal(vti?.unrealized_cents, 315_000 - 200_000);
  assert.ok(nw.warnings.some((w) => w.includes('BTC price is from 2026-10-01')));

  const txns = [
    { account: 'Checking', posted_on: '2026-11-02', amount: -54.2, category: 'Food', external_id: 'r1' },
    { account: 'Checking', posted_on: '2026-11-03', amount: -1000, category: 'transfer', external_id: 'r2' },
    { account: 'Checking', posted_on: '2026-11-04', amount: 5000, category: 'income', external_id: 'r3' },
  ];
  assert.deepEqual(call('fin_txn_add', { transactions: txns }), { inserted: 3, skipped_duplicates: 0 });
  assert.deepEqual(call('fin_txn_add', { transactions: txns }), { inserted: 0, skipped_duplicates: 3 });
  const s = call<{ total_out_cents: number; total_in_cents: number }>('fin_spending', {});
  assert.equal(s.total_out_cents, 5_420);
  assert.equal(s.total_in_cents, 500_000);
});

test('finance: theses surface on agenda when review is due', () => {
  const { call, ctx } = testHub();
  const t = call<{ id: string }>('fin_thesis_upsert', { symbol: 'nvda', thesis: 'Inference demand', invalidation: 'Hyperscaler capex cut', review_on: '2026-11-09' });
  const a = agenda(ctx, 7);
  assert.ok(a.items.some((i) => i.ref === `thesis:${t.id}` && i.kind === 'review'));
  call('fin_thesis_upsert', { id: t.id, review_note: 'Still intact', review_on: '2027-02-01' });
  assert.ok(!agenda(ctx, 7).items.some((i) => i.ref === `thesis:${t.id}`));
  assert.throws(() => call('fin_thesis_upsert', { symbol: 'X' }), /need symbol and thesis/);
});

test('hub: agenda orders overdue first; links resolve across modules; search spans modules', () => {
  const { call, ctx } = testHub();
  call('ws_task_add', { tasks: [{ title: 'Later thing', due_on: '2026-11-12' }, { title: 'Late thing', due_on: '2026-11-01' }] });
  const a = agenda(ctx, 7);
  assert.equal(a.items[0]?.kind, 'overdue');
  const job = call<{ id: string }>('jobs_add', { company: 'Cisco', title: 'AI Security PM', description: 'agentic governance runtime' });
  const page = call<{ id: string }>('ws_page_create', { title: 'Cisco interview prep', body: 'governance talking points' });
  call('hub_link', { from: `page:${page.id}`, to: `job:${job.id}`, relation: 'prep' });
  const links = call<{ title: string; direction: string }[]>('hub_links', { ref: `job:${job.id}` });
  assert.deepEqual(links.map((l) => [l.title, l.direction]), [['Cisco interview prep', 'in']]);
  assert.throws(() => call('hub_link', { from: `page:${page.id}`, to: 'job:jb_missing' }), /No such entity/);
  const hits = call<{ module: string }[]>('hub_search', { query: 'governance' });
  assert.deepEqual(new Set(hits.map((h) => h.module)), new Set(['jobs', 'workspace']));
});

test('fts query sanitizer neutralises FTS5 syntax', () => {
  assert.equal(ftsQuery('C++ "senior  NEAR(x'), '"c"* "senior"* "near"* "x"*');
  assert.equal(ftsQuery('***'), null);
  const { ctx } = testHub();
  assert.doesNotThrow(() => ctx.index.query('") OR 1=1 --'));
});

test('migrations are idempotent across reopen', () => {
  const h = testHub();
  for (const m of h.ctx.modules) assert.deepEqual(h.ctx.db.migrate(m.id, m.migrations), []);
});
