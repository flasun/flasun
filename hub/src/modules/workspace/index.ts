import { z } from 'zod';
import { defineTool, UserError, type AgendaItem, type HubContext, type HubModule } from '../../core/types.ts';
import { newId, ref } from '../../core/context.ts';
import { decodeTags, encodeTags, isoDate, limit, patch, tags, text } from '../../core/fields.ts';
import { html, markdown } from '../../core/html.ts';
import { badge, due, empty, options, postButton, section } from '../../core/ui.ts';
import { findProject } from '../projects/index.ts';

/**
 * The Notion replacement: nested Markdown pages and a task list. Deliberately
 * not a block editor or a generic "database" builder — those are what make
 * Notion slow to drive from an agent. Structured domains get their own module
 * with real columns instead (see jobs, finance).
 */

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'dropped'] as const;
const OPEN = `('todo','doing','blocked')`;

interface PageRow {
  id: string;
  parent_id: string | null;
  project_id: string | null;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: (typeof TASK_STATUSES)[number];
  priority: number;
  due_on: string | null;
  project_id: string | null;
  page_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function projectId(ctx: HubContext, p: string | null | undefined): string | null | undefined {
  if (p === undefined || p === null || p === '') return p === '' ? null : p;
  return findProject(ctx, p).id;
}

function getPage(ctx: HubContext, idOrTitle: string): PageRow {
  const p =
    ctx.db.one<PageRow>('SELECT * FROM pages WHERE id = ?', idOrTitle) ??
    ctx.db.one<PageRow>('SELECT * FROM pages WHERE title = ? COLLATE NOCASE AND archived = 0 ORDER BY updated_at DESC', idOrTitle);
  if (!p) throw new UserError(`No page "${idOrTitle}". Search with hub_search or list with ws_page_list.`);
  return p;
}

function getTask(ctx: HubContext, id: string): TaskRow {
  const t = ctx.db.one<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  if (!t) throw new UserError(`No task "${id}".`);
  return t;
}

function breadcrumb(ctx: HubContext, page: PageRow): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  let cur = page.parent_id;
  for (let i = 0; cur && i < 20; i++) {
    const p = ctx.db.one<PageRow>('SELECT id, title, parent_id FROM pages WHERE id = ?', cur);
    if (!p) break;
    out.unshift({ id: p.id, title: p.title });
    cur = p.parent_id;
  }
  return out;
}

function indexPage(ctx: HubContext, p: PageRow): void {
  if (p.archived) ctx.index.remove(ref('page', p.id));
  else ctx.index.upsert(ref('page', p.id), 'workspace', p.title, `${p.body}\n${decodeTags(p.tags).join(' ')}`);
}

function indexTask(ctx: HubContext, t: TaskRow): void {
  ctx.index.upsert(ref('task', t.id), 'workspace', t.title, `${t.notes ?? ''}\n${t.status}\n${decodeTags(t.tags).join(' ')}`);
}

function presentTask(ctx: HubContext, t: TaskRow) {
  const proj = t.project_id ? ctx.db.one<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', t.project_id)?.slug : undefined;
  return { id: t.id, title: t.title, status: t.status, priority: t.priority, due_on: t.due_on, project: proj ?? null, tags: decodeTags(t.tags), notes: t.notes };
}

function wouldCycle(ctx: HubContext, pageId: string, newParent: string): boolean {
  let cur: string | null = newParent;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === pageId) return true;
    cur = ctx.db.one<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = ?', cur)?.parent_id ?? null;
  }
  return false;
}

// --- tools -----------------------------------------------------------------

const createPage = defineTool({
  name: 'ws_page_create',
  title: 'Create page',
  description: 'Create a Markdown page (notes, docs, specs, meeting notes). Optionally nest under a parent page and/or attach to a project.',
  input: {
    title: text(200).min(1),
    body: text(200_000).default(''),
    parent: z.string().optional().describe('Parent page id or exact title.'),
    project: z.string().optional().describe('Project id or slug.'),
    tags: tags.optional(),
  },
  handler(a, ctx) {
    const parent = a.parent ? getPage(ctx, a.parent).id : null;
    const id = newId('pg');
    const ts = ctx.now().toISOString();
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO pages (id, parent_id, project_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, parent, projectId(ctx, a.project) ?? null, a.title, a.body, encodeTags(a.tags), ts, ts,
      );
      indexPage(ctx, getPage(ctx, id));
      ctx.log('workspace', ref('page', id), 'created', a.title);
    });
    return { id, ref: ref('page', id), title: a.title };
  },
});

