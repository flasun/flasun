import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { HubContext } from './core/types.ts';

/**
 * Import a directory of Markdown — a Notion "Markdown & CSV" export, an
 * Obsidian vault, or plain notes. Folders become parent pages; Notion's
 * 32-hex id suffixes are stripped; a leading `# Title` becomes the page title.
 * CSV database exports are reported, not imported: their columns map to real
 * modules (tasks, jobs, transactions), which deserves a deliberate mapping.
 */

const NOTION_ID = /\s+[0-9a-f]{32}$/i;
const MAX_FILE = 5 * 1024 * 1024;

export interface ImportReport {
  pages: number;
  skipped: string[];
  csv: string[];
}

function clean(name: string): string {
  return name.replace(NOTION_ID, '').trim() || 'Untitled';
}

function call(ctx: HubContext, tool: string, args: unknown): unknown {
  for (const m of ctx.modules) {
    const t = m.tools.find((x) => x.name === tool);
    if (t) return t.run(args, ctx);
  }
  throw new Error(`Tool ${tool} not enabled; include the workspace module.`);
}

export function importMarkdown(ctx: HubContext, root: string, opts: { project?: string; parent?: string } = {}): ImportReport {
  const report: ImportReport = { pages: 0, skipped: [], csv: [] };

  const createPage = (title: string, body: string, parent: string | undefined): string => {
    const res = call(ctx, 'ws_page_create', { title: title.slice(0, 200), body, parent, project: opts.project, tags: ['imported'] }) as { id: string };
    report.pages++;
    return res.id;
  };

  const walk = (dir: string, parentId: string | undefined): void => {
    const entries = readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
    const pageIdByStem = new Map<string, string>();

    for (const name of entries.filter((n) => extname(n).toLowerCase() === '.md')) {
      const path = join(dir, name);
      if (statSync(path).size > MAX_FILE) {
        report.skipped.push(`${path} (over 5 MB)`);
        continue;
      }
      let body = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      let title = clean(basename(name, extname(name)));
      const h1 = /^#\s+(.+)\n+/.exec(body);
      if (h1?.[1]) {
        title = h1[1].trim();
        body = body.slice(h1[0].length);
      }
      pageIdByStem.set(basename(name, extname(name)), createPage(title, body, parentId));
    }

    for (const name of entries) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        // Notion puts a page's children in a sibling folder with the same stem.
        const owner = pageIdByStem.get(name) ?? createPage(clean(name), '', parentId);
        walk(path, owner);
      } else if (extname(name).toLowerCase() === '.csv') {
        report.csv.push(path);
      } else if (extname(name).toLowerCase() !== '.md') {
        report.skipped.push(path);
      }
    }
  };

  ctx.db.tx(() => walk(root, opts.parent));
  return report;
}
