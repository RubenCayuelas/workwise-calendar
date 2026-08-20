/**
 * The time control's option list.
 *
 * The first test is the important one: it pins the form's granularity to the drag
 * layer's snap. If those two ever drift, a start time chosen in the gap form lands
 * between two positions the grid can produce, and dragging that block would silently
 * move it.
 */

import { describe, expect, it } from 'vitest';
import { MIN_ROW_MINUTES } from '../../lib/validation';
import { SNAP_MINUTES } from '../calendar/geometry';
import { TIME_STEP_MINUTES, clockMinutes, timeOptionMinutes } from './timeOptions';

describe('the time step', () => {
  it('is the same quarter hour the drag layer snaps to', () => {
    expect(TIME_STEP_MINUTES).toBe(SNAP_MINUTES);
    // The THIRD of the three, which nothing pinned until 2026-08-20 while `validation.ts` and
    // CLAUDE.md both claimed a test held it. A quarter of an hour is the smallest row the calendar
    // can draw AND the smallest amount the owner can aim at; two constants agreeing and a third
    // drifting would break the floor without breaking a test.
    expect(MIN_ROW_MINUTES).toBe(SNAP_MINUTES);
  });
});

describe('clockMinutes', () => {
  it('reads a clock time as minutes from midnight', () => {
    expect(clockMinutes('08:00')).toBe(480);
    expect(clockMinutes('19:30')).toBe(19 * 60 + 30);
  });

  it('returns undefined for an empty or half-typed value instead of throwing', () => {
    expect(clockMinutes('')).toBeUndefined();
    expect(clockMinutes('8')).toBeUndefined();
    expect(clockMinutes('nope')).toBeUndefined();
  });
});

describe('timeOptionMinutes', () => {
  it('offers every quarter hour of the day by default', () => {
    const options = timeOptionMinutes(undefined);
    expect(options).toHaveLength((24 * 60) / TIME_STEP_MINUTES);
    expect(options[0]).toBe(0);
    expect(options[options.length - 1]).toBe(23 * 60 + 45);
  });

  it('keeps a stored value that does not sit on the grid', () => {
    const options = timeOptionMinutes(8 * 60 + 10);
    expect(options).toContain(8 * 60 + 10);
    // Still in order, so the list does not read as broken.
    expect(options.indexOf(8 * 60 + 10)).toBe(options.indexOf(8 * 60) + 1);
  });

  it('honours a range, inclusive of both ends', () => {
    const options = timeOptionMinutes(undefined, { minMinutes: 8 * 60, maxMinutes: 9 * 60 });
    expect(options).toEqual([480, 495, 510, 525, 540]);
  });

  it('keeps a stored value that falls outside the range', () => {
    const options = timeOptionMinutes(7 * 60, { minMinutes: 8 * 60, maxMinutes: 9 * 60 });
    expect(options[0]).toBe(7 * 60);
  });

  it('takes a coarser step when one is asked for', () => {
    expect(timeOptionMinutes(undefined, { stepMinutes: 60, maxMinutes: 3 * 60 })).toEqual([
      0, 60, 120, 180,
    ]);
  });
});
