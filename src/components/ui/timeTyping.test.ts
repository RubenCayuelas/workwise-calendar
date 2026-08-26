/**
 * What a time typed into the field means.
 *
 * The commit rule is the one that matters: `changedFields` in src/components/settings/shift.ts
 * compares the STRINGS to decide what to PATCH, so rounding a value nobody touched would put
 * `period1Start` in the patch, and a Settings save recomposes the calendar and empties the undo line.
 */

import { describe, expect, it } from 'vitest';
import { MAX_TYPED_MINUTES, commitTypedTime, normalizeTypedTime, stepTypedTime } from './timeTyping';

/** A 14:10-18:10 afternoon: what `momentBounds` offers, from the shift's start to one step before it closes. */
const AFTERNOON = { minMinutes: 14 * 60 + 10, maxMinutes: 17 * 60 + 55 };

describe('normalizeTypedTime', () => {
  it('reads the short forms of a time', () => {
    expect(normalizeTypedTime('8')).toBe('08:00');
    expect(normalizeTypedTime('18')).toBe('18:00');
    expect(normalizeTypedTime('830')).toBe('08:30');
    expect(normalizeTypedTime('0830')).toBe('08:30');
    expect(normalizeTypedTime('8:30')).toBe('08:30');
    expect(normalizeTypedTime('08:30')).toBe('08:30');
    expect(normalizeTypedTime(' 08:30 ')).toBe('08:30');
    expect(normalizeTypedTime('00:00')).toBe('00:00');
  });

  it('refuses what it cannot read as one time', () => {
    expect(normalizeTypedTime('')).toBeUndefined();
    expect(normalizeTypedTime('8:3')).toBeUndefined();
    expect(normalizeTypedTime('25:00')).toBeUndefined();
    expect(normalizeTypedTime('12:60')).toBeUndefined();
    expect(normalizeTypedTime('ocho')).toBeUndefined();
    expect(normalizeTypedTime('-1:00')).toBeUndefined();
  });

  it('refuses the end of the day, whose last legal moment is 23:45', () => {
    expect(MAX_TYPED_MINUTES).toBe(23 * 60 + 45);
    expect(normalizeTypedTime('23:45')).toBe('23:45');
    expect(normalizeTypedTime('24:00')).toBeUndefined();
    expect(normalizeTypedTime('2400')).toBeUndefined();
    // A legible time above the ceiling still reads back; `commitTypedTime` is what refuses it.
    expect(normalizeTypedTime('23:50')).toBe('23:50');
  });
});

describe('stepTypedTime', () => {
  it('moves a quarter hour from a value on the grid', () => {
    expect(stepTypedTime('08:00', 1)).toBe('08:15');
    expect(stepTypedTime('08:00', -1)).toBe('07:45');
  });

  it('moves a whole hour when one is asked for', () => {
    expect(stepTypedTime('08:00', 1, { wholeHour: true })).toBe('09:00');
    expect(stepTypedTime('08:00', -1, { wholeHour: true })).toBe('07:00');
  });

  it('lands on the next multiple in that direction, not on the nearest', () => {
    // 08:20 is nearer 08:15, so a plain snap would send a press of `+` backwards.
    expect(stepTypedTime('08:20', 1)).toBe('08:30');
    expect(stepTypedTime('08:20', -1)).toBe('08:15');
    expect(stepTypedTime('08:10', 1)).toBe('08:15');
    expect(stepTypedTime('08:10', -1)).toBe('08:00');
    expect(stepTypedTime('08:20', 1, { wholeHour: true })).toBe('09:00');
    expect(stepTypedTime('08:20', -1, { wholeHour: true })).toBe('08:00');
  });

  it('stops at the two ends of the day', () => {
    expect(stepTypedTime('23:45', 1)).toBe('23:45');
    expect(stepTypedTime('23:00', 1, { wholeHour: true })).toBe('23:45');
    expect(stepTypedTime('00:00', -1)).toBe('00:00');
    expect(stepTypedTime('00:30', -1, { wholeHour: true })).toBe('00:00');
  });

  it('stops on a bound that is off the quarter grid', () => {
    expect(stepTypedTime('17:45', 1, { bounds: AFTERNOON })).toBe('17:55');
    expect(stepTypedTime('14:15', -1, { bounds: AFTERNOON })).toBe('14:10');
  });

  it('leaves a value it cannot read alone', () => {
    expect(stepTypedTime('ocho', 1)).toBe('ocho');
    expect(stepTypedTime('', -1)).toBe('');
  });
});

describe('commitTypedTime', () => {
  /**
   * THE LOAD-BEARING ONE. A hand-edited 08:10 has to survive a tab-through: snapping it to 08:15
   * would send `period1Start` in a Settings patch nobody asked for.
   */
  it('returns an untouched value verbatim, unsnapped', () => {
    expect(commitTypedTime('08:10', '08:10')).toEqual({ ok: true, value: '08:10' });
  });

  it('normalises and snaps a value that was actually typed', () => {
    expect(commitTypedTime('09:00', '8')).toEqual({ ok: true, value: '08:00' });
    expect(commitTypedTime('09:00', '830')).toEqual({ ok: true, value: '08:30' });
    expect(commitTypedTime('09:00', '08:10')).toEqual({ ok: true, value: '08:15' });
  });

  it('refuses a value it cannot read, changed or not', () => {
    expect(commitTypedTime('08:00', 'ocho')).toEqual({ ok: false, reason: 'invalid-format' });
    // Leaving the field twice over the same rubbish must not turn it legal on the second pass.
    expect(commitTypedTime('ocho', 'ocho')).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it('refuses past the last quarter of the day instead of sliding the value', () => {
    expect(commitTypedTime('08:00', '23:50')).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 0,
      maxMinutes: MAX_TYPED_MINUTES,
    });
  });

  it('refuses outside the bounds instead of clamping into them', () => {
    expect(commitTypedTime('15:00', '18:00', AFTERNOON)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 850,
      maxMinutes: 1075,
    });
    expect(commitTypedTime('15:00', '14:00', AFTERNOON)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 850,
      maxMinutes: 1075,
    });
  });

  it('keeps a bound that is off the quarter grid reachable', () => {
    expect(commitTypedTime('15:00', '17:55', AFTERNOON)).toEqual({ ok: true, value: '17:55' });
    expect(commitTypedTime('15:00', '17:50', AFTERNOON)).toEqual({ ok: true, value: '17:45' });
  });
});