const updatePage = defineTool({
  name: 'ws_page_update',
  title: 'Update page',
  description:
    'Edit a page. Use `append` to add to the end without resending the whole body (preferred for logs/notes); `body` replaces it entirely. Set archived=true to remove from lists and search.',
  input: {
    page: z.string().describe('Page id or exact title.'),
    title: text(200).min(1).optional(),
    body: text(200_000).optional(),
    append: text(50_000).optional(),
    parent: z.string().nullable().optional().describe('New parent page id/title, or null for top level.'),
    project: z.string().nullable().optional(),
    tags: tags.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  },
  handler(a, ctx) {
    const p = getPage(ctx, a.page);
    if (a.body !== undefined && a.append !== undefined) throw new UserError('Pass body or append, not both.');
    let parent: string | null | undefined;
    if (a.parent === null) parent = null;
    else if (a.parent !== undefined) {
      parent = getPage(ctx, a.parent).id;
      if (wouldCycle(ctx, p.id, parent)) throw new UserError('That parent would create a cycle.');
    }
    const body = a.append !== undefined ? `${p.body.replace(/\s+$/, '')}\n\n${a.append}` : a.body;
    const { sql, params } = patch({
      title: a.title, body, parent_id: parent,
      project_id: a.project === null ? null : projectId(ctx, a.project),
      tags: a.tags ? encodeTags(a.tags) : undefined,
      pinned: a.pinned, archived: a.archived,
    });
    if (!sql) return { id: p.id };
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE pages SET ${sql}, updated_at = ? WHERE id = ?`, ...params, ctx.now().toISOString(), p.id);
      const next = getPage(ctx, p.id);
      indexPage(ctx, next);
      ctx.log('workspace', ref('page', p.id), a.archived ? 'archived' : a.append ? 'appended' : 'updated', next.title);
    });
    return { id: p.id, ref: ref('page', p.id) };
  },
});

const addTask = defineTool({
  name: 'ws_task_add',
  title: 'Add tasks',
  description: 'Add one or more tasks. Priority 1 = urgent … 4 = someday.',
  input: {
    tasks: z
      .array(
        z.object({
          title: text(300).min(1),
          notes: text(10_000).optional(),
          priority: z.number().int().min(1).max(4).default(3),
          due_on: isoDate.optional(),
          project: z.string().optional().describe('Project id or slug.'),
          page: z.string().optional().describe('Page id this task came from.'),
          tags: tags.optional(),
        }),
      )
      .min(1)
      .max(50),
  },
  handler(a, ctx) {
    return ctx.db.tx(() =>
      a.tasks.map((t) => {
        const id = newId('tk');
        const ts = ctx.now().toISOString();
        ctx.db.run(
          `INSERT INTO tasks (id, title, notes, status, priority, due_on, project_id, page_id, tags, created_at, updated_at)
           VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
          id, t.title, t.notes, t.priority, t.due_on, projectId(ctx, t.project) ?? null,
          t.page ? getPage(ctx, t.page).id : null, encodeTags(t.tags), ts, ts,
        );
        const row = getTask(ctx, id);
        indexTask(ctx, row);
        ctx.log('workspace', ref('task', id), 'added', t.title);
        return presentTask(ctx, row);
      }),
    );
  },
});

