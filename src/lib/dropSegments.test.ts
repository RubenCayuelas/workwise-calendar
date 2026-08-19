import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t } from './dates';
import { segmentDroppedRow } from './dropSegments';
import { manualWindowsOf } from './manualWindow';

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

/** The documented shift as a HAND action sees it: `07:00-14:00` and `15:30-20:30`. */
const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

/** The afternoon switched off: one window, and the hole after it runs to midnight. */
const MORNING_ONLY = manualWindowsOf([PERIODS[0]], 60, 60);

/** A shift with no lunch at all, which `manualWindowsOf` fuses into ONE window. */
const NO_LUNCH = manualWindowsOf(
  [
    { startMinutes: t('08:00'), endMinutes: t('14:00') },
    { startMinutes: t('14:00'), endMinutes: t('18:00') },
  ],
  60,
  60,
);

describe('segmentDroppedRow — inside a window', () => {
  it('leaves a row that fits inside one window alone', () => {
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('10:00'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('10:00'), durationMinutes: 120 },
    ]);
  });

  it('cuts at the break, duration being NET working minutes', () => {
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('10:00'), durationMinutes: 360 })).toEqual([
      { startMinutes: t('10:00'), durationMinutes: 240 },
      { startMinutes: t('15:30'), durationMinutes: 120 },
    ]);
  });

  it('runs a row starting in the top margin straight on into the morning', () => {
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('07:00'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('07:00'), durationMinutes: 120 },
    ]);
  });
});

describe('segmentDroppedRow — the last minute of a window and the first', () => {
  it('keeps the last minute of the morning in the morning, cut at 14:00', () => {
    // 13:59 IS working time, so the one-minute head it leaves is the sliver Open Decision.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('13:59'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('13:59'), durationMinutes: 1 },
      { startMinutes: t('15:30'), durationMinutes: 119 },
    ]);
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('13:45'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('13:45'), durationMinutes: 15 },
      { startMinutes: t('15:30'), durationMinutes: 105 },
    ]);
  });

  it('leaves the first minute of the afternoon exactly where it is', () => {
    for (const minute of [t('15:30'), t('15:31'), t('15:45')]) {
      expect(
        segmentDroppedRow(WINDOWS, { startMinutes: minute, durationMinutes: 120 }),
        `from ${minute}`,
      ).toEqual([{ startMinutes: minute, durationMinutes: 120 }]);
    }
  });

  it('ends a row exactly on the boundary without inventing a second row', () => {
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('13:00'), durationMinutes: 60 })).toEqual([
      { startMinutes: t('13:00'), durationMinutes: 60 },
    ]);
  });
});

describe('segmentDroppedRow — every minute of the break means 15:30', () => {
  it('starts a row aimed anywhere in the break at the first minute that can hold work', () => {
    // 14:00 is the exclusive end of the first window and before the second's start: neither covers it.
    for (const minute of [
      t('14:00'),
      t('14:01'),
      t('14:15'),
      t('14:30'),
      t('15:00'),
      t('15:15'),
      t('15:29'),
    ]) {
      expect(
        segmentDroppedRow(WINDOWS, { startMinutes: minute, durationMinutes: 120 }),
        `aimed at ${minute}`,
      ).toEqual([{ startMinutes: t('15:30'), durationMinutes: 120 }]);
    }
  });

  it('gives the same answer for a row that would fit inside the break', () => {
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 90 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 90 },
    ]);
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('15:15'), durationMinutes: 15 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 15 },
    ]);
  });

  it('reports the overrun instead of hiding it when the afternoon cannot hold the row', () => {
    // 6 h from 15:30 reaches 21:30: the end-of-day guard's question, not this one's.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 360 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 360 },
    ]);
  });
});

describe('segmentDroppedRow — where there is no next working minute', () => {
  it('leaves a row past the last window alone, on the documented shift', () => {
    const noBottomMargin = manualWindowsOf(PERIODS, 60, 0);
    expect(
      segmentDroppedRow(noBottomMargin, { startMinutes: t('20:00'), durationMinutes: 60 }),
    ).toEqual([{ startMinutes: t('20:00'), durationMinutes: 60 }]);
  });

  it('leaves the whole afternoon alone on a day whose afternoon is switched off', () => {
    for (const minute of [t('15:00'), t('15:01'), t('18:00'), t('23:00')]) {
      expect(
        segmentDroppedRow(MORNING_ONLY, { startMinutes: minute, durationMinutes: 60 }),
        `from ${minute}`,
      ).toEqual([{ startMinutes: minute, durationMinutes: 60 }]);
    }
    expect(segmentDroppedRow(MORNING_ONLY, { startMinutes: t('14:59'), durationMinutes: 60 })).toEqual([
      { startMinutes: t('14:59'), durationMinutes: 60 },
    ]);
  });

  it('never cuts a shift configured with no lunch, which is one fused window', () => {
    expect(segmentDroppedRow(NO_LUNCH, { startMinutes: t('13:00'), durationMinutes: 240 })).toEqual([
      { startMinutes: t('13:00'), durationMinutes: 240 },
    ]);
    expect(segmentDroppedRow(NO_LUNCH, { startMinutes: t('14:00'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('14:00'), durationMinutes: 120 },
    ]);
  });

  it('returns a stretch whose tail would pass midnight exactly as it was made', () => {
    // A run longer than the day comes back UNCUT, so the caller can refuse the drop as it was made.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 600 })).toEqual([
      { startMinutes: t('14:00'), durationMinutes: 600 },
    ]);
  });
});
