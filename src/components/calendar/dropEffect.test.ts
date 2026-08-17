/**
 * The drag preview's promise, checked against the rules `resolveManualPlacement`
 * actually applies (CLAUDE.md, *A Drop That Overlaps*).
 *
 * The point of these is the SIDES: a reflowed drop only ever disturbs movable rows and
 * a fixed one only ever disturbs fixed rows, and getting that backwards would make the
 * preview announce a cut the server will not perform — which is worse than saying
 * nothing, because the owner would move the block again to undo something that never
 * happened.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDropQueue,
  dayHoldsMinutes,
  dayReflowsOn,
  dropEffectOf,
  dropFootprint,
  dropPins,
  dropPredecessor,
  footprintEnd,
  footprintWithinDay,
  resolveDropPreview,
  type DropEffectInput,
  type DropRow,
  type QueueRow,
} from './dropEffect';

/** The documented shift: 08:00-14:00, lunch, 15:30-19:30. */
const PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

/** The same day as a HAND action sees it: the periods with the margins fused on. */
const MANUAL_WINDOWS = [
  { startMinutes: 7 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
];

function row(overrides: Partial<DropRow> & { id: string }): DropRow {
  return {
    projectId: 'other',
    startMinutes: 8 * 60,
    durationMinutes: 6 * 60,
    locked: false,
    project: { name: 'Barandilla' },
    ...overrides,
  };
}

function input(overrides: Partial<DropEffectInput> = {}): DropEffectInput {
  return {
    rows: [],
    movingBlockIds: ['dropped'],
    projectId: 'porton',
    dayIsWeekend: false,
    // The ordinary Monday drop: a plain queue rank on a day the engine lays out.
    pinned: false,
    dayReflows: true,
    locked: false,
    manualWindows: PERIODS,
    startMinutes: 10 * 60,
    durationMinutes: 2 * 60,
    ...overrides,
  };
}

describe('dropEffectOf — a weekday drop the reflow will lay out', () => {
  it('cuts the movable row it lands inside, at the drop', () => {
    const effect = dropEffectOf(input({ rows: [row({ id: 'barandilla' })] }));
    expect(effect).toEqual({
      kind: 'cut',
      blockId: 'barandilla',
      projectName: 'Barandilla',
      cutMinutes: 10 * 60,
    });
  });

  it('leaves a row that starts at or after the drop alone', () => {
    // It already ranks behind the drop, so the forward fill settles it without help.
    const effect = dropEffectOf(
      input({ rows: [row({ id: 'later', startMinutes: 10 * 60, durationMinutes: 60 })] }),
    );
    expect(effect).toBeNull();
  });

  it('ignores a locked row: flexible work flows around it, and it is not a refusal', () => {
    expect(dropEffectOf(input({ rows: [row({ id: 'pinned', locked: true })] }))).toBeNull();
  });

  it('says nothing about the dropped unit meeting its own job', () => {
    // Two movable rows of one job are laid out contiguously and joined by auto-merge.
    const effect = dropEffectOf(input({ rows: [row({ id: 'mine', projectId: 'porton' })] }));
    expect(effect).toBeNull();
  });

  it('ignores rows the drop does not reach', () => {
    const early = row({ id: 'early', startMinutes: 8 * 60, durationMinutes: 60 });
    expect(dropEffectOf(input({ rows: [early] }))).toBeNull();
  });
});

describe('dropEffectOf — a drop the reflow will not lay out', () => {
  it('merges into the same job on the weekend, rather than cutting it', () => {
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true, pinned: true, dayReflows: false,
        rows: [row({ id: 'saturday', projectId: 'porton', project: { name: 'Portón' } })],
      }),
    );
    expect(effect?.kind).toBe('merge');
    expect(effect?.projectName).toBe('Portón');
  });

  it('cuts another job on the weekend', () => {
    const effect = dropEffectOf(input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [row({ id: 'barandilla' })] }));
    expect(effect).toMatchObject({ kind: 'cut', blockId: 'barandilla' });
  });

  it('refuses a locked row rather than cutting it', () => {
    const effect = dropEffectOf(
      input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [row({ id: 'pinned', locked: true })] }),
    );
    expect(effect).toMatchObject({ kind: 'blocked', blockId: 'pinned' });
  });

  it('still merges into the SAME job when the dragged unit is the padlocked one', () => {
    // It refused until 2026-08-14, when the padlock became the mark every weekend drop
    // leaves: the refusal then fired on the ordinary gesture of stacking more of one job
    // on the Saturday it already sits on. The server merges and keeps the padlock.
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true, pinned: true, dayReflows: false,
        locked: true,
        rows: [row({ id: 'saturday', projectId: 'porton' })],
      }),
    );
    expect(effect).toMatchObject({ kind: 'merge', blockId: 'saturday' });
  });

  it('collides with the locked rows of a weekday when the dragged unit is locked', () => {
    // A locked unit is fixed wherever it lands, so it meets the OTHER fixed rows —
    // and passes straight through the movable ones, which the reflow will move.
    const movable = row({ id: 'movable' });
    const pinned = row({ id: 'pinned', locked: true, project: { name: 'Escalera' } });
    expect(dropEffectOf(input({ locked: true, pinned: true, rows: [movable] }))).toBeNull();
    expect(dropEffectOf(input({ locked: true, pinned: true, rows: [pinned] }))).toMatchObject({
      kind: 'blocked',
      projectName: 'Escalera',
    });
  });

  it('puts a Friday drop on the fixed side, because the buffer padlocks it', () => {
    // A drop onto the colchón padlocks the row, so it leaves the movable pool and the
    // reflow will never separate it from what it lands on — exactly the weekend's case.
    const mine = row({
      id: 'viernes',
      projectId: 'porton',
      locked: true,
      project: { name: 'Portón' },
    });
    expect(dropEffectOf(input({ pinned: true, rows: [mine] }))).toMatchObject({
      kind: 'merge',
      blockId: 'viernes',
    });
    expect(
      dropEffectOf(input({ pinned: true, rows: [row({ id: 'a-mano', locked: true })] })),
    ).toMatchObject({ kind: 'blocked', blockId: 'a-mano' });
    // ...but only against the rows that are themselves fixed. An engine-placed Friday
    // row is still movable — that is the buffer self-cleaning — so the reflow lays it
    // out around the drop and there is nothing to promise.
    expect(dropEffectOf(input({ pinned: true, rows: [row({ id: 'desborde' })] }))).toBeNull();
  });

  it('passes a padlocked row by on the reflowed side, cutting nothing', () => {
    // A Mon-Thu drop the engine still owns flows around a padlocked row: the server
    // ignores fixed rows on that side, whichever gesture fixed them.
    expect(dropEffectOf(input({ rows: [row({ id: 'a-mano', locked: true })] }))).toBeNull();
  });

  it('measures the drop by its SEGMENTS, so it never claims the lunch band', () => {
    // 6 h released at 10:00 is stored as 10:00-14:00 plus 15:30-17:30 (CLAUDE.md, *A
    // Drop Is Stored In Segments*), so a row sitting inside the break is untouched. The
    // raw 10:00-16:00 rectangle the pointer draws would have announced a cut the server
    // will never perform — the one direction a preview must not be wrong in.
    const inLunch = row({ id: 'comida', startMinutes: 14 * 60 + 15, durationMinutes: 45 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, pinned: true, dayReflows: false, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [inLunch] }),
      ),
    ).toBeNull();

    // ...and the hours pushed past the break by that same cut DO reach further down the
    // afternoon than the rectangle does: 17:00 is inside the drop, 16:00 was its edge.
    const afternoon = row({ id: 'tarde', startMinutes: 17 * 60, durationMinutes: 60 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, pinned: true, dayReflows: false, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [afternoon] }),
      ),
      // Covered from its very start, so there is no head to leave behind: the server
      // deletes the row and re-places its whole duration after the drop. Not a split.
    ).toMatchObject({ kind: 'displace', blockId: 'tarde' });
  });

  it('tells a whole displacement from a real cut, because the toast afterwards does', () => {
    const cut = row({ id: 'medio', startMinutes: 9 * 60, durationMinutes: 3 * 60 });
    expect(
      dropEffectOf(input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [cut] })),
    ).toMatchObject({ kind: 'cut', blockId: 'medio', cutMinutes: 10 * 60 });

    const covered = row({ id: 'entero', startMinutes: 10 * 60, durationMinutes: 60 });
    expect(
      dropEffectOf(input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [covered] })),
    ).toMatchObject({ kind: 'displace', blockId: 'entero' });
  });

  it('reports the merge before the cut, the order the server resolves them in', () => {
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true, pinned: true, dayReflows: false,
        startMinutes: 9 * 60,
        durationMinutes: 4 * 60,
        rows: [
          row({ id: 'victim', startMinutes: 11 * 60, durationMinutes: 60 }),
          row({ id: 'mine', projectId: 'porton', startMinutes: 9 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    expect(effect).toMatchObject({ kind: 'merge', blockId: 'mine' });
  });
});

describe('a gap or a lock under the drop — refused, or slid past?', () => {
  it('announces the refusal on a day that neither reflows nor moves: the weekend', () => {
    // Nothing there will ever move, so the server answers 409 `overlaps-gap` and the ghost
    // has to say so: a preview that promises a placement the save will not perform is
    // worse than no preview.
    const resolved = resolveDropPreview(
      input({
        dayIsWeekend: true,
        pinned: true,
        dayReflows: false,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }],
      }),
    );
    expect(resolved.effect).toMatchObject({ kind: 'gap' });
    expect(resolved.slid).toBe(false);
  });

  it('SLIDES a Friday drop past the gap instead of refusing it', () => {
    // The colchón pins the row but the engine still lays the day out, so the drop is never
    // refused for a collision: it keeps the day the owner named and gives up the minute.
    const resolved = resolveDropPreview(
      input({
        pinned: true,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 11 * 60, pinned: true, slid: true });
    expect(resolved.effect).toBeNull();
  });

  it('slides a Monday lunch-band drop past a gap, which the old preview called harmless', () => {
    // The one the matrix flagged as K-1: the pin comes from the SLOT, not the day, so the
    // preview used to read the re-ranked side and say nothing at all while the server
    // moved the row somewhere else entirely.
    const resolved = resolveDropPreview(
      input({
        pinned: true,
        startMinutes: 14 * 60 + 30,
        durationMinutes: 2 * 60,
        gaps: [{ startMinutes: 15 * 60 + 30, durationMinutes: 60 }],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 16 * 60 + 30, pinned: true, slid: true });
  });

  it('slides past a LOCKED row too, and then has nothing left to refuse', () => {
    const resolved = resolveDropPreview(
      input({
        pinned: true,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        rows: [row({ id: 'locked', locked: true, startMinutes: 10 * 60, durationMinutes: 60 })],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 11 * 60, pinned: true, slid: true });
    expect(resolved.effect).toBeNull();
  });

  it('shows the refusal when the day has no clear slot: the pin cannot be given up', () => {
    // Gaps over every minute the unit could still start on: `firstClearStart` answers
    // null, and the server refuses rather than dropping the padlock it is about to put on
    // the row. So the ghost stays where the pointer is and names the gap.
    const resolved = resolveDropPreview(
      input({
        pinned: true,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 4 * 60 }, { startMinutes: 15 * 60 + 30, durationMinutes: 5 * 60 }],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 10 * 60, pinned: true, slid: false });
    expect(resolved.effect).toMatchObject({ kind: 'gap' });
  });

  it('slides a LOCKED unit too, on a day the engine lays out', () => {
    // The padlock keeps the engine off the row; it does not stop the owner aiming it. And
    // it cannot be treated differently from a drop onto the buffer, because since
    // 2026-08-14 that drop IS a padlocked one.
    const resolved = resolveDropPreview(
      input({
        locked: true,
        pinned: true,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 11 * 60, pinned: true, slid: true });
    expect(resolved.effect).toBeNull();
  });

  it('does not slide on a day the engine never lays out: the weekend refuses instead', () => {
    const resolved = resolveDropPreview(
      input({
        dayIsWeekend: true,
        dayReflows: false,
        pinned: true,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }],
      }),
    );
    expect(resolved).toMatchObject({ startMinutes: 10 * 60, pinned: true, slid: false });
    expect(resolved.effect).toMatchObject({ kind: 'gap' });
  });

  it('says nothing on a plain Monday-to-Thursday rank, where the reflow avoids the gap', () => {
    const resolved = resolveDropPreview(
      input({ startMinutes: 10 * 60, durationMinutes: 60, gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }] }),
    );
    expect(resolved).toMatchObject({ pinned: false, slid: false, effect: null });
  });

  it('names a locked row first, which is the more actionable of the two refusals', () => {
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true, pinned: true, dayReflows: false,
        startMinutes: 10 * 60,
        durationMinutes: 60,
        rows: [row({ id: 'locked', locked: true, startMinutes: 10 * 60, durationMinutes: 60 })],
        gaps: [{ startMinutes: 10 * 60, durationMinutes: 60 }],
      }),
    );
    expect(effect).toMatchObject({ kind: 'blocked', blockId: 'locked' });
  });

  it('is not confused by a gap the drop does not reach', () => {
    expect(
      resolveDropPreview(
        input({
          pinned: true,
          startMinutes: 10 * 60,
          durationMinutes: 60,
          gaps: [{ startMinutes: 12 * 60, durationMinutes: 60 }],
        }),
      ),
    ).toMatchObject({ startMinutes: 10 * 60, slid: false, effect: null });
  });
});

