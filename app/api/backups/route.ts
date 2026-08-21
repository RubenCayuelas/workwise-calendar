/**
 * GET -> { directory, backups: [{ name, date, time, bytes }] }   newest first
 *
 * Only the copies the app took itself. A file saved by hand into the same folder is deliberately
 * absent: the list says which copies the rotation manages, and mixing the two would make that
 * unreadable. Restoring one of those goes through `POST /api/backups/restore` with the file.
 */

import { route } from '@/src/lib/api';
import { listBackups } from '@/src/lib/operations/backups';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => listBackups());
}
