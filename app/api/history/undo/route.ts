/**
 * POST -> { changed, step, focusDate, drifted, summary }
 *
 * Walks the undo line back one step and restores that state. Nothing to undo is `changed: false`,
 * not a refusal. The line itself lives in the database and lasts one run of the app.
 */

import { route } from '@/src/lib/api';
import { undoChange } from '@/src/lib/operations/history';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return route(() => undoChange());
}
