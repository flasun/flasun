import { z } from 'zod';
import { defineTool, UserError, type AgendaItem, type HubContext, type HubModule, type ProjectSection } from '../../core/types.ts';
import { addDays, newId, ref } from '../../core/context.ts';
import { decodeTags, encodeTags, isoDate, limit, patch, tags, text } from '../../core/fields.ts';
import { html, markdown } from '../../core/html.ts';
import { badge, due, empty, linkTo, options, section } from '../../core/ui.ts';

export const PROJECT_STATUSES = ['idea', 'active', 'paused', 'done', 'dropped'] as const;
export const LOG_KINDS = ['update', 'decision', 'milestone', 'blocker', 'note'] as const;
const STALE_DAYS = 14;

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  status: (typeof PROJECT_STATUSES)[number];
  area: string | null;
  summary: string | null;
  goal: string | null;
  url: string | null;
  repo: string | null;
  started_on: string | null;
  target_on: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface LogRow {
  id: string;
  project_id: string;
  at: string;
  kind: (typeof LOG_KINDS)[number];
  title: string;
  body: string | null;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
}

/** Accepts an id (`pj_…`) or a slug (`vorion`). Every module that attaches to projects goes through this. */
export function findProject(ctx: HubContext, idOrSlug: string): ProjectRow {
  const p = ctx.db.one<ProjectRow>('SELECT * FROM projects WHERE id = ? OR slug = ?', idOrSlug, idOrSlug.toLowerCase());
  if (!p) throw new UserError(`No project "${idOrSlug}". Use proj_list to see slugs.`);
  return p;
}

function indexProject(ctx: HubContext, p: ProjectRow): void {
  ctx.index.upsert(ref('project', p.id), 'projects', p.name, [p.slug, p.summary, p.goal, p.area, decodeTags(p.tags).join(' ')].filter(Boolean).join('\n'));
}

function lastActivity(ctx: HubContext, projectId: string): string | null {
  return ctx.db.one<{ at: string | null }>('SELECT max(at) AS at FROM project_log WHERE project_id = ?', projectId)?.at ?? null;
}

function overview(ctx: HubContext, p: ProjectRow) {
  const log = ctx.db.all<LogRow>('SELECT * FROM project_log WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT 20', p.id);
  const sections: ProjectSection[] = ctx.modules.flatMap((m) => m.projectSections?.(ctx, p.id) ?? []);
  return { project: { ...p, tags: decodeTags(p.tags) }, log, sections, links: ctx.links.of(ref('project', p.id)) };
}

