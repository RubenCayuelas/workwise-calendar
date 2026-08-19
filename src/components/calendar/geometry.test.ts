// The week grid's arithmetic: geometry.ts and grouping.ts, both pure. Every block position, drop
// target and grouped unit comes out of them, so a mistake here moves the whole calendar at once.

import { describe, expect, it } from 'vitest';
import { MIN_MANUAL_ONLY_MINUTES, dayEndMinutes, manualWindowsOf } from '../../lib/manualWindow';
import type { DayShape, Gap, WorkPeriod } from '../../types';
import type { WeekBlock } from '../../lib/api-client';
import {
  BREAK_BAND_HEIGHT,
  MAX_PIXELS_PER_HOUR,
  MIN_PIXELS_PER_HOUR,
  SNAP_MINUTES,
  axisTicks,
  blockHoldsActions,
  createTimeline,
  clampDropStart,
  dateAtX,
  durationTo,
  emptyLabelMinutes,
  maxDurationFrom,
  nonWorkingBands,
  rankFor,
  slotAt,
  snapTo,
} from './geometry';
import { assignLanes, groupBlocks, packDay, segmentsOf, workingMinutesBetween } from './grouping';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented default: split shift 08:00-14:00 / 15:30-19:30, one hour of margin. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  // The hand view: the margins fused onto the periods, so 07:00-14:00 and 15:30-20:30.
  manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

