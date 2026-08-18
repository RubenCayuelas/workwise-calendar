/**
 * The eight ways a drop can end, and the one way it is allowed to say nothing.
 *
 * The rule these pin down is the owner's complaint, generalised: a drag that produces no
 * visible change must never be indistinguishable from a drag the app ignored. Friday was
 * the case that actually shipped (200, nothing moved, no message); the others — the row
 * settling back where it started, the hours carrying on into another week, a row of the
 * same job absorbing it — have exactly the same shape on screen.
 */

import { describe, expect, it } from 'vitest';
import { describeDrop, type DropOutcomeInput } from './dropOutcome';

const WEEK = [
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
  '2026-08-15',
  '2026-08-16',
];

function input(overrides: Partial<DropOutcomeInput> = {}): DropOutcomeInput {
  return {
    from: { date: '2026-08-12', startMinutes: 8 * 60 },
    to: { date: '2026-08-13', startMinutes: 10 * 60 },
    landed: { date: '2026-08-13', startMinutes: 10 * 60, locked: false },
    merged: false,
    wasLocked: false,
    // The ordinary case: the server wrote something, and the hours all landed on one day.
    changed: true,
    placed: [{ date: '2026-08-13', minutes: 4 * 60 }],
    visibleDates: WEEK,
    ...overrides,
  };
}

