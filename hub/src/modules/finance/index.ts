import { z } from 'zod';
import { defineTool, UserError, type AgendaItem, type HubContext, type HubModule } from '../../core/types.ts';
import { addDays, newId, ref } from '../../core/context.ts';
import { isoDate, money, patch, text, toCents } from '../../core/fields.ts';
import { html, markdown, SafeHtml } from '../../core/html.ts';
import { badge, due, empty, section } from '../../core/ui.ts';

/**
 * Personal ledger: accounts, balances, holdings, prices, transactions, and
 * investment theses with explicit invalidation criteria and review dates.
 *
 * It records and computes; it does not fetch quotes or give advice. Prices come
 * in through fin_price_set — from you, or from Claude relaying another MCP
 * (e.g. a market-data server). Cash is integer cents; quantities and unit
 * prices are REAL (fractional shares/crypto), market values are rounded to
 * cents at computation time. Single base currency: accounts in other
 * currencies are reported but excluded from totals, with a warning.
 */

export const ACCOUNT_KINDS = ['checking', 'savings', 'brokerage', 'retirement', 'crypto', 'credit', 'loan', 'property', 'other'] as const;
const LIABILITY_KINDS = new Set(['credit', 'loan']);
export const THESIS_STATUSES = ['watching', 'holding', 'trimmed', 'exited', 'rejected'] as const;
const PRICE_STALE_DAYS = 7;
const BALANCE_STALE_DAYS = 35;

interface AccountRow { id: string; name: string; kind: string; institution: string | null; currency: string; liability: number; archived: number; created_at: string }
interface HoldingRow { account_id: string; symbol: string; quantity: number; cost_basis_cents: number | null; updated_at: string }
interface PriceRow { symbol: string; as_of: string; price: number; source: string | null }
interface ThesisRow {
  id: string; symbol: string; title: string; status: string; thesis: string; invalidation: string | null;
  entry_target: number | null; exit_target: number | null; review_on: string | null; created_at: string; updated_at: string;
}

function baseCurrency(ctx: HubContext): string {
  return ctx.db.one<{ value: string }>(`SELECT value FROM fin_settings WHERE key = 'base_currency'`)?.value ?? 'USD';
}

function account(ctx: HubContext, idOrName: string): AccountRow {
  const a = ctx.db.one<AccountRow>('SELECT * FROM fin_accounts WHERE id = ? OR name = ? COLLATE NOCASE', idOrName, idOrName);
  if (!a) throw new UserError(`No account "${idOrName}". Add with fin_account_add.`);
  return a;
}

function latestPrice(ctx: HubContext, symbol: string): PriceRow | undefined {
  return ctx.db.one<PriceRow>('SELECT * FROM fin_prices WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', symbol);
}

