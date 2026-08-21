/**
 * POST -> { changed, step, focusDate, drifted, summary }
 *
 * Walks the undo line forward one step. The tail is dropped by the next mutation, so a redo is
 * only ever available directly after an undo.
 */

import { route } from '@/src/lib/api';
import { redoChange } from '@/src/lib/operations/history';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return route(() => redoChange());
}