describe('createTimeline', () => {
  it('maps the configured axis onto pixels', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });

    expect(timeline.startMinutes).toBe(420);
    expect(timeline.endMinutes).toBe(1230);
    // 13.5 h of clock, of which the 90-minute break is drawn as a 28 px seam: 810 - 90 + 28.
    expect(timeline.height).toBe(810 - 90 + BREAK_BAND_HEIGHT);
    expect(timeline.yOf(420)).toBe(0);
    expect(timeline.yOf(480)).toBe(60);
    expect(timeline.heightBetween(480, 630)).toBe(150);
    expect(timeline.minutesAt(60)).toBe(480);
  });

  it('never draws a block outside the axis, however short', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 15 minutes at 60px/h is 15px, which is fine; a 0-minute row must still be visible
    // rather than collapse into nothing the owner cannot click.
    expect(timeline.heightBetween(600, 600)).toBe(1);
    expect(timeline.yOf(0)).toBe(0);
    expect(timeline.yOf(1440)).toBe(timeline.height);
  });

  // Exactly which minutes are squeezed: the hole BETWEEN two periods, and nothing else. A margin
  // holds work the owner placed by hand, so it is drawn at the same scale as the morning.
  it('compresses the lunch break and nothing else', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });

    // 14:00 -> 15:30, 90 minutes of clock, drawn as a 28 px band.
    expect(timeline.heightBetween(14 * 60, 15 * 60 + 30)).toBe(BREAK_BAND_HEIGHT);
    // The two margins, an hour each, at the axis's own scale.
    expect(timeline.heightBetween(7 * 60, 8 * 60)).toBe(60);
    expect(timeline.heightBetween(19 * 60 + 30, 20 * 60 + 30)).toBe(60);
    // And the periods either side of it.
    expect(timeline.heightBetween(8 * 60, 14 * 60)).toBe(360);
    expect(timeline.heightBetween(15 * 60 + 30, 19 * 60 + 30)).toBe(240);
  });

  it('leaves the axis linear when the day has no break in it', () => {
    // The afternoon switched off: one period, two margins, nothing between two periods.
    const shape: DayShape = { ...SHAPE, periods: [MORNING], timelineEndMinutes: 15 * 60 };
    const timeline = createTimeline(shape, { pixelsPerHour: 60 });
    expect(timeline.height).toBe(8 * 60);
    expect(timeline.heightBetween(14 * 60, 15 * 60)).toBe(60);
  });

  it('never stretches a break that is already smaller than the band', () => {
    const periods: WorkPeriod[] = [
      { startMinutes: 8 * 60, endMinutes: 14 * 60 },
      { startMinutes: 14 * 60 + 10, endMinutes: 19 * 60 + 30 },
    ];
    // Ten minutes at 60px/h is 10px; compressing may only ever make a hole smaller.
    const timeline = createTimeline({ ...SHAPE, periods }, { pixelsPerHour: 60 });
    expect(timeline.heightBetween(14 * 60, 14 * 60 + 10)).toBe(10);
  });

  // The thing a piecewise axis could most easily break: no stored row straddles a break, so every
  // legal row lives in one uncompressed stretch and is `duration * pixelsPerMinute` to the pixel.
  it('draws every legal row at exactly its own minutes', () => {
    for (const fitHeight of [742, 751, 675, 999]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      for (const window of SHAPE.manualWindows) {
        for (let start = window.startMinutes; start < window.endMinutes; start += SNAP_MINUTES) {
          for (const duration of [15, 30, 60, 120, 240]) {
            if (start + duration > window.endMinutes) continue;
            expect(
              timeline.heightBetween(start, start + duration),
              `${start} + ${duration} at ${fitHeight}`,
            ).toBeCloseTo(duration * timeline.pixelsPerMinute, 9);
          }
        }
      }
    }
  });

  it('grows to cover work placed outside the configured day', () => {
    // A block dropped by hand at 21:00, or left over from a longer working day.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60, cover: [6 * 60 + 20, 21 * 60 + 15] });
    expect(timeline.startMinutes).toBe(6 * 60);
    expect(timeline.endMinutes).toBe(22 * 60);
  });

  it('fits the height it is given, within bounds', () => {
    // The band comes off the top and the 12 h of WORKING time share the rest: (675-28)/12.
    const fitted = createTimeline(SHAPE, { fitHeight: 675 });
    expect(fitted.pixelsPerMinute * 60).toBeCloseTo((675 - BREAK_BAND_HEIGHT) / 12);
    // Which is the whole point of compressing it: the same window, a taller working hour.
    expect(fitted.pixelsPerMinute).toBeGreaterThan(675 / 810);
    expect(fitted.height).toBe(675);
    // A tiny window scrolls rather than collapsing the day.
    expect(createTimeline(SHAPE, { fitHeight: 100 }).pixelsPerMinute * 60).toBe(MIN_PIXELS_PER_HOUR);
    // A very tall one stops stretching.
    expect(createTimeline(SHAPE, { fitHeight: 4000 }).pixelsPerMinute * 60).toBe(MAX_PIXELS_PER_HOUR);
  });

  it('clamps a start so the row still fits inside the day', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(timeline.clampStart(1200, 120)).toBe(1230 - 120);
    expect(timeline.clampStart(0, 120)).toBe(420);
  });

  it('survives a degenerate configuration instead of dividing by zero', () => {
    const timeline = createTimeline({ ...SHAPE, timelineStartMinutes: 600, timelineEndMinutes: 600 });
    expect(timeline.spanMinutes).toBe(60);
    expect(Number.isFinite(timeline.height)).toBe(true);
  });

  // The invariant the drag layer rests on: the pixel a minute is DRAWN at reads back as that
  // minute. Over every minute, not a sample, because the axis is piecewise — one scale inside the
  // periods and another inside the band — so the two directions must agree on every seam too.
  it('reads back every minute of the axis at the pixel it was drawn at', () => {
    for (const fitHeight of [742, 751, 675, 700, 813, 999]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      for (let minutes = timeline.startMinutes; minutes <= timeline.endMinutes; minutes += 1) {
        expect(timeline.minutesAt(timeline.yOf(minutes)), `${minutes} at ${fitHeight}`).toBe(minutes);
      }
    }
  });

  // A compressed minute is worth ~0.31 px, so folding two onto one pixel would stall a drag
  // through the band and then jump it.
  it('never runs backwards, at any scale', () => {
    for (const fitHeight of [742, 751, 675, 700, 813, 999]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      for (let minutes = timeline.startMinutes; minutes < timeline.endMinutes; minutes += 1) {
        expect(timeline.yOf(minutes + 1), `${minutes} at ${fitHeight}`).toBeGreaterThan(
          timeline.yOf(minutes),
        );
      }
      expect(timeline.yOf(timeline.startMinutes)).toBe(0);
      expect(Math.round(timeline.yOf(timeline.endMinutes))).toBe(timeline.height);
    }
  });

  // The same properties at heights the running app really fits, which are not round numbers:
  // 679 / 547 / 859 are 1440x900, 1366x768 and 1920x1080, at 54.25, 43.25 and 69.25 px/h. 399 and
  // 339 are short windows where the scale is CLAMPED to the floor — the only place the two
  // directions could round differently while every hand-picked height passed.
  it('is exact at the heights the running app actually fits, clamped scales included', () => {
    for (const fitHeight of [679, 547, 859, 399, 339]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      const at = `fitHeight ${fitHeight}`;

      // A flat 28 px whatever the scale. To 9 decimals, not exactly: `heightBetween` subtracts two
      // accumulated origins, so at 69.25 px/h it lands on 28.000000000000057.
      expect(timeline.heightBetween(14 * 60, 15 * 60 + 30), at).toBeCloseTo(BREAK_BAND_HEIGHT, 9);

      for (let minutes = timeline.startMinutes; minutes <= timeline.endMinutes; minutes += 1) {
        // The pixel a minute is drawn at reads back as that minute.
        expect(timeline.minutesAt(timeline.yOf(minutes)), `${minutes} at ${at}`).toBe(minutes);
        // And the axis never folds or runs backwards, band included.
        if (minutes < timeline.endMinutes) {
          expect(timeline.yOf(minutes + 1), `${minutes} at ${at}`).toBeGreaterThan(
            timeline.yOf(minutes),
          );
        }
      }

      // Every legal row is drawn at exactly its own minutes, stepped by the MINUTE: a stored row's
      // start is not obliged to be a quarter past anything.
      for (const window of SHAPE.manualWindows) {
        for (let start = window.startMinutes; start < window.endMinutes; start += 1) {
          for (const duration of [15, 30, 45, 60, 90, 120, 240, 360]) {
            if (start + duration > window.endMinutes) continue;
            expect(
              timeline.heightBetween(start, start + duration),
              `${start} + ${duration} at ${at}`,
            ).toBeCloseTo(duration * timeline.pixelsPerMinute, 9);
          }
        }
      }
    }
  });

  // The clamp's purpose: the axis must never answer "the day is shorter" when the WINDOW is.
  it('keeps the working hour legible on a short window instead of fitting it', () => {
    const short = createTimeline(SHAPE, { fitHeight: 339 });
    expect(short.pixelsPerMinute * 60).toBe(MIN_PIXELS_PER_HOUR);
    // 12 h of working time at the floor, plus the band: taller than the space there was,
    // so the column scrolls rather than compressing an hour into nothing.
    expect(short.height).toBe(MIN_PIXELS_PER_HOUR * 12 + BREAK_BAND_HEIGHT);
    expect(short.height).toBeGreaterThan(339);
  });

  // The band is a paint decision and `durationTo`'s dead zone an arithmetic one: compressing the
  // first must not create a second, so every minute in the comida still reads back as itself.
  it('keeps the compressed band readable in both directions, minute by minute', () => {
    const timeline = createTimeline(SHAPE, { fitHeight: 742 });
    for (let minutes = 14 * 60; minutes <= 15 * 60 + 30; minutes += 1) {
      expect(timeline.minutesAt(timeline.yOf(minutes))).toBe(minutes);
    }
    // The seams themselves: the last minute of the morning and the first of the afternoon
    // are converted by the segment they open, so neither can round into its neighbour.
    expect(timeline.yOf(14 * 60)).toBeCloseTo(timeline.heightBetween(7 * 60, 14 * 60), 9);
    expect(timeline.minutesAt(timeline.yOf(14 * 60))).toBe(14 * 60);
    expect(timeline.minutesAt(timeline.yOf(15 * 60 + 30))).toBe(15 * 60 + 30);
  });
});