describe('dropFootprint — what the ghost draws', () => {
  it('is one rectangle for a drop that stays inside a period', () => {
    expect(dropFootprint({ manualWindows: PERIODS, startMinutes: 10 * 60, durationMinutes: 2 * 60 })).toEqual([
      { startMinutes: 10 * 60, durationMinutes: 2 * 60 },
    ]);
  });

  it('is the two rows the server will store when the drop crosses lunch', () => {
    expect(dropFootprint({ manualWindows: PERIODS, startMinutes: 10 * 60, durationMinutes: 6 * 60 })).toEqual([
      { startMinutes: 10 * 60, durationMinutes: 4 * 60 },
      { startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 },
    ]);
  });

  /**
   * THE ONE SHAPE THE GHOST MAY NEVER DRAW — one rectangle through the grey band.
   *
   * CLAUDE.md, *Calendar View -> Drag-drop*: "the ghost is drawn in segments, one rectangle
   * per row the gesture will be stored as, because one rectangle straight through the grey
   * band promises a shape that will never exist". `dropFootprint` breaks that for a run
   * longer than the day ON PURPOSE — a tail past midnight is returned uncut so the server
   * can refuse the drop as it was made — and since the drag unit is the whole RUN, that is
   * the ORDINARY case rather than a corner: measured on the running app, 2026-08-17, an 18 h
   * run picked up on Tuesday drew a single translucent rectangle over the entire column,
   * hatched comida included, on every day the pointer crossed.
   */
  it('draws an over-long run as the day it can fill, band left clear', () => {
    const run = { manualWindows: MANUAL_WINDOWS, startMinutes: 7 * 60, durationMinutes: 18 * 60 };

    // The storage answer: one uncut segment, 07:00 + 18 h, which reaches 01:00 tomorrow.
    expect(dropFootprint(run)).toEqual([{ startMinutes: 7 * 60, durationMinutes: 18 * 60 }]);

    // The drawn answer: the day's own 12 h, cut at the break like every other drop.
    expect(footprintWithinDay(run)).toEqual([
      { startMinutes: 7 * 60, durationMinutes: 7 * 60 },
      { startMinutes: 15 * 60 + 30, durationMinutes: 5 * 60 },
    ]);
  });

  it('is dropFootprint exactly whenever the gesture does fit', () => {
    for (const startMinutes of [7 * 60, 8 * 60, 10 * 60, 13 * 60, 15 * 60 + 30, 19 * 60]) {
      for (const durationMinutes of [15, 60, 4 * 60, 6 * 60]) {
        const input = { manualWindows: MANUAL_WINDOWS, startMinutes, durationMinutes };
        if (footprintEnd(input) === null) continue;
        expect(footprintWithinDay(input), `${startMinutes} + ${durationMinutes}`).toEqual(
          dropFootprint(input),
        );
      }
    }
  });

  /**
   * A start inside the comida keeps its own latitude: there is no boundary inside such a row
   * to cut it at (`segmentDroppedRow`), so it stays the one rectangle it will really be
   * stored as. Open Decision 5 owns what that drop should mean; this only fixes the drawing
   * of a run, and must not quietly re-answer it.
   */
  it('leaves a drop released inside the band alone', () => {
    const inBand = { manualWindows: MANUAL_WINDOWS, startMinutes: 14 * 60 + 30, durationMinutes: 60 };
    expect(footprintWithinDay(inBand)).toEqual(dropFootprint(inBand));
  });
});

