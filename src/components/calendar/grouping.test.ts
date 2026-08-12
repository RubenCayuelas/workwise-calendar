/**
 * The visual unit, and in particular what it carries about a HAND-SET length.
 *
 * A unit is one gesture on screen but several rows in the database, so the two facts
 * the block draws — the padlock and the hand-set mark — roll up differently and this
 * is where that is pinned down. `locked` answers a yes/no question about the whole
 * unit; `manualBlockIds` has to name the rows, because that list is exactly what
 * *back to automatic* sends and a unit can legitimately be half hand-set.
 */

import { describe, expect, it } from 'vitest';
import { groupBlocks } from './grouping';
import type { WeekBlock } from '../../lib/api-client';

const PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

function block(overrides: Partial<WeekBlock> & { id: string }): WeekBlock {
  return {
    projectId: 'barandilla',
    date: '2026-08-12',
    startMinutes: 8 * 60,
    durationMinutes: 60,
    locked: false,
    manualDuration: false,
    handPlaced: false,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    project: { id: 'barandilla', name: 'Barandilla', color: '#2F6FEB' },
    ...overrides,
  };
}

describe('groupBlocks — the hand-set mark', () => {
  it('leaves the list empty when the engine owns every row', () => {
    const groups = groupBlocks([block({ id: 'a' })], PERIODS);
    expect(groups[0].manualBlockIds).toEqual([]);
  });

  it('keeps both halves of a stretch that had to be cut at the lunch break', () => {
    // The engine stores a 7 h hand-set stretch as 13:00-14:00 plus 15:30-19:30 and
    // reads them back as ONE stretch; the unit has to be able to release both.
    const groups = groupBlocks(
      [
        block({ id: 'morning', startMinutes: 13 * 60, durationMinutes: 60, manualDuration: true }),
        block({
          id: 'afternoon',
          startMinutes: 15 * 60 + 30,
          durationMinutes: 4 * 60,
          manualDuration: true,
        }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].manualBlockIds).toEqual(['morning', 'afternoon']);
    expect(groups[0].manualBlockIds.length).toBe(groups[0].blocks.length);
  });

  it('names only the hand-set half of a unit the owner half sized', () => {
    const groups = groupBlocks(
      [
        block({ id: 'drawn', startMinutes: 13 * 60, durationMinutes: 60, manualDuration: true }),
        block({ id: 'auto', startMinutes: 15 * 60 + 30, durationMinutes: 60 }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].manualBlockIds).toEqual(['drawn']);
    // The unit is still one thing to drag, and only part of it is hand-set — which is
    // why the group cannot answer this with a single boolean.
    expect(groups[0].manualBlockIds.length).toBeLessThan(groups[0].blocks.length);
  });

  it('does not leak the mark across two jobs that merely touch', () => {
    const groups = groupBlocks(
      [
        block({ id: 'a', durationMinutes: 60, manualDuration: true }),
        block({ id: 'b', projectId: 'porton', startMinutes: 9 * 60, durationMinutes: 60 }),
      ],
      PERIODS,
    );
    expect(groups.map((group) => group.manualBlockIds)).toEqual([['a'], []]);
  });
});

describe('groupBlocks — what *back to automatic* releases', () => {
  it('is empty while the engine owns the unit', () => {
    expect(groupBlocks([block({ id: 'a' })], PERIODS)[0].releasableBlockIds).toEqual([]);
  });

  it('covers a hand-PLACED row whose length is perfectly automatic', () => {
    // The Friday defect's row: pinned to a day, sized by the engine. Keying the action
    // off `manualBlockIds` alone would leave it with no visible way back.
    const groups = groupBlocks([block({ id: 'viernes', handPlaced: true })], PERIODS);
    expect(groups[0].manualBlockIds).toEqual([]);
    expect(groups[0].releasableBlockIds).toEqual(['viernes']);
  });

  it('names each row once when a row carries both marks', () => {
    const groups = groupBlocks(
      [block({ id: 'ambas', manualDuration: true, handPlaced: true })],
      PERIODS,
    );
    expect(groups[0].releasableBlockIds).toEqual(['ambas']);
  });

  it('gathers both halves of a unit the owner pinned and then sized', () => {
    const groups = groupBlocks(
      [
        block({ id: 'morning', startMinutes: 13 * 60, durationMinutes: 60, handPlaced: true }),
        block({
          id: 'afternoon',
          startMinutes: 15 * 60 + 30,
          durationMinutes: 60,
          manualDuration: true,
        }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].releasableBlockIds).toEqual(['morning', 'afternoon']);
  });
});
