/**
 * The week grid's arithmetic, pinned.
 *
 * These two modules are pure on purpose: every block position, every drop target and
 * every grouped unit on screen comes out of them, and a mistake here moves the whole
 * calendar at once. The cases below are the ones that were reasoned about while building
 * the grid — the wireframe's axis, the lunch break, and the rank tie that makes a drop
 * look like it did nothing.
 */

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

  /**
   * THE BREAK BETWEEN TWO PERIODS IS A SEAM, THE MARGINS ARE THE DAY.
   *
   * The owner asked for both at once: «haz el hueco del medio para la comida pequeño […] es
   * despreciable ya que no podemos trabajar ahí», and «coloca todas las horas». The second
   * is paid for by the first, so what is asserted here is exactly which minutes are
   * squeezed — the hole BETWEEN the periods, and nothing else. The margins hold work the
   * owner placed by hand and are drawn at the same scale as the morning.
   */
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

  /**
   * A ROW'S RECTANGLE IS ITS OWN MINUTES, still — the thing a piecewise axis could most
   * easily break, and the one it may not. No stored row straddles a break (CLAUDE.md,
   * invariant 3), so every legal row lives inside one uncompressed stretch and its drawn
   * height is `duration * pixelsPerMinute` to the pixel, wherever in the day it sits.
   */
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

  /**
   * THE INVARIANT THE WHOLE DRAG LAYER RESTS ON: the pixel a minute is DRAWN at is the
   * pixel that READS BACK as that minute. Every gesture is "the block's edge is drawn
   * here, I put the pointer there" — if the two directions disagree by more than half a
   * `SNAP_MINUTES` anywhere on the axis, a release lands on a quarter of an hour the
   * owner did not choose.
   *
   * Asserted over every minute of the axis, not a sample. SINCE THE AXIS IS PIECEWISE
   * (2026-08-17) that is no longer a formality: pixels per minute is one number inside the
   * periods and the margins and another inside the compressed break, so the two directions
   * have to agree segment by segment AND on every seam between two of them. A drift of a
   * single percent inside the band is exactly the shape of defect that cost this project a
   * round already (*One Axis Per Gesture*), and it would be invisible until a resize
   * crossed the comida. The fitted heights are the ones the shop's own window produces,
   * and their scales are deliberately not round.
   */
  it('reads back every minute of the axis at the pixel it was drawn at', () => {
    for (const fitHeight of [742, 751, 675, 700, 813, 999]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      for (let minutes = timeline.startMinutes; minutes <= timeline.endMinutes; minutes += 1) {
        expect(timeline.minutesAt(timeline.yOf(minutes)), `${minutes} at ${fitHeight}`).toBe(minutes);
      }
    }
  });

  /**
   * And in the other direction, which the compression makes a real question: the axis must
   * never fold two minutes onto one pixel or run backwards, or a drag through the band
   * would stall and then jump. A compressed minute is worth ~0.31 px, so this is a much
   * finer claim than it was.
   */
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

  /**
   * THE SAME THREE PROPERTIES AT THE HEIGHTS THE APP REALLY PRODUCES — measured off the
   * running calendar, 2026-08-17, rather than chosen.
   *
   * The lists above are round numbers picked by hand, and they miss the two cases a real
   * window walks into. `fitHeight` is `areaHeight - DAY_HEADER_ALLOWANCE` with `areaHeight`
   * rounded by the ResizeObserver (`useElementHeight`), so it is an integer — but WHICH
   * integers matter:
   *
   * - 679 / 547 / 859 are the shop's 1440x900, a 1366x768 laptop and a 1920x1080 monitor.
   *   Their scales are 54.25, 43.25 and 69.25 px/h: fitted, and deliberately not round.
   * - 399 and 339 are a SHORT window (1440x620, 1280x560), where the fitted scale falls
   *   under `MIN_PIXELS_PER_HOUR` and is CLAMPED. That is new ground for the piecewise axis
   *   and the one case none of the numbers above reach: clamping makes `pixelsPerMinute`
   *   exactly 0.7, the axis stops filling the height and the column scrolls instead, and
   *   the compressed band is then 28 px out of 532 rather than out of 679. A clamped scale
   *   is also the only place the two directions could round differently while every
   *   hand-picked height passed.
   *
   * Asserted together because they are one claim — the axis is a RULER — and a ruler that
   * is exact at one height and not at another is not a ruler.
   */
  it('is exact at the heights the running app actually fits, clamped scales included', () => {
    for (const fitHeight of [679, 547, 859, 399, 339]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      const at = `fitHeight ${fitHeight}`;

      // The band is a flat 28 px whatever the scale, which is what pays for the labels.
      // To 9 decimals rather than exactly: `heightBetween` is a difference of two
      // accumulated segment origins, so at 69.25 px/h it lands on 28.000000000000057. That
      // is a float residue and not a scale error — 6e-14 of a pixel — and asserting
      // equality here would only be asserting that the arithmetic happened to be lucky.
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

      // Every legal row — one that starts on any minute of a manual window and ends inside
      // the same one, which is every row the data model allows — is drawn at exactly its
      // own minutes. Stepped by the minute rather than by the snap, because a stored row's
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

  /**
   * A SHORT WINDOW STOPS FITTING AND STARTS SCROLLING, which is the clamp's whole purpose:
   * the axis must never answer "the day is shorter" when what happened is "the window is".
   */
  it('keeps the working hour legible on a short window instead of fitting it', () => {
    const short = createTimeline(SHAPE, { fitHeight: 339 });
    expect(short.pixelsPerMinute * 60).toBe(MIN_PIXELS_PER_HOUR);
    // 12 h of working time at the floor, plus the band: taller than the space there was,
    // so the column scrolls rather than compressing an hour into nothing.
    expect(short.height).toBe(MIN_PIXELS_PER_HOUR * 12 + BREAK_BAND_HEIGHT);
    expect(short.height).toBeGreaterThan(339);
  });

  /**
   * The band is a paint decision and `durationTo`'s dead zone is an arithmetic one, and
   * compressing the first must not have created a second: inside the comida every minute
   * still reads back as itself, at ~3.2 minutes to the pixel. What a pointer in there MEANS
   * is unchanged — see `BREAK_BAND_HEIGHT`.
   */
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
    // «En la división de horas de 8 a 11 es un salto muy grande, coloca todas las horas»
    // (2026-08-17). 07:00 08:00 09:00 … 14:00, then 15:30 16:00 … 19:30 20:00 20:30.
    expect(axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes)).toEqual([
      420, 480, 540, 600, 660, 720, 780, 840, 930, 960, 1020, 1080, 1140, 1170, 1200, 1230,
    ]);
  });

  it('leaves the compressed band to its own two edges', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const minutes = axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes);
    // 15:00 is a whole hour and it is inside the comida: 28 px of band cannot carry a third
    // label between 14:00 and 15:30, and a time printed on top of another is worse than a
    // missing one. It is the only hour of this shift that is dropped.
    expect(minutes).not.toContain(15 * 60);
    expect(minutes.filter((tick) => tick % 60 === 0 && tick !== 15 * 60)).toHaveLength(13);
  });

  /**
   * MEASURED ON THE RUNNING APP, 2026-08-17, at a 876 px window: the axis fits 655 px, an
   * hour is 52.25 px, and 20:00 sits 26 px above 20:30 — far enough apart by any
   * centre-to-centre test, and printed one on top of the other all the same. The label at
   * the very bottom of the axis is anchored by its BOTTOM (`.tickLast`), so it reaches a
   * whole label height up into the column instead of half of one. 19:30 is a period edge
   * and stays whatever happens.
   */
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

  /**
   * TWO PERIOD EDGES CAN COLLIDE WITH EACH OTHER, and then one of them has to go.
   *
   * "Never drop a period edge" was unconditional, and this is the configuration that made it
   * impossible to keep: Settings accepts `08:00-14:00` then `14:10-18:10`, and the band
   * deliberately draws that 10-minute break at its own 9 px rather than stretching it to
   * `BREAK_BAND_HEIGHT` ("compressing may only ever make a hole smaller"). Two 18 px labels
   * do not fit in 9 px. Measured on the running app, 2026-08-17: `14:00` and `14:10` printed
   * one through the other, an unreadable smudge down the side of the calendar.
   *
   * The EARLIER edge survives, because it is the moment work stops. The boundary itself is
   * not lost with its label — `.bandBreak` draws a solid rule on both of its own edges.
   */
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

  /**
   * AN AXIS END IS ONLY THE OUTER LIP OF A GREY MARGIN, so a period edge outranks it.
   *
   * Margins step in half hours (`HOUR_STEP` = 0.5), so a 0.5 h margin is two clicks away in
   * Settings, and at `MIN_PIXELS_PER_HOUR` half an hour is 21 px — less than one label. One
   * of `07:30` and `08:00` has to go, and dropping `08:00` to keep the top of a band nobody
   * works in would be the wrong way round.
   */
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

  /**
   * WHATEVER IS DROPPED, NOTHING LEFT ON THE AXIS MAY OVERLAP ANYTHING ELSE — the property
   * the individual cases above are examples of, over every shift Settings can produce and
   * every scale the window can ask for. A label printed through another is the defect; which
   * one gives way is the policy.
   */
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
          // And every period edge that COULD be shown still is: dropping one is only ever
          // forced by another label already standing in its box.
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
    // `frame` is what the edge zones are measured from and `slotAt` never reads it; the
    // columns' own span is what it would be on a window wide enough for the whole week.
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
    // Landing on a start means "put me before this one" (owner, 2026-08-13) — and since
    // thirds it is the ORDINARY way to say it: the upper third of a row aims at its start.
    expect(rankFor(480, [480], onAxis, false)).toBe(479);
    // A tie on the very first minute of the axis can only go the other way.
    expect(rankFor(420, [420], onAxis, false)).toBe(421);
  });

  it('never nudges a PINNED placement, whose minute is the clock and not a rank', () => {
    // Matrix N-3/N-4: nudged, a Saturday drop released on 10:00 came back stored at 09:59
    // and the day's durations read 2,02 h and 1,98 h — minutes the owner never drew, on the
    // one kind of day whose whole promise is that what they drew is what they get.
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
    // A release with no working time under it means the next minute that has some, so 6 h
    // aimed at the band is 6 h from 15:30 — 21:30, past the end of the day — and is clamped
    // like any other overrun. It used to be left alone, because the row was measured as
    // starting in the band and stored uncut straight through it.
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60, 360, timeline)).toBe(13 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60 + 30, 360, timeline)).toBe(13 * 60);
    // Short enough to fit from 15:30, the release stands: the clamp has nothing to say, and
    // `dropLanding` is what turns it into 15:30.
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
    // The owner's report B: the drag "no pasa de las horas de comer y las de margen".
    // It used to stop at 14:00 for a row starting at 12:00 — 120 minutes — so a 4 h
    // morning row could not be made longer by any gesture at all. The limit is now the
    // end of the day's last window (20:30 here) counted as NET working minutes: two
    // hours of morning plus five of afternoon-and-margin.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(maxDurationFrom(12 * 60, SHAPE.manualWindows, REACH)).toBe(120 + 300);
    expect(maxDurationFrom(18 * 60, SHAPE.manualWindows, REACH)).toBe(150);
    // A row that starts in the top margin reaches just as far: the margin is inside the
    // window, so there is no boundary between 07:00 and the morning below it.
    expect(maxDurationFrom(7 * 60, SHAPE.manualWindows, REACH)).toBe(420 + 300);
  });

  it('measures a row that starts in the break from the next working minute', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // A row inside the lunch band reaches as far as one starting at 15:30 does, because that
    // is where its hours really begin (`firstWorkingMinute`) and where the write path stores
    // them. It used to be capped at the band itself — 60 minutes from 14:30 — which capped
    // the DRAG at a number the storage disagreed with by the whole break.
    expect(maxDurationFrom(14 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(300);
    expect(maxDurationFrom(14 * 60, SHAPE.manualWindows, REACH)).toBe(300);
    // Past the last window there IS no next working minute, so the old reading stands: the
    // hole alone, up to the end of the axis.
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
    // "arrastro hasta las 17:30 una tarea que empezaba a las 10, en vez de la hora del
    // medio sumarla, ignorarla y sería de 10 a 14 y de 15:30 a 17:30." Four hours of
    // morning plus two of afternoon. Emphatically not 7.5 h.
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
    // A row INSIDE the band, dragged to another minute of the band: its hours start at 15:30,
    // so nothing between 14:00 and 15:30 is a length at all and the floor answers. That is
    // the same dead zone the band has always been to this gesture — "14:00, 15:00 and 15:29
    // all commit the same duration" — now stated from the row's real start too.
    expect(durationTo(14 * 60 + 30, 15 * 60, SHAPE.manualWindows, REACH)).toBe(SNAP_MINUTES);
    expect(durationTo(14 * 60 + 30, 16 * 60, SHAPE.manualWindows, REACH)).toBe(30);
  });

  it('is the same resolution the pin threshold is stated in', () => {
    // A hand action pins its row when it asks for manual-only time (a margin, the lunch
    // band), and the line is "at least one snap step" — because a drop's rank is nudged by
    // a single minute to break a tie and one minute of margin is not a request for the
    // margin. The two constants have to move together, so they are held equal here.
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
    manualDuration: partial.manualDuration ?? false,
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
    // 07:00-07:30 in the top margin and 08:00-09:00 in the morning, same job. Half an
    // hour of margin sits between them and a hand can work it, so they are two units —
    // and the grid must not draw them as one with a phantom seam. Read against the
    // periods this pair looks contiguous, which is the trap the manual window closes.
    const rows = [
      block({ startMinutes: 420, durationMinutes: 30 }),
      block({ startMinutes: 480, durationMinutes: 60 }),
    ];
    expect(groupBlocks(rows, SHAPE.manualWindows)).toHaveLength(2);
    expect(groupBlocks(rows, SHAPE.periods)).toHaveLength(1);
  });

  it('joins a margin row to the period below it when they touch', () => {
    // 07:00-08:00 and 08:00-10:00: one unbroken rectangle from the margin into the
    // morning, which is what a drop into the margin looks like once it is stored.
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
    // Same job at 08:00-10:00 and 11:00-12:00: an hour of working time sits between
    // them (a gap, or another job), so they are two units.
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

/**
 * THE OTHER AXIS OF THE SAME DEFECT `MIN_ACTIONS_HEIGHT` closes: a block tall enough to
 * keep its bar inside it, and too narrow for the bar to leave anything of it to press.
 * Measured on the running app — a weekend column is 116 px at its floor, so a block in it
 * is 112 px, and a five-button bar is 130 px of that.
 */
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
