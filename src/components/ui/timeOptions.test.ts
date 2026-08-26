/**
 * The time control's granularity, and its one safe parse.
 *
 * The first test is the important one: it pins the form's granularity to the drag
 * layer's snap. If those two ever drift, a start time chosen in the gap form lands
 * between two positions the grid can produce, and dragging that block would silently
 * move it.
 */

import { describe, expect, it } from 'vitest';
import { MIN_ROW_MINUTES } from '../../lib/validation';
import { SNAP_MINUTES } from '../calendar/geometry';
import { TIME_STEP_MINUTES, clockMinutes } from './timeOptions';
import * as timeOptions from './timeOptions';

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

describe('the module surface', () => {
  it('no longer offers the list of quarter hours the dropdown was built from', () => {
    // 96 options from 00:00 to 23:45. The step and the parse are what the app needs from here;
    // the list would be a second way to say what a legal time is.
    expect(Object.keys(timeOptions)).not.toContain('timeOptionMinutes');
  });
});
