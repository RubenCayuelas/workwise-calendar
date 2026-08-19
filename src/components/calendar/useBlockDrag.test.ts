// A gesture is resolved against the axis it PRESSED on. Every case here hands the press one axis
// and the pointer events an axis that has already re-fitted, then demands the press axis's answer.
// Release pixels are always `metrics.top + pressAxis.yOf(target)`, never literals.

import { describe, expect, it } from 'vitest';
import { manualWindowsOf } from '../../lib/manualWindow';
import type { DayShape, WorkPeriod } from '../../types';
import type { WeekDay } from '../../lib/api-client';
import { SNAP_MINUTES, createTimeline, type GridMetrics, type Timeline } from './geometry';
import type { AimRow } from './dropAim';
import { previewMove, previewResize, type DragSession, type DragTarget } from './useBlockDrag';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented default shift, one hour of margin at each end: the axis is 07:00-20:30. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

/** The axis at rest and the axis the legend's collapse produced mid-drag: measured, 742 and 751 px. */
const PRESS_AXIS = createTimeline(SHAPE, { fitHeight: 742 });
const REFITTED_AXIS = createTimeline(SHAPE, { fitHeight: 751 });

/** The grid's origin, as `measure()` reads it: unchanged by a re-fit (measured). */
const TOP = 152.5;
const METRICS: GridMetrics = {
  top: TOP,
  columns: [
    { date: '2026-08-13', left: 200, width: 180 },
    { date: '2026-08-15', left: 380, width: 180 },
  ],
  // These cases press at x=260 and never reach either edge strip, so no page turn is in play.
  frame: { left: 142, right: 560, leftZone: 58, rightZone: 40 },
};

const THURSDAY: WeekDay = day('2026-08-13', { role: 'auto' });
/** The weekend keeps the exact minute a drop asks for, so an error there is stored. */
const SATURDAY: WeekDay = day('2026-08-15', { role: 'manual', isWeekend: true });

function day(date: string, over: Partial<WeekDay>): WeekDay {
  return {
    date,
    weekday: 4,
    role: 'auto',
    isClosed: false,
    isWeekend: false,
    isToday: false,
    isPast: false,
    periods: [MORNING, AFTERNOON],
    manualWindows: [...SHAPE.manualWindows],
    capacityMinutes: 600,
    plannableMinutes: 600,
    bookedMinutes: 0,
    ...over,
  };
}

const dayAt = (date: string): WeekDay | undefined =>
  [THURSDAY, SATURDAY].find((candidate) => candidate.date === date);

/**
 * What the two previews need of the week: the day under the pointer, the week in order
 * (a release below the end of a day resolves to another column), and the rows a drop is
 * aimed against. These cases are about the AXIS, so the calendar under them is empty and
 * the aim is left exactly where the pointer put it — thirds have their own file.
 */
const OPTIONS = {
  dayAt,
  days: (): readonly WeekDay[] => [THURSDAY, SATURDAY],
  rowsOn: (): readonly AimRow[] => [],
};

/** `Reja`, the 4 h row of the report: Thursday 10:00-14:00. */
function target(over: Partial<DragTarget> = {}): DragTarget {
  return {
    groupId: 'reja',
    projectId: 'p-reja',
    name: 'Reja',
    color: '#1D9E75',
    date: '2026-08-13',
    startMinutes: 10 * 60,
    durationMinutes: 4 * 60,
    blockIds: ['reja'],
    blockId: 'reja',
    locked: false,
    ...over,
  };
}

