/**
 * THE STORAGE RULE AT ITS BOUNDARIES.
 *
 * `segmentDroppedRow` is proven all over `composition.test.ts` and `dropEffect.test.ts`
 * through the drops that use it. What is proven HERE is the minutes at the edges of a
 * window, one by one, because that is where it was wrong: a release at 14:00 — the minute
 * period 1 ends, belonging to no window — found no boundary to cut against and stored
 * `14:00 +120m -> 16:00`, one row straight through the break, ninety minutes of which is
 * lunch. It was not an off-by-one either; every minute from 14:00 to 15:29 did it.
 *
 * So the cases below are the boundary minutes themselves and never a sample from the middle:
 * the last minute of each window, the first minute of each, and every interesting minute of
 * the break between them. Integer minutes, no clock, no database.
 */

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
    // The rule's own worked example: 6 h at 10:00 is 10:00-14:00 plus 15:30-17:30.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('10:00'), durationMinutes: 360 })).toEqual([
      { startMinutes: t('10:00'), durationMinutes: 240 },
      { startMinutes: t('15:30'), durationMinutes: 120 },
    ]);
  });

  it('runs a row starting in the top margin straight on into the morning', () => {
    // A margin is inside the manual window, so there is no boundary at 08:00 to cut at.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('07:00'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('07:00'), durationMinutes: 120 },
    ]);
  });
});

describe('segmentDroppedRow — the last minute of a window and the first', () => {
  it('keeps the last minute of the morning in the morning, cut at 14:00', () => {
    // 13:59 IS working time, so it is its own answer. The cut leaves a one-minute head; that
    // sliver is an Open Decision and `MIN_ROW_MINUTES` is deliberately not a write guard, so
    // it is recorded here as the boundary's real behaviour rather than quietly rounded away.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('13:59'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('13:59'), durationMinutes: 1 },
      { startMinutes: t('15:30'), durationMinutes: 119 },
    ]);
    // A quarter of an hour before the boundary, which is the smallest thing the owner can aim
    // at, comes out as two rows the calendar can draw.
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
    // 13:00 + 60 net ends at 14:00: the row stops where the window does, so there is nothing
    // left to carry over and no empty second segment.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('13:00'), durationMinutes: 60 })).toEqual([
      { startMinutes: t('13:00'), durationMinutes: 60 },
    ]);
  });
});

describe('segmentDroppedRow — every minute of the break means 15:30', () => {
  it('starts a row aimed anywhere in the break at the first minute that can hold work', () => {
    // 14:00 is the minute period 1 ends: the exclusive end of the first window, before the
    // start of the second, belonging to neither. It used to be stored as `14:00 +120m`, and so
    // was every other minute of the band.
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
    // 90 minutes at 14:00 ends exactly at 15:30, so it never crossed anything — and it is
    // still ninety minutes of work booked over lunch, which is the other half of the defect.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 90 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 90 },
    ]);
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('15:15'), durationMinutes: 15 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 15 },
    ]);
  });

  it('reports the overrun instead of hiding it when the afternoon cannot hold the row', () => {
    // 6 h from 15:30 reaches 21:30, past the end of the day. That is the end-of-day guard's
    // question and this function must not answer it by pretending the row is shorter.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 360 })).toEqual([
      { startMinutes: t('15:30'), durationMinutes: 360 },
    ]);
  });
});

describe('segmentDroppedRow — where there is no next working minute', () => {
  it('leaves a row past the last window alone, on the documented shift', () => {
    // A margin the owner has since set to 0 strands rows out here. Nothing later covers them,
    // so there is no start to offer and `dayEndMinutes` is what has an opinion.
    const noBottomMargin = manualWindowsOf(PERIODS, 60, 0);
    expect(
      segmentDroppedRow(noBottomMargin, { startMinutes: t('20:00'), durationMinutes: 60 }),
    ).toEqual([{ startMinutes: t('20:00'), durationMinutes: 60 }]);
  });

  it('leaves the whole afternoon alone on a day whose afternoon is switched off', () => {
    // The day is `07:00-15:00` (morning plus its two margins) and the hole after it runs to
    // midnight. Every minute of that hole is left exactly as it came: there is no later window
    // to move into, so the drop rolls to another day or the write path refuses it.
    for (const minute of [t('15:00'), t('15:01'), t('18:00'), t('23:00')]) {
      expect(
        segmentDroppedRow(MORNING_ONLY, { startMinutes: minute, durationMinutes: 60 }),
        `from ${minute}`,
      ).toEqual([{ startMinutes: minute, durationMinutes: 60 }]);
    }
    // And the last minute inside the day is still inside it.
    expect(segmentDroppedRow(MORNING_ONLY, { startMinutes: t('14:59'), durationMinutes: 60 })).toEqual([
      { startMinutes: t('14:59'), durationMinutes: 60 },
    ]);
  });

  it('never cuts a shift configured with no lunch, which is one fused window', () => {
    expect(segmentDroppedRow(NO_LUNCH, { startMinutes: t('13:00'), durationMinutes: 240 })).toEqual([
      { startMinutes: t('13:00'), durationMinutes: 240 },
    ]);
    // 14:00 is a period edge here and covered by the fused window, so it is its own answer.
    expect(segmentDroppedRow(NO_LUNCH, { startMinutes: t('14:00'), durationMinutes: 120 })).toEqual([
      { startMinutes: t('14:00'), durationMinutes: 120 },
    ]);
  });

  it('returns a stretch whose tail would pass midnight exactly as it was made', () => {
    // A run longer than the day (Open Decision 13): returned UNCUT and at the start it was
    // asked for, so the caller can refuse the drop as it was made rather than store half of
    // it. Moving the start forward first must not turn that into a half-cut row.
    expect(segmentDroppedRow(WINDOWS, { startMinutes: t('14:00'), durationMinutes: 600 })).toEqual([
      { startMinutes: t('14:00'), durationMinutes: 600 },
    ]);
  });
});