const updateTask = defineTool({
  name: 'ws_task_update',
  title: 'Update tasks',
  description: 'Update one or more tasks (status, due date, priority, …). Only provided fields change. status=done stamps completed_at.',
  input: {
    updates: z
      .array(
        z.object({
          id: z.string(),
          title: text(300).min(1).optional(),
          notes: text(10_000).nullable().optional(),
          status: z.enum(TASK_STATUSES).optional(),
          priority: z.number().int().min(1).max(4).optional(),
          due_on: isoDate.nullable().optional(),
          project: z.string().nullable().optional(),
          tags: tags.optional(),
        }),
      )
      .min(1)
      .max(50),
  },
  annotations: { idempotentHint: true },
  handler(a, ctx) {
    return ctx.db.tx(() =>
      a.updates.map((u) => {
        const t = getTask(ctx, u.id);
        const closing = u.status === 'done' || u.status === 'dropped';
        const { sql, params } = patch({
          title: u.title, notes: u.notes, status: u.status, priority: u.priority, due_on: u.due_on,
          project_id: u.project === null ? null : projectId(ctx, u.project),
          tags: u.tags ? encodeTags(u.tags) : undefined,
          completed_at: u.status === undefined ? undefined : closing ? ctx.now().toISOString() : null,
        });
        if (sql) {
          ctx.db.run(`UPDATE tasks SET ${sql}, updated_at = ? WHERE id = ?`, ...params, ctx.now().toISOString(), t.id);
          indexTask(ctx, getTask(ctx, t.id));
          ctx.log('workspace', ref('task', t.id), u.status && u.status !== t.status ? u.status : 'updated', t.title);
        }
        return presentTask(ctx, getTask(ctx, t.id));
      }),
    );
  },
});

const listTasks = defineTool({
  name: 'ws_task_list',
  title: 'List tasks',
  description: 'List tasks. Defaults to open tasks (todo/doing/blocked) ordered by due date then priority.',
  input: {
    status: z.array(z.enum(TASK_STATUSES)).optional().describe('Defaults to open statuses.'),
    project: z.string().optional(),
    tag: z.string().optional(),
    due_before: isoDate.optional().describe('Inclusive.'),
    limit,
  },
  annotations: { readOnlyHint: true },
  handler(a, ctx) {
    const statuses = a.status && a.status.length > 0 ? a.status : ['todo', 'doing', 'blocked'];
    const pid = a.project ? findProject(ctx, a.project).id : null;
    const rows = ctx.db.all<TaskRow>(
      `SELECT * FROM tasks
        WHERE status IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value = lower(?)))
          AND (? IS NULL OR (due_on IS NOT NULL AND due_on <= ?))
        ORDER BY due_on IS NULL, due_on, priority, created_at LIMIT ?`,
      JSON.stringify(statuses), pid, pid, a.tag, a.tag, a.due_before, a.due_before, a.limit,
    );
    return rows.map((t) => presentTask(ctx, t));
  },
});

