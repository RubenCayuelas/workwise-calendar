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
    // The visible difference is a padlock the owner did not press, so it is said.
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
    // The row is exactly where it was released, so only a NEW padlock is news.
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
    // The padlock is the one that is new STATE, and its sentence names the day too.
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

  // `landed` is only the first row, so nothing else in this file could name both days.
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

  // `changed` is asked of the ROWS, so a pass that folded a run into one row and laid it
  // out again reports `false` even though every id in sight is new.
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
