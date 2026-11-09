import type { HubModule } from '../core/types.ts';
import { hub } from './hub.ts';
import { projects } from './projects/index.ts';
import { workspace } from './workspace/index.ts';
import { jobs } from './jobs/index.ts';
import { finance } from './finance/index.ts';

/**
 * Registry. To add a domain (a project-specific integration, health, reading
 * list…), write a HubModule under ./<id>/ and add it here. It gets the shared
 * DB, search, links, agenda and a dashboard slot for free, and can run in the
 * combined server or on its own with `--modules <id>`.
 */
export const ALL_MODULES: readonly HubModule[] = [hub, projects, workspace, jobs, finance];
