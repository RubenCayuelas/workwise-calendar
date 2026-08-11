/**
 * `created_at` / `updated_at` values produced by the app rather than by SQLite.
 *
 * Almost every row lets `DEFAULT CURRENT_TIMESTAMP` and the `updated_at` triggers
 * do this. The exception is a row that exists only in memory for the length of one
 * recomposition: the LIFO edit transforms invent a `Block` before any INSERT has
 * happened (`HoursChange.now`), and the engine's queue order tie-breaks on
 * `createdAt` before `id`. Comparing that invented value against stored ones is
 * only meaningful if both are written the same way.
 *
 * So this deliberately matches SQLite's `CURRENT_TIMESTAMP` exactly:
 * `YYYY-MM-DD HH:MM:SS`, in UTC. It is a bookkeeping timestamp and NEVER a
 * calendar day — a shop day is a local `YYYY-MM-DD` from src/lib/dates.ts, because
 * anything saved after 22:00 Madrid time would fall on the wrong UTC day.
 */
export function nowTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace('T', ' ');
}
