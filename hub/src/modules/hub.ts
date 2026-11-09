import { z } from 'zod';
import { defineTool, type AgendaItem, type HubContext, type HubModule } from '../core/types.ts';
import { addDays, parseRef, recentActivity, requireRef, resolveRef } from '../core/context.ts';

/** Cross-module tools. Always enabled; this is the part that makes N modules one system. */

export function agenda(ctx: HubContext, days: number): { today: string; horizon: string; items: AgendaItem[] } {
  const today = ctx.today();
  const horizon = addDays(today, days);
  const rank = { overdue: 0, due: 1, review: 2, stale: 3 } as const;
  const items = ctx.modules
    .flatMap((m) => {
      try {
        return m.agenda?.(ctx, horizon) ?? [];
      } catch (err) {
        // One broken module must not blank the whole agenda.
        return [{ module: m.id, ref: `module:${m.id}` as const, title: `agenda failed: ${(err as Error).message}`, date: today, kind: 'stale' as const }];
      }
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.date.localeCompare(b.date));
  return { today, horizon, items };
}

export const hub: HubModule = {
  id: 'hub',
  title: 'Hub',
  description:
    'Cross-module tools: hub_agenda (what needs attention across everything), hub_search (full-text across all modules), hub_link / hub_links (connect any two entities by ref, e.g. a page to a job application), hub_recent (activity feed).',
  kinds: ['module'],
  migrations: [],
  tools: [
    defineTool({
      name: 'hub_agenda',
      title: 'Agenda',
      description: 'Start here. Everything due, overdue, up for review or gone stale across all modules within the next N days.',
      input: { days: z.number().int().min(0).max(60).default(7) },
      annotations: { readOnlyHint: true },
      handler: (a, ctx) => agenda(ctx, a.days),
    }),
    defineTool({
      name: 'hub_search',
      title: 'Search everything',
      description: 'Full-text search across pages, tasks, projects, applications, contacts, theses… Prefix-matches each word. Returns refs usable with other tools.',
      input: {
        query: z.string().min(1).max(200),
        modules: z.array(z.string()).optional().describe('Restrict to module ids, e.g. ["workspace","jobs"].'),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: { readOnlyHint: true },
      handler: (a, ctx) => ctx.index.query(a.query, { modules: a.modules, limit: a.limit }),
    }),
    defineTool({
      name: 'hub_link',
      title: 'Link entities',
      description: 'Link two entities by ref (kind:id), e.g. page:pg_… → job:jb_… with relation "prep". remove=true deletes the link.',
      input: {
        from: z.string(),
        to: z.string(),
        relation: z.string().trim().min(1).max(40).default('related'),
        remove: z.boolean().default(false),
      },
      annotations: { idempotentHint: true },
      handler(a, ctx) {
        const from = parseRef(a.from);
        const to = parseRef(a.to);
        if (a.remove) return { removed: ctx.links.remove(from, to, a.relation) };
        const f = requireRef(ctx, from);
        const t = requireRef(ctx, to);
        ctx.links.add(from, to, a.relation);
        ctx.log(f.module, from, 'linked', `${f.title} —${a.relation}→ ${t.title}`);
        return { from, to, relation: a.relation };
      },
    }),
    defineTool({
      name: 'hub_links',
      title: 'Show links',
      description: 'All entities linked to or from a ref, with titles.',
      input: { ref: z.string() },
      annotations: { readOnlyHint: true },
      handler(a, ctx) {
        const r = parseRef(a.ref);
        return ctx.links.of(r).map((l) => ({ ...l, title: resolveRef(ctx, l.ref)?.title ?? '(missing)' }));
      },
    }),
    defineTool({
      name: 'hub_recent',
      title: 'Recent activity',
      description: 'What changed recently across all modules, newest first.',
      input: { limit: z.number().int().min(1).max(200).default(30), module: z.string().optional() },
      annotations: { readOnlyHint: true },
      handler(a, ctx) {
        const rows = recentActivity(ctx, a.module ? 200 : a.limit);
        return (a.module ? rows.filter((r) => r.module === a.module) : rows).slice(0, a.limit);
      },
    }),
  ],
};
