#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db } from './core/db.ts';
import { createContext, resolveModules } from './core/context.ts';
import { ALL_MODULES } from './modules/index.ts';
import { buildMcpServer } from './server/mcp.ts';
import { createHubServer } from './server/http.ts';
import { importMarkdown } from './importer.ts';
import type { HubContext } from './core/types.ts';

const USAGE = `hub — personal MCP hub + dashboard

Usage:
  hub mcp      [--modules a,b]           stdio MCP server (Claude Code / Desktop)
  hub serve    [--port 4317] [--host 127.0.0.1] [--modules a,b] [--no-mcp] [--no-dashboard]
                                         dashboard at /, Streamable HTTP MCP at /mcp
  hub import   <dir> [--project slug] [--parent "Page title"]
                                         import a Notion export / folder of Markdown
  hub modules                            list modules and their tools
  hub reindex                            rebuild the full-text index
  hub backup   <file>                    consistent snapshot of the database

Options:
  --db <path>   database file (env HUB_DB, default ~/.flasun-hub/hub.db)

Env: HUB_DB, HUB_MODULES, HUB_TOKEN (required for non-loopback --host), HUB_ALLOWED_HOSTS, HUB_PORT`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      modules: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      project: { type: 'string' },
      parent: { type: 'string' },
      'no-mcp': { type: 'boolean', default: false },
      'no-dashboard': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    console.log(USAGE);
    return;
  }

  const dbPath = resolve(values.db ?? process.env.HUB_DB ?? join(homedir(), '.flasun-hub', 'hub.db'));
  const modSpec = values.modules ?? process.env.HUB_MODULES ?? 'all';
  const modules = resolveModules(ALL_MODULES, modSpec === 'all' ? 'all' : ['hub', ...modSpec.split(',').map((s) => s.trim()).filter(Boolean)]);
  const open = (): HubContext => createContext(new Db(dbPath), modules);

  switch (cmd) {
    case 'mcp': {
      const ctx = open();
      // stdout belongs to the protocol; everything human goes to stderr.
      console.error(`[hub] stdio MCP · db ${dbPath} · modules ${modules.map((m) => m.id).join(',')}`);
      void buildMcpServer(ctx).connect(new StdioServerTransport());
      return;
    }
    case 'serve': {
      const ctx = open();
      const port = Number(values.port ?? process.env.HUB_PORT ?? 4317);
      const host = values.host ?? '127.0.0.1';
      const server = createHubServer(ctx, {
        host,
        port,
        token: process.env.HUB_TOKEN || undefined,
        allowedHosts: (process.env.HUB_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        mcp: !values['no-mcp'],
        dashboard: !values['no-dashboard'],
      });
      server.listen(port, host, () => {
        console.error(`[hub] http://${host === '::1' ? '[::1]' : host}:${port}/  ·  MCP at /mcp  ·  db ${dbPath}`);
      });
      const stop = () => server.close(() => {
        ctx.db.close();
        process.exit(0);
      });
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'import': {
      const dir = rest[0];
      if (!dir || !existsSync(dir)) throw new Error('Usage: hub import <dir>');
      const ctx = open();
      const r = importMarkdown(ctx, resolve(dir), { project: values.project, parent: values.parent });
      console.log(`Imported ${r.pages} pages.`);
      if (r.csv.length) console.log(`CSV databases not imported (map them to tasks/jobs/finance deliberately):\n  ${r.csv.join('\n  ')}`);
      if (r.skipped.length) console.log(`Skipped ${r.skipped.length} non-Markdown files.`);
      return;
    }
    case 'modules': {
      for (const m of modules) {
        console.log(`${m.id.padEnd(10)} ${m.title}${m.dependsOn?.length ? `  (needs ${m.dependsOn.join(', ')})` : ''}`);
        for (const t of m.tools) console.log(`  ${t.name.padEnd(20)} ${t.title}`);
      }
      console.log(`\n${modules.reduce((n, m) => n + m.tools.length, 0)} tools`);
      return;
    }
    case 'reindex': {
      const ctx = open();
      ctx.db.tx(() => {
        ctx.db.run('DELETE FROM search_index');
        const n = ctx.modules.reduce((sum, m) => sum + (m.reindex?.(ctx) ?? 0), 0);
        console.log(`Reindexed ${n} entities.`);
      });
      return;
    }
    case 'backup': {
      const out = rest[0];
      if (!out) throw new Error('Usage: hub backup <file>');
      if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite.`);
      const ctx = open();
      ctx.db.raw.exec(`VACUUM INTO '${resolve(out).replace(/'/g, "''")}'`);
      console.log(`Backed up to ${resolve(out)}`);
      return;
    }
    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (err) {
  console.error(`hub: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