const tools = [
  createPage,
  defineTool({
    name: 'ws_page_get',
    title: 'Read page',
    description: 'Read a page by id or exact title: full Markdown body, breadcrumb, child pages, linked tasks and links.',
    input: { page: z.string() },
    annotations: { readOnlyHint: true },
    handler(a, ctx) {
      const p = getPage(ctx, a.page);
      return {
        ...p,
        tags: decodeTags(p.tags),
        breadcrumb: breadcrumb(ctx, p),
        children: ctx.db.all<{ id: string; title: string }>('SELECT id, title FROM pages WHERE parent_id = ? AND archived = 0 ORDER BY title', p.id),
        tasks: ctx.db.all<TaskRow>('SELECT * FROM tasks WHERE page_id = ? ORDER BY status, due_on', p.id).map((t) => presentTask(ctx, t)),
        links: ctx.links.of(ref('page', p.id)),
      };
    },
  }),
  updatePage,
  defineTool({
    name: 'ws_page_list',
    title: 'List pages',
    description: 'List page titles (no bodies). Filter by parent, project or tag. For full-text, use hub_search.',
    input: {
      parent: z.string().nullable().optional().describe('Parent id/title; null = top-level only; omit = all.'),
      project: z.string().optional(),
      tag: z.string().optional(),
      include_archived: z.boolean().default(false),
      limit,
    },
    annotations: { readOnlyHint: true },
    handler(a, ctx) {
      const parentFilter = a.parent === undefined ? 'any' : a.parent === null ? 'root' : getPage(ctx, a.parent).id;
      const pid = a.project ? findProject(ctx, a.project).id : null;
      return ctx.db.all<{ id: string; title: string; parent_id: string | null; updated_at: string }>(
        `SELECT id, title, parent_id, updated_at FROM pages
          WHERE (? = 1 OR archived = 0)
            AND (? = 'any' OR (? = 'root' AND parent_id IS NULL) OR parent_id = ?)
            AND (? IS NULL OR project_id = ?)
            AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(pages.tags) WHERE value = lower(?)))
          ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
        a.include_archived, parentFilter, parentFilter, parentFilter, pid, pid, a.tag, a.tag, a.limit,
      );
    },
  }),
  addTask,
  updateTask,
  listTasks,
];

// --- dashboard -------------------------------------------------------------

function taskRow(ctx: HubContext, t: TaskRow, today: string) {
  const proj = t.project_id ? ctx.db.one<{ slug: string; name: string }>('SELECT slug, name FROM projects WHERE id = ?', t.project_id) : undefined;
  const next = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : t.status === 'blocked' ? 'doing' : 'todo';
  return html`<li class="task p${t.priority}">
    ${postButton(`/tasks/${t.id}/status`, t.status === 'done' ? '↺' : '✓', { status: t.status === 'done' ? 'todo' : 'done' }, 'icon')}
    <span class="t">${t.title}</span>
    ${proj ? html`<a class="badge info" href="/projects/${proj.slug}">${proj.slug}</a>` : ''}
    ${due(t.due_on, today)}
    ${t.status !== 'done' && t.status !== 'dropped' ? postButton(`/tasks/${t.id}/status`, `→ ${next}`, { status: next }, 'ghost') : ''}
  </li>`;
}

function pageTree(ctx: HubContext): ReturnType<typeof html> {
  const rows = ctx.db.all<{ id: string; title: string; parent_id: string | null; pinned: number }>(
    'SELECT id, title, parent_id, pinned FROM pages WHERE archived = 0 ORDER BY pinned DESC, title');
  const kids = new Map<string | null, typeof rows>();
  for (const r of rows) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r]);
  const ids = new Set(rows.map((r) => r.id));
  const roots = rows.filter((r) => !r.parent_id || !ids.has(r.parent_id));
  const walk = (list: typeof rows, depth: number): ReturnType<typeof html> =>
    html`<ul class="tree">${list.map((r) => html`<li><a href="/pages/${r.id}">${r.pinned ? '★ ' : ''}${r.title}</a>${depth < 8 && kids.has(r.id) ? walk(kids.get(r.id) ?? [], depth + 1) : ''}</li>`)}</ul>`;
  return roots.length === 0 ? empty('No pages yet.') : walk(roots, 0);
}

export const workspace: HubModule = {
  id: 'workspace',
  title: 'Workspace',
  description:
    'Notion replacement: nested Markdown pages (ws_page_*) and tasks (ws_task_*). Prefer ws_page_update with `append` over rewriting whole pages. Attach pages/tasks to projects by slug.',
  dependsOn: ['projects'],
  kinds: ['page', 'task'],
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE pages (
          id TEXT PRIMARY KEY, parent_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
          pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX pages_parent ON pages (parent_id);
        CREATE INDEX pages_project ON pages (project_id);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT,
          status TEXT NOT NULL CHECK (status IN ('todo','doing','blocked','done','dropped')),
          priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
          due_on TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
          tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
        CREATE INDEX tasks_open ON tasks (status, due_on);
        CREATE INDEX tasks_project ON tasks (project_id);
      `,
    },
  ],
  tools,
  resolve(r, ctx) {
    const [kind, id] = r.split(':') as [string, string];
    if (kind === 'page') {
      const p = ctx.db.one<PageRow>('SELECT id, title FROM pages WHERE id = ?', id);
      return p ? { title: p.title, href: `/pages/${p.id}` } : null;
    }
    const t = ctx.db.one<TaskRow>('SELECT id, title FROM tasks WHERE id = ?', id);
    return t ? { title: t.title, href: `/tasks#${t.id}` } : null;
  },
  agenda(ctx, horizon) {
    const today = ctx.today();
    return ctx.db
      .all<TaskRow>(`SELECT * FROM tasks WHERE status IN ${OPEN} AND due_on IS NOT NULL AND due_on <= ? ORDER BY due_on, priority`, horizon)
      .map((t): AgendaItem => ({
        module: 'workspace', ref: ref('task', t.id), title: t.title, date: t.due_on ?? today,
        kind: (t.due_on ?? today) < today ? 'overdue' : 'due', detail: `P${t.priority}${t.status === 'blocked' ? ' · blocked' : ''}`,
      }));
  },
  projectSections(ctx, projectId) {
    const tasks = ctx.db.all<TaskRow>(`SELECT * FROM tasks WHERE project_id = ? AND status IN ${OPEN} ORDER BY due_on IS NULL, due_on, priority LIMIT 50`, projectId);
    const pages = ctx.db.all<PageRow>('SELECT id, title, updated_at FROM pages WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 50', projectId);
    return [
      { title: 'Open tasks', items: tasks.map((t) => ({ ref: ref('task', t.id), title: t.title, meta: [t.status, t.due_on ? `due ${t.due_on}` : '', `P${t.priority}`].filter(Boolean).join(' · ') })) },
      { title: 'Pages', items: pages.map((p) => ({ ref: ref('page', p.id), title: p.title, meta: p.updated_at.slice(0, 10) })) },
    ];
  },
  reindex(ctx) {
    const pages = ctx.db.all<PageRow>('SELECT * FROM pages');
    pages.forEach((p) => indexPage(ctx, p));
    const tasks = ctx.db.all<TaskRow>('SELECT * FROM tasks');
    tasks.forEach((t) => indexTask(ctx, t));
    return pages.length + tasks.length;
  },
  dashboard: {
    nav: { label: 'Workspace', href: '/tasks' },
    card(ctx) {
      const today = ctx.today();
      const open = ctx.db.one<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE status IN ${OPEN}`)?.n ?? 0;
      const overdue = ctx.db.one<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE status IN ${OPEN} AND due_on < ?`, today)?.n ?? 0;
      const pages = ctx.db.one<{ n: number }>('SELECT count(*) AS n FROM pages WHERE archived = 0')?.n ?? 0;
      return html`<a class="card" href="/tasks"><h3>Workspace</h3><dl>
        <div><dt>open tasks</dt><dd>${open}</dd></div><div><dt>overdue</dt><dd class="${overdue ? 'bad' : ''}">${overdue}</dd></div>
        <div><dt>pages</dt><dd>${pages}</dd></div></dl></a>`;
    },
    routes: [
      {
        method: 'GET',
        path: '/tasks',
        handler(req, ctx) {
          const today = ctx.today();
          const show = req.query.get('show') === 'done' ? 'done' : 'open';
          const rows = ctx.db.all<TaskRow>(
            show === 'done'
              ? `SELECT * FROM tasks WHERE status IN ('done','dropped') ORDER BY completed_at DESC LIMIT 100`
              : `SELECT * FROM tasks WHERE status IN ${OPEN} ORDER BY due_on IS NULL, due_on, priority, created_at`,
          );
          const groups = show === 'done' ? [['Completed', rows] as const] : (['doing', 'blocked', 'todo'] as const).map((s) => [s, rows.filter((t) => t.status === s)] as const);
          return {
            kind: 'page',
            title: 'Tasks',
            body: html`
              ${section('Add task', html`<form method="post" action="/tasks" class="row">
                <input name="title" placeholder="Task" required maxlength="300" class="grow">
                <input name="project" placeholder="project slug" maxlength="48" size="12">
                <input type="date" name="due_on">
                <select name="priority">${options(['1', '2', '3', '4'], '3')}</select>
                <button>Add</button></form>`)}
              <div class="cols">
                <div>${groups.map(([name, list]) => section(`${name} (${list.length})`, list.length === 0 ? empty('—') : html`<ul class="tasks">${list.map((t) => taskRow(ctx, t, today))}</ul>`))}</div>
                <div>${section('Pages', pageTree(ctx), html`<a href="/pages/new" class="button">New page</a>`)}</div>
              </div>
              <p><a href="/tasks?show=${show === 'done' ? 'open' : 'done'}">${show === 'done' ? 'Show open' : 'Show completed'}</a></p>`,
          };
        },
      },
      {
        method: 'POST',
        path: '/tasks',
        handler(req, ctx) {
          addTask.run({ tasks: [{
            title: req.form.get('title') ?? '',
            project: req.form.get('project') || undefined,
            due_on: req.form.get('due_on') || undefined,
            priority: Number(req.form.get('priority') ?? 3),
          }] }, ctx);
          return { kind: 'redirect', to: '/tasks' };
        },
      },
      {
        method: 'POST',
        path: '/tasks/:id/status',
        handler(req, ctx) {
          updateTask.run({ updates: [{ id: req.params.id, status: req.form.get('status') }] }, ctx);
          return { kind: 'redirect', to: '/tasks' };
        },
      },
      {
        method: 'GET',
        path: '/pages/new',
        handler(req) {
          const parent = req.query.get('parent') ?? '';
          return {
            kind: 'page',
            title: 'New page',
            body: section('New page', html`<form method="post" action="/pages" class="stack">
              <input type="hidden" name="parent" value="${parent}">
              <input name="title" placeholder="Title" required maxlength="200">
              <input name="project" placeholder="project slug (optional)" maxlength="48">
              <textarea name="body" rows="20" placeholder="Markdown"></textarea>
              <button>Create</button></form>`),
          };
        },
      },
      {
        method: 'POST',
        path: '/pages',
        handler(req, ctx) {
          const res = createPage.run({
            title: req.form.get('title') ?? '',
            body: req.form.get('body') ?? '',
            parent: req.form.get('parent') || undefined,
            project: req.form.get('project') || undefined,
          }, ctx) as { id: string };
          return { kind: 'redirect', to: `/pages/${res.id}` };
        },
      },
      {
        method: 'GET',
        path: '/pages/:id',
        handler(req, ctx) {
          const p = getPage(ctx, req.params.id ?? '');
          const editing = req.query.get('edit') === '1';
          const children = ctx.db.all<{ id: string; title: string }>('SELECT id, title FROM pages WHERE parent_id = ? AND archived = 0 ORDER BY title', p.id);
          const proj = p.project_id ? ctx.db.one<{ slug: string; name: string }>('SELECT slug, name FROM projects WHERE id = ?', p.project_id) : undefined;
          const crumbs = breadcrumb(ctx, p);
          return {
            kind: 'page',
            title: p.title,
            body: html`
              <nav class="crumbs"><a href="/tasks">Workspace</a>${crumbs.map((c) => html` / <a href="/pages/${c.id}">${c.title}</a>`)}</nav>
              <div class="head"><h1>${p.title}</h1>
                ${proj ? html`<a class="badge info" href="/projects/${proj.slug}">${proj.name}</a>` : ''}
                ${decodeTags(p.tags).map((t) => badge(t))}
                <span class="spacer"></span>
                ${editing ? '' : html`<a class="button" href="/pages/${p.id}?edit=1">Edit</a>`}
                <a class="button ghost" href="/pages/new?parent=${p.id}">Sub-page</a>
                ${postButton(`/pages/${p.id}/archive`, 'Archive', {}, 'ghost')}
              </div>
              ${editing
                ? html`<form method="post" action="/pages/${p.id}" class="stack">
                    <input name="title" value="${p.title}" required maxlength="200">
                    <textarea name="body" rows="28">${p.body}</textarea>
                    <div class="row"><button>Save</button><a href="/pages/${p.id}">Cancel</a></div></form>`
                : html`<article class="md">${p.body ? markdown(p.body) : empty('Empty page.')}</article>`}
              ${children.length ? section('Sub-pages', html`<ul>${children.map((c) => html`<li><a href="/pages/${c.id}">${c.title}</a></li>`)}</ul>`) : ''}
              <p class="muted">Updated ${p.updated_at.slice(0, 16).replace('T', ' ')} · <code>page:${p.id}</code></p>`,
          };
        },
      },
      {
        method: 'POST',
        path: '/pages/:id',
        handler(req, ctx) {
          updatePage.run({ page: req.params.id, title: req.form.get('title') ?? undefined, body: req.form.get('body') ?? undefined }, ctx);
          return { kind: 'redirect', to: `/pages/${req.params.id}` };
        },
      },
      {
        method: 'POST',
        path: '/pages/:id/archive',
        handler(req, ctx) {
          updatePage.run({ page: req.params.id, archived: true }, ctx);
          return { kind: 'redirect', to: '/tasks' };
        },
      },
    ],
  },
};
