import { describe, expect, it } from 'vitest';
import {
  fillStartFor,
  freeStretchesFrom,
  planDropSpill,
  takeableFrom,
  type SpillDay,
} from './dropSpill';
import { MIN_ROW_MINUTES } from './validation';

/** The documented shift, in minutes: 08:00-14:00 and 15:30-19:30. */
const PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

const MORNING_MINUTES = 6 * 60;
const AFTERNOON_MINUTES = 4 * 60;
const DAY_MINUTES = MORNING_MINUTES + AFTERNOON_MINUTES;

function day(date: string, overrides: Partial<SpillDay> = {}): SpillDay {
  return {
    date,
    periods: PERIODS,
    immovable: [],
    budgetMinutes: DAY_MINUTES,
    ...overrides,
  };
}

describe('freeStretchesFrom — one stretch per period, never across the break', () => {
  it('cuts an empty day at the lunch break', () => {
    expect(freeStretchesFrom(PERIODS, [], 0)).toEqual([
      { startMinutes: 8 * 60, endMinutes: 14 * 60 },
      { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
    ]);
  });

  it('starts where it is told to, and never backwards', () => {
    expect(freeStretchesFrom(PERIODS, [], 16 * 60)).toEqual([
      { startMinutes: 16 * 60, endMinutes: 19 * 60 + 30 },
    ]);
  });

  it('reads a start inside the break as the whole afternoon', () => {
    expect(freeStretchesFrom(PERIODS, [], 15 * 60)).toEqual([
      { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
    ]);
  });

  it('leaves a hole in front of an obstacle and the run after it', () => {
    const stretches = freeStretchesFrom(
      PERIODS,
      [{ startMinutes: 16 * 60, durationMinutes: 2 * 60 }],
      15 * 60 + 30,
    );
    expect(stretches).toEqual([
      { startMinutes: 15 * 60 + 30, endMinutes: 16 * 60 },
      { startMinutes: 18 * 60, endMinutes: 19 * 60 + 30 },
    ]);
  });

  it('folds two obstacles that overlap into one', () => {
    const stretches = freeStretchesFrom(
      PERIODS,
      [
        { startMinutes: 9 * 60, durationMinutes: 60 },
        { startMinutes: 9 * 60 + 30, durationMinutes: 60 },
      ],
      8 * 60,
    );
    expect(stretches[0]).toEqual({ startMinutes: 8 * 60, endMinutes: 9 * 60 });
    expect(stretches[1]).toEqual({ startMinutes: 10 * 60 + 30, endMinutes: 14 * 60 });
  });

  it('never returns a stretch inside a visual margin, because auto-fill never uses one', () => {
    expect(freeStretchesFrom(PERIODS, [], 7 * 60)[0]).toEqual({
      startMinutes: 8 * 60,
      endMinutes: 14 * 60,
    });
  });
});

describe('fillStartFor — the hours begin where the work in front of them ends', () => {
  it('pulls a release in free time back to the top of its free run', () => {
    // The owner's own case: released at 16:00 into an afternoon that is free from 15:30.
    expect(fillStartFor(PERIODS, [{ startMinutes: 8 * 60, durationMinutes: 6 * 60 }], 16 * 60)).toBe(
      15 * 60 + 30,
    );
  });

  it('stops at the row in front, movable or not', () => {
    // 15:30-16:30 is another job's ordinary row: it is ranked in front of the drop, so it
    // stays in front of it.
    expect(
      fillStartFor(PERIODS, [{ startMinutes: 15 * 60 + 30, durationMinutes: 60 }], 16 * 60 + 30),
    ).toBe(16 * 60 + 30);
  });

  it('leaves a release INSIDE a row alone — that row is cut there', () => {
    expect(
      fillStartFor(PERIODS, [{ startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 }], 16 * 60 + 30),
    ).toBe(16 * 60 + 30);
  });

  it('does not reach across the break', () => {
    // The morning is empty, but the release is in the afternoon: the pull-back stops at the
    // period boundary rather than promising the day starts over.
    expect(fillStartFor(PERIODS, [], 17 * 60)).toBe(15 * 60 + 30);
  });

  it('leaves a release no period covers alone', () => {
    expect(fillStartFor(PERIODS, [], 7 * 60 + 30)).toBe(7 * 60 + 30);
  });
});

describe('planDropSpill — fill what is left, carry the rest', () => {
  it("answers the owner's case: 6 h into a 4 h afternoon is 4 h here and 2 h tomorrow", () => {
    const spill = planDropSpill({
      days: [
        day('2026-08-17', {
          immovable: [],
          fromMinutes: 15 * 60 + 30,
          // The morning is spent by the work ranked in front of the drop.
          budgetMinutes: AFTERNOON_MINUTES,
        }),
        day('2026-08-18'),
      ],
      durationMinutes: 6 * 60,
    });

    expect(spill.pieces).toEqual([
      { date: '2026-08-17', startMinutes: 15 * 60 + 30, durationMinutes: 4 * 60 },
      { date: '2026-08-18', startMinutes: 8 * 60, durationMinutes: 2 * 60 },
    ]);
    expect(spill.beyondMinutes).toBe(0);
  });

  it('fills the hole in FRONT of a locked block and continues after it', () => {
    const spill = planDropSpill({
      days: [
        day('2026-08-17', {
          immovable: [{ startMinutes: 16 * 60, durationMinutes: 60 }],
          fromMinutes: 15 * 60 + 30,
          budgetMinutes: AFTERNOON_MINUTES - 60,
        }),
        day('2026-08-18'),
      ],
      durationMinutes: 4 * 60,
    });

    expect(spill.pieces).toEqual([
      { date: '2026-08-17', startMinutes: 15 * 60 + 30, durationMinutes: 30 },
      { date: '2026-08-17', startMinutes: 17 * 60, durationMinutes: 2 * 60 + 30 },
      { date: '2026-08-18', startMinutes: 8 * 60, durationMinutes: 60 },
    ]);
  });

  it('steps over a hole too short to hold a row, leaving its minutes free', () => {
    const spill = planDropSpill({
      days: [
        day('2026-08-17', {
          // Ten minutes in front of a lock that holds the rest of the day.
          immovable: [{ startMinutes: 15 * 60 + 40, durationMinutes: 3 * 60 + 50 }],
          fromMinutes: 15 * 60 + 30,
          budgetMinutes: 10,
        }),
        day('2026-08-18'),
      ],
      durationMinutes: 2 * 60,
    });

    expect(spill.pieces).toEqual([
      { date: '2026-08-18', startMinutes: 8 * 60, durationMinutes: 2 * 60 },
    ]);
  });

  it('lays a run longer than a day out across days', () => {
    const spill = planDropSpill({
      days: [day('2026-08-17'), day('2026-08-18'), day('2026-08-19')],
      durationMinutes: 18 * 60,
    });

    expect(spill.pieces).toEqual([
      { date: '2026-08-17', startMinutes: 8 * 60, durationMinutes: MORNING_MINUTES },
      { date: '2026-08-17', startMinutes: 15 * 60 + 30, durationMinutes: AFTERNOON_MINUTES },
      { date: '2026-08-18', startMinutes: 8 * 60, durationMinutes: MORNING_MINUTES },
      { date: '2026-08-18', startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 },
    ]);
    expect(spill.beyondMinutes).toBe(0);
  });

  it('reports the hours no day offered can take', () => {
    const spill = planDropSpill({ days: [day('2026-08-17')], durationMinutes: 14 * 60 });
    expect(spill.pieces.reduce((total, piece) => total + piece.durationMinutes, 0)).toBe(DAY_MINUTES);
    expect(spill.beyondMinutes).toBe(4 * 60);
  });

  it('skips a day the engine cannot fill at all', () => {
    const spill = planDropSpill({
      days: [day('2026-08-17', { budgetMinutes: 0 }), day('2026-08-18')],
      durationMinutes: 2 * 60,
    });
    expect(spill.pieces).toEqual([
      { date: '2026-08-18', startMinutes: 8 * 60, durationMinutes: 2 * 60 },
    ]);
  });

  it('never draws a piece under a quarter of an hour, and never leaves one behind', () => {
    for (let minutes = MIN_ROW_MINUTES; minutes <= 20 * 60; minutes += 5) {
      for (const from of [8 * 60, 13 * 60 + 50, 15 * 60 + 30, 19 * 60 + 20]) {
        const spill = planDropSpill({
          days: [
            day('2026-08-17', { fromMinutes: from }),
            day('2026-08-18'),
            day('2026-08-19'),
            day('2026-08-20'),
          ],
          durationMinutes: minutes,
        });
        const drawn = spill.pieces.reduce((total, piece) => total + piece.durationMinutes, 0);
        expect(drawn + spill.beyondMinutes, `${minutes} from ${from}`).toBe(minutes);
        for (const piece of spill.pieces) {
          expect(piece.durationMinutes, `${minutes} from ${from}`).toBeGreaterThanOrEqual(
            MIN_ROW_MINUTES,
          );
          // Every piece is a legal row: inside one period, ending no later than it does.
          const period = PERIODS.find(
            (candidate) =>
              piece.startMinutes >= candidate.startMinutes &&
              piece.startMinutes + piece.durationMinutes <= candidate.endMinutes,
          );
          expect(period, `${piece.startMinutes} +${piece.durationMinutes}`).toBeDefined();
        }
      }
    }
  });
});

describe('takeableFrom — the quarter-hour floor at the one place splitting happens', () => {
  it('takes the whole rest when it fits', () => {
    expect(takeableFrom(4 * 60, 2 * 60, false)).toBe(2 * 60);
  });

  it('draws a remainder that could not be a row anywhere', () => {
    expect(takeableFrom(10, 10, false)).toBe(10);
  });

  it('steps over a stretch too short to hold a row', () => {
    expect(takeableFrom(10, 2 * 60, false)).toBe(0);
    expect(takeableFrom(10, 2 * 60, true)).toBe(10);
  });

  it('sends a remainder of one quarter but not two on whole', () => {
    expect(takeableFrom(60, 20, false)).toBe(20);
    expect(takeableFrom(10, 20, false)).toBe(0);
  });

  it('leaves a full quarter for the hours that carry on', () => {
    expect(takeableFrom(60, 70, false)).toBe(55);
  });
});
