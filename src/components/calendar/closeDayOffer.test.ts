/**
 * *Cerrar el día aquí* is ONE offer with TWO doors, and these cases are what holds the two
 * shut on the same answer.
 *
 * The row's hover bar has always offered it. Since 2026-08-18 a press on the bottom edge of
 * a row the engine lays out offers it too — the edge sizes nothing there, so the refusal
 * points at what really does end a day early — and the two must not be able to propose
 * different gaps from the same row, or the toast would open a form the button never would.
 *
 * The gap itself is never written by the app. What is tested here is the PROPOSAL.
 */

import { describe, expect, it } from 'vitest';
import type { WeekBlock, WeekDay } from '../../lib/api-client';
import type { Gap, WorkPeriod } from '../../types';
import { manualWindowsOf } from '../../lib/manualWindow';
import { closeDayAfter, closeDayInputFor } from './closeDayOffer';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

function dayOf(overrides: Partial<WeekDay> = {}): WeekDay {
  return {
    date: '2026-08-19',
    weekday: 3,
    role: 'auto',
    isClosed: false,
    isWeekend: false,
    isToday: false,
    isPast: false,
    periods: [MORNING, AFTERNOON],
    manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
    capacityMinutes: 600,
    plannableMinutes: 600,
    bookedMinutes: 0,
    ...overrides,
  };
}

function blockOf(overrides: Partial<WeekBlock> = {}): WeekBlock {
  return {
    id: 'b1',
    projectId: 'p1',
    date: '2026-08-19',
    startMinutes: 8 * 60,
    durationMinutes: 4 * 60,
    locked: false,
    createdAt: '2026-08-18T08:00:00Z',
    updatedAt: '2026-08-18T08:00:00Z',
    project: { id: 'p1', name: 'Railing', color: '#c07a2b' },
    ...overrides,
  };
}

function gapOf(startMinutes: number, durationMinutes: number): Gap {
  return {
    id: `g-${startMinutes}`,
    unitId: `g-${startMinutes}`,
    date: '2026-08-19',
    startMinutes,
    durationMinutes,
    createdAt: '2026-08-18T08:00:00Z',
    updatedAt: '2026-08-18T08:00:00Z',
  };
}

describe('closeDayInputFor', () => {
  it('carries the day, its periods and every row on it, with the job names the preview needs', () => {
    const block = blockOf({ locked: true });
    const input = closeDayInputFor(dayOf(), [block], [gapOf(18 * 60, 60)]);

    expect(input).not.toBeNull();
    expect(input?.date).toBe('2026-08-19');
    expect(input?.periods).toEqual([MORNING, AFTERNOON]);
    // The name is what the form says about a displaced job, and `locked` is what makes the
    // save refusable — both have to survive the mapping.
    expect(input?.blocks).toEqual([
      {
        id: 'b1',
        projectId: 'p1',
        name: 'Railing',
        startMinutes: 8 * 60,
        durationMinutes: 4 * 60,
        locked: true,
      },
    ]);
    expect(input?.gaps).toHaveLength(1);
  });

  it('has nothing to offer on a day with no plannable hours to cap', () => {
    // Each of the three is a day the action makes no sense on: there is no auto-fill to
    // stop on a weekend or a closed day, and the past is a record rather than a plan.
    expect(closeDayInputFor(dayOf({ isWeekend: true }), [], [])).toBeNull();
    expect(closeDayInputFor(dayOf({ isClosed: true }), [], [])).toBeNull();
    expect(closeDayInputFor(dayOf({ isPast: true }), [], [])).toBeNull();
  });
});

describe('closeDayAfter', () => {
  it('proposes the gap from the END of the row, which is what the label promises', () => {
    const block = blockOf();
    const offer = closeDayAfter(closeDayInputFor(dayOf(), [block], []), block);

    // 08:00 + 4 h: the hours up to here stay today, the rest of the day stops.
    expect(offer?.fromMinutes).toBe(12 * 60);
    expect(offer?.input.date).toBe('2026-08-19');
  });

  it('reads the ROW and not the unit, so each half of a lunch-split unit offers its own moment', () => {
    const morning = blockOf({ id: 'b1', startMinutes: 10 * 60, durationMinutes: 4 * 60 });
    const afternoon = blockOf({ id: 'b2', startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 });
    const input = closeDayInputFor(dayOf(), [morning, afternoon], []);

    expect(closeDayAfter(input, morning)?.fromMinutes).toBe(14 * 60);
    expect(closeDayAfter(input, afternoon)?.fromMinutes).toBe(17 * 60 + 30);
  });

  it('offers nothing when the row already runs to the end of the day', () => {
    const block = blockOf({ startMinutes: 15 * 60 + 30, durationMinutes: 4 * 60 });
    expect(closeDayAfter(closeDayInputFor(dayOf(), [block], []), block)).toBeNull();
  });

  it('offers nothing when existing gaps already hold every minute after the row', () => {
    // The hours are already not plannable, so a second gap would take nothing away — and a
    // button that changes nothing is worse than no button.
    const block = blockOf({ startMinutes: 8 * 60, durationMinutes: 4 * 60 });
    const gaps = [gapOf(12 * 60, 2 * 60), gapOf(15 * 60 + 30, 4 * 60)];
    expect(closeDayAfter(closeDayInputFor(dayOf(), [block], gaps), block)).toBeNull();
  });

  it('has nothing to offer where the day itself has nothing to cap', () => {
    const block = blockOf();
    expect(closeDayAfter(closeDayInputFor(dayOf({ isWeekend: true }), [block], []), block)).toBeNull();
  });
});
