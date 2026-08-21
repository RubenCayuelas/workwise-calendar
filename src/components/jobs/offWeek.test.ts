/**
 * A form's date leaving the week on screen. The owner is offered the trip and, declining, is put back
 * on a day they can still see — never left looking at a week their band is not in.
 */

import { describe, expect, it } from 'vitest';
import { offWeekChoice } from './offWeek';

const WEEK = [
  '2026-08-24',
  '2026-08-25',
  '2026-08-26',
  '2026-08-27',
  '2026-08-28',
  '2026-08-29',
  '2026-08-30',
];

describe('a date that leaves the week on screen', () => {
  it('says nothing while the date is still visible', () => {
    expect(offWeekChoice('2026-08-26', WEEK, '2026-08-24')).toBeNull();
  });

  it('offers the trip, and the way back, once the date is off screen', () => {
    expect(offWeekChoice('2026-09-08', WEEK, '2026-08-26')).toEqual({
      goTo: '2026-09-08',
      backTo: '2026-08-26',
    });
  });

  it('goes back to the last date that WAS on screen, not merely the previous one', () => {
    // Sep 1 -> Sep 8 must not offer Sep 1 as the way back: it is off screen too, and the owner
    // would be stranded with nothing left to press.
    expect(offWeekChoice('2026-09-08', WEEK, '2026-08-27')).toEqual({
      goTo: '2026-09-08',
      backTo: '2026-08-27',
    });
  });

  it('offers no way back when nothing on screen was ever chosen', () => {
    expect(offWeekChoice('2026-09-08', WEEK, null)).toEqual({
      goTo: '2026-09-08',
      backTo: null,
    });
  });

  it('says nothing with no week to compare against', () => {
    expect(offWeekChoice('2026-09-08', [], '2026-08-24')).toBeNull();
  });

  it('says nothing for a date that is not a date', () => {
    expect(offWeekChoice('', WEEK, '2026-08-24')).toBeNull();
  });
});