describe('nonWorkingBands', () => {
  it('greys the two margins and the lunch break', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(nonWorkingBands(SHAPE.periods, timeline)).toEqual([
      { kind: 'marginTop', startMinutes: 420, endMinutes: 480 },
      { kind: 'lunch', startMinutes: 840, endMinutes: 930 },
      { kind: 'marginBottom', startMinutes: 1170, endMinutes: 1230 },
    ]);
  });

  it('has no lunch band when the afternoon is switched off', () => {
    const shape: DayShape = { ...SHAPE, periods: [MORNING], timelineEndMinutes: 15 * 60 };
    const bands = nonWorkingBands(shape.periods, createTimeline(shape, { pixelsPerHour: 60 }));
    expect(bands.map((band) => band.kind)).toEqual(['marginTop', 'marginBottom']);
  });
});

describe('emptyLabelMinutes', () => {
  it('sits in the middle of the morning, not on the 14:00 rule', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // The column's own midpoint is 13:45 — fifteen minutes above the boundary and on
    // the edge of the lunch band, which is why "libre" read as debris. 11:00 is inside
    // the day's longest working stretch, clear of every band and every rule.
    expect(emptyLabelMinutes(SHAPE.periods, timeline)).toBe(11 * 60);
    expect(emptyLabelMinutes(SHAPE.periods, timeline)).not.toBe(
      (timeline.startMinutes + timeline.endMinutes) / 2,
    );
  });

  it('follows the longest period when the afternoon is the long one', () => {
    const periods: WorkPeriod[] = [
      { startMinutes: 8 * 60, endMinutes: 10 * 60 },
      { startMinutes: 12 * 60, endMinutes: 20 * 60 },
    ];
    const timeline = createTimeline({ ...SHAPE, periods }, { pixelsPerHour: 60 });
    expect(emptyLabelMinutes(periods, timeline)).toBe(16 * 60);
  });

  it('falls back to the middle of the axis on a day with no working stretch', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(emptyLabelMinutes([], timeline)).toBe((timeline.startMinutes + timeline.endMinutes) / 2);
  });
});

