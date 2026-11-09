import { z } from 'zod';
import type { Db, Migration } from './db.ts';
import type { SafeHtml } from './html.ts';

/** `kind:id`, e.g. `task:tk_3f9a2b7c`. Every entity in every module is addressable this way. */
export type Ref = `${string}:${string}`;

export interface SearchIndex {
  upsert(ref: Ref, module: string, title: string, body: string): void;
  remove(ref: Ref): void;
  query(q: string, opts?: { modules?: readonly string[]; limit?: number }): SearchHit[];
}

export interface SearchHit {
  ref: Ref;
  module: string;
  title: string;
  snippet: string;
}

export interface ActivityEntry {
  at: string;
  module: string;
  ref: Ref | null;
  action: string;
  summary: string;
}

export interface Links {
  add(from: Ref, to: Ref, relation: string): void;
  remove(from: Ref, to: Ref, relation?: string): number;
  of(ref: Ref): { ref: Ref; relation: string; direction: 'out' | 'in' }[];
}

export interface HubContext {
  readonly db: Db;
  readonly index: SearchIndex;
  readonly links: Links;
  readonly modules: readonly HubModule[];
  now(): Date;
  /** Local calendar date, YYYY-MM-DD. */
  today(): string;
  log(module: string, ref: Ref | null, action: string, summary: string): void;
  module<T extends HubModule>(id: string): T | undefined;
}

// ---------------------------------------------------------------------------
// Tools: modules declare these; the MCP layer adapts them to the SDK.
// Keeping the SDK out of module code means handlers are unit-testable as plain
// functions and the transport can change without touching a module.
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly shape: z.ZodRawShape;
  readonly annotations: ToolAnnotations;
  run(input: unknown, ctx: HubContext): unknown;
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  handler: (args: z.output<z.ZodObject<S>>, ctx: HubContext) => unknown;
}): Tool {
  const schema = z.object(def.input).strict();
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    shape: def.input,
    annotations: def.annotations ?? {},
    run: (input, ctx) => def.handler(schema.parse(input ?? {}), ctx),
  };
}

/** Thrown for caller mistakes (unknown id, bad transition). Surfaced to the model as a tool error, not a crash. */
export class UserError extends Error {
  override name = 'UserError';
}

// ---------------------------------------------------------------------------
// Cross-module surfaces
// ---------------------------------------------------------------------------

export interface AgendaItem {
  module: string;
  ref: Ref;
  title: string;
  /** YYYY-MM-DD the item is due or became stale. */
  date: string;
  kind: 'due' | 'overdue' | 'stale' | 'review';
  detail?: string;
}

export interface ResolvedRef {
  title: string;
  href: string;
}

/** A block another module contributes to a project's overview (tasks, pages, applications…). */
export interface ProjectSection {
  title: string;
  items: { ref: Ref; title: string; meta?: string }[];
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashRequest {
  method: 'GET' | 'POST';
  params: Record<string, string>;
  query: URLSearchParams;
  form: URLSearchParams;
}

export type DashResponse =
  | { kind: 'page'; title: string; body: SafeHtml }
  | { kind: 'redirect'; to: string };

export interface DashRoute {
  method: 'GET' | 'POST';
  /** `/jobs/:id` style; params land in `req.params`. */
  path: string;
  handler(req: DashRequest, ctx: HubContext): DashResponse;
}

export interface HubModule {
  readonly id: string;
  readonly title: string;
  /** One paragraph; goes into the MCP server instructions. */
  readonly description: string;
  readonly dependsOn?: readonly string[];
  /** Ref kinds this module owns, e.g. ['task', 'page']. */
  readonly kinds: readonly string[];
  readonly migrations: readonly Migration[];
  readonly tools: readonly Tool[];
  resolve?(ref: Ref, ctx: HubContext): ResolvedRef | null;
  agenda?(ctx: HubContext, horizon: string): AgendaItem[];
  projectSections?(ctx: HubContext, projectId: string): ProjectSection[];
  /** Rebuild this module's search rows from its tables. */
  reindex?(ctx: HubContext): number;
  readonly dashboard?: {
    nav: { label: string; href: string };
    card(ctx: HubContext): SafeHtml;
    routes: readonly DashRoute[];
  };
}
