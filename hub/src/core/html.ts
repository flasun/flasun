import { Marked, type Tokens } from 'marked';

/**
 * Everything stored here can originate from model output, and model output can
 * originate from a scraped job post or a pasted email. Treat every string as
 * hostile: the `html` tag escapes all interpolations unless explicitly wrapped
 * in SafeHtml, and Markdown is rendered with raw HTML disabled and URL schemes
 * allow-listed. The server also sends a no-inline-script CSP as a second wall.
 */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(v: HtmlValue): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#)/i;

export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_URL.test(trimmed) ? trimmed : null;
}

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (!href) return text;
      const external = /^https?:/i.test(href);
      return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer nofollow" target="_blank"' : ''}>${text}</a>`;
    },
    image(token: Tokens.Image): string {
      // No remote image loads: they are a read-receipt / exfiltration channel.
      return escapeHtml(token.text || token.href);
    },
  },
});

export function markdown(src: string): SafeHtml {
  return new SafeHtml(md.parse(src, { async: false }));
}