/**
 * A RUN DOES NOT END AT A TIME OF DAY — it ends on a later DAY.
 *
 * The drag unit is the run (CLAUDE.md, *The Unit of a Drag Is the RUN*), so the ghost's
 * `durationMinutes` is a total ACROSS DAYS. Adding it to a start and calling the sum an
 * end-of-day is a category error, and it was a visible one: an 18 h run released at 07:00
 * gave `420 + 1080 = 1500`, which `formatTime` printed as `--:--` and complained about
 * once per pointer move — forty times in a single drag. The quiet half was worse: 13 h at
 * 07:00 gave `21:30`, a perfectly plausible hour an hour past the end of the day.
 */
describe('footprintEnd — the clock end, or nothing at all', () => {
  it('is the end of the last stored row when the day holds every minute', () => {
    expect(
      footprintEnd({ manualWindows: MANUAL_WINDOWS, startMinutes: 10 * 60, durationMinutes: 2 * 60 }),
    ).toBe(12 * 60);
  });

  it('skips the lunch break, because duration is NET working minutes', () => {
    // 6 h from 10:00 is 10:00-14:00 plus 15:30-17:30, not 10:00-16:00.
    expect(
      footprintEnd({ manualWindows: MANUAL_WINDOWS, startMinutes: 10 * 60, durationMinutes: 6 * 60 }),
    ).toBe(17 * 60 + 30);
  });

  it('accepts a stretch that ends exactly on the day’s last minute', () => {
    // 12 h from 07:00 is the whole manual window: 7 h before lunch, 5 h after.
    expect(
      footprintEnd({ manualWindows: MANUAL_WINDOWS, startMinutes: 7 * 60, durationMinutes: 12 * 60 }),
    ).toBe(20 * 60 + 30);
  });

  it('is null for the 18 h run that produced 25:00', () => {
    expect(
      footprintEnd({ manualWindows: MANUAL_WINDOWS, startMinutes: 7 * 60, durationMinutes: 18 * 60 }),
    ).toBeNull();
  });

  it('is null for the quiet overrun too, not only the one past midnight', () => {
    expect(
      footprintEnd({ manualWindows: MANUAL_WINDOWS, startMinutes: 7 * 60, durationMinutes: 13 * 60 }),
    ).toBeNull();
  });
});

