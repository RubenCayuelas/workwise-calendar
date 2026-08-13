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
import { dropEffectOf, dropFootprint, type DropEffectInput, type DropRow } from './dropEffect';

/** The documented shift: 08:00-14:00, lunch, 15:30-19:30. */
const PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

function row(overrides: Partial<DropRow> & { id: string }): DropRow {
  return {
    projectId: 'other',
    startMinutes: 8 * 60,
    durationMinutes: 6 * 60,
    locked: false,
    handPlaced: false,
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
    dayIsBuffer: false,
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
        dayIsWeekend: true,
        rows: [row({ id: 'saturday', projectId: 'porton', project: { name: 'Portón' } })],
      }),
    );
    expect(effect?.kind).toBe('merge');
    expect(effect?.projectName).toBe('Portón');
  });

  it('cuts another job on the weekend', () => {
    const effect = dropEffectOf(input({ dayIsWeekend: true, rows: [row({ id: 'barandilla' })] }));
    expect(effect).toMatchObject({ kind: 'cut', blockId: 'barandilla' });
  });

  it('refuses a locked row rather than cutting it', () => {
    const effect = dropEffectOf(
      input({ dayIsWeekend: true, rows: [row({ id: 'pinned', locked: true })] }),
    );
    expect(effect).toMatchObject({ kind: 'blocked', blockId: 'pinned' });
  });

  it('refuses a merge whose own row is the locked one', () => {
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true,
        locked: true,
        rows: [row({ id: 'saturday', projectId: 'porton' })],
      }),
    );
    expect(effect).toMatchObject({ kind: 'blocked', blockId: 'saturday' });
  });

  it('collides with the locked rows of a weekday when the dragged unit is locked', () => {
    // A locked unit is fixed wherever it lands, so it meets the OTHER fixed rows —
    // and passes straight through the movable ones, which the reflow will move.
    const movable = row({ id: 'movable' });
    const pinned = row({ id: 'pinned', locked: true, project: { name: 'Escalera' } });
    expect(dropEffectOf(input({ locked: true, rows: [movable] }))).toBeNull();
    expect(dropEffectOf(input({ locked: true, rows: [pinned] }))).toMatchObject({
      kind: 'blocked',
      projectName: 'Escalera',
    });
  });

  it('puts a Friday drop on the fixed side, because the buffer pins it', () => {
    // A drop onto the colchón is hand-placed, so it leaves the movable pool and the
    // reflow will never separate it from what it lands on — exactly the weekend's case.
    const mine = row({
      id: 'viernes',
      projectId: 'porton',
      handPlaced: true,
      project: { name: 'Portón' },
    });
    expect(dropEffectOf(input({ dayIsBuffer: true, rows: [mine] }))).toMatchObject({
      kind: 'merge',
      blockId: 'viernes',
    });
    expect(
      dropEffectOf(input({ dayIsBuffer: true, rows: [row({ id: 'a-mano', handPlaced: true })] })),
    ).toMatchObject({ kind: 'cut', blockId: 'a-mano' });
    // ...but only against the rows that are themselves fixed. An engine-placed Friday
    // row is still movable — that is the buffer self-cleaning — so the reflow lays it
    // out around the drop and there is nothing to promise.
    expect(dropEffectOf(input({ dayIsBuffer: true, rows: [row({ id: 'desborde' })] }))).toBeNull();
  });

  it('treats a hand-placed row as fixed on the reflowed side too, so it is passed by', () => {
    // A Mon-Thu drop flows around a row a human pinned, exactly as it flows around a
    // lock: the server ignores fixed rows on that side and cuts nothing.
    expect(dropEffectOf(input({ rows: [row({ id: 'a-mano', handPlaced: true })] }))).toBeNull();
  });

  it('measures the drop by its SEGMENTS, so it never claims the lunch band', () => {
    // 6 h released at 10:00 is stored as 10:00-14:00 plus 15:30-17:30 (CLAUDE.md, *A
    // Drop Is Stored In Segments*), so a row sitting inside the break is untouched. The
    // raw 10:00-16:00 rectangle the pointer draws would have announced a cut the server
    // will never perform — the one direction a preview must not be wrong in.
    const inLunch = row({ id: 'comida', startMinutes: 14 * 60 + 15, durationMinutes: 45 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [inLunch] }),
      ),
    ).toBeNull();

    // ...and the hours pushed past the break by that same cut DO reach further down the
    // afternoon than the rectangle does: 17:00 is inside the drop, 16:00 was its edge.
    const afternoon = row({ id: 'tarde', startMinutes: 17 * 60, durationMinutes: 60 });
    expect(
      dropEffectOf(
        input({ dayIsWeekend: true, startMinutes: 10 * 60, durationMinutes: 6 * 60, rows: [afternoon] }),
      ),
    ).toMatchObject({ kind: 'cut', blockId: 'tarde' });
  });

  it('reports the merge before the cut, the order the server resolves them in', () => {
    const effect = dropEffectOf(
      input({
        dayIsWeekend: true,
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
});
