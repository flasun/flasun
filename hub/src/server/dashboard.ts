import { ZodError } from 'zod';
import { html, type SafeHtml } from '../core/html.ts';
import type { DashRequest, DashResponse, DashRoute, HubContext } from '../core/types.ts';
import { UserError } from '../core/types.ts';
import { recentActivity } from '../core/context.ts';
import { badge, due, empty, linkTo, refLink, section } from '../core/ui.ts';
import { agenda } from '../modules/hub.ts';
import { CSS } from './style.ts';

export { CSS };

export function layout(ctx: HubContext, title: string, body: SafeHtml, q = ''): string {
  const nav = ctx.modules.flatMap((m) => (m.dashboard ? [m.dashboard.nav] : []));
  return `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Hub</title><link rel="stylesheet" href="/static/app.css"></head>
<body><header class="top"><a class="brand" href="/">Hub</a><nav>${nav.map((n) => html`<a href="${n.href}">${n.label}</a>`)}</nav>
<form action="/search" method="get" class="search"><input type="search" name="q" value="${q}" placeholder="Search everything" aria-label="Search"></form></header>
<main>${body}</main></body></html>`.value}`;
}

const AGENDA_TONE = { overdue: 'bad', due: 'warn', review: 'info', stale: 'neutral' } as const;

function home(ctx: HubContext): DashResponse {
  const a = agenda(ctx, 7);
  const cards = ctx.modules.flatMap((m) => (m.dashboard ? [m.dashboard.card(ctx)] : []));
  const recent = recentActivity(ctx, 25);
  return {
    kind: 'page',
    title: 'Today',
    body: html`
      <div class="head"><h1>${new Date(`${a.today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h1></div>
      <div class="cards">${cards}</div>
      <div class="cols">
        <div>${section(`Agenda · next 7 days (${a.items.length})`, a.items.length === 0 ? empty('Nothing due. Clear runway.') : html`<ul class="agenda">${a.items.map((i) => html`<li>
          ${badge(i.kind, AGENDA_TONE[i.kind])} ${linkTo(ctx, i.ref, i.title)} ${i.detail ? html`<span class="muted">${i.detail}</span>` : ''} ${due(i.date, a.today)}
          <span class="mod">${i.module}</span></li>`)}</ul>`)}</div>
        <div>${section('Recent', recent.length === 0 ? empty('No activity yet.') : html`<ul class="feed">${recent.map((r) => html`<li>
          <span class="muted">${r.at.slice(5, 16).replace('T', ' ')}</span> ${badge(r.action)} ${r.ref ? linkTo(ctx, r.ref, r.summary) : r.summary}</li>`)}</ul>`)}</div>
      </div>`,
  };
}

function search(ctx: HubContext, q: string): DashResponse {
  const hits = q ? ctx.index.query(q, { limit: 50 }) : [];
  return {
    kind: 'page',
    title: `Search: ${q}`,
    body: section(`Results for “${q}” (${hits.length})`, hits.length === 0 ? empty(q ? 'No matches.' : 'Type a query.') : html`<ul class="results">${hits.map((h) => html`<li>
      ${badge(h.module, 'info')} ${refLink(ctx, h.ref)}<div class="muted">${h.snippet}</div></li>`)}</ul>`),
  };
}

interface Compiled {
  route: DashRoute;
  re: RegExp;
  keys: string[];
}

export function compileRoutes(ctx: HubContext): Compiled[] {
  const core: DashRoute[] = [
    { method: 'GET', path: '/', handler: (_r, c) => home(c) },
    { method: 'GET', path: '/search', handler: (r, c) => search(c, (r.query.get('q') ?? '').slice(0, 200)) },
  ];
  const all = [...core, ...ctx.modules.flatMap((m) => m.dashboard?.routes ?? [])];
  return all.map((route) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${route.path.replace(/\/:([a-z_]+)/gi, (_m, k: string) => {
        keys.push(k);
        return '/([^/]+)';
      })}/?$`,
    );
    return { route, re, keys };
  });
}

export function dispatch(
  ctx: HubContext,
  routes: Compiled[],
  method: 'GET' | 'POST',
  pathname: string,
  query: URLSearchParams,
  form: URLSearchParams,
): { status: number; html?: string; redirect?: string } {
  for (const { route, re, keys } of routes) {
    if (route.method !== method) continue;
    const m = re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? '');
    });
    const req: DashRequest = { method, params, query, form };
    try {
      const res = route.handler(req, ctx);
      return res.kind === 'redirect' ? { status: 303, redirect: res.to } : { status: 200, html: layout(ctx, res.title, res.body, query.get('q') ?? '') };
    } catch (err) {
      const msg =
        err instanceof UserError ? err.message
        : err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : null;
      if (msg === null) console.error('[hub] dashboard error', err);
      return {
        status: msg === null ? 500 : 400,
        html: layout(ctx, 'Error', section(msg === null ? 'Something broke' : 'Can’t do that', html`<p>${msg ?? 'Internal error — see server log.'}</p><p><a href="/">Home</a></p>`)),
      };
    }
  }
  return { status: 404, html: layout(ctx, 'Not found', section('Not found', html`<p>No page at ${pathname}.</p>`)) };
}
