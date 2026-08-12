/**
 * The five ways a drop can end, and the one way it is allowed to say nothing.
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
    landed: { date: '2026-08-13', startMinutes: 10 * 60, handPlaced: false },
    merged: false,
    visibleDates: WEEK,
    ...overrides,
  };
}

describe('describeDrop', () => {
  it('says nothing when the row is sitting where it was released', () => {
    // The calendar IS the answer here; a toast would be narration.
    expect(describeDrop(input())).toBeNull();
  });

  it('announces the pin, which is a new state rather than a movement', () => {
    // Friday's own defect: the drop now sticks, and the only visible difference is that
    // the row stopped obeying the engine — so it has to be said, with its undo.
    expect(
      describeDrop(
        input({
          to: { date: '2026-08-14', startMinutes: 10 * 60 },
          landed: { date: '2026-08-14', startMinutes: 10 * 60, handPlaced: true },
        }),
      ),
    ).toEqual({ kind: 'pinned', date: '2026-08-14' });
  });

  it('names the week the hours carried on into', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-24', startMinutes: 8 * 60, handPlaced: false } }),
      ),
    ).toEqual({ kind: 'leftWeek', date: '2026-08-24' });
  });

  it('admits it when the reflow put the row back where it started', () => {
    // The silent no-op in its general form: the rank changed, the layout did not.
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-12', startMinutes: 8 * 60, handPlaced: false } }),
      ),
    ).toEqual({ kind: 'unchanged', date: '2026-08-12' });
  });

  it('explains a row that settled well away from the drop point', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-13', startMinutes: 15 * 60 + 30, handPlaced: false } }),
      ),
    ).toEqual({ kind: 'settled', date: '2026-08-13' });
  });

  it('lets a short settle pass in silence: a drop is a rank, and the slide shows it', () => {
    expect(
      describeDrop(
        input({ landed: { date: '2026-08-13', startMinutes: 10 * 60 + 45, handPlaced: false } }),
      ),
    ).toBeNull();
  });

  it('says the hours were absorbed when the row id is gone', () => {
    expect(describeDrop(input({ landed: null }))).toEqual({ kind: 'absorbed', date: '2026-08-13' });
  });

  it('leaves an overlap merge to the notice that already reports it', () => {
    expect(describeDrop(input({ landed: null, merged: true }))).toBeNull();
  });
});