const createProject = defineTool({
    name: 'proj_create',
    title: 'Create project',
    description: 'Create a project. Projects are rows, not separate servers: tasks, pages, notes and other modules attach to them by slug.',
    input: {
      name: text(120).min(1),
      slug: z.string().regex(/^[a-z0-9-]{1,48}$/).optional().describe('Short handle, e.g. "vorion". Derived from name if omitted.'),
      status: z.enum(PROJECT_STATUSES).default('active'),
      area: text(60).optional().describe('Life/work area, e.g. "vorion", "personal", "career".'),
      summary: text(2000).optional(),
      goal: text(2000).optional().describe('What done looks like.'),
      url: z.string().url().optional(),
      repo: text(200).optional(),
      target_on: isoDate.optional(),
      tags: tags.optional(),
    },
    handler(a, ctx) {
      const slug = a.slug ?? slugify(a.name);
      if (ctx.db.one('SELECT 1 FROM projects WHERE slug = ?', slug)) throw new UserError(`Slug "${slug}" is taken.`);
      const id = newId('pj');
      const ts = ctx.now().toISOString();
      ctx.db.tx(() => {
        ctx.db.run(
          `INSERT INTO projects (id, slug, name, status, area, summary, goal, url, repo, started_on, target_on, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, slug, a.name, a.status, a.area, a.summary, a.goal, a.url, a.repo,
          a.status === 'active' ? ctx.today() : null, a.target_on, encodeTags(a.tags), ts, ts,
        );
        const p = findProject(ctx, id);
        indexProject(ctx, p);
        ctx.log('projects', ref('project', id), 'created', a.name);
      });
      return findProject(ctx, id);
    },
  });

const logProject = defineTool({
    name: 'proj_log',
    title: 'Log to project',
    description: 'Append a dated entry to a project\'s log. Use kind=decision for decisions and their rationale — this is the decision record.',
    input: {
      project: z.string().describe('id or slug'),
      kind: z.enum(LOG_KINDS).default('update'),
      title: text(200).min(1),
      body: text(20000).optional().describe('Markdown.'),
    },
    handler(a, ctx) {
      const p = findProject(ctx, a.project);
      const id = newId('pl');
      ctx.db.tx(() => {
        ctx.db.run('INSERT INTO project_log (id, project_id, at, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)',
          id, p.id, ctx.now().toISOString(), a.kind, a.title, a.body);
        ctx.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', ctx.now().toISOString(), p.id);
        ctx.index.upsert(ref('plog', id), 'projects', `${p.name}: ${a.title}`, a.body ?? '');
        ctx.log('projects', ref('project', p.id), a.kind, a.title);
      });
      return { id, project: p.slug };
    },
  });

const tools = [
  createProject,
  logProject,
  defineTool({
    name: 'proj_update',
    title: 'Update project',
    description: 'Change a project\'s fields or status. Only provided fields change.',
    input: {
      project: z.string().describe('id or slug'),
      name: text(120).min(1).optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      area: text(60).nullable().optional(),
      summary: text(2000).nullable().optional(),
      goal: text(2000).nullable().optional(),
      url: z.string().url().nullable().optional(),
      repo: text(200).nullable().optional(),
      target_on: isoDate.nullable().optional(),
      tags: tags.optional(),
    },
    annotations: { idempotentHint: true },
    handler(a, ctx) {
      const p = findProject(ctx, a.project);
      const { sql, params } = patch({
        name: a.name, status: a.status, area: a.area, summary: a.summary, goal: a.goal,
        url: a.url, repo: a.repo, target_on: a.target_on,
        tags: a.tags ? encodeTags(a.tags) : undefined,
        started_on: a.status === 'active' && !p.started_on ? ctx.today() : undefined,
      });
      if (!sql) return p;
      ctx.db.tx(() => {
        ctx.db.run(`UPDATE projects SET ${sql}, updated_at = ? WHERE id = ?`, ...params, ctx.now().toISOString(), p.id);
        const next = findProject(ctx, p.id);
        indexProject(ctx, next);
        if (a.status && a.status !== p.status) {
          ctx.db.run('INSERT INTO project_log (id, project_id, at, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)',
            newId('pl'), p.id, ctx.now().toISOString(), 'update', `Status: ${p.status} → ${a.status}`, null);
        }
        ctx.log('projects', ref('project', p.id), 'updated', next.name);
      });
      return findProject(ctx, p.id);
    },
  }),
  defineTool({
    name: 'proj_list',
    title: 'List projects',
    description: 'List projects with open-task counts and days since last log entry.',
    input: { status: z.enum(PROJECT_STATUSES).optional(), area: z.string().optional(), limit },
    annotations: { readOnlyHint: true },
    handler(a, ctx) {
      const rows = ctx.db.all<ProjectRow>(
        `SELECT * FROM projects WHERE (? IS NULL OR status = ?) AND (? IS NULL OR area = ?)
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'idea' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`,
        a.status, a.status, a.area, a.area, a.limit,
      );
      return rows.map((p) => ({
        id: p.id, slug: p.slug, name: p.name, status: p.status, area: p.area, target_on: p.target_on,
        last_log: lastActivity(ctx, p.id),
      }));
    },
  }),
  defineTool({
    name: 'proj_get',
    title: 'Project overview',
    description: 'Everything about one project: fields, recent log (decisions, milestones, blockers), and sections contributed by other modules (open tasks, pages, …).',
    input: { project: z.string().describe('id or slug') },
    annotations: { readOnlyHint: true },
    handler: (a, ctx) => overview(ctx, findProject(ctx, a.project)),
  }),
];

export const projects: HubModule = {
  id: 'projects',
  title: 'Projects',
  description:
    'Projects (by slug) with a dated log of updates, decisions, milestones and blockers. Other modules attach to projects, so proj_get is the one-call project briefing.',
  kinds: ['project', 'plog'],
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('idea','active','paused','done','dropped')),
          area TEXT, summary TEXT, goal TEXT, url TEXT, repo TEXT,
          started_on TEXT, target_on TEXT, tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE project_log (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('update','decision','milestone','blocker','note')),
          title TEXT NOT NULL, body TEXT);
        CREATE INDEX project_log_project ON project_log (project_id, at DESC);
      `,
    },
  ],
  tools,
  resolve(r, ctx) {
    const [kind, id] = r.split(':') as [string, string];
    if (kind === 'project') {
      const p = ctx.db.one<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
      return p ? { title: p.name, href: `/projects/${p.slug}` } : null;
    }
    const l = ctx.db.one<LogRow & { slug: string; name: string }>(
      'SELECT l.*, p.slug, p.name FROM project_log l JOIN projects p ON p.id = l.project_id WHERE l.id = ?', id);
    return l ? { title: `${l.name}: ${l.title}`, href: `/projects/${l.slug}` } : null;
  },
  agenda(ctx, horizon) {
    const today = ctx.today();
    const items: AgendaItem[] = ctx.db
      .all<ProjectRow>(`SELECT * FROM projects WHERE status = 'active' AND target_on IS NOT NULL AND target_on <= ?`, horizon)
      .map((p) => ({
        module: 'projects', ref: ref('project', p.id), title: `${p.name} target`, date: p.target_on ?? today,
        kind: (p.target_on ?? today) < today ? 'overdue' : 'due',
      }));
    const staleBefore = addDays(today, -STALE_DAYS);
    for (const p of ctx.db.all<ProjectRow>(`SELECT * FROM projects WHERE status = 'active'`)) {
      const last = (lastActivity(ctx, p.id) ?? p.created_at).slice(0, 10);
      if (last < staleBefore) {
        items.push({ module: 'projects', ref: ref('project', p.id), title: `${p.name}: no log since ${last}`, date: last, kind: 'stale' });
      }
    }
    return items;
  },
  reindex(ctx) {
    const rows = ctx.db.all<ProjectRow>('SELECT * FROM projects');
    rows.forEach((p) => indexProject(ctx, p));
    const logs = ctx.db.all<LogRow & { name: string }>('SELECT l.*, p.name FROM project_log l JOIN projects p ON p.id = l.project_id');
    logs.forEach((l) => ctx.index.upsert(ref('plog', l.id), 'projects', `${l.name}: ${l.title}`, l.body ?? ''));
    return rows.length + logs.length;
  },
  dashboard: {
    nav: { label: 'Projects', href: '/projects' },
    card(ctx) {
      const active = ctx.db.one<{ n: number }>(`SELECT count(*) AS n FROM projects WHERE status = 'active'`)?.n ?? 0;
      const recent = ctx.db.all<{ title: string; kind: string; name: string; slug: string }>(
        `SELECT l.title, l.kind, p.name, p.slug FROM project_log l JOIN projects p ON p.id = l.project_id ORDER BY l.at DESC, l.rowid DESC LIMIT 4`);
      return html`<a class="card" href="/projects"><h3>Projects</h3><dl><div><dt>active</dt><dd>${active}</dd></div></dl>
        <ul class="mini">${recent.map((l) => html`<li>${badge(l.kind)} <b>${l.name}</b> ${l.title}</li>`)}</ul></a>`;
    },
    routes: [
      {
        method: 'GET',
        path: '/projects',
        handler(_req, ctx) {
          const rows = ctx.db.all<ProjectRow>(
            `SELECT * FROM projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'idea' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, name`);
          const today = ctx.today();
          return {
            kind: 'page',
            title: 'Projects',
            body: html`
              ${section('Projects', rows.length === 0 ? empty('No projects yet.') : html`<table><thead><tr><th>Project</th><th>Status</th><th>Area</th><th>Target</th><th>Last log</th></tr></thead><tbody>
                ${rows.map((p) => html`<tr><td><a href="/projects/${p.slug}">${p.name}</a><div class="muted">${p.summary ?? ''}</div></td>
                  <td>${badge(p.status, p.status === 'active' ? 'good' : p.status === 'paused' ? 'warn' : 'neutral')}</td>
                  <td>${p.area ?? ''}</td><td>${due(p.target_on, today)}</td><td class="muted">${(lastActivity(ctx, p.id) ?? '').slice(0, 10)}</td></tr>`)}
              </tbody></table>`)}
              ${section('New project', html`<form method="post" action="/projects" class="grid">
                <label>Name <input name="name" required maxlength="120"></label>
                <label>Area <input name="area" maxlength="60"></label>
                <label>Status <select name="status">${options(PROJECT_STATUSES, 'active')}</select></label>
                <label>Target <input type="date" name="target_on"></label>
                <label class="wide">Summary <textarea name="summary" rows="2"></textarea></label>
                <button>Create</button></form>`)}`,
          };
        },
      },
      {
        method: 'POST',
        path: '/projects',
        handler(req, ctx) {
          const p = createProject.run({
            name: req.form.get('name') ?? '',
            area: req.form.get('area') || undefined,
            status: req.form.get('status') || undefined,
            target_on: req.form.get('target_on') || undefined,
            summary: req.form.get('summary') || undefined,
          }, ctx) as ProjectRow;
          return { kind: 'redirect', to: `/projects/${p.slug}` };
        },
      },
      {
        method: 'GET',
        path: '/projects/:slug',
        handler(req, ctx) {
          const o = overview(ctx, findProject(ctx, req.params.slug ?? ''));
          const p = o.project;
          return {
            kind: 'page',
            title: p.name,
            body: html`
              <div class="head"><h1>${p.name}</h1>${badge(p.status, p.status === 'active' ? 'good' : 'neutral')}
                ${p.area ? badge(p.area, 'info') : ''}${p.target_on ? html` target ${due(p.target_on, ctx.today())}` : ''}</div>
              ${p.summary ? html`<p class="lead">${p.summary}</p>` : ''}
              ${p.goal ? html`<p><b>Done means:</b> ${p.goal}</p>` : ''}
              <div class="cols">
                <div>${o.sections.map((s) => section(s.title, s.items.length === 0 ? empty('Nothing here.') : html`<ul>${s.items.map((i) => html`<li>${linkTo(ctx, i.ref, i.title)} <span class="muted">${i.meta ?? ''}</span></li>`)}</ul>`))}</div>
                <div>${section('Log', html`
                  <form method="post" action="/projects/${p.slug}/log" class="stack">
                    <div class="row"><select name="kind">${options(LOG_KINDS, 'update')}</select><input name="title" placeholder="What happened / what was decided" required maxlength="200"></div>
                    <textarea name="body" rows="3" placeholder="Details (markdown)"></textarea><button>Log</button></form>
                  ${o.log.length === 0 ? empty('No entries.') : html`<ol class="log">${o.log.map((l) => html`<li><div>${badge(l.kind, l.kind === 'blocker' ? 'bad' : l.kind === 'decision' ? 'info' : l.kind === 'milestone' ? 'good' : 'neutral')} <b>${l.title}</b> <span class="muted">${l.at.slice(0, 10)}</span></div>${l.body ? html`<div class="md">${markdown(l.body)}</div>` : ''}</li>`)}</ol>`}`)}</div>
              </div>`,
          };
        },
      },
      {
        method: 'POST',
        path: '/projects/:slug/log',
        handler(req, ctx) {
          logProject.run({ project: req.params.slug, kind: req.form.get('kind') || undefined, title: req.form.get('title') ?? '', body: req.form.get('body') || undefined }, ctx);
          return { kind: 'redirect', to: `/projects/${req.params.slug}` };
        },
      },
    ],
  },
};