/** The pointer goes down at `pressMinutes`, on the axis as it stands at that moment. */
function press(
  kind: 'move' | 'resize',
  pressMinutes: number,
  axis: Timeline = PRESS_AXIS,
  over: Partial<DragTarget> = {},
): DragSession {
  const dragTarget = target(over);
  return {
    kind,
    target: dragTarget,
    timeline: axis,
    originX: 260,
    originY: TOP + axis.yOf(pressMinutes),
    grabOffsetMinutes: kind === 'move' ? pressMinutes - dragTarget.startMinutes : 0,
    moved: true,
    // Past the click slop: these cases are all real drags, never a shaky click.
    travelled: 40,
    preview: null,
    // The edge state of a drag that has never been near an edge: nothing remembered, the
    // zones armed (the press was in the middle of the grid), nothing counting down.
    point: null,
    edgeArmed: true,
    edge: null,
  };
}

/** The client Y of a minute, as the grid draws it. How the release point is chosen. */
const yOf = (minutes: number, axis: Timeline = PRESS_AXIS): number => TOP + axis.yOf(minutes);

describe('previewResize', () => {
  it("commits the owner's worked example: 10:00 released on 17:30 is 6 h", () => {
    const session = press('resize', 14 * 60);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, OPTIONS);

    // 10:00-14:00 plus 15:30-17:30; the lunch break costs nothing.
    expect(preview.durationMinutes).toBe(360);
  });

  it('holds that answer when the axis re-fits between the press and the release', () => {
    // The legend's collapse: the grid grew 9 px, so later pointer events carry the new scale.
    const session = press('resize', 14 * 60, PRESS_AXIS);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, OPTIONS);

    expect(preview.durationMinutes).toBe(360);
    // The re-fitted axis still reads that pixel as an earlier minute — the whole defect.
    expect(REFITTED_AXIS.minutesAt(yOf(17 * 60 + 30) - TOP)).toBeLessThan(17 * 60 + 30);
    // Since the axis compresses the band the drift accumulates over WORKING pixels: 6.7 min at
    // 17:30, which snaps back onto its quarter, and 8 at 19:30, which commits 7,75 h for 8 h.
    expect(REFITTED_AXIS.minutesAt(yOf(19 * 60 + 30) - TOP)).toBe(19 * 60 + 22);
    expect(previewResize({ clientY: yOf(19 * 60 + 30) }, press('resize', 14 * 60, REFITTED_AXIS), METRICS, OPTIONS).durationMinutes).toBe(480 - SNAP_MINUTES);
  });

  // `requested` is NET working minutes from 10:00, which is why 14:00 and 15:00 both ask for 4 h.
  it.each([
    { release: 10 * 60 + 45, requested: 45 },
    { release: 11 * 60 + 45, requested: 105 },
    { release: 13 * 60, requested: 180 },
    { release: 14 * 60, requested: 240 },
    { release: 15 * 60, requested: 240 }, // inside the grey band: a dead zone, not a jump
    { release: 16 * 60, requested: 270 },
    { release: 17 * 60, requested: 330 },
    { release: 17 * 60 + 30, requested: 360 },
    { release: 18 * 60 + 30, requested: 420 },
    { release: 19 * 60 + 30, requested: 480 },
    { release: 20 * 60 + 15, requested: 525 }, // into the bottom margin, which is hand time
  ])('released on $release commits $requested minutes', ({ release, requested }) => {
    const session = press('resize', 14 * 60);
    expect(previewResize({ clientY: yOf(release) }, session, METRICS, OPTIONS).durationMinutes).toBe(
      requested,
    );
  });
});

