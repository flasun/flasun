import { html, type HtmlValue, type SafeHtml } from './html.ts';
import type { HubContext, Ref } from './types.ts';
import { resolveRef } from './context.ts';

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function badge(label: string, tone: Tone = 'neutral'): SafeHtml {
  return html`<span class="badge ${tone}">${label}</span>`;
}

export function due(date: string | null | undefined, today: string): SafeHtml {
  if (!date) return html``;
  const tone: Tone = date < today ? 'bad' : date === today ? 'warn' : 'neutral';
  return html`<span class="due ${tone}">${date === today ? 'today' : date}</span>`;
}

export function refLink(ctx: HubContext, r: Ref): SafeHtml {
  const res = resolveRef(ctx, r);
  return res ? html`<a href="${res.href}">${res.title}</a>` : html`<span class="muted">${r}</span>`;
}

/** Link to an entity's page with caller-supplied text (falls back to plain text if it no longer exists). */
export function linkTo(ctx: HubContext, r: Ref, text: string): SafeHtml {
  const res = resolveRef(ctx, r);
  return res ? html`<a href="${res.href}">${text}</a>` : html`<span>${text}</span>`;
}

export function section(title: string, body: HtmlValue, aside?: HtmlValue): SafeHtml {
  return html`<section class="panel"><header><h2>${title}</h2>${aside ?? ''}</header>${body}</section>`;
}

export function empty(text: string): SafeHtml {
  return html`<p class="empty">${text}</p>`;
}

export function card(title: string, href: string, stats: readonly [string, string | number][], body?: HtmlValue): SafeHtml {
  return html`<a class="card" href="${href}">
    <h3>${title}</h3>
    <dl>${stats.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    ${body ?? ''}
  </a>`;
}

export function options(values: readonly string[], selected?: string | null): SafeHtml {
  return html`${values.map((v) => html`<option value="${v}" ${v === selected ? html`selected` : ''}>${v}</option>`)}`;
}

/** Inline POST button; forms are the only mutation path (no JS, CSP forbids inline script). */
export function postButton(action: string, label: string, fields: Record<string, string> = {}, cls = ''): SafeHtml {
  return html`<form method="post" action="${action}" class="inline">
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="${cls}">${label}</button>
  </form>`;
}
