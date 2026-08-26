/**
 * The reveal's aim. It decides where the grid says "a press here creates", so a mistake here either
 * promises a create over a row that would MOVE, or hides the one affordance the gesture has.
 */

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t } from '../../lib/dates';
import { manualWindowsOf } from '../../lib/manualWindow';
import { CREATE_RAIL_PX } from './geometry';
import { aimAt } from './paintAim';

const WINDOWS = manualWindowsOf(
  [
    { startMinutes: t('08:00'), endMinutes: t('14:00') },
    { startMinutes: t('15:30'), endMinutes: t('19:30') },
  ],
  60,
  60,
);

/** The wireframe's morning: one job from 10:00 to 12:00, the rest of the day free. */
const ROWS = [{ startMinutes: t('10:00'), durationMinutes: 120 }];

function aim(x: number, at: string, rows = ROWS) {
  return aimAt({ x, minutes: t(at), windows: WINDOWS, rows });
}

describe('aimAt', () => {
  it('names the minute anywhere on a free part of the column', () => {
    expect(aim(200, '09:00')).toBe(t('09:00'));
    expect(aim(200, '13:00')).toBe(t('13:00'));
  });

  it('says nothing over a row, where a press moves it', () => {
    expect(aim(200, '11:00')).toBeNull();
    // The row's own start is occupied; the minute it ends is not.
    expect(aim(200, '10:00')).toBeNull();
    expect(aim(200, '12:00')).toBe(t('12:00'));
  });

  it('names the minute over a row when the pointer is on the rail', () => {
    expect(aim(0, '11:00')).toBe(t('11:00'));
    expect(aim(CREATE_RAIL_PX - 1, '11:00')).toBe(t('11:00'));
  });

  it('the rail ends where it ends', () => {
    expect(aim(CREATE_RAIL_PX, '11:00')).toBeNull();
  });

  it('snaps to the quarter hour, on the rail and off it', () => {
    expect(aim(0, '11:07')).toBe(t('11:00'));
    expect(aim(200, '09:08')).toBe(t('09:15'));
  });

  it('names the afternoon from inside the lunch break, which is where a band would start', () => {
    expect(aim(200, '14:30')).toBe(t('15:30'));
    expect(aim(0, '14:30')).toBe(t('15:30'));
  });

  it('takes a margin at its face value: the owner puts real work in one', () => {
    expect(aim(200, '07:30')).toBe(t('07:30'));
    expect(aim(200, '20:00')).toBe(t('20:00'));
  });

  it('says nothing past the last window, where the named minute would not be a start', () => {
    // Only reachable on an axis widened to cover a row placed by hand beyond the day.
    expect(aim(200, '21:00')).toBeNull();
    expect(aim(0, '21:00')).toBeNull();
  });

  it('reads a gap exactly as it reads a block', () => {
    const gap = [{ startMinutes: t('09:00'), durationMinutes: 30 }];

    expect(aim(200, '09:15', gap)).toBeNull();
    expect(aim(0, '09:15', gap)).toBe(t('09:15'));
  });

  it('a whole day of flush rows leaves the rail as the only way in', () => {
    const booked = [
      { startMinutes: t('08:00'), durationMinutes: 120 },
      { startMinutes: t('10:00'), durationMinutes: 120 },
    ];

    expect(aim(200, '09:59', booked)).toBeNull();
    expect(aim(200, '10:00', booked)).toBeNull();
    expect(aim(8, '09:59', booked)).toBe(t('10:00'));
  });
});
