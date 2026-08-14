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
  MAX_PIXELS_PER_HOUR,
  MIN_PIXELS_PER_HOUR,
  SNAP_MINUTES,
  axisTicks,
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
    expect(timeline.height).toBe(810);
    expect(timeline.yOf(420)).toBe(0);
    expect(timeline.yOf(480)).toBe(60);
    expect(timeline.heightOf(150)).toBe(150);
    expect(timeline.minutesAt(60)).toBe(480);
  });

  it('never draws a block outside the axis, however short', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 15 minutes at 60px/h is 15px, which is fine; a 0-minute row must still be visible
    // rather than collapse into nothing the owner cannot click.
    expect(timeline.heightOf(0)).toBe(1);
    expect(timeline.yOf(0)).toBe(0);
    expect(timeline.yOf(1440)).toBe(810);
  });

  it('grows to cover work placed outside the configured day', () => {
    // A block dropped by hand at 21:00, or left over from a longer working day.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60, cover: [6 * 60 + 20, 21 * 60 + 15] });
    expect(timeline.startMinutes).toBe(6 * 60);
    expect(timeline.endMinutes).toBe(22 * 60);
  });

  it('fits the height it is given, within bounds', () => {
    // 13.5 h in 675px is exactly 50px/h.
    expect(createTimeline(SHAPE, { fitHeight: 675 }).pixelsPerMinute * 60).toBeCloseTo(50);
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
   * Asserted over every minute of the axis, not a sample: the margins and the lunch band
   * are ordinary pixels to this mapping (the band is a paint decision, `durationTo`'s
   * dead zone is an arithmetic one) and a scale that drifted only inside them would be
   * invisible right up to the moment a resize crossed one. The fitted heights are the
   * ones the shop's own window produces, and their scales are deliberately not round.
   */
  it('reads back every minute of the axis at the pixel it was drawn at', () => {
    for (const fitHeight of [742, 751, 675, 700, 813, 999]) {
      const timeline = createTimeline(SHAPE, { fitHeight });
      for (let minutes = timeline.startMinutes; minutes <= timeline.endMinutes; minutes += 1) {
        expect(timeline.minutesAt(timeline.yOf(minutes))).toBe(minutes);
      }
    }
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
  it('labels exactly what the wireframe labels', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 07:00 08:00 11:00 14:00 15:30 17:30 19:30 20:30 — the edges of the day plus an
    // interior tick wherever a period would otherwise run more than three hours unlabelled.
    expect(axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes)).toEqual([
      420, 480, 660, 840, 930, 1050, 1170, 1230,
    ]);
  });

  it('marks the edges of the day as boundaries and the rest as interior', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const ticks = new Map(axisTicks(SHAPE.periods, timeline).map((tick) => [tick.minutes, tick.boundary]));
    expect(ticks.get(480)).toBe(true);
    expect(ticks.get(660)).toBe(false);
    expect(ticks.get(1050)).toBe(false);
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
    const hit = slotAt({ x: 350, y: 1000 + 67 }, { top: 1000, columns }, timeline);
    expect(hit).toEqual({ date: '2026-08-11', exactMinutes: 487, snappedMinutes: 480 });
  });

  it('breaks a rank tie BEFORE the row it landed on, whichever way the hand wandered', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // The clamp is the caller's, so the nudge obeys whatever keeps the row inside the day.
    const onAxis = (minutes: number): number => timeline.clampStart(minutes);
    // No tie: the snapped value stands.
    expect(rankFor(480, 483, [600], onAxis, false)).toBe(480);
    // Landing on a start means "put me before this one" (owner, 2026-08-13) — and it means
    // that from either side of the minute, because the owner cannot aim at a hair.
    expect(rankFor(480, 477, [480], onAxis, false)).toBe(479);
    expect(rankFor(480, 484, [480], onAxis, false)).toBe(479);
    // A tie on the very first minute of the axis can only go the other way.
    expect(rankFor(420, 418, [420], onAxis, false)).toBe(421);
  });

  it('never nudges a PINNED placement, whose minute is the clock and not a rank', () => {
    // Matrix N-3/N-4: nudged, a Saturday drop released on 10:00 came back stored at 09:59
    // and the day's durations read 2,02 h and 1,98 h — minutes the owner never drew, on the
    // one kind of day whose whole promise is that what they drew is what they get.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const onAxis = (minutes: number): number => timeline.clampStart(minutes);
    expect(rankFor(600, 597, [600], onAxis, true)).toBe(600);
    expect(rankFor(600, 604, [600], onAxis, true)).toBe(600);
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

  it('leaves the lunch band reachable while the row still ends inside the day', () => {
    // CLAUDE.md's Open Decision about a drop released in the band: untouched.
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60, 360, timeline)).toBe(14 * 60);
    expect(clampDropStart(SHAPE.manualWindows, 14 * 60 + 30, 360, timeline)).toBe(14 * 60 + 30);
    // 8 h from 14:30 would reach 22:30, so it is clamped like any other overrun.
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

  it('keeps a row that starts in a hole inside that hole', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // Inside the lunch break: up to the afternoon's start, exactly as before. Nothing
    // may swallow working time it does not own.
    expect(maxDurationFrom(14 * 60 + 30, SHAPE.manualWindows, REACH)).toBe(60);
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
    expect(durationTo(14 * 60 + 30, 15 * 60, SHAPE.manualWindows, REACH)).toBe(30);
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
    handPlaced: partial.handPlaced ?? false,
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
