/**
 * The data layer's specification: repositories, the scheduler seam and the
 * operations the API routes are thin wrappers around.
 *
 * `composition.test.ts` already proves the engine's rules against a snapshot. What
 * is left to prove is everything that snapshot has to survive on its way to SQLite:
 *
 * - the hours invariant holds after every write, in integer minutes,
 * - a refusal writes NOTHING, whichever half of the operation refuses,
 * - the Friday colchón is opt-in per operation and cannot be reached by accident,
 * - hours survive the REAL <-> minutes boundary without drifting.
 *
 * Every test runs against `openDatabase(':memory:')`, migrated and isolated, and
 * every operation is given an explicit `today` so the suite does not depend on the
 * day it is run. The week is the wireframe's: Monday 10 to Sunday 16 August 2026.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from './db';
import { minutesToHHmm } from './dates';
import { AppError } from './errors';
import { PROJECT_COLORS } from './projectColors';
import { assertProjectHours, readSummary } from './scheduler';
import { createProject, deleteProject, patchProject } from './operations/projects';
import {
  deleteBlock,
  moveBlock,
  releaseBlockDuration,
  resizeBlock,
  setBlockLock,
  splitBlock,
} from './operations/blocks';
import { createGap, deleteGap } from './operations/gaps';
import { updateSettings } from './operations/settings';
import { readWeek } from './operations/views';
import { listBlocks } from './repositories/blocks';
import { listGaps } from './repositories/gaps';
import { listProjects } from './repositories/projects';
import { readSettings } from './settings';
import type { Block } from '../types';

const LAST_FRI = '2026-08-07';
const MON = '2026-08-10';
const TUE = '2026-08-11';
const WED = '2026-08-12';
const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const SUN = '2026-08-16';
const NEXT_MON = '2026-08-17';

const BLUE = PROJECT_COLORS[0];
const GREEN = PROJECT_COLORS[1];

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One row per line as `YYYY-MM-DD HH:mm-HH:mm job`, so a failure reads like the calendar. */
function render(blocks: readonly Block[], names: Map<string, string>): string[] {
  return blocks.map(
    (block) =>
      `${block.date} ${minutesToHHmm(block.startMinutes)}-${minutesToHHmm(
        block.startMinutes + block.durationMinutes,
      )} ${names.get(block.projectId) ?? block.projectId}${block.locked ? ' [locked]' : ''}`,
  );
}

function calendar(): string[] {
  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  return render(listBlocks(db), names);
}

function job(name: string, hours: number, color: string = BLUE, today = MON) {
  return createProject({ name, color, totalMinutes: hours * 60, today }, db);
}

/** Runs `work` and returns the AppError it threw, failing the test if it did not. */
function refusal(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the operation to be refused');
}

// ---------------------------------------------------------------------------

