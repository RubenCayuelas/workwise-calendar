/**
 * Closing a day early: the gap the action pre-fills, and what it says will happen.
 *
 * The numbers are the workshop's default split shift — 08:00-14:00 and 15:30-19:30 —
 * because that is the day every one of these sentences is read against.
 */

import { describe, expect, it } from 'vitest';
import { dayEndMinutes, planCloseDay, type CloseDayBlock, type CloseDayInput } from './closeDay';

const MORNING = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

function day(overrides: Partial<CloseDayInput> = {}): CloseDayInput {
  return {
    date: '2026-08-12',
    periods: [MORNING, AFTERNOON],
    blocks: [],
    gaps: [],
    ...overrides,
  };
}

function block(overrides: Partial<CloseDayBlock> = {}): CloseDayBlock {
  return {
    id: 'b1',
    projectId: 'p1',
    name: 'Puerta',
    startMinutes: 8 * 60,
    durationMinutes: 120,
    locked: false,
    ...overrides,
  };
}

describe('dayEndMinutes', () => {
  it('is the end of the last enabled period', () => {
    expect(dayEndMinutes([MORNING, AFTERNOON])).toBe(19 * 60 + 30);
    expect(dayEndMinutes([MORNING])).toBe(14 * 60);
  });

  it('is undefined on a day with no periods', () => {
    expect(dayEndMinutes([])).toBeUndefined();
  });
});

describe('planCloseDay', () => {
  it('runs from the chosen moment to the end of the last period, in TWO rows', () => {
    const plan = planCloseDay(day(), 10 * 60);
    expect(plan).not.toBeNull();
    expect(plan?.startMinutes).toBe(10 * 60);
    expect(plan?.endMinutes).toBe(19 * 60 + 30);
    // NET working minutes, not wall clock: 4 h of morning left plus the whole 4 h afternoon. The
    // comida is not closed because nothing was open in it.
    expect(plan?.durationMinutes).toBe(480);
    expect(plan?.workingMinutes).toBe(480);
    // And the gap it proposes is the two rows a gap of those hours is stored as.
    expect(plan?.rows).toEqual([
      { startMinutes: 10 * 60, durationMinutes: 240 },
      { startMinutes: 15 * 60 + 30, durationMinutes: 240 },
    ]);
  });

  it('ends at the morning when the afternoon is switched off', () => {
    const plan = planCloseDay(day({ periods: [MORNING] }), 10 * 60);
    expect(plan?.endMinutes).toBe(14 * 60);
    expect(plan?.durationMinutes).toBe(240);
    expect(plan?.workingMinutes).toBe(240);
    expect(plan?.rows).toEqual([{ startMinutes: 10 * 60, durationMinutes: 240 }]);
  });

  it('counts only the afternoon for a moment inside the lunch break', () => {
    const plan = planCloseDay(day(), 14 * 60 + 30);
    expect(plan?.workingMinutes).toBe(240);
    expect(plan?.durationMinutes).toBe(240);
    // One row, and it starts where the shop can work again — never inside the comida.
    expect(plan?.rows).toEqual([{ startMinutes: 15 * 60 + 30, durationMinutes: 240 }]);
  });

  it('clamps a moment before the shift up to the start of the day', () => {
    const plan = planCloseDay(day(), 7 * 60);
    expect(plan?.startMinutes).toBe(8 * 60);
    expect(plan?.workingMinutes).toBe(600);
  });

  it('refuses a moment at or after the end of the day', () => {
    expect(planCloseDay(day(), 19 * 60 + 30)).toBeNull();
    expect(planCloseDay(day(), 20 * 60)).toBeNull();
  });

  it('refuses a day with no working periods at all', () => {
    expect(planCloseDay(day({ periods: [] }), 10 * 60)).toBeNull();
  });

  it('does not count time an existing gap already holds', () => {
    const plan = planCloseDay(day({ gaps: [{ startMinutes: 17 * 60, durationMinutes: 150 }] }), 10 * 60);
    // The 17:00 gap already covers the last 2.5 h of the afternoon.
    expect(plan?.workingMinutes).toBe(480 - 150);
  });

  it('counts two overlapping gaps once', () => {
    const plan = planCloseDay(
      day({
        gaps: [
          { startMinutes: 16 * 60, durationMinutes: 120 },
          { startMinutes: 17 * 60, durationMinutes: 120 },
        ],
      }),
      16 * 60,
    );
    // 16:00-19:30 is 3.5 h and the two gaps cover 16:00-19:00 between them.
    expect(plan?.workingMinutes).toBe(30);
  });

  it('reports nothing left to close when the rest of the day is already a gap', () => {
    const plan = planCloseDay(day({ gaps: [{ startMinutes: 10 * 60, durationMinutes: 570 }] }), 10 * 60);
    expect(plan?.workingMinutes).toBe(0);
  });

  it('lists the jobs whose hours are inside the stretch, in clock order', () => {
    const plan = planCloseDay(
      day({
        blocks: [
          block({ id: 'a', projectId: 'p2', name: 'Barandilla', startMinutes: 12 * 60, durationMinutes: 120 }),
          block({ id: 'b', projectId: 'p1', name: 'Puerta', startMinutes: 15 * 60 + 30, durationMinutes: 120 }),
        ],
      }),
      13 * 60,
    );
    expect(plan?.displaced).toEqual([
      { projectId: 'p2', name: 'Barandilla', minutes: 60 },
      { projectId: 'p1', name: 'Puerta', minutes: 120 },
    ]);
  });

  it('adds up the two halves of a job split around lunch', () => {
    const plan = planCloseDay(
      day({
        blocks: [
          block({ id: 'a', startMinutes: 13 * 60, durationMinutes: 60 }),
          block({ id: 'b', startMinutes: 15 * 60 + 30, durationMinutes: 120 }),
        ],
      }),
      13 * 60,
    );
    expect(plan?.displaced).toEqual([{ projectId: 'p1', name: 'Puerta', minutes: 180 }]);
  });

  it('ignores work that ends exactly at the moment the day closes', () => {
    const plan = planCloseDay(
      day({ blocks: [block({ startMinutes: 8 * 60, durationMinutes: 120 })] }),
      10 * 60,
    );
    expect(plan?.displaced).toEqual([]);
    expect(plan?.locked).toEqual([]);
  });

  it('lists a locked row as a conflict rather than as displaced work', () => {
    const plan = planCloseDay(
      day({ blocks: [block({ startMinutes: 16 * 60, durationMinutes: 120, locked: true })] }),
      10 * 60,
    );
    expect(plan?.displaced).toEqual([]);
    expect(plan?.locked).toEqual([
      {
        blockId: 'b1',
        projectId: 'p1',
        name: 'Puerta',
        startMinutes: 16 * 60,
        durationMinutes: 120,
      },
    ]);
  });
});
