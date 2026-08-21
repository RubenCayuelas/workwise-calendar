/**
 * POST -> { created, removed, skipped? }
 *
 * Called once when the app is opened. Elapsed time and not a schedule: nothing runs while the app is
 * closed, so three weeks away owes ONE copy. `created` is null with `skipped` saying why — the
 * setting is off, or the newest copy is not old enough yet.
 */

import { route } from '@/src/lib/api';
import { takeAutomaticBackup } from '@/src/lib/operations/backups';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return route(() => takeAutomaticBackup());
}
