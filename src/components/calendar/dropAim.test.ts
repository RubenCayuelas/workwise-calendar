/**
 * The two rules that turn a pixel into a place: thirds, and the next day.
 *
 * Both were decided with the owner on 2026-08-14 and both replace an answer they called
 * indefensible — an exact minute nobody can aim at, and a refusal where any calendar would
 * simply use the day after.
 */

import { describe, expect, it } from 'vitest';
import { manualWindowsOf } from '../../lib/manualWindow';
import type { DayShape, WorkPeriod } from '../../types';
import type { WeekDay } from '../../lib/api-client';
import { createTimeline } from './geometry';
import { aimAtThirds, resolveDropDay } from './dropAim';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented shift: periods 08:00-14:00 and 15:30-19:30, margins 07:00 and 20:30. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

const TIMELINE = createTimeline(SHAPE, { pixelsPerHour: 60 });

function day(date: string, over: Partial<WeekDay> = {}): WeekDay {
  return {
    date,
    weekday: 1,
    role: 'auto',
    isClosed: false,
    isWeekend: false,
    isToday: false,
    isPast: false,
    periods: [MORNING, AFTERNOON],
    manualWindows: [...SHAPE.manualWindows],
    capacityMinutes: 600,
    plannableMinutes: 600,
    bookedMinutes: 0,
    ...over,
  };
}

/** A working week: Mon-Thu auto, Friday the colchón, Sat/Sun manual. */
const WEEK: WeekDay[] = [
  day('2026-08-17'),
  day('2026-08-18'),
  day('2026-08-19'),
  day('2026-08-20'),
  day('2026-08-21', { role: 'buffer', weekday: 5 }),
  day('2026-08-22', { role: 'manual', weekday: 6, isWeekend: true }),
  day('2026-08-23', { role: 'manual', weekday: 7, isWeekend: true }),
];

describe('aimAtThirds', () => {
  /** `Alfa`, four hours of it: 09:00-13:00. Thirds at 09:00, 10:20 and 11:40. */
  const ALFA = { id: 'alfa', startMinutes: 9 * 60, durationMinutes: 240 };

  it('leaves an aim over free time exactly where the pointer put it', () => {
    expect(aimAtThirds(8 * 60 + 15, [ALFA])).toBe(8 * 60 + 15);
    expect(aimAtThirds(13 * 60 + 30, [ALFA])).toBe(13 * 60 + 30);
  });

  it('reads the upper third as "before this one" — the row keeps its start', () => {
    expect(aimAtThirds(9 * 60, [ALFA])).toBe(9 * 60);
    expect(aimAtThirds(9 * 60 + 45, [ALFA])).toBe(9 * 60);
    // The last minute of the upper third is still "before".
    expect(aimAtThirds(10 * 60 + 15, [ALFA])).toBe(9 * 60);
  });

  it('reads the middle third as "cut it here", at the row\'s own midpoint', () => {
    // 11:00 for every one of them: the owner is choosing the ROW, not a minute in it.
    expect(aimAtThirds(10 * 60 + 30, [ALFA])).toBe(11 * 60);
    expect(aimAtThirds(11 * 60, [ALFA])).toBe(11 * 60);
    expect(aimAtThirds(11 * 60 + 30, [ALFA])).toBe(11 * 60);
  });

  it('reads the lower third as "after it" — the aim moves to the row\'s end', () => {
    expect(aimAtThirds(11 * 60 + 45, [ALFA])).toBe(13 * 60);
    expect(aimAtThirds(12 * 60 + 59, [ALFA])).toBe(13 * 60);
  });

  it('offers HALVES on a row too short to cut, so no third can produce a sliver', () => {
    // A quarter-hour row: both halves of a cut would be below `MIN_ROW_MINUTES`, so the
    // middle third would only ever offer a gesture whose outcome is the very thing thirds
    // were adopted to remove.
    const sliver = { id: 's', startMinutes: 10 * 60, durationMinutes: 15 };
    expect(aimAtThirds(10 * 60 + 2, [sliver])).toBe(10 * 60);
    expect(aimAtThirds(10 * 60 + 12, [sliver])).toBe(10 * 60 + 15);
  });

  it('never cuts within a snap step of either end of the row', () => {
    // A half-hour row can be cut, and the only legal cut is dead centre.
    const short = { id: 'h', startMinutes: 10 * 60, durationMinutes: 30 };
    expect(aimAtThirds(10 * 60 + 12, [short])).toBe(10 * 60 + 15);
  });

  it('answers about the row the aim is really in when several are on the day', () => {
    const beta = { id: 'beta', startMinutes: 15 * 60 + 30, durationMinutes: 120 };
    expect(aimAtThirds(16 * 60 + 45, [ALFA, beta])).toBe(16 * 60 + 30);
  });
});