describe('dayHoldsMinutes — is there any start on this day that would work?', () => {
  it('holds a stretch up to the whole manual window, margins included', () => {
    expect(dayHoldsMinutes(MANUAL_WINDOWS, 12 * 60)).toBe(true);
    // The periods alone are 10 h; the two margins are what make the other 2 h reachable.
    expect(dayHoldsMinutes(PERIODS, 12 * 60)).toBe(false);
  });

  it('says no to a run longer than the day, which is what the clamp cannot say', () => {
    // `latestStartFor` answers 07:00 here — its "nothing fits" fallback — so the ghost
    // used to read «18 h no pueden empezar después de las 07:00», which claims 07:00 works.
    expect(dayHoldsMinutes(MANUAL_WINDOWS, 18 * 60)).toBe(false);
  });
});

/**
 * THE QUESTION THE GHOST HAS TO ANSWER BEFORE IT PRINTS ANYTHING: is the minute under the
 * pointer a promise, or only a place in a queue?
 *
 * Getting it wrong is the defect the owner lived with — a ghost reading `09:00–14:00` over
 * Thursday, released, and the row settling on Wednesday at 12:00. Nothing was broken; the
 * preview had simply promised something a re-ranking drop cannot deliver.
 */
describe('dropPins — does the row keep the minute it is released on?', () => {
  const day = { periods: PERIODS, manualWindows: MANUAL_WINDOWS, startMinutes: 10 * 60, durationMinutes: 2 * 60 };

  it('re-ranks an unlocked unit dropped inside a Monday-to-Thursday period', () => {
    expect(dropPins({ ...day, locked: false, role: 'auto' })).toBe(false);
  });

  it.each([
    ['the weekend', { locked: false, role: 'manual' as const }],
    ['the Friday colchón', { locked: false, role: 'buffer' as const }],
    ['a locked unit, wherever it lands', { locked: true, role: 'auto' as const }],
  ])('pins the exact minute on %s', (_name, drop) => {
    expect(dropPins({ ...day, ...drop })).toBe(true);
  });

  it('pins a MONDAY drop whose footprint reaches a visual margin', () => {
    // The clause that lives only on the server (`pinsTheRow`) and that the preview used to
    // miss: read off the day alone, this was drawn as a harmless re-rank and stored as a pin.
    expect(
      dropPins({ ...day, locked: false, role: 'auto', startMinutes: 7 * 60, durationMinutes: 60 }),
    ).toBe(true);
  });

  it('does NOT pin a MONDAY drop aimed at the lunch band, because it starts at 15:30', () => {
    // The band is not a slot: a release with no working time under it means the next minute
    // that has some (`firstWorkingMinute`), so the row is stored at 15:30 — inside the
    // periods, where a Monday-to-Thursday drop is an ordinary queue rank. It used to pin,
    // and it had to, because the row was stored where it was released: one solid row through
    // the break, which the engine could only have answered by undoing the drop.
    //
    // A MARGIN still pins (the test above): margin time is workable time the owner chose,
    // and the engine's index space has none of it.
    for (const startMinutes of [14 * 60, 14 * 60 + 30, 15 * 60 + 29, 15 * 60 + 30]) {
      expect(
        dropPins({ ...day, locked: false, role: 'auto', startMinutes, durationMinutes: 60 }),
        `released at ${startMinutes}`,
      ).toBe(false);
    }
  });
});

