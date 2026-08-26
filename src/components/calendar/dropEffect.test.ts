// The drag preview's promise, checked against the rules `resolveManualPlacement` really applies.
// The point is the SIDES: a reflowed drop disturbs only movable rows and a fixed one only fixed
// ones. Backwards, the preview announces a cut the server will never perform.

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
  gapDropEffect,
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
    project: { name: 'Railing' },
    ...overrides,
  };
}

function input(overrides: Partial<DropEffectInput> = {}): DropEffectInput {
  return {
    rows: [],
    movingBlockIds: ['dropped'],
    projectId: 'shutter',
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
    const effect = dropEffectOf(input({ rows: [row({ id: 'railing' })] }));
    expect(effect).toEqual({
      kind: 'cut',
      blockId: 'railing',
      projectName: 'Railing',
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
    const effect = dropEffectOf(input({ rows: [row({ id: 'mine', projectId: 'shutter' })] }));
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
        rows: [row({ id: 'saturday', projectId: 'shutter', project: { name: 'Shutter' } })],
      }),
    );
    expect(effect?.kind).toBe('merge');
    expect(effect?.projectName).toBe('Shutter');
  });

  it('cuts another job on the weekend', () => {
    const effect = dropEffectOf(input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [row({ id: 'railing' })] }));
    expect(effect).toMatchObject({ kind: 'cut', blockId: 'railing' });
  });

  it('refuses a locked row rather than cutting it', () => {
    const effect = dropEffectOf(
      input({ dayIsWeekend: true, pinned: true, dayReflows: false, rows: [row({ id: 'pinned', locked: true })] }),
    );
    expect(effect).toMatchObject({ kind: 'blocked', blockId: 'pinned' });
  });

  it('still merges into the SAME job when the dragged unit is the padlocked one', () => {
    // Stacking more of one job on the Saturday it sits on: the server merges, padlock and all.
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true, pinned: true, dayReflows: false,
        locked: true,
        rows: [row({ id: 'saturday', projectId: 'shutter' })],
      }),
    );
    expect(effect).toMatchObject({ kind: 'merge', blockId: 'saturday' });
  });

  it('collides with the locked rows of a weekday when the dragged unit is locked', () => {
    // A locked unit meets the other FIXED rows and passes through the movable ones.
    const movable = row({ id: 'movable' });
    const pinned = row({ id: 'pinned', locked: true, project: { name: 'Staircase' } });
    expect(dropEffectOf(input({ locked: true, pinned: true, rows: [movable] }))).toBeNull();
    expect(dropEffectOf(input({ locked: true, pinned: true, rows: [pinned] }))).toMatchObject({
      kind: 'blocked',
      projectName: 'Staircase',
    });
  });

  it('puts a Friday drop on the fixed side, because the buffer padlocks it', () => {
    // The buffer padlocks the row, so the reflow will never separate it from what it lands on.
    const mine = row({
      id: 'viernes',
      projectId: 'shutter',
      locked: true,
      project: { name: 'Shutter' },
    });
    expect(dropEffectOf(input({ pinned: true, rows: [mine] }))).toMatchObject({
      kind: 'merge',
      blockId: 'viernes',
    });
    expect(
      dropEffectOf(input({ pinned: true, rows: [row({ id: 'a-mano', locked: true })] })),
    ).toMatchObject({ kind: 'blocked', blockId: 'a-mano' });
    // ...but an engine-placed Friday row is still movable, so there is nothing to promise.
    expect(dropEffectOf(input({ pinned: true, rows: [row({ id: 'overflow' })] }))).toBeNull();
  });

  it('passes a padlocked row by on the reflowed side, cutting nothing', () => {
    // The server ignores fixed rows on the reflowed side: flexible work flows around them.
    expect(dropEffectOf(input({ rows: [row({ id: 'a-mano', locked: true })] }))).toBeNull();
  });

  it('measures the drop by its SEGMENTS, so it never claims the lunch band', () => {
    // 6 h at 10:00 is stored 10:00-14:00 + 15:30-17:30, so a row inside the break is untouched;
    // the raw 10:00-16:00 rectangle would announce a cut.
    const inLunch = row({ id: 'lunch break', startMinutes: 14 * 60 + 15, durationMinutes: 45 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, pinned: true, dayReflows: false, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [inLunch] }),
      ),
    ).toBeNull();

    // ...and the segments reach further than the rectangle: 17:00 is inside the drop, 16:00 was
    // its edge.
    const afternoon = row({ id: 'tarde', startMinutes: 17 * 60, durationMinutes: 60 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, pinned: true, dayReflows: false, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [afternoon] }),
      ),
      // Covered from its start: no head to leave behind, so the whole row is displaced, not cut.
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
          row({ id: 'mine', projectId: 'shutter', startMinutes: 9 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    expect(effect).toMatchObject({ kind: 'merge', blockId: 'mine' });
  });
});