export function netWorth(ctx: HubContext) {
  const today = ctx.today();
  const base = baseCurrency(ctx);
  const warnings: string[] = [];
  const accounts = ctx.db.all<AccountRow>('SELECT * FROM fin_accounts WHERE archived = 0 ORDER BY liability, kind, name');
  const rows = accounts.map((a) => {
    const bal = ctx.db.one<{ as_of: string; balance_cents: number }>(
      'SELECT as_of, balance_cents FROM fin_balances WHERE account_id = ? ORDER BY as_of DESC LIMIT 1', a.id);
    const holdings = ctx.db.all<HoldingRow>('SELECT * FROM fin_holdings WHERE account_id = ? AND quantity <> 0 ORDER BY symbol', a.id).map((h) => {
      const p = latestPrice(ctx, h.symbol);
      if (!p) warnings.push(`${h.symbol} in ${a.name} has no price; valued at 0.`);
      else if (p.as_of < addDays(today, -PRICE_STALE_DAYS)) warnings.push(`${h.symbol} price is from ${p.as_of}.`);
      const value = p ? Math.round(h.quantity * p.price * 100) : 0;
      return {
        symbol: h.symbol, quantity: h.quantity, price: p?.price ?? null, price_as_of: p?.as_of ?? null,
        value_cents: value, cost_basis_cents: h.cost_basis_cents,
        unrealized_cents: h.cost_basis_cents === null || !p ? null : value - h.cost_basis_cents,
      };
    });
    if (bal && bal.as_of < addDays(today, -BALANCE_STALE_DAYS)) warnings.push(`${a.name} balance is from ${bal.as_of}.`);
    if (!bal && holdings.length === 0) warnings.push(`${a.name} has no balance or holdings.`);
    const cash = bal?.balance_cents ?? 0;
    const value = cash + holdings.reduce((n, h) => n + h.value_cents, 0);
    const included = a.currency === base;
    if (!included) warnings.push(`${a.name} is in ${a.currency}; excluded from ${base} totals.`);
    return { id: a.id, name: a.name, kind: a.kind, institution: a.institution, currency: a.currency, liability: a.liability === 1, included,
      cash_cents: cash, balance_as_of: bal?.as_of ?? null, value_cents: value, holdings };
  });
  const assets = rows.filter((r) => r.included && !r.liability).reduce((n, r) => n + r.value_cents, 0);
  const liabilities = rows.filter((r) => r.included && r.liability).reduce((n, r) => n + Math.abs(r.value_cents), 0);
  const byKind: Record<string, number> = {};
  for (const r of rows) if (r.included && !r.liability) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.value_cents;
  return { as_of: today, currency: base, assets_cents: assets, liabilities_cents: liabilities, net_cents: assets - liabilities, by_kind_cents: byKind, accounts: rows, warnings };
}

function spending(ctx: HubContext, from: string, to: string, groupBy: 'category' | 'payee' | 'month') {
  const key = groupBy === 'month' ? `substr(posted_on, 1, 7)` : `coalesce(${groupBy}, '(none)')`;
  const rows = ctx.db.all<{ k: string; out_cents: number; in_cents: number; n: number }>(
    `SELECT ${key} AS k,
            -sum(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS out_cents,
            sum(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS in_cents, count(*) AS n
       FROM fin_txns WHERE posted_on BETWEEN ? AND ? AND coalesce(category, '') <> 'transfer'
      GROUP BY k ORDER BY out_cents DESC`,
    from, to,
  );
  return {
    from, to, group_by: groupBy,
    total_out_cents: rows.reduce((n, r) => n + r.out_cents, 0),
    total_in_cents: rows.reduce((n, r) => n + r.in_cents, 0),
    groups: rows.map((r) => ({ [groupBy]: r.k, out_cents: r.out_cents, in_cents: r.in_cents, count: r.n })),
  };
}

const symbol = z.string().trim().min(1).max(20).transform((s) => s.toUpperCase());

