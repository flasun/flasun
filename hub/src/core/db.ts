import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** What callers may bind. Booleans become 0/1, undefined becomes NULL. */
export type Param = string | number | bigint | boolean | null | undefined;

export interface Migration {
  /** Monotonic per module, starting at 1. Never edit an applied migration; add a new one. */
  readonly version: number;
  readonly sql: string;
}

function bind(params: readonly Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * Thin synchronous wrapper over node:sqlite.
 *
 * WAL + busy_timeout is what lets a stdio MCP process (spawned per Claude
 * session) and the dashboard process share one file safely.
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.raw = new DatabaseSync(path);
    this.raw.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;',
    );
    this.raw.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (
         module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL,
         PRIMARY KEY (module, version))`,
    );
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...bind(params)) as unknown as T[];
  }

  one<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...bind(params)) as unknown as T | undefined;
  }

  run(sql: string, ...params: Param[]): number {
    return Number(this.stmt(sql).run(...bind(params)).changes);
  }

  /** Nested calls become savepoints, so module code can always wrap its own writes. */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate(module: string, migrations: readonly Migration[]): number[] {
    const done = new Set(
      this.all<{ version: number }>('SELECT version FROM _migrations WHERE module = ?', module).map((r) => r.version),
    );
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO _migrations (module, version, applied_at) VALUES (?, ?, ?)', module, m.version, new Date().toISOString());
      });
      applied.push(m.version);
    }
    return applied;
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
