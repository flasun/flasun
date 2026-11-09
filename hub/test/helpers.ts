import { Db } from '../src/core/db.ts';
import { createContext, resolveModules } from '../src/core/context.ts';
import { ALL_MODULES } from '../src/modules/index.ts';
import type { HubContext } from '../src/core/types.ts';

export interface TestHub {
  ctx: HubContext;
  call: <T = unknown>(tool: string, args?: unknown) => T;
  setNow: (iso: string) => void;
}

export function testHub(nowIso = '2026-11-09T15:00:00'): TestHub {
  let now = new Date(nowIso);
  const ctx = createContext(new Db(':memory:'), resolveModules(ALL_MODULES, 'all'), { now: () => now });
  const call = <T,>(tool: string, args: unknown = {}): T => {
    for (const m of ctx.modules) {
      const t = m.tools.find((x) => x.name === tool);
      if (t) return t.run(args, ctx) as T;
    }
    throw new Error(`no tool ${tool}`);
  };
  return { ctx, call, setNow: (iso) => (now = new Date(iso)) };
}