// The ghost may never promise a row past the end of the day. The trap: a row stranded outside the
// windows widens the axis (`cover`), and capping at the AXIS let the drag grow into that very space.
describe('previewResize past the end of the day', () => {
  const NO_BOTTOM_MARGIN: DayShape = {
    ...SHAPE,
    marginBottomMinutes: 0,
    manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 0),
  };
  const STRANDED: WeekDay = day('2026-08-13', {
    manualWindows: [...NO_BOTTOM_MARGIN.manualWindows],
  });
  // The axis the grid paints in that state: widened to the containing hour so the row shows.
  const WIDENED = createTimeline(NO_BOTTOM_MARGIN, { fitHeight: 742, cover: [20 * 60 + 30] });

  it('caps a growing row at the end of the day, not at the end of the axis', () => {
    const session = press('resize', 19 * 60 + 30, PRESS_AXIS, {
      startMinutes: 15 * 60 + 30,
      durationMinutes: 240,
    });
    // Released below the last rule the grid draws: 20:30 is the answer, twice over.
    expect(previewResize({ clientY: yOf(22 * 60) }, session, METRICS, OPTIONS).durationMinutes).toBe(300);
    expect(previewResize({ clientY: yOf(20 * 60 + 30) }, session, METRICS, OPTIONS).durationMinutes).toBe(300);
  });

  it('will not grow a row that already sits outside the windows, and keeps its length', () => {
    const strandedAt = (date: string): WeekDay | undefined => (date === '2026-08-13' ? STRANDED : undefined);
    const stranded = { ...OPTIONS, dayAt: strandedAt, days: () => [STRANDED] };
    const session = press('resize', 20 * 60 + 30, WIDENED, {
      startMinutes: 19 * 60 + 30,
      durationMinutes: 60,
    });
    const releaseY = (minutes: number): number => TOP + WIDENED.yOf(minutes);

    // Dragged to the bottom of the widened axis: the row stays the hour it is.
    expect(
      previewResize({ clientY: releaseY(21 * 60) }, session, METRICS, stranded).durationMinutes,
    ).toBe(60);
    // And it can still be shortened, which is the way back inside the day.
    expect(
      previewResize({ clientY: releaseY(20 * 60) }, session, METRICS, stranded).durationMinutes,
    ).toBe(30);
  });
});

