/**
 * Loading every block on the calendar, for the Settings screen's warning.
 *
 * There is no endpoint that returns all blocks in one call — `/api/week` is one week at
 * a time and the horizon can be many weeks — but `/api/projects/:id` returns every block
 * of a job, so the jobs plus their details cover the whole calendar exactly.
 *
 * That is `1 + jobs` requests, which is why it is called ONLY when a change is about to
 * remove working time (see `needsBlockCheck`). A single-user workshop has a handful of
 * open jobs, and the alternative — walking the horizon week by week — is both more
 * requests and still not provably complete.
 */

import { getProject, listProjects, type RequestOptions } from '../../lib/api-client';
import type { ScheduledBlock } from './warnings';

export async function loadScheduledBlocks(options?: RequestOptions): Promise<ScheduledBlock[]> {
  const projects = await listProjects(options);
  const details = await Promise.all(projects.map((project) => getProject(project.id, options)));

  return details.flatMap((detail) =>
    detail.blocks.map((block) => ({ block, projectName: detail.project.name })),
  );
}