describe('a gap or a lock under the drop — refused, or slid past?', () => {
  it('announces the refusal on a day that neither reflows nor moves: the weekend', () => {
    // Nothing there will ever move: the server answers 409 `overlaps-gap` and the ghost says so.
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
    // The buffer pins the row, but the engine lays the day out: it gives up the minute, not the day.
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
    // The pin comes from the SLOT and not the day, which is the case a preview reading only the
    // day gets silently wrong.
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
    // Gaps over every start left: `firstClearStart` is null, so the ghost stays put and names it.
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
    // The padlock keeps the engine off the row; it does not stop the owner aiming it.
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

  // `dropFootprint` returns a run longer than the day UNCUT on purpose, so the server can refuse
  // it as it was made; drawn, that was one rectangle over the whole column, band included.
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

  // A start inside the lunch break has no boundary to cut at (`segmentDroppedRow`), so it stays the
  // one rectangle it will really be stored as.
  it('leaves a drop released inside the band alone', () => {
    const inBand = { manualWindows: MANUAL_WINDOWS, startMinutes: 14 * 60 + 30, durationMinutes: 60 };
    expect(footprintWithinDay(inBand)).toEqual(dropFootprint(inBand));
  });
});

// A run's duration is a total ACROSS DAYS, so `start + duration` is not a clock time: 18 h at
// 07:00 gave 1500 (printed `--:--`), and 13 h gave a plausible-looking 21:30.
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
    // `latestStartFor` answers 07:00 here — its "nothing fits" fallback — a start that does not work.
    expect(dayHoldsMinutes(MANUAL_WINDOWS, 18 * 60)).toBe(false);
  });
});

// An absence's own ghost: the server answers a gap with two outcomes and neither is a block's.
describe('gapDropEffect — what an absence dropped here will do', () => {
  const at = (
    startMinutes: number,
    durationMinutes: number,
    rows: DropRow[],
    dayIsWeekend = false,
  ) =>
    gapDropEffect({ rows, dayIsWeekend, manualWindows: MANUAL_WINDOWS, startMinutes, durationMinutes });

  it('says nothing over free time', () => {
    expect(at(10 * 60, 120, [row({ id: 'grille', startMinutes: 8 * 60, durationMinutes: 60 })])).toBeNull();
  });

  it('names the job it will push forward', () => {
    expect(
      at(10 * 60, 120, [row({ id: 'grille', startMinutes: 10 * 60, durationMinutes: 120 })]),
    ).toEqual({ kind: 'displace', projectName: 'Railing' });
  });

  it('CUTS the row it starts inside, and says so', () => {
    // The engine turns the absence into an obstacle: the head keeps its place, the rest is poured in
    // after it, and one row becomes two. Verified against the operations layer for 10:00-12:00 plus a
    // quarter of an hour at 11:00 — 10:00-11:00 and 11:15-12:15.
    expect(
      at(11 * 60, 15, [row({ id: 'grille', startMinutes: 10 * 60, durationMinutes: 120 })]),
    ).toEqual({ kind: 'cut', projectName: 'Railing' });
  });

  it('covers a row from its very start: displaced whole, not cut', () => {
    expect(
      at(10 * 60, 15, [row({ id: 'grille', startMinutes: 10 * 60, durationMinutes: 120 })]),
    ).toEqual({ kind: 'displace', projectName: 'Railing' });
  });

  it('names the FIRST row on the clock, and cuts only if the absence starts inside it', () => {
    const rows = [
      row({ id: 'grille', startMinutes: 8 * 60, durationMinutes: 120, project: { name: 'Grille' } }),
      row({ id: 'door', startMinutes: 10 * 60, durationMinutes: 120, project: { name: 'Door' } }),
    ];

    expect(at(9 * 60, 3 * 60, rows)).toEqual({ kind: 'cut', projectName: 'Grille' });
    expect(at(8 * 60, 3 * 60, rows)).toEqual({ kind: 'displace', projectName: 'Grille' });
  });

  it('is a REFUSAL over a padlocked row: `gap-over-fixed-block` writes nothing', () => {
    expect(
      at(10 * 60, 120, [
        row({ id: 'grille', startMinutes: 10 * 60, durationMinutes: 120, locked: true, project: { name: 'Grille' } }),
      ]),
    ).toEqual({ kind: 'blocked', projectName: 'Grille' });
  });

  it('is a refusal over ANY row of a weekend day, padlock or not', () => {
    // `isMovable` says no by the DATE there, so nothing will move out of the way.
    expect(
      at(10 * 60, 120, [row({ id: 'grille', startMinutes: 10 * 60, durationMinutes: 120 })], true),
    ).toEqual({ kind: 'blocked', projectName: 'Railing' });
  });

  it('reports the refusal even when an ordinary row comes first on the clock', () => {
    expect(
      at(8 * 60, 6 * 60, [
        row({ id: 'suelta', startMinutes: 8 * 60, durationMinutes: 60 }),
        row({ id: 'fija', startMinutes: 12 * 60, durationMinutes: 60, locked: true, project: { name: 'Shutter' } }),
      ]),
    ).toEqual({ kind: 'blocked', projectName: 'Shutter' });
  });

  it('measures the footprint over the lunch break, so the far half is judged too', () => {
    // 4 h from 12:00 is 12:00-14:00 and 15:30-17:30; the row it lands on is in the afternoon.
    expect(
      at(12 * 60, 4 * 60, [
        row({ id: 'tarde', startMinutes: 16 * 60, durationMinutes: 60, locked: true, project: { name: 'Staircase' } }),
      ]),
    ).toEqual({ kind: 'blocked', projectName: 'Staircase' });
  });
});