describe('previewMove', () => {
  // The clamp is measured in CLOCK minutes: 6 h from 13:15 needs 7 h 30 and ends 20:45, past the day.
  it.each([
    { release: 13 * 60 + 15, start: 13 * 60 },
    { release: 13 * 60 + 30, start: 13 * 60 },
    { release: 13 * 60 + 45, start: 13 * 60 },
    { release: 12 * 60 + 45, start: 12 * 60 + 45 },
    { release: 13 * 60, start: 13 * 60 },
  ])('a 6 h unit released at $release starts at $start', ({ release, start }) => {
    const session = press('move', 13 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 360,
    });
    session.grabOffsetMinutes = 0;
    const preview = previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS);
    expect(preview.startMinutes).toBe(start);
  });

  it('leaves a 10 h unit no later than 09:00, whatever the release point', () => {
    const session = press('move', 8 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 600,
    });
    session.grabOffsetMinutes = 0;
    for (const release of [10 * 60, 12 * 60, 13 * 60, 19 * 60]) {
      expect(
        previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS).startMinutes,
        `released at ${release}`,
      ).toBe(9 * 60);
    }
  });

  it('reads a release in the lunch band as 15:30, the first minute that can hold work', () => {
    // No minute of the band is a slot: `firstWorkingMinute` in `dropLanding`, which the ghost
    // imports so it cannot answer differently from the server.
    const session = press('move', 14 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 120,
    });
    session.grabOffsetMinutes = 0;
    for (const release of [14 * 60, 14 * 60 + 15, 15 * 60, 15 * 60 + 29, 15 * 60 + 30]) {
      expect(
        previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS).startMinutes,
        `released at ${release}`,
      ).toBe(15 * 60 + 30);
    }
    // The last minute of the MORNING is working time, so it is its own answer.
    expect(
      previewMove({ clientX: 460, clientY: yOf(13 * 60 + 45) }, session, METRICS, OPTIONS)
        .startMinutes,
    ).toBe(13 * 60 + 45);
  });

  it('clamps a run the day cannot hold from 15:30 rather than letting it overrun', () => {
    // Saturday does not reflow, so there is no day to roll to: the drag clamps to 13:00 instead.
    const session = press('move', 14 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 360,
    });
    session.grabOffsetMinutes = 0;
    const preview = previewMove({ clientX: 460, clientY: yOf(14 * 60) }, session, METRICS, OPTIONS);
    expect(preview.startMinutes).toBe(13 * 60);
    expect(preview.clamped).toBe(true);
  });

  it('keeps the start when the pointer has not travelled at all', () => {
    // The grab offset cancels an ORIGIN error and this is a SCALE error, so a still hand drifted
    // nine minutes — stored as a quarter of an hour on the weekend, which keeps the minute.
    const grab = 19 * 60 + 10;
    const session = press('move', grab, PRESS_AXIS, { startMinutes: 15 * 60 + 30, durationMinutes: 240 });
    const preview = previewMove({ clientX: 460, clientY: yOf(grab) }, session, METRICS, OPTIONS);

    expect(preview.date).toBe('2026-08-15');
    expect(preview.startMinutes).toBe(15 * 60 + 30);
  });

  it('lands a move on the minute the pointer was released on', () => {
    // Grabbed 30 min into a 09:00 row, released on 12:20: 11:50, which snaps to 11:45.
    const session = press('move', 9 * 60 + 30, PRESS_AXIS, {
      startMinutes: 9 * 60,
      durationMinutes: 120,
    });
    const preview = previewMove({ clientX: 260, clientY: yOf(12 * 60 + 20) }, session, METRICS, OPTIONS);

    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(11 * 60 + 45);
  });

  // `pinned` says the row keeps the minute it was released on, so the clock range is a promise;
  // without it the release is only a queue rank. Read off the DAY alone, a margin drop gets it wrong.
  describe('pinned', () => {
    const moveTo = (date: string, release: number, over: Partial<DragTarget> = {}) => {
      const session = press('move', 8 * 60, PRESS_AXIS, { date, startMinutes: 8 * 60, ...over });
      session.grabOffsetMinutes = 0;
      return previewMove(
        { clientX: date === '2026-08-13' ? 260 : 460, clientY: yOf(release) },
        session,
        METRICS,
        OPTIONS,
      );
    };

    it('is false inside the working periods of a day the engine reflows', () => {
      expect(moveTo('2026-08-13', 10 * 60, { durationMinutes: 120 }).pinned).toBe(false);
    });

    it('is true in the top margin of that same day', () => {
      // 07:15 + 2 h: an hour of it is margin, which the engine's index space cannot represent.
      expect(moveTo('2026-08-13', 7 * 60 + 15, { durationMinutes: 120 }).pinned).toBe(true);
    });

    it('is FALSE when the unit merely reaches the bottom margin (2026-08-17)', () => {
      // 6 h from 13:00 reaches an hour into the bottom margin, and those minutes are hours the
      // reflow carries to the next day, not a claim on the margin.
      expect(moveTo('2026-08-13', 13 * 60, { durationMinutes: 360 }).pinned).toBe(false);
    });

    it('is true when the unit STARTS in the bottom margin', () => {
      expect(moveTo('2026-08-13', 19 * 60 + 45, { durationMinutes: 30 }).pinned).toBe(true);
    });

    it('is true on the weekend, wherever the release lands', () => {
      expect(moveTo('2026-08-15', 10 * 60, { durationMinutes: 120 }).pinned).toBe(true);
    });

    it('is true for a locked unit on a day the engine reflows', () => {
      expect(moveTo('2026-08-13', 10 * 60, { durationMinutes: 120, locked: true }).pinned).toBe(true);
    });
  });

  // The ghost stops at the last start that ends inside the day (unclamped: 409 `row-past-day-end`),
  // and `clamped` is what lets it say so instead of freezing in silence.
  describe('clamped', () => {
    // Only a drop that lands LITERALLY is clamped, so these units are padlocked.
    const releaseAt = (release: number, durationMinutes: number, locked = true) => {
      const session = press('move', 8 * 60, PRESS_AXIS, {
        date: '2026-08-13',
        startMinutes: 8 * 60,
        durationMinutes,
        locked,
      });
      session.grabOffsetMinutes = 0;
      return previewMove({ clientX: 260, clientY: yOf(release) }, session, METRICS, OPTIONS);
    };

    it('is not set while the ghost is still under the pointer', () => {
      expect(releaseAt(11 * 60, 360).clamped).toBe(false);
      expect(releaseAt(13 * 60, 360).clamped).toBe(false);
    });

    it('is set once the release is below the last start that fits the day', () => {
      const preview = releaseAt(18 * 60, 360);
      expect(preview.startMinutes).toBe(13 * 60);
      expect(preview.clamped).toBe(true);
    });

    it('is never set for a queue rank, which has no footprint to fit', () => {
      // Clamping a rank claimed «6 h no pueden empezar después de las…» about a release that works.
      const preview = releaseAt(18 * 60, 360, false);
      expect(preview.startMinutes).toBe(18 * 60);
      expect(preview.clamped).toBe(false);
      expect(preview.rolled).toBe(false);
    });

    it('is not set for a release above the axis, which is the edge of the screen', () => {
      expect(releaseAt(6 * 60, 120).clamped).toBe(false);
    });
  });

  it('follows the grid when the grid itself moves under a still hand', () => {
    // Why `measure()` stays live: a scroll really does change the minute under a still pointer.
    // Only the SCALE is fixed at press.
    const session = press('move', 9 * 60 + 30, PRESS_AXIS, {
      startMinutes: 9 * 60,
      durationMinutes: 120,
    });
    const scrolled: GridMetrics = { ...METRICS, top: TOP - PRESS_AXIS.yOf(10 * 60) + PRESS_AXIS.yOf(9 * 60) };
    const preview = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, METRICS, OPTIONS);
    const afterScroll = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, scrolled, OPTIONS);

    expect(preview.startMinutes).toBe(9 * 60);
    expect(afterScroll.startMinutes).toBe(10 * 60);
  });
});