describe('axisTicks', () => {
  it('labels every hour of the day, and both edges of every period', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 07:00 08:00 09:00 … 14:00, then 15:30 16:00 … 19:30 20:00 20:30.
    expect(axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes)).toEqual([
      420, 480, 540, 600, 660, 720, 780, 840, 930, 960, 1020, 1080, 1140, 1170, 1200, 1230,
    ]);
  });

  it('leaves the compressed band to its own two edges', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const minutes = axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes);
    // 28 px of band cannot carry a third label between 14:00 and 15:30, so 15:00 goes — the only
    // hour of this shift that is dropped.
    expect(minutes).not.toContain(15 * 60);
    expect(minutes.filter((tick) => tick % 60 === 0 && tick !== 15 * 60)).toHaveLength(13);
  });

  // At a 655 px axis, 20:00 sits 26 px above 20:30 — far apart by any centre test, and printed
  // through it: the last label is anchored by its BOTTOM, so it reaches a whole label height up.
  it('drops the hour the label at the foot of the axis would print over', () => {
    const timeline = createTimeline(SHAPE, { fitHeight: 655 });
    const minutes = axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes);
    expect(minutes).toContain(19 * 60 + 30);
    expect(minutes).toContain(20 * 60 + 30);
    expect(minutes).not.toContain(20 * 60);
    // The morning is untouched — every hour of it is still there.
    expect(minutes).toContain(9 * 60);
    expect(minutes).toContain(13 * 60);
  });

  it('drops an hour a period edge would print over, and never the edge', () => {
    // A shift starting at 15:50: 16:00 is 10 minutes below it, which at 60px/h is 10px.
    const periods: WorkPeriod[] = [MORNING, { startMinutes: 15 * 60 + 50, endMinutes: 19 * 60 + 30 }];
    const timeline = createTimeline({ ...SHAPE, periods }, { pixelsPerHour: 60 });
    const minutes = axisTicks(periods, timeline).map((tick) => tick.minutes);
    expect(minutes).toContain(15 * 60 + 50);
    expect(minutes).not.toContain(16 * 60);
    expect(minutes).toContain(17 * 60);
  });

  // A 10-minute break is drawn at its own 9 px (compressing only ever shrinks a hole), and two
  // 18 px labels do not fit in 9 px. The EARLIER edge survives: it is when work stops.
  it('keeps the earlier of two period edges too close together to both be read', () => {
    const periods: WorkPeriod[] = [
      { startMinutes: 8 * 60, endMinutes: 14 * 60 },
      { startMinutes: 14 * 60 + 10, endMinutes: 18 * 60 + 10 },
    ];
    const shape: DayShape = {
      ...SHAPE,
      periods,
      manualWindows: manualWindowsOf(periods, 60, 60),
      timelineEndMinutes: 19 * 60 + 10,
    };
    const minutes = axisTicks(periods, createTimeline(shape, { fitHeight: 679 })).map((t) => t.minutes);

    expect(minutes).toContain(14 * 60);
    expect(minutes).not.toContain(14 * 60 + 10);
    // The rest of the day is unaffected: the other two edges and the ordinary hours.
    expect(minutes).toContain(8 * 60);
    expect(minutes).toContain(18 * 60 + 10);
    expect(minutes).toContain(10 * 60);
  });

  // An axis end is only the outer lip of a grey margin, so a period edge outranks it: at the scale
  // floor a 0.5 h margin is 21 px, less than one label, and one of 07:30 / 08:00 has to go.
  it('gives up the end of the axis rather than the hour work starts at', () => {
    const shape: DayShape = {
      ...SHAPE,
      manualWindows: manualWindowsOf([MORNING, AFTERNOON], 30, 30),
      marginTopMinutes: 30,
      marginBottomMinutes: 30,
      timelineStartMinutes: 7 * 60 + 30,
      timelineEndMinutes: 20 * 60,
    };
    // A short window, so the scale is clamped to the floor and half an hour is 21 px.
    const timeline = createTimeline(shape, { fitHeight: 300 });
    expect(timeline.pixelsPerMinute * 60).toBe(MIN_PIXELS_PER_HOUR);
    const minutes = axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes);

    expect(minutes).toContain(8 * 60);
    expect(minutes).not.toContain(7 * 60 + 30);
    // And the same at the foot of the axis: 19:30 is the edge, 20:00 the lip.
    expect(minutes).toContain(19 * 60 + 30);
    expect(minutes).not.toContain(20 * 60);
  });

  // The property the cases above are examples of, over every shift Settings can produce: a label
  // printed through another is the defect, and which one gives way is only the policy.
  it('never leaves two labels overlapping, at any shift or scale', () => {
    const shifts: WorkPeriod[][] = [
      [MORNING, AFTERNOON],
      [MORNING],
      [{ startMinutes: 8 * 60, endMinutes: 14 * 60 }, { startMinutes: 14 * 60 + 10, endMinutes: 18 * 60 + 10 }],
      [{ startMinutes: 8 * 60, endMinutes: 14 * 60 }, { startMinutes: 15 * 60 + 50, endMinutes: 19 * 60 + 30 }],
      [{ startMinutes: 6 * 60 + 30, endMinutes: 12 * 60 + 30 }, { startMinutes: 13 * 60, endMinutes: 21 * 60 }],
    ];
    for (const periods of shifts) {
      for (const margin of [0, 30, 60, 120]) {
        for (const fitHeight of [300, 339, 400, 547, 679, 859, 1400]) {
          const windows = manualWindowsOf(periods, margin, margin);
          const shape: DayShape = {
            ...SHAPE,
            periods,
            manualWindows: windows,
            marginTopMinutes: margin,
            marginBottomMinutes: margin,
            timelineStartMinutes: windows[0].startMinutes,
            timelineEndMinutes: windows[windows.length - 1].endMinutes,
          };
          const timeline = createTimeline(shape, { fitHeight });
          const ticks = axisTicks(periods, timeline);
          const boxes = ticks.map((tick) => {
            const y = timeline.yOf(tick.minutes);
            if (tick.minutes <= timeline.startMinutes) return { top: y, bottom: y + 18 };
            if (tick.minutes >= timeline.endMinutes) return { top: y - 18, bottom: y };
            return { top: y - 9, bottom: y + 9 };
          });
          const where = `${JSON.stringify(periods)} margin ${margin} at ${fitHeight}`;
          for (let i = 1; i < boxes.length; i += 1) {
            expect(boxes[i].top, `${where}: ${ticks[i - 1].minutes} then ${ticks[i].minutes}`)
              .toBeGreaterThanOrEqual(boxes[i - 1].bottom);
          }
          // Dropping a label is only ever forced by another already standing in its box.
          expect(ticks.length, where).toBeGreaterThan(1);
        }
      }
    }
  });

  it('marks the edges of the day as boundaries and the rest as interior', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const ticks = new Map(axisTicks(SHAPE.periods, timeline).map((tick) => [tick.minutes, tick.boundary]));
    expect(ticks.get(480)).toBe(true);
    expect(ticks.get(840)).toBe(true);
    expect(ticks.get(660)).toBe(false);
    expect(ticks.get(1020)).toBe(false);
  });
});

