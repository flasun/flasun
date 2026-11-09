import { randomBytes } from 'node:crypto';
import { Db, type Migration } from './db.ts';
import type { ActivityEntry, HubContext, HubModule, Links, Ref, SearchHit, SearchIndex } from './types.ts';
import { UserError } from './types.ts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

/** `tk_3f9a2b7c` — 40 bits of randomness; plenty for one person's records. */
export function newId(prefix: string): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[(bytes[i] ?? 0) & 31];
  return `${prefix}_${s}`;
}

export function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return toLocalDate(dt);
}

export function parseRef(s: string): Ref {
  const m = /^([a-z][a-z_]*):([A-Za-z0-9_.-]+)$/.exec(s.trim());
  if (!m) throw new UserError(`Not a ref: "${s}". Expected kind:id, e.g. task:tk_3f9a2b7c`);
  return `${m[1]}:${m[2]}` as Ref;
}

export function ref(kind: string, id: string): Ref {
  return `${kind}:${id}`;
}

const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE VIRTUAL TABLE search_index USING fts5(
        ref UNINDEXED, module UNINDEXED, title, body,
        tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TABLE links (
        from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'related',
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_ref, to_ref, relation));
      CREATE INDEX links_to ON links (to_ref);
      CREATE TABLE activity (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, module TEXT NOT NULL,
        ref TEXT, action TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX activity_at ON activity (at DESC);
    `,
  },
];

/**
 * FTS5 has its own query language; raw user input like `C++ "senior` is a syntax
 * error. Reduce input to word tokens and prefix-match each (implicit AND).
 */
export function ftsQuery(q: string): string | null {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.slice(0, 12).map((t) => `"${t}"*`).join(' ');
}

function makeIndex(db: Db): SearchIndex {
  return {
    upsert(r, module, title, body) {
      db.run('DELETE FROM search_index WHERE ref = ?', r);
      db.run('INSERT INTO search_index (ref, module, title, body) VALUES (?, ?, ?, ?)', r, module, title, body);
    },
    remove(r) {
      db.run('DELETE FROM search_index WHERE ref = ?', r);
    },
    query(q, opts = {}) {
      const match = ftsQuery(q);
      if (!match) return [];
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      const rows = db.all<SearchHit>(
        `SELECT ref, module, title, snippet(search_index, 3, '[', ']', ' … ', 12) AS snippet
           FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 0, 0, 5.0, 1.0) LIMIT ?`,
        match,
        limit * 3,
      );
      const mods = opts.modules && opts.modules.length > 0 ? new Set(opts.modules) : null;
      return (mods ? rows.filter((r) => mods.has(r.module)) : rows).slice(0, limit);
    },
  };
}

function makeLinks(db: Db, now: () => Date): Links {
  return {
    add(from, to, relation) {
      if (from === to) throw new UserError('Cannot link an entity to itself.');
      db.run(
        'INSERT OR IGNORE INTO links (from_ref, to_ref, relation, created_at) VALUES (?, ?, ?, ?)',
        from,
        to,
        relation,
        now().toISOString(),
      );
    },
    remove(from, to, relation) {
      return relation
        ? db.run('DELETE FROM links WHERE from_ref = ? AND to_ref = ? AND relation = ?', from, to, relation)
        : db.run('DELETE FROM links WHERE from_ref = ? AND to_ref = ?', from, to);
    },
    of(r) {
      const out = db.all<{ from_ref: Ref; relation: string }>('SELECT from_ref, relation FROM links WHERE to_ref = ?', r);
      const inn = db.all<{ to_ref: Ref; relation: string }>('SELECT to_ref, relation FROM links WHERE from_ref = ?', r);
      return [
        ...inn.map((l) => ({ ref: l.to_ref, relation: l.relation, direction: 'out' as const })),
        ...out.map((l) => ({ ref: l.from_ref, relation: l.relation, direction: 'in' as const })),
      ];
    },
  };
}

/** Topologically order modules so dependencies migrate first; auto-include missing deps. */
export function resolveModules(all: readonly HubModule[], wanted: readonly string[] | 'all'): HubModule[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  const order: HubModule[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    const m = byId.get(id);
    if (!m) throw new Error(`Unknown module "${id}". Available: ${[...byId.keys()].join(', ')}`);
    if (visiting.has(id)) throw new Error(`Module dependency cycle at "${id}"`);
    visiting.add(id);
    for (const dep of m.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    seen.add(id);
    order.push(m);
  };
  for (const id of wanted === 'all' ? [...byId.keys()] : wanted) visit(id);
  return order;
}

export interface ContextOptions {
  now?: () => Date;
}

export function createContext(db: Db, modules: readonly HubModule[], opts: ContextOptions = {}): HubContext {
  db.migrate('core', CORE_MIGRATIONS);
  for (const m of modules) db.migrate(m.id, m.migrations);
  const now = opts.now ?? (() => new Date());
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    db,
    modules,
    index: makeIndex(db),
    links: makeLinks(db, now),
    now,
    today: () => toLocalDate(now()),
    log(module, r, action, summary) {
      db.run(
        'INSERT INTO activity (at, module, ref, action, summary) VALUES (?, ?, ?, ?, ?)',
        now().toISOString(),
        module,
        r,
        action,
        summary.slice(0, 500),
      );
    },
    module<T extends HubModule>(id: string) {
      return byId.get(id) as T | undefined;
    },
  };
}

export function recentActivity(ctx: HubContext, limit = 30): ActivityEntry[] {
  return ctx.db.all<ActivityEntry>(
    'SELECT at, module, ref, action, summary FROM activity ORDER BY id DESC LIMIT ?',
    Math.min(Math.max(limit, 1), 200),
  );
}

/** Ask the owning module for a display title + dashboard link. */
export function resolveRef(ctx: HubContext, r: Ref): { title: string; href: string; module: string } | null {
  const kind = r.slice(0, r.indexOf(':'));
  for (const m of ctx.modules) {
    if (!m.kinds.includes(kind)) continue;
    const res = m.resolve?.(r, ctx);
    return res ? { ...res, module: m.id } : null;
  }
  return null;
}

export function requireRef(ctx: HubContext, r: Ref): { title: string; href: string; module: string } {
  const res = resolveRef(ctx, r);
  if (!res) throw new UserError(`No such entity: ${r}`);
  return res;
}
