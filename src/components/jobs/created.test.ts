// The form closes on the write, so these sentences are all that is left of it. The dates are the
// wireframe's own week: 2026-08-14 is the Friday buffer, 2026-08-17 next week's Monday.

import { describe, expect, it } from 'vitest';
import { announceCreation } from './created';
import { describePlacement } from './placement';
import type { CreationOutcome } from '../../lib/api-client';
import type { Block } from '../../types';
import { FRI, MON, NEXT_MON, TUE } from '../../testing/fixtures';

function block(overrides: Partial<Block> & { id: string }): Block {
  return {
    projectId: 'job-1',
    date: MON,
    startMinutes: 8 * 60,
    durationMinutes: 120,
    locked: false,
    createdAt: '2026-08-01 09:00:00',
    updatedAt: '2026-08-01 09:00:00',
    ...overrides,
  };
}

function creation(overrides: Partial<CreationOutcome> = {}): CreationOutcome {
  return {
    startDate: MON,
    day: 'auto',
    mode: 'queue',
    autoLock: false,
    dayLock: false,
    deferred: false,
    startsOn: MON,
    endsOn: MON,
    ...overrides,
  };
}

/** A job created inside the week on screen, with no date of its own. */
const plain = describePlacement([], [block({ id: 'a', date: MON }), block({ id: 'b', date: TUE })], MON);

describe('announceCreation', () => {
  it('names the rows the hours were born as', () => {
    expect(announceCreation(plain).rows.map((row) => row.block.id)).toEqual(['a', 'b']);
  });

  it('confirms an ordinary creation and says nothing else', () => {
    expect(announceCreation(plain)).toMatchObject({ tone: 'success', hints: [] });
  });

  it('warns, and explains the buffer, when the hours reached Friday', () => {
    const outcome = describePlacement([], [block({ id: 'a', date: FRI })], MON);

    expect(announceCreation(outcome)).toMatchObject({
      tone: 'warning',
      hints: ['day.bufferHint'],
    });
  });

  it('warns when the hours landed in a later week, without a sentence of its own', () => {
    const outcome = describePlacement([], [block({ id: 'a', date: NEXT_MON })], MON);

    expect(announceCreation(outcome)).toMatchObject({ tone: 'warning', hints: [] });
  });

  it('explains a whole job padlocked by its date', () => {
    expect(announceCreation(plain, creation({ autoLock: true })).hints).toEqual([
      'jobForm.createdLocked',
    ]);
  });

  it('explains a padlock the chosen DAY left behind', () => {
    expect(announceCreation(plain, creation({ dayLock: true })).hints).toEqual([
      'jobForm.createdDayLocked',
    ]);
  });

  it('says the padlock once when the date locked the job AND the day', () => {
    // `autoLock` already says every row is fixed; the narrower sentence would only repeat it.
    expect(announceCreation(plain, creation({ autoLock: true, dayLock: true })).hints).toEqual([
      'jobForm.createdLocked',
    ]);
  });

  it('says nothing about a padlock for a job that named no date', () => {
    expect(announceCreation(plain).hints).toEqual([]);
  });

  it('keeps the buffer sentence and the padlock sentence together, buffer first', () => {
    const outcome = describePlacement([], [block({ id: 'a', date: FRI })], MON);

    expect(announceCreation(outcome, creation({ dayLock: true })).hints).toEqual([
      'day.bufferHint',
      'jobForm.createdDayLocked',
    ]);
  });
});