const tools = [
  defineTool({
    name: 'fin_account_add',
    title: 'Add account',
    description: 'Add a financial account. credit/loan kinds are liabilities by default.',
    input: {
      name: text(80).min(1),
      kind: z.enum(ACCOUNT_KINDS),
      institution: text(80).optional(),
      currency: z.string().length(3).optional(),
      liability: z.boolean().optional(),
    },
    handler(a, ctx) {
      if (ctx.db.one('SELECT 1 FROM fin_accounts WHERE name = ? COLLATE NOCASE', a.name)) throw new UserError(`Account "${a.name}" exists.`);
      const id = newId('ac');
      ctx.db.run('INSERT INTO fin_accounts (id, name, kind, institution, currency, liability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, a.name, a.kind, a.institution, (a.currency ?? baseCurrency(ctx)).toUpperCase(), a.liability ?? LIABILITY_KINDS.has(a.kind), ctx.now().toISOString());
      ctx.log('finance', ref('account', id), 'account', a.name);
      return { id, ref: ref('account', id) };
    },
  }),
  defineTool({
    name: 'fin_balance_set',
    title: 'Record balances',
    description: 'Record account balances as of a date (cash balance; for brokerage accounts, the uninvested cash). For liabilities, pass the amount owed as a positive number.',
    input: {
      balances: z.array(z.object({ account: z.string(), balance: z.number().finite(), as_of: isoDate.optional() })).min(1).max(100),
    },
    annotations: { idempotentHint: true },
    handler(a, ctx) {
      return ctx.db.tx(() =>
        a.balances.map((b) => {
          const acc = account(ctx, b.account);
          const asOf = b.as_of ?? ctx.today();
          ctx.db.run('INSERT OR REPLACE INTO fin_balances (account_id, as_of, balance_cents) VALUES (?, ?, ?)', acc.id, asOf, toCents(b.balance));
          return { account: acc.name, as_of: asOf, balance_cents: toCents(b.balance) };
        }),
      );
    },
  }),
  defineTool({
    name: 'fin_holding_set',
    title: 'Set holdings',
    description: 'Set the current position for symbols in an account (absolute, not a delta). quantity 0 removes the position. cost_basis is the total paid, not per share.',
    input: {
      holdings: z.array(z.object({
        account: z.string(), symbol, quantity: z.number().finite().nonnegative(), cost_basis: z.number().finite().nonnegative().optional(),
      })).min(1).max(200),
    },
    annotations: { idempotentHint: true },
    handler(a, ctx) {
      return ctx.db.tx(() =>
        a.holdings.map((h) => {
          const acc = account(ctx, h.account);
          if (h.quantity === 0) {
            ctx.db.run('DELETE FROM fin_holdings WHERE account_id = ? AND symbol = ?', acc.id, h.symbol);
          } else {
            ctx.db.run(
              `INSERT INTO fin_holdings (account_id, symbol, quantity, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (account_id, symbol) DO UPDATE SET quantity = excluded.quantity,
                 cost_basis_cents = coalesce(excluded.cost_basis_cents, fin_holdings.cost_basis_cents), updated_at = excluded.updated_at`,
              acc.id, h.symbol, h.quantity, h.cost_basis === undefined ? null : toCents(h.cost_basis), ctx.now().toISOString());
          }
          ctx.log('finance', ref('account', acc.id), 'holding', `${h.symbol} → ${h.quantity}`);
          return { account: acc.name, symbol: h.symbol, quantity: h.quantity };
        }),
      );
    },
  }),
  defineTool({
    name: 'fin_price_set',
    title: 'Record prices',
    description: 'Record unit prices (base currency) for symbols. Feed from a market-data MCP or manual quotes; one price per symbol per day.',
    input: {
      prices: z.array(z.object({ symbol, price: z.number().finite().positive(), as_of: isoDate.optional(), source: text(60).optional() })).min(1).max(500),
    },
    annotations: { idempotentHint: true },
    handler(a, ctx) {
      ctx.db.tx(() => {
        for (const p of a.prices) {
          ctx.db.run('INSERT OR REPLACE INTO fin_prices (symbol, as_of, price, source) VALUES (?, ?, ?, ?)', p.symbol, p.as_of ?? ctx.today(), p.price, p.source);
        }
      });
      return { recorded: a.prices.length };
    },
  }),
  defineTool({
    name: 'fin_txn_add',
    title: 'Add transactions',
    description:
      'Add transactions. amount is signed: negative = money out. Pass external_id (bank/CSV row id) to make re-imports idempotent. category "transfer" is excluded from spending.',
    input: {
      transactions: z.array(z.object({
        account: z.string(), posted_on: isoDate, amount: z.number().finite(),
        payee: text(120).optional(), category: text(60).optional(), memo: text(500).optional(), external_id: text(120).optional(),
      })).min(1).max(1000),
    },
    handler(a, ctx) {
      let inserted = 0;
      ctx.db.tx(() => {
        const accts = new Map<string, AccountRow>();
        for (const t of a.transactions) {
          const acc = accts.get(t.account) ?? account(ctx, t.account);
          accts.set(t.account, acc);
          inserted += ctx.db.run(
            `INSERT OR IGNORE INTO fin_txns (id, account_id, posted_on, amount_cents, payee, category, memo, external_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newId('tx'), acc.id, t.posted_on, toCents(t.amount), t.payee, t.category?.toLowerCase(), t.memo, t.external_id, ctx.now().toISOString());
        }
      });
      if (inserted) ctx.log('finance', null, 'transactions', `${inserted} transactions added`);
      return { inserted, skipped_duplicates: a.transactions.length - inserted };
    },
  }),
  defineTool({
    name: 'fin_net_worth',
    title: 'Net worth',
    description: 'Current net worth from latest balances and holdings × latest prices, by account and kind, with unrealized P/L and staleness warnings. record=true saves a dated snapshot for the trend chart.',
    input: { record: z.boolean().default(false) },
    handler(a, ctx) {
      const nw = netWorth(ctx);
      if (a.record) {
        ctx.db.run('INSERT OR REPLACE INTO fin_snapshots (as_of, assets_cents, liabilities_cents, net_cents) VALUES (?, ?, ?, ?)',
          nw.as_of, nw.assets_cents, nw.liabilities_cents, nw.net_cents);
        ctx.log('finance', null, 'snapshot', `Net worth ${money(nw.net_cents, nw.currency)}`);
      }
      return nw;
    },
  }),
  defineTool({
    name: 'fin_spending',
    title: 'Spending',
    description: 'Money out/in over a date range grouped by category, payee or month. Excludes category "transfer".',
    input: { from: isoDate.optional().describe('Default: first of this month.'), to: isoDate.optional(), group_by: z.enum(['category', 'payee', 'month']).default('category') },
    annotations: { readOnlyHint: true },
    handler: (a, ctx) => spending(ctx, a.from ?? `${ctx.today().slice(0, 7)}-01`, a.to ?? ctx.today(), a.group_by),
  }),
  defineTool({
    name: 'fin_thesis_upsert',
    title: 'Investment thesis',
    description:
      'Create or update an investment thesis. Always capture invalidation (what would prove it wrong) and a review_on date — the agenda surfaces theses due for review. Pass id to update.',
    input: {
      id: z.string().optional(),
      symbol: symbol.optional(),
      title: text(200).optional(),
      status: z.enum(THESIS_STATUSES).optional(),
      thesis: text(50_000).optional().describe('Markdown.'),
      invalidation: text(5000).optional(),
      entry_target: z.number().positive().nullable().optional(),
      exit_target: z.number().positive().nullable().optional(),
      review_on: isoDate.nullable().optional(),
      review_note: text(5000).optional().describe('Appended to the thesis with today\'s date.'),
    },
    handler(a, ctx) {
      const ts = ctx.now().toISOString();
      if (!a.id) {
        if (!a.symbol || !a.thesis) throw new UserError('New theses need symbol and thesis.');
        const id = newId('th');
        ctx.db.run(
          `INSERT INTO fin_theses (id, symbol, title, status, thesis, invalidation, entry_target, exit_target, review_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, a.symbol, a.title ?? a.symbol, a.status ?? 'watching', a.thesis, a.invalidation, a.entry_target, a.exit_target,
          a.review_on ?? addDays(ctx.today(), 90), ts, ts);
        ctx.index.upsert(ref('thesis', id), 'finance', `${a.symbol}: ${a.title ?? 'thesis'}`, `${a.thesis}\n${a.invalidation ?? ''}`);
        ctx.log('finance', ref('thesis', id), 'thesis', `${a.symbol}: ${a.title ?? ''}`);
        return { id, ref: ref('thesis', id) };
      }
      const t = ctx.db.one<ThesisRow>('SELECT * FROM fin_theses WHERE id = ?', a.id);
      if (!t) throw new UserError(`No thesis "${a.id}".`);
      const thesis = a.review_note ? `${a.thesis ?? t.thesis}\n\n**Review ${ctx.today()}:** ${a.review_note}` : a.thesis;
      const { sql, params } = patch({
        symbol: a.symbol, title: a.title, status: a.status, thesis, invalidation: a.invalidation,
        entry_target: a.entry_target, exit_target: a.exit_target, review_on: a.review_on,
      });
      if (sql) ctx.db.run(`UPDATE fin_theses SET ${sql}, updated_at = ? WHERE id = ?`, ...params, ts, t.id);
      const next = ctx.db.one<ThesisRow>('SELECT * FROM fin_theses WHERE id = ?', t.id) as ThesisRow;
      ctx.index.upsert(ref('thesis', t.id), 'finance', `${next.symbol}: ${next.title}`, `${next.thesis}\n${next.invalidation ?? ''}`);
      ctx.log('finance', ref('thesis', t.id), a.review_note ? 'reviewed' : 'thesis', `${next.symbol}: ${next.title}`);
      return next;
    },
  }),
  defineTool({
    name: 'fin_thesis_list',
    title: 'List theses',
    description: 'Investment theses with latest price vs entry/exit targets. due_only=true returns those with review_on today or earlier.',
    input: { status: z.array(z.enum(THESIS_STATUSES)).optional(), due_only: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
    handler(a, ctx) {
      const statuses = a.status && a.status.length > 0 ? a.status : ['watching', 'holding', 'trimmed'];
      return ctx.db
        .all<ThesisRow>(
          `SELECT * FROM fin_theses WHERE status IN (SELECT value FROM json_each(?)) AND (? = 0 OR (review_on IS NOT NULL AND review_on <= ?)) ORDER BY review_on IS NULL, review_on`,
          JSON.stringify(statuses), a.due_only, ctx.today())
        .map((t) => ({ ...t, latest_price: latestPrice(ctx, t.symbol) ?? null }));
    },
  }),
];

// --- dashboard -------------------------------------------------------------

function sparkline(points: { as_of: string; net_cents: number }[]): SafeHtml {
  if (points.length < 2) return html`<p class="muted">Trend appears after two snapshots (fin_net_worth record=true).</p>`;
  const w = 320, h = 60, pad = 4;
  const vals = points.map((p) => p.net_cents);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const xy = points.map((p, i) => [pad + (i / (points.length - 1)) * (w - 2 * pad), h - pad - ((p.net_cents - min) / span) * (h - 2 * pad)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const first = points[0], last = points[points.length - 1];
  return html`<figure class="spark"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Net worth from ${first?.as_of ?? ''} to ${last?.as_of ?? ''}">
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
    <figcaption class="muted">${first?.as_of ?? ''} → ${last?.as_of ?? ''} · ${points.length} snapshots</figcaption></figure>`;
}

function bars(rows: [string, number][], cur: string): SafeHtml {
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  return html`<ul class="bars">${rows.map(([k, v]) => html`<li><span>${k}</span><progress max="${max}" value="${Math.abs(v)}"></progress><b>${money(v, cur)}</b></li>`)}</ul>`;
}

export const finance: HubModule = {
  id: 'finance',
  title: 'Finance & investing',
  description:
    'Personal ledger (fin_*): accounts, balances, holdings, prices, transactions, net worth with snapshots, spending by category, and investment theses with invalidation criteria and review dates. Records and computes only — no quotes fetched, no advice given. Amounts are in the base currency; negative transaction = money out.',
  kinds: ['account', 'thesis', 'symbol'],
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE fin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO fin_settings (key, value) VALUES ('base_currency', 'USD');
        CREATE TABLE fin_accounts (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          kind TEXT NOT NULL CHECK (kind IN ('checking','savings','brokerage','retirement','crypto','credit','loan','property','other')),
          institution TEXT, currency TEXT NOT NULL DEFAULT 'USD', liability INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE fin_balances (account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
          as_of TEXT NOT NULL, balance_cents INTEGER NOT NULL, PRIMARY KEY (account_id, as_of));
        CREATE TABLE fin_holdings (account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL, quantity REAL NOT NULL, cost_basis_cents INTEGER, updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, symbol));
        CREATE TABLE fin_prices (symbol TEXT NOT NULL, as_of TEXT NOT NULL, price REAL NOT NULL CHECK (price > 0), source TEXT,
          PRIMARY KEY (symbol, as_of));
        CREATE TABLE fin_txns (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
          posted_on TEXT NOT NULL, amount_cents INTEGER NOT NULL, payee TEXT, category TEXT, memo TEXT,
          external_id TEXT, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX fin_txns_dedupe ON fin_txns (account_id, external_id) WHERE external_id IS NOT NULL;
        CREATE INDEX fin_txns_date ON fin_txns (posted_on);
        CREATE TABLE fin_theses (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('watching','holding','trimmed','exited','rejected')),
          thesis TEXT NOT NULL, invalidation TEXT, entry_target REAL, exit_target REAL, review_on TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE fin_snapshots (as_of TEXT PRIMARY KEY, assets_cents INTEGER NOT NULL, liabilities_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL);
      `,
    },
  ],
  tools,
  resolve(r, ctx) {
    const [kind, id] = r.split(':') as [string, string];
    if (kind === 'account') {
      const a = ctx.db.one<AccountRow>('SELECT * FROM fin_accounts WHERE id = ?', id);
      return a ? { title: a.name, href: '/finance' } : null;
    }
    if (kind === 'symbol') return { title: id, href: '/finance' };
    const t = ctx.db.one<ThesisRow>('SELECT * FROM fin_theses WHERE id = ?', id);
    return t ? { title: `${t.symbol}: ${t.title}`, href: `/finance#${t.id}` } : null;
  },
  agenda(ctx, horizon) {
    const today = ctx.today();
    const items: AgendaItem[] = ctx.db
      .all<ThesisRow>(`SELECT * FROM fin_theses WHERE status IN ('watching','holding','trimmed') AND review_on IS NOT NULL AND review_on <= ?`, horizon)
      .map((t) => ({ module: 'finance', ref: ref('thesis', t.id), title: `Review thesis: ${t.symbol}`, date: t.review_on ?? today, kind: 'review', detail: t.title }));
    const stale = addDays(today, -PRICE_STALE_DAYS);
    for (const h of ctx.db.all<{ symbol: string }>('SELECT DISTINCT symbol FROM fin_holdings WHERE quantity <> 0')) {
      const p = latestPrice(ctx, h.symbol);
      if (!p || p.as_of < stale) {
        items.push({ module: 'finance', ref: ref('symbol', h.symbol), title: `Price for ${h.symbol} ${p ? `from ${p.as_of}` : 'missing'}`, date: p?.as_of ?? today, kind: 'stale' });
      }
    }
    return items;
  },
  reindex(ctx) {
    const rows = ctx.db.all<ThesisRow>('SELECT * FROM fin_theses');
    rows.forEach((t) => ctx.index.upsert(ref('thesis', t.id), 'finance', `${t.symbol}: ${t.title}`, `${t.thesis}\n${t.invalidation ?? ''}`));
    return rows.length;
  },
  dashboard: {
    nav: { label: 'Finance', href: '/finance' },
    card(ctx) {
      const nw = netWorth(ctx);
      const due = ctx.db.one<{ n: number }>(`SELECT count(*) AS n FROM fin_theses WHERE status IN ('watching','holding','trimmed') AND review_on <= ?`, ctx.today())?.n ?? 0;
      return html`<a class="card" href="/finance"><h3>Finance</h3><dl>
        <div><dt>net worth</dt><dd>${nw.accounts.length ? money(nw.net_cents, nw.currency) : '—'}</dd></div>
        <div><dt>theses to review</dt><dd class="${due ? 'warn' : ''}">${due}</dd></div>
        <div><dt>warnings</dt><dd>${nw.warnings.length}</dd></div></dl></a>`;
    },
    routes: [
      {
        method: 'GET',
        path: '/finance',
        handler(_req, ctx) {
          const nw = netWorth(ctx);
          const cur = nw.currency;
          const today = ctx.today();
          const snaps = ctx.db.all<{ as_of: string; net_cents: number }>('SELECT as_of, net_cents FROM fin_snapshots ORDER BY as_of DESC LIMIT 120').reverse();
          const month = spending(ctx, `${today.slice(0, 7)}-01`, today, 'category');
          const theses = ctx.db.all<ThesisRow>(`SELECT * FROM fin_theses WHERE status IN ('watching','holding','trimmed') ORDER BY review_on IS NULL, review_on`);
          const holdings = nw.accounts.flatMap((a) => a.holdings.map((h) => ({ ...h, account: a.name })));
          return {
            kind: 'page',
            title: 'Finance',
            body: html`
              <div class="stats">
                <div><b>${money(nw.net_cents, cur)}</b><span>net worth</span></div>
                <div><b>${money(nw.assets_cents, cur)}</b><span>assets</span></div>
                <div><b>${money(nw.liabilities_cents, cur)}</b><span>liabilities</span></div>
                <div><b>${money(month.total_out_cents, cur)}</b><span>spent this month</span></div>
              </div>
              ${nw.warnings.length ? html`<ul class="warnings">${nw.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
              <div class="cols">
                <div>
                  ${section('Trend', sparkline(snaps))}
                  ${section('Allocation', Object.keys(nw.by_kind_cents).length ? bars(Object.entries(nw.by_kind_cents).sort((x, y) => y[1] - x[1]), cur) : empty('No assets recorded.'))}
                  ${section('Accounts', nw.accounts.length === 0 ? empty('Add accounts with fin_account_add.') : html`<table><thead><tr><th>Account</th><th>Kind</th><th class="num">Value</th><th>As of</th></tr></thead><tbody>
                    ${nw.accounts.map((a) => html`<tr><td>${a.name}<div class="muted">${a.institution ?? ''}</div></td><td>${badge(a.kind, a.liability ? 'bad' : 'neutral')}</td>
                      <td class="num">${a.liability ? '−' : ''}${money(Math.abs(a.value_cents), a.currency)}</td><td class="muted">${a.balance_as_of ?? ''}</td></tr>`)}</tbody></table>`)}
                </div>
                <div>
                  ${section('Holdings', holdings.length === 0 ? empty('No positions.') : html`<table><thead><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Value</th><th class="num">P/L</th></tr></thead><tbody>
                    ${holdings.map((h) => html`<tr><td><b>${h.symbol}</b><div class="muted">${h.account}</div></td><td class="num">${h.quantity}</td>
                      <td class="num">${money(h.value_cents, cur)}<div class="muted">${h.price_as_of ?? 'no price'}</div></td>
                      <td class="num ${h.unrealized_cents === null ? '' : h.unrealized_cents >= 0 ? 'good' : 'bad'}">${h.unrealized_cents === null ? '—' : money(h.unrealized_cents, cur)}</td></tr>`)}</tbody></table>`)}
                  ${section('Spending this month', month.groups.length === 0 ? empty('No transactions this month.') : bars(month.groups.slice(0, 10).map((g) => [String(g.category), g.out_cents]), cur))}
                  ${section('Theses', theses.length === 0 ? empty('None. Create with fin_thesis_upsert.') : html`${theses.map((t) => {
                    const p = latestPrice(ctx, t.symbol);
                    return html`<details id="${t.id}" class="thesis"><summary><b>${t.symbol}</b> ${t.title} ${badge(t.status, 'info')} ${t.review_on ? html`review ${due(t.review_on, today)}` : ''}
                      <span class="muted">${p ? `@ ${p.price} (${p.as_of})` : ''}${t.entry_target ? ` · entry ${t.entry_target}` : ''}${t.exit_target ? ` · exit ${t.exit_target}` : ''}</span></summary>
                      <div class="md">${markdown(t.thesis)}</div>${t.invalidation ? html`<p><b>Wrong if:</b> ${t.invalidation}</p>` : ''}</details>`;
                  })}`)}
                </div>
              </div>`,
          };
        },
      },
    ],
  },
};
