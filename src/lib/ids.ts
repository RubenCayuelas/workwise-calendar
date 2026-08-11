import { randomUUID } from 'crypto';

/**
 * Primary keys for projects, blocks and gaps.
 *
 * A UUID rather than an autoincrement, because the composition engine hands back
 * rows it has not written yet: `compose` reuses the ids of the blocks an item was
 * built from and leaves `null` where the caller must INSERT, and the LIFO edit
 * transforms need an id for a row they invent (`HoursChange.newBlockId`) before
 * any transaction has started. Generating the id in the app keeps both cases the
 * same shape as an ordinary row.
 *
 * The engine's queue order tie-breaks on `created_at` first and only then on `id`
 * (see `sortedByQueueRank`), so an unsortable id costs nothing.
 */
export function newId(): string {
  return randomUUID();
}