// Is the minute under the pointer a promise, or only a place in a queue? Got wrong, the ghost read
// `09:00–14:00` over Thursday and the row settled on Wednesday at 12:00.
describe('dropPins — does the row keep the minute it is released on?', () => {
  const day = {
    periods: PERIODS,
    manualWindows: MANUAL_WINDOWS,
    closed: false,
    startMinutes: 10 * 60,
    durationMinutes: 2 * 60,
  };

  it('re-ranks an unlocked unit dropped inside a Monday-to-Thursday period', () => {
    expect(dropPins({ ...day, fixed: false, role: 'auto' })).toBe(false);
  });

  it.each([
    ['the weekend', { fixed: false, role: 'manual' as const }],
    ['the Friday buffer', { fixed: false, role: 'buffer' as const }],
    ['a locked unit or a gap, wherever it lands', { fixed: true, role: 'auto' as const }],
    [
      'a CLOSED weekday, which is a weekend by another name',
      { fixed: false, closed: true, role: 'auto' as const },
    ],
  ])('pins the exact minute on %s', (_name, drop) => {
    expect(dropPins({ ...day, ...drop })).toBe(true);
  });

  it('pins a MONDAY drop whose footprint reaches a visual margin', () => {
    // Read off the DAY alone this is a harmless re-rank, and the server stores it as a pin.
    expect(
      dropPins({ ...day, fixed: false, role: 'auto', startMinutes: 7 * 60, durationMinutes: 60 }),
    ).toBe(true);
  });

  it('does NOT pin a MONDAY drop aimed at the lunch band, because it starts at 15:30', () => {
    // The band is not a slot: `firstWorkingMinute` stores the row at 15:30, inside the periods,
    // where a Mon-Thu drop is an ordinary rank. A MARGIN still pins — it is workable time.
    for (const startMinutes of [14 * 60, 14 * 60 + 30, 15 * 60 + 29, 15 * 60 + 30]) {
      expect(
        dropPins({ ...day, fixed: false, role: 'auto', startMinutes, durationMinutes: 60 }),
        `released at ${startMinutes}`,
      ).toBe(false);
    }
  });
});

describe('dayReflowsOn — may a collision refuse the drop at all?', () => {
  const day = { role: 'auto' as const, isClosed: false, isPast: false };

  it.each([
    ['Monday to Thursday', day],
    ['the Friday buffer, which the engine still lays out', { ...day, role: 'buffer' as const }],
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
    queueRow({ id: 'mon', date: '2026-08-17', startMinutes: 8 * 60, name: 'Door' }),
    queueRow({ id: 'tue', date: '2026-08-18', startMinutes: 8 * 60, name: 'Staircase' }),
    queueRow({ id: 'tue-pm', date: '2026-08-18', startMinutes: 15 * 60 + 30, name: 'Staircase' }),
    queueRow({ id: 'wed', date: '2026-08-19', startMinutes: 8 * 60, name: 'Casing' }),
  ];
  const queue = buildDropQueue(rows, () => true);

  it('names the row a Thursday drop falls in behind, which is on Wednesday', () => {
    // The drop's own COLUMN is not where the answer lives: the only stable fact is the rank.
    expect(dropPredecessor(queue, [], '2026-08-20', 9 * 60)?.id).toBe('wed');
  });

  it('names the row above when the drop lands lower down the same day', () => {
    expect(dropPredecessor(queue, [], '2026-08-18', 17 * 60)?.id).toBe('tue-pm');
  });

  it('skips the rows being dragged: a unit cannot rank itself behind itself', () => {
    expect(dropPredecessor(queue, ['wed'], '2026-08-20', 9 * 60)?.id).toBe('tue-pm');
  });

  it('answers null before the first row of the week, rather than claiming a first place', () => {
    // The queue reaches into weeks this screen cannot see, so "it goes first" is uncheckable.
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