describe('drop targets', () => {
  const columns = [
    { date: '2026-08-10', left: 100, width: 200 },
    { date: '2026-08-11', left: 300, width: 200 },
    { date: '2026-08-15', left: 500, width: 100 },
  ];

  it('finds the column under the pointer, and none outside the grid', () => {
    expect(dateAtX(150, columns)).toBe('2026-08-10');
    expect(dateAtX(300, columns)).toBe('2026-08-11');
    expect(dateAtX(560, columns)).toBe('2026-08-15');
    expect(dateAtX(90, columns)).toBeUndefined();
    expect(dateAtX(700, columns)).toBeUndefined();
  });

  it('snaps a drop to the quarter hour', () => {
    expect(snapTo(487)).toBe(480);
    expect(snapTo(496)).toBe(495);
  });

  it('reads a pointer position as a date and a minute', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // `frame` is what the edge zones are measured from; `slotAt` never reads it.
    const frame = { left: 100, right: 600, leftZone: 58, rightZone: 40 };
    const hit = slotAt({ x: 350, y: 1000 + 67 }, { top: 1000, columns, frame }, timeline);
    expect(hit).toEqual({ date: '2026-08-11', exactMinutes: 487, snappedMinutes: 480 });
  });

  it('breaks a rank tie BEFORE the row it landed on', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // The clamp is the caller's, so the nudge obeys whatever keeps the row inside the day.
    const onAxis = (minutes: number): number => timeline.clampStart(minutes);
    // No tie: the snapped value stands.
    expect(rankFor(480, [600], onAxis, false)).toBe(480);
    // Landing on a start means "put me before this one", which is what a row's upper third aims at.
    expect(rankFor(480, [480], onAxis, false)).toBe(479);
    // A tie on the very first minute of the axis can only go the other way.
    expect(rankFor(420, [420], onAxis, false)).toBe(421);
  });

  it('never nudges a PINNED placement, whose minute is the clock and not a rank', () => {
    // Nudged, a Saturday drop released on 10:00 stored 09:59 and durations of 2,02 h and 1,98 h.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const onAxis = (minutes: number): number => timeline.clampStart(minutes);
    expect(rankFor(600, [600], onAxis, true)).toBe(600);
  });
});