describe('creating a job', () => {
  it('places its hours from Monday, splitting at the lunch break', () => {
    job('Puerta', 8);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('moves a job that does not fit whole to the next day, leaving the hole', () => {
    job('Puerta', 8);
    // Monday has 2 h of its 10 h stop line left, and "never split a job to make it
    // fit": the whole 4 h goes to Tuesday and Monday keeps its 2 h for the owner.
    job('Barandilla', 4, GREEN);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${TUE} 08:00-12:00 Barandilla`,
    ]);
  });

  it('skips the Friday colchon and lands on next Monday', () => {
    // 40 h fills Monday to Thursday at the 10 h stop line; the remaining 4 h are a
    // NEW job's hours, and "new job placement never targets Friday".
    job('Escalera', 44);

    const dates = [...new Set(listBlocks(db).map((block) => block.date))];
    expect(dates).toEqual([MON, TUE, WED, THU, NEXT_MON]);
    expect(dates).not.toContain(FRI);
  });

  it('keeps 2.5 h exact across the hours/minutes boundary', () => {
    const created = job('Remate', 2.5);

    expect(created.project.totalMinutes).toBe(150);
    expect(listBlocks(db)[0].durationMinutes).toBe(150);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('writes nothing at all when the hours cannot fit inside the horizon', () => {
    updateSettings({ planningHorizonWeeks: 1 }, { today: MON }, db);

    const error = refusal(() => job('Imposible', 200));

    expect(error.code).toBe('horizon-exceeded');
    expect(error.messageKey).toBe('errors.horizonExceeded');
    expect(error.status).toBe(409);
    // The project row was inserted before the engine ran: the rollback is what
    // stops a job existing with no hours on the calendar.
    expect(listProjects(db)).toEqual([]);
    expect(listBlocks(db)).toEqual([]);
  });
});

describe('the Friday buffer is opt-in', () => {
  it('absorbs overflow when an already-placed job grows', () => {
    const created = job('Escalera', 40);
    expect(calendar().every((line) => !line.startsWith(FRI))).toBe(true);

    patchProject(created.project.id, { totalMinutes: 44 * 60, today: MON }, db);

    expect(calendar().filter((line) => line.startsWith(FRI))).toEqual([
      `${FRI} 08:00-12:00 Escalera`,
    ]);
  });

  it('is not spent by an unrelated save', () => {
    job('Escalera', 40);
    // A second job is new work, not growth: its hours skip Friday entirely.
    job('Puerta', 4, GREEN);

    expect(calendar().some((line) => line.startsWith(FRI))).toBe(false);
    expect(calendar().filter((line) => line.startsWith(NEXT_MON))).toEqual([
      `${NEXT_MON} 08:00-12:00 Puerta`,
    ]);
  });

  it('self-cleans when room appears in Mon-Thu', () => {
    const escalera = job('Escalera', 40);
    patchProject(escalera.project.id, { totalMinutes: 44 * 60, today: MON }, db);
    expect(calendar().some((line) => line.startsWith(FRI))).toBe(true);

    patchProject(escalera.project.id, { totalMinutes: 36 * 60, today: MON }, db);

    expect(calendar().some((line) => line.startsWith(FRI))).toBe(false);
  });
});

describe('block gestures', () => {
  it('reorders the queue on a drop rather than pinning the block', () => {
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`, `${MON} 12:00-14:00 Barandilla`]);

    // Dropped into the top visual margin, above Monday's work. 07:00 is the RANK,
    // not the final time: the reflow settles the row at the top of the periods, and
    // everything behind it shifts. Dropping in a margin only sticks if the row is
    // also locked, since an unlocked row is always pulled back into working time.
    moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Barandilla`,
      `${MON} 10:00-14:00 Puerta`,
    ]);
  });

  it('lets a locked block hold its slot while the rest flows past it', () => {
    const puerta = job('Puerta', 4);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);
    job('Barandilla', 4, GREEN);

    expect(calendar()).toEqual([
      `${MON} 08:00-12:00 Puerta [locked]`,
      `${MON} 12:00-14:00 Barandilla`,
      `${MON} 15:30-17:30 Barandilla`,
    ]);
  });

  it('refuses to shrink a job\'s last block and writes nothing', () => {
    const puerta = job('Puerta', 8);
    const before = calendar();
    const last = puerta.blocks[puerta.blocks.length - 1];

    const error = refusal(() => resizeBlock(last.id, { durationMinutes: 60, today: MON }, db));

    expect(error.code).toBe('shrink-last-block');
    expect(error.messageKey).toBe('errors.shrinkLastBlock');
    expect(calendar()).toEqual(before);
  });

  it('raises the estimate when the last block is enlarged', () => {
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];

    const result = resizeBlock(last.id, { durationMinutes: 4 * 60, today: MON }, db);

    expect(result.summary.queuedMinutes).toBe(10 * 60);
    expect(listProjects(db)[0].totalMinutes).toBe(10 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('resizes an unlocked future row and the new length is actually stored', () => {
    // The reproduced defect: `PATCH /api/blocks/:id` with a resize used to answer 200
    // with the row unchanged, because the recomposition that follows re-derived the
    // job's segmentation from its total and undid the transfer.
    const puerta = job('Puerta', 8);
    const morning = puerta.blocks[0];
    expect(morning.durationMinutes).toBe(6 * 60);

    const result = resizeBlock(morning.id, { durationMinutes: 2 * 60, today: MON }, db);

    expect(result.block?.durationMinutes).toBe(2 * 60);
    expect(result.block?.manualDuration).toBe(true);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta`,
      // The 4 h went to the job's LAST block, and the run ends at the hand-set row, so
      // the remainder starts on the next auto-fill day instead of flowing straight back.
      `${TUE} 08:00-14:00 Puerta`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('gives the hours it frees to the job behind it, and takes them back on release', () => {
    const puerta = job('Puerta', 8);
    job('Barandilla', 4, GREEN);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${TUE} 08:00-12:00 Barandilla`,
    ]);

    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta`,
      // Barandilla moves up into the hours Monday just gained: a newer job starts
      // before the older one's remainder, which is the price of honouring the length.
      `${MON} 10:00-14:00 Barandilla`,
      `${TUE} 08:00-14:00 Puerta`,
    ]);

    const released = releaseBlockDuration(puerta.blocks[0].id, { today: MON }, db);

    // Releasing gives back the LENGTH, not the queue position. Barandilla now ranks
    // between Puerta's two runs on the calendar, and queue order IS calendar order, so
    // the engine keeps that order — exactly as it does after any drag. To put Puerta
    // back in front, drag it there.
    expect(released.block?.manualDuration).toBe(false);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta`,
      `${MON} 10:00-14:00 Barandilla`,
      `${TUE} 08:00-14:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('puts a job back the way it was when the only hand-set row is released', () => {
    const puerta = job('Puerta', 8);
    const automatic = calendar();

    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Puerta`, `${TUE} 08:00-14:00 Puerta`]);

    releaseBlockDuration(puerta.blocks[0].id, { today: MON }, db);

    expect(calendar()).toEqual(automatic);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('keeps a hand-set length through an unrelated save, a new job and a delete', () => {
    const puerta = job('Puerta', 8);
    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);
    const handSetId = puerta.blocks[0].id;

    const barandilla = job('Barandilla', 2, GREEN);
    createGap({ date: THU, startMinutes: 8 * 60, durationMinutes: 60, today: MON }, db);
    deleteProject(barandilla.project.id, { today: MON }, db);

    const stored = listBlocks(db).find((row) => row.id === handSetId);
    expect(stored?.durationMinutes).toBe(2 * 60);
    expect(stored?.manualDuration).toBe(true);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Puerta`, `${TUE} 08:00-14:00 Puerta`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses to shrink the last block with a 409 rather than doing nothing', () => {
    // The other half of the same fix: where the transfer is genuinely impossible the
    // caller gets a refusal with an i18n key, never a 200 with the row unchanged.
    const puerta = job('Puerta', 8);
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(puerta.blocks[puerta.blocks.length - 1].id, { durationMinutes: 60, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('shrink-last-block');
    expect(error.messageKey).toBe('errors.shrinkLastBlock');
    expect(calendar()).toEqual(before);
    expect(listBlocks(db).every((row) => !row.manualDuration)).toBe(true);
  });

  it('cuts a movable row a drop lands in, so the day reads A, B, A', () => {
    // The second reproduced defect: Porton dropped onto Wednesday 10:00, inside
    // Barandilla's 08:00-14:00 row, used to land at 15:30 — after the whole block —
    // and push Barandilla to Thursday.
    job('Barandilla', 6, GREEN, WED);
    const porton = job('Puerta', 2, BLUE, WED);
    expect(calendar()).toEqual([`${WED} 08:00-14:00 Barandilla`, `${WED} 15:30-17:30 Puerta`]);

    const result = moveBlock(porton.blocks[0].id, { date: WED, startMinutes: 10 * 60, today: WED }, db);

    expect(calendar()).toEqual([
      `${WED} 08:00-10:00 Barandilla`,
      `${WED} 10:00-12:00 Puerta`,
      `${WED} 12:00-14:00 Barandilla`,
      `${WED} 15:30-17:30 Barandilla`,
    ]);
    expect(result.displacedProjectIds).toHaveLength(1);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('moves a portion of a job without changing its estimate', () => {
    const puerta = job('Puerta', 8);
    job('Barandilla', 2, GREEN);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${MON} 17:30-19:30 Barandilla`,
    ]);

    splitBlock(
      puerta.blocks[0].id,
      { durationMinutes: 2 * 60, date: WED, startMinutes: 8 * 60, today: MON },
      db,
    );

    // The 2 h left the front of the job and took a new place in the queue — behind
    // Barandilla, which is what the drop asked for. It does NOT stay on Wednesday:
    // an unlocked fragment settles contiguously like any other unlocked row, so
    // parking hours on a specific day means locking them.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Barandilla`,
      `${MON} 17:30-19:30 Puerta`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Puerta')?.totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes the hours off the job when a block is deleted, and refuses the last one', () => {
    const puerta = job('Puerta', 8);

    deleteBlock(puerta.blocks[1].id, { today: MON }, db);
    expect(listProjects(db)[0].totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    const error = refusal(() => deleteBlock(listBlocks(db)[0].id, { today: MON }, db));
    expect(error.code).toBe('delete-last-block');
    expect(listBlocks(db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A hand drop where the reflow cannot reach
// ---------------------------------------------------------------------------
//
// The weekend and the frozen past are outside the engine, so two rows dropped on top
// of each other there stay that way: `compose` hands them back untouched and the grid
// draws them as two lanes. That used to happen silently — verified by splitting 2 h
// onto a Saturday the job already occupied. `manualPlacementBlockId` closes it inside
// the same transaction, so the invariant is asserted over the resolved calendar too.

describe('a drop onto the weekend, where the engine may not reflow', () => {
  it('merges two rows of the SAME job into one, summing the hours', () => {
    const puerta = job('Puerta', 8);
    splitBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, date: SAT, startMinutes: 9 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Puerta`, `${SAT} 09:00-11:00 Puerta`]);

    // The second 2 h land ON the first fragment. Sum, not union: 09:00-13:00 is 4 h.
    const result = splitBlock(
      listBlocks(db)[0].id,
      { durationMinutes: 2 * 60, date: SAT, startMinutes: 10 * 60, today: MON },
      db,
    );

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`, `${SAT} 09:00-13:00 Puerta`]);
    expect(result.mergedBlockIds).toHaveLength(1);
    expect(result.displacedProjectIds).toEqual([]);
    // Four hours on Saturday plus four on Monday: the estimate never moved.
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('cuts ANOTHER job and pushes its tail after the drop, keeping its hours', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: SAT, startMinutes: 9 * 60, today: MON }, db);
    const puerta = job('Puerta', 1);

    const result = moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 09:00-10:00 Barandilla`,
      `${SAT} 10:00-11:00 Puerta`,
      `${SAT} 11:00-12:00 Barandilla`,
    ]);
    expect(result.displacedProjectIds).toEqual([barandilla.project.id]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(2 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('carries a Saturday tail that no longer fits onto Sunday, never into the week', () => {
    const barandilla = job('Barandilla', 1, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: SAT, startMinutes: 18 * 60 + 30, today: MON }, db);
    const puerta = job('Puerta', 1);

    moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 18 * 60 + 30, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 18:30-19:30 Puerta`,
      `${SUN} 08:00-09:00 Barandilla`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses a drop onto a locked row, names it, and writes nothing', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: SAT, startMinutes: 9 * 60, today: MON }, db);
    setBlockLock(listBlocks(db)[0].id, true, { today: MON }, db);
    const puerta = job('Puerta', 1);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 10 * 60, today: MON }, db),
    );

    expect(error.code).toBe('overlaps-locked-block');
    expect(error.messageKey).toBe('errors.dropOverLockedBlock');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      projectName: 'Barandilla',
      date: SAT,
      startTime: '09:00',
      endTime: '11:00',
    });
    // The move is written before the engine runs, so the rollback is what keeps the
    // calendar exactly as it was.
    expect(calendar()).toEqual(before);
  });

  it('leaves the past alone but resolves a drop INTO it, since the past is frozen too', () => {
    // The owner may edit the past by hand at any time; the engine may not. So a drop
    // there is resolved the same way, and the displaced hours chain forward out of the
    // frozen day into the movable pool, where the reflow takes them.
    const historial = job('Historial', 1, GREEN);
    moveBlock(historial.blocks[0].id, { date: LAST_FRI, startMinutes: 18 * 60 + 30, today: MON }, db);
    const puerta = job('Puerta', 1);

    moveBlock(puerta.blocks[0].id, { date: LAST_FRI, startMinutes: 18 * 60 + 30, today: MON }, db);

    expect(calendar()).toEqual([
      `${LAST_FRI} 18:30-19:30 Puerta`,
      `${MON} 08:00-09:00 Historial`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('answers with `block: null` when the merge absorbed the very row that was moved', () => {
    const puerta = job('Puerta', 4);
    splitBlock(puerta.blocks[0].id, { durationMinutes: 60, date: SAT, startMinutes: 9 * 60, today: MON }, db);
    const monday = listBlocks(db).find((row) => row.date === MON);

    // The Monday row is dropped ON TOP of the fragment, and ranks after it, so the
    // fragment survives with the summed hours and the moved id is gone.
    const result = moveBlock(monday!.id, { date: SAT, startMinutes: 9 * 60 + 30, today: MON }, db);

    expect(calendar()).toEqual([`${SAT} 09:00-13:00 Puerta`]);
    expect(result.block).toBeNull();
    expect(result.mergedBlockIds).toEqual([monday!.id]);
    expect(result.blocks).toHaveLength(1);
    expect(listProjects(db)[0].totalMinutes).toBe(4 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('reports nothing merged or displaced for a gesture that is not a drop', () => {
    const puerta = job('Puerta', 4);

    const locked = setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    expect(locked.mergedBlockIds).toEqual([]);
    expect(locked.displacedProjectIds).toEqual([]);
  });
});

describe('gaps', () => {
  it('pushes unlocked work forward', () => {
    job('Puerta', 4);

    createGap({ date: MON, startMinutes: 8 * 60, durationMinutes: 2 * 60, reason: 'Avería', today: MON }, db);

    expect(calendar()).toEqual([`${MON} 10:00-14:00 Puerta`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses to cover a locked block, naming it, and saves nothing', () => {
    const puerta = job('Puerta', 4);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    const error = refusal(() =>
      createGap({ date: MON, startMinutes: 9 * 60, durationMinutes: 60, today: MON }, db),
    );

    expect(error.code).toBe('gap-over-fixed-block');
    expect(error.messageKey).toBe('errors.gapOverLockedBlock');
    expect(error.details).toMatchObject({ projectName: 'Puerta', date: MON, startTime: '08:00' });
    expect(listGaps(db)).toEqual([]);
  });

  it('gives the time back when it is deleted', () => {
    job('Puerta', 4);
    const gap = createGap({ date: MON, startMinutes: 8 * 60, durationMinutes: 2 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 10:00-14:00 Puerta`]);

    deleteGap(gap.gap.id, { today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);
  });
});

describe('settings', () => {
  it('re-caps the capacity to the shift and reflows the calendar', () => {
    job('Escalera', 12);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Escalera`,
      `${MON} 15:30-19:30 Escalera`,
      `${TUE} 08:00-10:00 Escalera`,
    ]);

    const result = updateSettings({ period2Enabled: false }, { today: MON }, db);

    // The stop line was 10 h; with no afternoon the shift is 6 h and the setting is
    // pulled down rather than the save being rejected.
    expect(result.settings.defaultDayCapacity).toBe(6);
    expect(readSettings(db).defaultDayCapacity).toBe(6);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Escalera`,
      `${TUE} 08:00-14:00 Escalera`,
    ]);
  });

  it('ignores absent fields instead of blanking them', () => {
    // A PATCH route reads every optional field and passes what it found, so the
    // fields the request omitted arrive as explicit `undefined`. A spread merge does
    // not skip those, so this used to wipe `period1Start` and then fail validating it.
    const result = updateSettings(
      { period1Start: undefined, gapColor: undefined, period2Enabled: false },
      { today: MON },
      db,
    );

    expect(result.settings.period1Start).toBe('08:00');
    expect(result.settings.period2Enabled).toBe(false);
    expect(readSettings(db).period1End).toBe('14:00');
  });

  it('reports the offending field on a bad value', () => {
    const error = refusal(() => updateSettings({ visualMarginTop: 9 }, { today: MON }, db));

    expect(error.status).toBe(400);
    expect(error.field).toBe('visualMarginTop');
    expect(error.messageKey).toBe('errors.settingsInvalid');
  });
});

describe('deleting a job', () => {
  it('cascades its blocks and closes the hole', () => {
    const puerta = job('Puerta', 4);
    job('Barandilla', 4, GREEN);

    deleteProject(puerta.project.id, { today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Barandilla`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('the views the screens read', () => {
  it('answers the week with its days, blocks and their jobs in one call', () => {
    job('Puerta', 4);

    const week = readWeek(WED, { today: MON }, db);

    expect(week.week.startDate).toBe(MON);
    expect(week.week.isoWeek).toBe(33);
    expect(week.days.map((day) => day.role)).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
      'buffer',
      'manual',
      'manual',
    ]);
    // Plannable is the ENGINE's number: unlocked work is movable, so it does not
    // reduce it. Occupancy is `bookedMinutes`, which is what a day header reports.
    expect(week.days[0].plannableMinutes).toBe(10 * 60);
    expect(week.days[0].bookedMinutes).toBe(4 * 60);
    expect(week.days[5].plannableMinutes).toBe(0);
    expect(week.blocks[0].project).toEqual({ id: week.blocks[0].projectId, name: 'Puerta', color: BLUE });
    expect(week.shape.timelineStartMinutes).toBe(7 * 60);
    expect(week.shape.timelineEndMinutes).toBe(20 * 60 + 30);
  });

  it('summarises the whole calendar, not the week on screen', () => {
    job('Escalera', 44);

    const summary = readSummary(db, MON);

    expect(summary.queuedMinutes).toBe(44 * 60);
    expect(summary.lastOccupiedDate).toBe(NEXT_MON);
    expect(summary.bufferDate).toBe(FRI);
    expect(summary.bufferClear).toBe(true);
  });
});
