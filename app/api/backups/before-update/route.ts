/**
 * POST { version } -> { created, removed }
 *
 * The way back from an update, taken while the calendar is still the one the old version wrote. The
 * desktop shell calls this and installs nothing unless it answers 200: a refusal here is a refusal to
 * update.
 *
 * `version` is the update about to install, and it becomes part of a filename, so anything that is
 * not a version is refused. The shell is the only caller — the browser never knows the app's version.
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, requireText, route } from '@/src/lib/api';
import { takePreUpdateBackup } from '@/src/lib/operations/backups';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return takePreUpdateBackup(requireText(body, 'version', { maxLength: 64 }));
  });
}