describe('resolveDropDay', () => {
  const resolve = (date: string, startMinutes: number, durationMinutes: number) =>
    resolveDropDay({ days: WEEK, date, startMinutes, durationMinutes, timeline: TIMELINE });

  it('leaves a release the day can hold exactly where it is', () => {
    expect(resolve('2026-08-18', 10 * 60, 120)).toEqual({
      date: '2026-08-18',
      startMinutes: 10 * 60,
      rolled: false,
      clamped: false,
    });
  });

  it('moves a release below what the day holds to the next day, at its first period', () => {
    // 6 h released at 18:00 on a Tuesday: the day ends at 20:30 and cannot hold it, so it
    // is Wednesday — which is what aiming past the bottom of a column means anywhere else.
    expect(resolve('2026-08-18', 18 * 60, 360)).toEqual({
      date: '2026-08-19',
      startMinutes: 8 * 60,
      rolled: true,
      clamped: false,
    });
  });

  it('skips the weekend and a closed day on its way forward', () => {
    const week = [...WEEK];
    week[3] = day('2026-08-20', { isClosed: true });
    const rolled = resolveDropDay({
      days: week,
      date: '2026-08-19',
      startMinutes: 19 * 60,
      durationMinutes: 360,
      timeline: TIMELINE,
    });
    // Thursday is closed, so it is Friday — the colchón, which is exactly what CLAUDE.md
    // has it hold: the overflow of a day that ran out of room.
    expect(rolled).toEqual({
      date: '2026-08-21',
      startMinutes: 8 * 60,
      rolled: true,
      clamped: false,
    });
  });

  it('clamps instead of rolling on a day the engine never lays out', () => {
    // The weekend is a literal placement on a day the owner named on purpose. Moving it to
    // Sunday would be a bigger surprise than pulling the ghost up and saying so.
    expect(resolve('2026-08-22', 18 * 60, 360)).toEqual({
      date: '2026-08-22',
      startMinutes: 13 * 60,
      rolled: false,
      clamped: true,
    });
  });

  it('clamps when no day left on the week could hold the run either', () => {
    // Sunday is the last column, and a run longer than a whole day fits nowhere anyway.
    expect(resolve('2026-08-21', 19 * 60, 360)).toEqual({
      date: '2026-08-21',
      startMinutes: 13 * 60,
      rolled: false,
      clamped: true,
    });
  });

  it('never rolls into a day whose margins are the only room left', () => {
    // The roll is measured over the PERIODS: a run that only fits by reaching into the
    // bottom margin would come back padlocked, and the owner asked for the next day, not
    // for a mark. 10 h is the whole shift, so it fits the periods exactly.
    expect(resolve('2026-08-17', 18 * 60, 600)).toEqual({
      date: '2026-08-18',
      startMinutes: 8 * 60,
      rolled: true,
      clamped: false,
    });
    // 10 h 15 does not, and there is no day on the week that could take it.
    expect(resolve('2026-08-17', 18 * 60, 615).rolled).toBe(false);
  });

  it('says nothing about a date the week does not hold', () => {
    expect(resolve('2026-09-01', 10 * 60, 120)).toEqual({
      date: '2026-09-01',
      startMinutes: 10 * 60,
      rolled: false,
      clamped: false,
    });
  });
});