/** The day's own end, which is what a resize is capped by. Never the axis's. */
const REACH = { endOfDayMinutes: dayEndMinutes(SHAPE.manualWindows) };

describe('clampDropStart', () => {
  const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });

  it('leaves a release that fits exactly where it was made', () => {
    expect(clampDropStart(SHAPE.manualWindows, 8 * 60, 360, timeline)).toBe(8 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 13 * 60, 360, timeline)).toBe(13 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 7 * 60, 720, timeline)).toBe(7 * 60);
  });

  it('pulls a release that would run past the end of the day back to the latest start', () => {
    // 13:15 + 6 h net reaches 20:45 — the drop that broke invariant 3.
    expect(clampDropStart(SHAPE.manualWindows, 13 * 60 + 15, 360, timeline)).toBe(13 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 19 * 60, 600, timeline)).toBe(9 * 60);
  });

  it('keeps the axis as the other bound', () => {
    expect(clampDropStart(SHAPE.manualWindows, 6 * 60, 60, timeline)).toBe(7 * 60);
  });

  it('measures a release in the lunch band from 15:30, which is where it will start', () => {
    // 6 h aimed at the band is 6 h from 15:30, so it reaches 21:30 and is clamped like any overrun.
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60, 360, timeline)).toBe(13 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60 + 30, 360, timeline)).toBe(13 * 60);
    // Short enough to fit from 15:30, the release stands: `dropLanding` turns it into 15:30.
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60, 120, timeline)).toBe(14 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 15 * 60 + 29, 300, timeline)).toBe(15 * 60 + 29);
    // 8 h from 14:30 would reach 23:30, so it is clamped like any other overrun.
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60 + 30, 480, timeline)).toBe(11 * 60);
  });

  it('does not consult the widened axis, which the overrun itself opened', () => {
    // The axis grows to 22:00 to keep a row visible; the DAY still ends at 20:30.
    const widened = createTimeline(SHAPE, { pixelsPerHour: 60, cover: [22 * 60] });
    expect(clampDropStart(SHAPE.manualWindows, 15 * 60, 360, widened)).toBe(13 * 60);
  });
});