describe('describeDrop', () => {
  it('says nothing when the row is sitting where it was released', () => {
    // The calendar IS the answer here; a toast would be narration.
    expect(describeDrop(input())).toBeNull();
  });

  it('announces the padlock the drop added, which is a new state rather than a movement', () => {
    // Friday's own defect: the drop now sticks, and the visible difference is a padlock
    // the owner did not press — so it has to be said, with its undo.
    expect(
      describeDrop(
        input({
          to: { date: '2026-08-14', startMinutes: 10 * 60 },
          landed: { date: '2026-08-14', startMinutes: 10 * 60, locked: true },
        }),
      ),
    ).toEqual({ kind: 'pinned', date: '2026-08-14' });
  });

  it('says nothing about a padlock the row already had', () => {
    // Dragging a padlocked row keeps it exactly where it was released, which is what the
    // owner asked for and already knows. Only a NEW padlock is news.
    expect(
      describeDrop(
        input({
          to: { date: '2026-08-14', startMinutes: 10 * 60 },
          landed: { date: '2026-08-14', startMinutes: 10 * 60, locked: true },
          wasLocked: true,
        }),
      ),
    ).toBeNull();
  });

  it('names the week the hours carried on into', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-24', startMinutes: 8 * 60, locked: false } }),
      ),
    ).toEqual({ kind: 'leftWeek', date: '2026-08-24' });
  });

  /*
   * THE OTHER SIDE OF THE SAME WEEK, and not the same sentence. Measured in the browser
   * on 2026-08-17: a 10 h run dragged from Monday 17 August into the week of 7 September
   * and released on the Wednesday came back on Wednesday 19 AUGUST — the drop is a rank,
   * and its contiguous place is behind the work that is already there. `leftWeek`'s words
   * ("no longer fitted this week: its hours carry on") describe the opposite journey.
   */
  it('tells a row the queue laid out EARLIER apart from one that overflowed', () => {
    expect(
      describeDrop(
        input({
          // The drag started on 17 August and paged: the week on screen is September's.
          from: { date: '2026-08-17', startMinutes: 8 * 60 },
          to: { date: '2026-09-09', startMinutes: 10 * 60 },
          landed: { date: '2026-08-19', startMinutes: 8 * 60, locked: false },
          visibleDates: [
            '2026-09-07',
            '2026-09-08',
            '2026-09-09',
            '2026-09-10',
            '2026-09-11',
            '2026-09-12',
            '2026-09-13',
          ],
        }),
      ),
    ).toEqual({ kind: 'pulledBack', date: '2026-08-19' });
  });

  it('admits it when the reflow put the row back where it started', () => {
    // The silent no-op in its general form: the rank changed, the layout did not.
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-12', startMinutes: 8 * 60, locked: false } }),
      ),
    ).toEqual({ kind: 'unchanged', date: '2026-08-12' });
  });

  it('explains a row that settled well away from the drop point', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-13', startMinutes: 15 * 60 + 30, locked: false } }),
      ),
    ).toEqual({ kind: 'settled', date: '2026-08-13' });
  });

  it('lets a short settle pass in silence: a drop is a rank, and the slide shows it', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-13', startMinutes: 10 * 60 + 45, locked: false } }),
      ),
    ).toBeNull();
  });

  /*
   * EDGE PAGING: the block was picked up in one week and released in another, so the week
   * on screen is not the week the drag started in. The row is exactly where it was
   * released — every other branch would therefore be silent — and the thing the owner
   * cannot see for themselves is which week they are now looking at.
   */
  it('names the week when the drag paged into it', () => {
    expect(
      describeDrop(
        input({
          from: { date: '2026-08-05', startMinutes: 8 * 60 },
          to: { date: '2026-08-13', startMinutes: 10 * 60 },
          landed: { date: '2026-08-13', startMinutes: 10 * 60, locked: false },
        }),
      ),
    ).toEqual({ kind: 'movedWeek', date: '2026-08-13' });
  });

  it('still leads with the padlock when a paged drop landed on the weekend', () => {
    // Two true things; the padlock is the one that is new STATE, and its sentence names
    // the day it fixed the row to, which says the week as plainly as the other would.
    expect(
      describeDrop(
        input({
          from: { date: '2026-08-05', startMinutes: 8 * 60 },
          to: { date: '2026-08-15', startMinutes: 10 * 60 },
          landed: { date: '2026-08-15', startMinutes: 10 * 60, locked: true },
        }),
      ),
    ).toEqual({ kind: 'pinned', date: '2026-08-15' });
  });

  it('still reports hours that left the week even when the drag paged into it', () => {
    expect(
      describeDrop(
        input({
          from: { date: '2026-08-05', startMinutes: 8 * 60 },
          landed: { date: '2026-08-24', startMinutes: 8 * 60, locked: false },
        }),
      ),
    ).toEqual({ kind: 'leftWeek', date: '2026-08-24' });
  });

  /*
   * FILL AND OVERFLOW, the outcome the owner's own report produced. Their words: «Si quiero
   * colocar la tarea test3 en el hueco del lunes no se divide sino que dice que no cabe.»
   * It divides now, and the sentence has to name both days — `landed` is only the first row,
   * so nothing else in this file could have told them.
   */
  it('names every day the hours ended up on when they filled and carried on', () => {
    expect(
      describeDrop(
        input({
          to: { date: '2026-08-12', startMinutes: 15 * 60 + 30 },
          landed: { date: '2026-08-12', startMinutes: 15 * 60 + 30, locked: false },
          placed: [
            { date: '2026-08-12', minutes: 4 * 60 },
            { date: '2026-08-13', minutes: 2 * 60 },
          ],
        }),
      ),
    ).toEqual({ kind: 'filled', date: '2026-08-12' });
  });

  it('counts a stretch cut at the comida as ONE day, not as an overflow', () => {
    // Two rows, one day: nothing carried anywhere, so the calendar is the answer.
    expect(
      describeDrop(
        input({
          landed: { date: '2026-08-13', startMinutes: 10 * 60, locked: false },
          placed: [{ date: '2026-08-13', minutes: 6 * 60 }],
        }),
      ),
    ).toBeNull();
  });

  it('leads with the division even when the tail left the week', () => {
    // `leftWeek` reads the dragged ROW; the division names all of it, which is more.
    expect(
      describeDrop(
        input({
          placed: [
            { date: '2026-08-13', minutes: 4 * 60 },
            { date: '2026-08-24', minutes: 2 * 60 },
          ],
        }),
      ),
    ).toEqual({ kind: 'filled', date: '2026-08-13' });
  });

  /*
   * THE SERVER SAYS IT, THE CLIENT DOES NOT INFER IT. `changed` is asked of the ROWS, so a
   * pass that folded a run into one row and laid it out again reports `false` even though
   * every id in sight is new — and a drop the reflow answered with the calendar the owner
   * already had is exactly the silence this whole round came from.
   */
  it('admits a drop the server wrote nothing for, whatever the ids did', () => {
    expect(
      describeDrop(
        input({
          changed: false,
          landed: { date: '2026-08-13', startMinutes: 15 * 60 + 30, locked: false },
          placed: [
            { date: '2026-08-13', minutes: 4 * 60 },
            { date: '2026-08-14', minutes: 2 * 60 },
          ],
        }),
      ),
    ).toEqual({ kind: 'unchanged', date: '2026-08-13' });
  });

  it('says the hours were absorbed when the row id is gone', () => {
    expect(describeDrop(input({ landed: null }))).toEqual({ kind: 'absorbed', date: '2026-08-13' });
  });

  it('leaves an overlap merge to the notice that already reports it', () => {
    expect(describeDrop(input({ landed: null, merged: true }))).toBeNull();
  });
});