// The aim and the day, through the preview. Their arithmetic is pinned in dropAim.test.ts; what
// these add is that the GESTURE asks them, and in what order.
describe('previewMove — the aim and the day', () => {
  /** Friday, the colchón: the next day the engine would use after Thursday. */
  const FRIDAY: WeekDay = day('2026-08-14', { role: 'buffer', weekday: 5 });
  const WEEK = [THURSDAY, FRIDAY, SATURDAY];

  const optionsWith = (rows: readonly AimRow[]) => ({
    dayAt: (date: string): WeekDay | undefined => WEEK.find((candidate) => candidate.date === date),
    days: (): readonly WeekDay[] => WEEK,
    rowsOn: (): readonly AimRow[] => rows,
  });

  const releaseOn = (
    release: number,
    durationMinutes: number,
    rows: readonly AimRow[] = [],
    locked = false,
  ) => {
    const session = press('move', 8 * 60, PRESS_AXIS, {
      date: '2026-08-13',
      startMinutes: 8 * 60,
      durationMinutes,
      locked,
    });
    session.grabOffsetMinutes = 0;
    return previewMove({ clientX: 260, clientY: yOf(release) }, session, METRICS, optionsWith(rows));
  };

  it('moves a LITERAL release the day cannot hold to the next day, at its first period', () => {
    // 6 h aimed at 18:00 on a day that ends at 20:30. The unit is padlocked, which is what makes
    // the release a placement with a footprint rather than a rank.
    const preview = releaseOn(18 * 60, 360, [], true);
    expect(preview.date).toBe('2026-08-14');
    expect(preview.startMinutes).toBe(8 * 60);
    expect(preview.rolled).toBe(true);
    expect(preview.clamped).toBe(false);
  });

  it('leaves the same release on the day when the drop is a queue rank', () => {
    const preview = releaseOn(18 * 60, 360);
    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(18 * 60);
    expect(preview.rolled).toBe(false);
    expect(preview.clamped).toBe(false);
  });

  it('stays on the day while what is aimed at still fits it', () => {
    const preview = releaseOn(18 * 60, 60);
    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(18 * 60);
    expect(preview.rolled).toBe(false);
  });

  it('quantises the aim against the row under it before asking about the day', () => {
    // `Alfa` 09:00-13:00: its middle third means "cut it", at the row's own midpoint.
    const alfa: AimRow = { id: 'alfa', startMinutes: 9 * 60, durationMinutes: 240 };
    expect(releaseOn(10 * 60 + 30, 120, [alfa]).startMinutes).toBe(11 * 60);
    expect(releaseOn(11 * 60 + 30, 120, [alfa]).startMinutes).toBe(11 * 60);
    // Its upper third means "before it", so the aim is the row's own start.
    expect(releaseOn(9 * 60 + 45, 120, [alfa]).startMinutes).toBe(9 * 60);
    // Its lower third means "after it".
    expect(releaseOn(12 * 60 + 30, 120, [alfa]).startMinutes).toBe(13 * 60);
  });
});

