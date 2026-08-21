import { describe, expect, it } from 'vitest';
import { manualWindowsOf } from '../../lib/manualWindow';
import { paintedSpan } from './paintSession';

const t = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

/** 07:00-14:00 and 15:30-20:30: a hand gesture reads the margins too. */
const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

describe('the band a paint draws', () => {
  it('is the minutes between the press and the pointer, snapped to the quarter hour', () => {
    expect(paintedSpan(WINDOWS, t('09:00'), t('11:00'))).toEqual({
      startMinutes: t('09:00'),
      durationMinutes: 120,
    });
    expect(paintedSpan(WINDOWS, t('09:07'), t('11:04'))).toEqual({
      startMinutes: t('09:00'),
      durationMinutes: 120,
    });
  });

  it('paints upwards as readily as downwards', () => {
    expect(paintedSpan(WINDOWS, t('11:00'), t('09:00'))).toEqual({
      startMinutes: t('09:00'),
      durationMinutes: 120,
    });
  });

  it('counts NET working minutes, so the comida costs nothing', () => {
    expect(paintedSpan(WINDOWS, t('13:00'), t('16:30'))).toEqual({
      startMinutes: t('13:00'),
      durationMinutes: 120,
    });
  });

  it('starts at the first minute that can hold work when the press was inside the comida', () => {
    expect(paintedSpan(WINDOWS, t('14:30'), t('17:30'))).toEqual({
      startMinutes: t('15:30'),
      durationMinutes: 120,
    });
  });

  it('reaches into the visual margins, which a hand gesture may use', () => {
    expect(paintedSpan(WINDOWS, t('07:00'), t('08:00'))).toEqual({
      startMinutes: t('07:00'),
      durationMinutes: 60,
    });
  });

  it('is nothing at all below a quarter of an hour — a press that wandered is not a gesture', () => {
    expect(paintedSpan(WINDOWS, t('09:00'), t('09:00'))).toBeNull();
    expect(paintedSpan(WINDOWS, t('09:00'), t('09:06'))).toBeNull();
    // Both ends inside the comida: no working minute between them.
    expect(paintedSpan(WINDOWS, t('14:15'), t('15:00'))).toBeNull();
  });

  it('paints the whole column as the 12 h the manual window holds, not 13.5', () => {
    expect(paintedSpan(WINDOWS, t('07:00'), t('20:30'))).toEqual({
      startMinutes: t('07:00'),
      durationMinutes: 12 * 60,
    });
  });
});