describe('dayReflowsOn — may a collision refuse the drop at all?', () => {
  const day = { role: 'auto' as const, isClosed: false, isPast: false };

  it.each([
    ['Monday to Thursday', day],
    ['the Friday colchón, which the engine still lays out', { ...day, role: 'buffer' as const }],
  ])('%s: the drop is a re-ranking, so it is never refused', (_name, value) => {
    expect(dayReflowsOn(value)).toBe(true);
  });

  it.each([
    ['the weekend', { ...day, role: 'manual' as const }],
    ['a closed day', { ...day, isClosed: true }],
    ['the frozen past', { ...day, isPast: true }],
  ])('%s: the drop lands literally, so a collision is real', (_name, value) => {
    expect(dayReflowsOn(value)).toBe(false);
  });
});

describe('the queue a re-ranked drop is expressed against', () => {
  const rows = [
    queueRow({ id: 'mon', date: '2026-08-17', startMinutes: 8 * 60, name: 'Puerta' }),
    queueRow({ id: 'tue', date: '2026-08-18', startMinutes: 8 * 60, name: 'Escalera' }),
    queueRow({ id: 'tue-pm', date: '2026-08-18', startMinutes: 15 * 60 + 30, name: 'Escalera' }),
    queueRow({ id: 'wed', date: '2026-08-19', startMinutes: 8 * 60, name: 'Marco' }),
  ];
  const queue = buildDropQueue(rows, () => true);

  it('names the row a Thursday drop falls in behind, which is on Wednesday', () => {
    // The whole point: the drop's own COLUMN is not where the answer lives. The reflow
    // packs forward from the first free slot, so the only stable fact is the rank.
    expect(dropPredecessor(queue, [], '2026-08-20', 9 * 60)?.id).toBe('wed');
  });

  it('names the row above when the drop lands lower down the same day', () => {
    expect(dropPredecessor(queue, [], '2026-08-18', 17 * 60)?.id).toBe('tue-pm');
  });

  it('skips the rows being dragged: a unit cannot rank itself behind itself', () => {
    expect(dropPredecessor(queue, ['wed'], '2026-08-20', 9 * 60)?.id).toBe('tue-pm');
  });

  it('answers null before the first row of the week, rather than claiming a first place', () => {
    // The queue reaches back into weeks this screen cannot see, so "it goes first" is a
    // claim the ghost has no way to check. The caller says the generic sentence instead.
    expect(dropPredecessor(queue, [], '2026-08-17', 8 * 60)).toBeNull();
  });

  it('leaves out every row the engine will not lay out', () => {
    const mixed = [
      queueRow({ id: 'locked', date: '2026-08-17', startMinutes: 9 * 60, name: 'A', locked: true }),
      queueRow({ id: 'hand', date: '2026-08-17', startMinutes: 10 * 60, name: 'B', locked: true }),
      queueRow({ id: 'weekend', date: '2026-08-22', startMinutes: 9 * 60, name: 'C' }),
      queueRow({ id: 'movable', date: '2026-08-17', startMinutes: 11 * 60, name: 'D' }),
    ];
    const built = buildDropQueue(mixed, (date) => date !== '2026-08-22');
    expect(built.map((entry) => entry.id)).toEqual(['movable']);
  });
});

function queueRow(over: {
  id: string;
  date: string;
  startMinutes: number;
  name: string;
  locked?: boolean;
}): QueueRow {
  return {
    id: over.id,
    date: over.date,
    startMinutes: over.startMinutes,
    locked: over.locked ?? false,
    project: { name: over.name },
  };
}