describe('maxDurationFrom', () => {
  it('carries a row past the lunch break to the end of the last manual window', () => {
    // The limit is the end of the day's last window (20:30 here) in NET working minutes: two hours
    // of morning plus five of afternoon-and-margin, not a stop at 14:00.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(maxDurationFrom(12 * 60, SHAPE.manualWindows, REACH)).toBe(120 + 300);
    expect(maxDurationFrom(18 * 60, SHAPE.manualWindows, REACH)).toBe(150);
    // A margin is inside the window, so there is no boundary between 07:00 and the morning.
    expect(maxDurationFrom(7 * 60, SHAPE.manualWindows, REACH)).toBe(420 + 300);
  });

  it('measures a row that starts in the break from the next working minute', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // A row inside the band reaches as far as one at 15:30: that is where its hours begin
    // (`firstWorkingMinute`) and where the write path stores them.
    expect(maxDurationFrom(14 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(300);
    expect(maxDurationFrom(14 * 60, SHAPE.manualWindows, REACH)).toBe(300);
    // Past the last window there is no next working minute: the hole alone, to the axis end.
    expect(maxDurationFrom(20 * 60, SHAPE.manualWindows, REACH)).toBe(30);
  });

  it('never returns less than one snap step', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(maxDurationFrom(20 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(SNAP_MINUTES);
  });
});

describe('durationTo', () => {
  const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });

  it("is the owner's worked example: 10:00 dragged to 17:30 is 6 h", () => {
    // 10:00-14:00 plus 15:30-17:30: four hours of morning and two of afternoon, not 7.5 h.
    expect(durationTo(10 * 60, 17 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(6 * 60);
  });

  it('gives the lunch break away for free: anywhere inside it is the same 4 h', () => {
    for (const pointer of [14 * 60, 14 * 60 + 15, 14 * 60 + 45, 15 * 60 + 30]) {
      expect(durationTo(10 * 60, pointer, SHAPE.manualWindows, REACH)).toBe(4 * 60);
    }
  });

  it('shrinks symmetrically, back across the break', () => {
    expect(durationTo(10 * 60, 16 * 60, SHAPE.manualWindows, REACH)).toBe(4 * 60 + 30);
    expect(durationTo(10 * 60, 13 * 60, SHAPE.manualWindows, REACH)).toBe(3 * 60);
    expect(durationTo(10 * 60, 10 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(30);
  });

  it('reaches into both margins, which is the only way a hand can use them', () => {
    // The bottom margin: 19:30 is the last period's end, 20:30 the axis's.
    expect(durationTo(18 * 60, 20 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(150);
    // And the top one, which continues straight into the morning with no seam.
    expect(durationTo(7 * 60, 9 * 60, SHAPE.manualWindows, REACH)).toBe(120);
  });

  it('snaps on the clock and never collapses the row', () => {
    expect(durationTo(10 * 60, 12 * 60 + 7, SHAPE.manualWindows, REACH)).toBe(120);
    expect(durationTo(10 * 60, 12 * 60 + 8, SHAPE.manualWindows, REACH)).toBe(135);
    // Dragged above its own start, or into the band right after it.
    expect(durationTo(13 * 60, 11 * 60, SHAPE.manualWindows, REACH)).toBe(SNAP_MINUTES);
    // A row INSIDE the band: its hours start at 15:30, so nothing in the band is a length at all
    // and the floor answers — the dead zone, now read from the row's own start too.
    expect(durationTo(14 * 60 + 30, 15 * 60, SHAPE.manualWindows, REACH)).toBe(SNAP_MINUTES);
    expect(durationTo(14 * 60 + 30, 16 * 60, SHAPE.manualWindows, REACH)).toBe(30);
  });

  it('is the same resolution the pin threshold is stated in', () => {
    // A drop's rank is nudged by a single minute to break a tie, so one minute of margin is not a
    // request for the margin: the pin threshold and the snap step have to move together.
    expect(MIN_MANUAL_ONLY_MINUTES).toBe(SNAP_MINUTES);
  });

  it('caps at the end of the day, wherever the pointer went', () => {
    expect(durationTo(10 * 60, 23 * 60, SHAPE.manualWindows, REACH)).toBe(
      maxDurationFrom(10 * 60, SHAPE.manualWindows, REACH),
    );
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

let sequence = 0;

function block(partial: Partial<WeekBlock> & { startMinutes: number; durationMinutes: number }): WeekBlock {
  sequence += 1;
  const projectId = partial.projectId ?? 'job-a';
  return {
    id: partial.id ?? `block-${sequence}`,
    projectId,
    date: partial.date ?? '2026-08-11',
    startMinutes: partial.startMinutes,
    durationMinutes: partial.durationMinutes,
    locked: partial.locked ?? false,
    createdAt: partial.createdAt ?? `2026-08-11 08:00:0${sequence}`,
    updatedAt: partial.updatedAt ?? '2026-08-11 08:00:00',
    project: partial.project ?? { id: projectId, name: projectId, color: '#185FA5' },
  };
}

describe('workingMinutesBetween', () => {
  it('is zero across the lunch break and across a margin', () => {
    expect(workingMinutesBetween(SHAPE.periods, 840, 930)).toBe(0);
    expect(workingMinutesBetween(SHAPE.periods, 1170, 1230)).toBe(0);
  });

  it('counts the working time a gap in the middle of a period holds', () => {
    expect(workingMinutesBetween(SHAPE.periods, 660, 720)).toBe(60);
  });
});

describe('groupBlocks', () => {
  it('joins the two halves of a job around the lunch break into one unit', () => {
    const groups = groupBlocks(
      [
        block({ startMinutes: 780, durationMinutes: 60 }),
        block({ startMinutes: 930, durationMinutes: 120 }),
      ],
      SHAPE.manualWindows,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].totalMinutes).toBe(180);
    expect(groups[0].startMinutes).toBe(780);
    expect(groups[0].endMinutes).toBe(1050);
    expect(segmentsOf(groups).map((segment) => [segment.isFirst, segment.isLast])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('does not join two jobs that merely touch', () => {
    const groups = groupBlocks(
      [
        block({ projectId: 'job-a', startMinutes: 480, durationMinutes: 120 }),
        block({ projectId: 'job-b', startMinutes: 600, durationMinutes: 120 }),
      ],
      SHAPE.manualWindows,
    );
    expect(groups).toHaveLength(2);
  });

  it('does not join across a MARGIN either, which the periods alone would', () => {
    // Half an hour of margin sits between them and a hand can work it, so they are two units.
    // Read against the PERIODS the pair looks contiguous, which is the trap.
    const rows = [
      block({ startMinutes: 420, durationMinutes: 30 }),
      block({ startMinutes: 480, durationMinutes: 60 }),
    ];
    expect(groupBlocks(rows, SHAPE.manualWindows)).toHaveLength(2);
    expect(groupBlocks(rows, SHAPE.periods)).toHaveLength(1);
  });

  it('joins a margin row to the period below it when they touch', () => {
    // One unbroken rectangle from the margin into the morning: a stored margin drop.
    const groups = groupBlocks(
      [
        block({ startMinutes: 420, durationMinutes: 60 }),
        block({ startMinutes: 480, durationMinutes: 120 }),
      ],
      SHAPE.manualWindows,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].totalMinutes).toBe(180);
  });

  it('does not join across a break that holds working time', () => {
    // An hour of working time between them (a gap, or another job), so they are two units.
    const groups = groupBlocks(
      [
        block({ startMinutes: 480, durationMinutes: 120 }),
        block({ startMinutes: 660, durationMinutes: 60 }),
      ],
      SHAPE.manualWindows,
    );
    expect(groups).toHaveLength(2);
  });

  it('reports a unit as locked only when every one of its rows is', () => {
    const groups = groupBlocks(
      [
        block({ startMinutes: 780, durationMinutes: 60, locked: true }),
        block({ startMinutes: 930, durationMinutes: 120, locked: false }),
      ],
      SHAPE.manualWindows,
    );
    expect(groups[0].locked).toBe(false);
  });
});

describe('lanes', () => {
  it('leaves a day with no overlap at full width', () => {
    const placements = assignLanes([
      { id: 'a', startMinutes: 480, endMinutes: 600 },
      { id: 'b', startMinutes: 600, endMinutes: 720 },
    ]);
    expect([...placements.values()]).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
  });

  it('splits the column between rows that overlap, which only a human can create', () => {
    const placements = assignLanes([
      { id: 'a', startMinutes: 480, endMinutes: 660 },
      { id: 'b', startMinutes: 540, endMinutes: 720 },
    ]);
    expect(placements.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(placements.get('b')).toEqual({ lane: 1, lanes: 2 });
  });

  it('packs gaps and blocks together, since they share the column', () => {
    const gap: Gap = {
      id: 'gap-1',
      date: '2026-08-11',
      startMinutes: 540,
      durationMinutes: 60,
      createdAt: '2026-08-11 08:00:00',
      updatedAt: '2026-08-11 08:00:00',
    };
    const groups = groupBlocks([block({ startMinutes: 480, durationMinutes: 120 })], SHAPE.manualWindows);
    const placements = packDay(groups, [gap]);
    expect(placements.get(groups[0].id)?.lanes).toBe(2);
    expect(placements.get('gap-1')?.lanes).toBe(2);
  });
});

// A block tall enough to hold its bar and too NARROW to leave anything of it to press. Measured: a
// weekend column is 116 px at its floor, so a block is 112 px and a five-button bar 130 px of that.
describe('blockHoldsActions', () => {
  it('keeps the bar inside a block with room left for its own name', () => {
    expect(blockHoldsActions(260, 5)).toBe(true);
    expect(blockHoldsActions(180, 3)).toBe(true);
  });

  it('hands the bar out when it would take the whole top of the block', () => {
    // A weekend column at its 116 px floor, showing every action.
    expect(blockHoldsActions(112, 5)).toBe(false);
    // And a weekday block once two lanes share the column.
    expect(blockHoldsActions(130, 4)).toBe(false);
  });

  it('leaves the bar where the wireframe puts it until the grid has been measured', () => {
    expect(blockHoldsActions(null, 5)).toBe(true);
  });
});