// The week paged mid-drag: the axis is fixed, everything HORIZONTAL is not. The one thing that
// could remember the old week is the date the preview falls back to over no column — the gutter,
// which is exactly where the left edge zone is.
describe('previewMove after the week has paged', () => {
  const NEXT_WEEK_THURSDAY: WeekDay = day('2026-08-20', { role: 'auto' });
  const NEXT_WEEK_SATURDAY: WeekDay = day('2026-08-22', { role: 'manual', isWeekend: true });
  const PAGED = [NEXT_WEEK_THURSDAY, NEXT_WEEK_SATURDAY];

  /** The same grid, one week on: same boxes, new dates. Paging changes only the labels. */
  const PAGED_METRICS: GridMetrics = {
    ...METRICS,
    columns: [
      { date: '2026-08-20', left: 200, width: 180 },
      { date: '2026-08-22', left: 380, width: 180 },
    ],
  };

  const pagedOptions = {
    dayAt: (date: string): WeekDay | undefined => PAGED.find((candidate) => candidate.date === date),
    days: (): readonly WeekDay[] => PAGED,
    rowsOn: (): readonly AimRow[] => [],
  };

  /** A drag that began on last week's Thursday and has a preview from that week. */
  function paging(): DragSession {
    const session = press('move', 10 * 60);
    session.grabOffsetMinutes = 0;
    session.preview = {
      kind: 'move',
      groupId: 'reja',
      color: '#1D9E75',
      date: '2026-08-13',
      startMinutes: 10 * 60,
      durationMinutes: 240,
      allowed: true,
    };
    return session;
  }

  it('lands on the new week when the pointer is over a column', () => {
    const preview = previewMove(
      { clientX: 260, clientY: yOf(10 * 60) },
      paging(),
      PAGED_METRICS,
      pagedOptions,
    );
    expect(preview.date).toBe('2026-08-20');
    expect(preview.allowed).toBe(true);
  });

  it('falls back to the nearest column, not to the day it remembers from last week', () => {
    // x = 60 is the gutter, where the pointer sits while paging. Kept, `2026-08-13` would be a
    // date no column carries and `dayAt` cannot find.
    const preview = previewMove(
      { clientX: 60, clientY: yOf(10 * 60) },
      paging(),
      PAGED_METRICS,
      pagedOptions,
    );
    expect(preview.date).toBe('2026-08-20');
    expect(preview.allowed).toBe(true);
  });

  it('keeps the remembered column while it is still on screen', () => {
    // Why the fallback is not simply "nearest": leaving the grid sideways keeps the column.
    const preview = previewMove(
      { clientX: 60, clientY: yOf(10 * 60) },
      paging(),
      METRICS,
      OPTIONS,
    );
    expect(preview.date).toBe('2026-08-13');
  });
});
