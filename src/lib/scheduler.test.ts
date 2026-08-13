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
import {
  createProject,
  deleteProject,
  patchProject,
  previewProjectCreation,
} from './operations/projects';
import {
  deleteBlock,
  moveBlock,
  releaseBlock,
  resizeBlock,
  setBlockLock,
  splitBlock,
} from './operations/blocks';
import { createGap, deleteGap } from './operations/gaps';
import { updateSettings } from './operations/settings';
import { readWeek } from './operations/views';
import { insertBlock, listBlocks, updateBlock } from './repositories/blocks';
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
const NEXT_TUE = '2026-08-18';

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

describe('creating a job with a start date', () => {
  /** The same call as `job()`, with the optional floor the create form now offers. */
  function dated(
    name: string,
    hours: number,
    startDate: string,
    options: { force?: boolean; today?: string } = {},
  ) {
    return createProject(
      {
        name,
        color: GREEN,
        totalMinutes: hours * 60,
        startDate,
        ...(options.force === undefined ? {} : { force: options.force }),
        today: options.today ?? MON,
      },
      db,
    );
  }

  it('is a floor: while the queue reaches the day, the job still joins the queue', () => {
    job('Puerta', 20);
    const created = dated('Barandilla', 4, MON);

    // Monday and Tuesday are full, so "not before Monday" is satisfied by Wednesday.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-19:30 Puerta`,
      `${TUE} 08:00-14:00 Puerta`,
      `${TUE} 15:30-19:30 Puerta`,
      `${WED} 08:00-12:00 Barandilla`,
    ]);
    expect(created.placement).toMatchObject({ mode: 'queue', deferred: true, autoLock: false });
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('forces the day when the owner says so, pushing what follows', () => {
    job('Puerta', 20);
    const created = dated('Barandilla', 4, TUE, { force: true });

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-19:30 Puerta`,
      `${TUE} 08:00-12:00 Barandilla`,
      `${TUE} 12:00-14:00 Puerta`,
      `${TUE} 15:30-19:30 Puerta`,
      `${WED} 08:00-12:00 Puerta`,
    ]);
    expect(created.placement).toMatchObject({ mode: 'forced', deferred: false });
    // Nothing was pinned: forcing writes a queue rank, exactly like a drag.
    expect(listBlocks(db).every((block) => !block.locked && !block.handPlaced)).toBe(true);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('locks every row of a job born beyond the work planned, and the lock holds', () => {
    job('Puerta', 4);
    const created = dated('Barandilla', 4, NEXT_MON);

    expect(calendar()).toEqual([
      `${MON} 08:00-12:00 Puerta`,
      `${NEXT_MON} 08:00-12:00 Barandilla [locked]`,
    ]);
    expect(created.placement).toMatchObject({ autoLock: true, mode: 'born', deferred: false });

    // The whole point of the padlock: an unrelated creation must not drag it to today.
    job('Reja', 6);
    expect(calendar()).toEqual([
      `${MON} 08:00-12:00 Puerta`,
      `${MON} 12:00-14:00 Reja`,
      `${MON} 15:30-19:30 Reja`,
      `${NEXT_MON} 08:00-12:00 Barandilla [locked]`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('honours a Friday by hand, marking it hand-placed rather than locked', () => {
    // 44 h fills Monday to Thursday and spills onto NEXT Monday (a new job skips the
    // colchón), so the queue already runs past this Friday: nothing needs a padlock,
    // and the hand mark is what keeps the buffer from self-cleaning the row away.
    job('Puerta', 44);
    const created = dated('Barandilla', 4, FRI);
    const row = listBlocks(db).find((block) => block.date === FRI);

    expect(row).toMatchObject({ startMinutes: 8 * 60, durationMinutes: 240, handPlaced: true });
    expect(row?.locked).toBe(false);
    expect(created.placement).toMatchObject({ day: 'buffer', handPlaced: true, autoLock: false });

    // And it survives the create-then-reflow churn that used to undo a Friday drop.
    job('Reja', 2);
    expect(listBlocks(db).find((block) => block.date === FRI)?.id).toBe(row?.id);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('honours a Saturday, where the engine places nothing at all', () => {
    job('Puerta', 20);
    dated('Barandilla', 4, SAT);
    const row = listBlocks(db).find((block) => block.date === SAT);

    // Beyond the work planned, so it carries BOTH marks: the hand says the owner chose
    // the day, the padlock is what stops the reflow claiming the hours back.
    expect(row).toMatchObject({
      startMinutes: 8 * 60,
      durationMinutes: 240,
      handPlaced: true,
      locked: true,
    });
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('records the past where it happened, locked, and the engine leaves it alone', () => {
    dated('Barandilla', 3, LAST_FRI);

    expect(calendar()).toEqual([`${LAST_FRI} 08:00-11:00 Barandilla [locked]`]);

    job('Puerta', 4);
    expect(calendar()).toEqual([
      `${LAST_FRI} 08:00-11:00 Barandilla [locked]`,
      `${MON} 08:00-12:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('splits a long job at the lunch break and skips the colchon on the way forward', () => {
    dated('Escalera', 24, NEXT_TUE);

    expect(calendar()).toEqual([
      `${NEXT_TUE} 08:00-14:00 Escalera [locked]`,
      `${NEXT_TUE} 15:30-19:30 Escalera [locked]`,
      '2026-08-19 08:00-14:00 Escalera [locked]',
      '2026-08-19 15:30-19:30 Escalera [locked]',
      // Thursday the 20th, not Friday the 21st: a new job never targets the buffer.
      '2026-08-20 08:00-12:00 Escalera [locked]',
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('previews exactly what the save then writes', () => {
    job('Puerta', 20);

    for (const [startDate, force] of [
      [MON, false],
      [TUE, true],
      [NEXT_MON, false],
      [FRI, false],
      [SAT, false],
      [LAST_FRI, false],
    ] as const) {
      const preview = previewProjectCreation(
        { startDate, totalMinutes: 4 * 60, force, today: MON },
        db,
      );
      const created = createProject(
        { name: `Job ${startDate}`, color: BLUE, totalMinutes: 4 * 60, startDate, force, today: MON },
        db,
      );

      expect(
        created.blocks.map((block) => ({
          date: block.date,
          startMinutes: block.startMinutes,
          durationMinutes: block.durationMinutes,
          locked: block.locked,
          handPlaced: block.handPlaced,
        })),
        `preview drifted for ${startDate}`,
      ).toEqual(preview.rows);

      // Reset for the next case, so each one is measured against the same calendar.
      deleteProject(created.project.id, { today: MON }, db);
    }
  });

  it('names the jobs and the days in the way, across the whole span', () => {
    job('Puerta', 20);
    const preview = previewProjectCreation({ startDate: MON, totalMinutes: 20 * 60, today: MON }, db);

    expect(preview.span).toEqual({ startDate: MON, endDate: TUE });
    expect(
      preview.collisions.map((item) => `${item.date} ${item.projectName} ${item.minutes}`),
    ).toEqual([`${MON} Puerta 600`, `${TUE} Puerta 600`]);
    expect(preview.deferred).toBe(true);
    expect(preview.canForce).toBe(true);
    expect(preview.freeDates[0]).toBe(WED);
  });

  it('refuses without writing when the hours run past the horizon', () => {
    updateSettings({ planningHorizonWeeks: 1 }, { today: MON }, db);

    const error = refusal(() => dated('Imposible', 200, TUE));

    expect(error.code).toBe('horizon-exceeded');
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

// ---------------------------------------------------------------------------
// A drop the engine used to undo
// ---------------------------------------------------------------------------
//
// THE REPRODUCED DEFECT. `PATCH /api/blocks/:id {action:"move", date:<a Friday>,
// startMinutes:600}` answered 200 and changed nothing. Friday is in the movable pool —
// the engine may put growth overflow there AND recover it — so the reflow pulled the
// hand-dropped row straight back. The same move to a Saturday worked, and to a past
// Monday worked; only Friday failed, silently, which is the worst mode.

describe('a drop onto the Friday colchon', () => {
  it('stays on Friday, in the slot it was dropped in', () => {
    const puerta = job('Puerta', 4);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);

    const result = moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta`]);
    expect(result.block?.handPlaced).toBe(true);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('survives the churn that used to undo it: another job created, then deleted', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    const barandilla = job('Barandilla', 4, GREEN);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Barandilla`, `${FRI} 10:00-14:00 Puerta`]);

    deleteProject(barandilla.project.id, { today: MON }, db);
    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('comes home when the row is put back to automatic', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    const released = releaseBlock(puerta.blocks[0].id, { today: MON }, db);

    expect(released.block?.handPlaced).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);
  });

  it('leaves an ordinary weekday drop unmarked — it re-ranks the queue, it does not pin', () => {
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);

    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);

    expect(result.block?.handPlaced).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`, `${MON} 10:00-14:00 Puerta`]);
  });

  it('marks a weekend drop too, where the engine already kept its hands off', () => {
    const puerta = job('Puerta', 4);

    const result = moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 9 * 60, today: MON }, db);

    expect(result.block?.handPlaced).toBe(true);
    expect(calendar()).toEqual([`${SAT} 09:00-13:00 Puerta`]);
  });

  it('clears the mark when the row is dragged back into the auto-fill week', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    const result = moveBlock(puerta.blocks[0].id, { date: TUE, startMinutes: 10 * 60, today: MON }, db);

    expect(result.block?.handPlaced).toBe(false);
    // Back under the engine, which settles it at the top of the week.
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);
  });

  it('gives the scissors the same rule: a fragment dropped on Friday stays there', () => {
    const puerta = job('Puerta', 8);

    splitBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, date: FRI, startMinutes: 9 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${FRI} 09:00-11:00 Puerta`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
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

    const released = releaseBlock(puerta.blocks[0].id, { today: MON }, db);

    // Releasing gives back the LENGTH, not the queue position. Barandilla now ranks
    // between Puerta's two runs on the calendar, and queue order IS calendar order, so
    // the engine keeps that order — exactly as it does after any drag. To put Puerta
    // back in front, drag it there.
    expect(released.block?.manualDuration).toBe(false);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta`,
      `${MON} 10:00-14:00 Barandilla`,
      // Puerta's second run is a CONTINUATION — the job already started this morning —
      // so it fills Monday's afternoon and finishes on Tuesday, instead of moving whole
      // to Tuesday and leaving 15:30-19:30 empty. Monday is booked to its 10 h stop line.
      `${MON} 15:30-19:30 Puerta`,
      `${TUE} 08:00-10:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('puts a job back the way it was when the only hand-set row is released', () => {
    const puerta = job('Puerta', 8);
    const automatic = calendar();

    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Puerta`, `${TUE} 08:00-14:00 Puerta`]);

    releaseBlock(puerta.blocks[0].id, { today: MON }, db);

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

  it('fills the rest of the day with the tail a drop displaced, instead of jumping a week', () => {
    // The third reproduced defect, in the owner's words: «al mover un bloque a otro, en
    // vez de adaptarse, desplazó el bloque al día siguiente sin partirlo ni nada,
    // dejando el día vacío después de la tarea que he movido».
    job('Barandilla', 12, GREEN, THU);
    const marquesina = job('Marquesina', 2, BLUE, THU);
    const dropped = listBlocks(db).find((row) => row.projectId === marquesina.project.id);

    moveBlock(dropped!.id, { date: THU, startMinutes: 10 * 60, today: THU }, db);

    expect(calendar()).toEqual([
      `${THU} 08:00-10:00 Barandilla`,
      `${THU} 10:00-12:00 Marquesina`,
      // The 10 h tail used to leave Thursday 12:00-19:30 empty and land whole on the
      // following Monday. A continuation fills forward from where it was cut.
      `${THU} 12:00-14:00 Barandilla`,
      `${THU} 15:30-19:30 Barandilla`,
      `${NEXT_MON} 08:00-12:00 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(12 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('stores a drop that crosses the lunch break as two rows', () => {
    // The fourth reproduced defect: a 360 min drop at 10:00 was stored as ONE row
    // running straight through 14:00-15:30. `duration` is net working time, so that row
    // was a lie, and the grid, the overlap arithmetic and auto-merge all assume it
    // cannot happen.
    const puerta = job('Puerta', 6);

    moveBlock(puerta.blocks[0].id, { date: LAST_FRI, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${LAST_FRI} 10:00-14:00 Puerta`,
      `${LAST_FRI} 15:30-17:30 Puerta`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(6 * 60);
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
// Growing a job whose last row is in the frozen past
// ---------------------------------------------------------------------------
//
// The worst defect found on v0.4, and the one that needed no unusual gesture at all: a
// row on TODAY becomes a past row overnight, so any job carrying yesterday's work was
// one hours-edit away from a dead app.
//
// Reproduced over HTTP on a clean database with today = Wed 2026-08-12: a 2 h job whose
// one row sat on Tue 11 at 12:00-14:00, raised to 6 h, was stored as `Tue 12:00 + 360
// min` — one row straight through the 14:00-15:30 lunch break, claiming 6 h where the
// clock holds 4.5 h. Raised to 13 h it became `12:00-25:00`, and the week view died with
// `RangeError: Invalid minutes "1500"` out of `useFormat().time`.
//
// Two independent fixes, and the second one matters even though the first closes the
// path: the LIFO growth target now agrees with the movable pool, AND no transaction can
// store a row running past the end of its day whatever produced it.

describe('raising the hours of a job whose only row is in the frozen past', () => {
  /** A 2 h job whose single row sits on yesterday at 12:00, today being Wednesday. */
  function yesterdaysWork() {
    const puerta = job('Puerta', 2, BLUE, WED);
    moveBlock(puerta.blocks[0].id, { date: TUE, startMinutes: 12 * 60, today: WED }, db);
    expect(calendar()).toEqual([`${TUE} 12:00-14:00 Puerta`]);
    return { project: puerta.project, blockId: listBlocks(db)[0].id };
  }

  it('gives the added hours their own row instead of inflating yesterday', () => {
    const { project, blockId } = yesterdaysWork();

    patchProject(project.id, { totalMinutes: 6 * 60, today: WED }, db);

    // Yesterday is the RECORD of what the shop did: 2 h, unchanged and never straddling
    // the lunch break. The 4 h are a row of their own, placed by the engine.
    expect(calendar()).toEqual([`${TUE} 12:00-14:00 Puerta`, `${WED} 08:00-12:00 Puerta`]);
    expect(listBlocks(db).find((row) => row.id === blockId)?.durationMinutes).toBe(2 * 60);
    expect(listProjects(db)[0].totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('keeps every stored row inside its day when the estimate is raised to 13 h', () => {
    // The step that used to write `12:00-25:00` and take the page down.
    const { project } = yesterdaysWork();

    patchProject(project.id, { totalMinutes: 6 * 60, today: WED }, db);
    patchProject(project.id, { totalMinutes: 13 * 60, today: WED }, db);

    expect(calendar()).toEqual([
      `${TUE} 12:00-14:00 Puerta`,
      `${WED} 08:00-14:00 Puerta`,
      `${WED} 15:30-19:30 Puerta`,
      `${THU} 08:00-09:00 Puerta`,
    ]);
    for (const row of listBlocks(db)) {
      expect(row.startMinutes + row.durationMinutes, `${row.date} runs past the end of the day`).toBeLessThanOrEqual(
        24 * 60,
      );
    }
    expect(listProjects(db)[0].totalMinutes).toBe(13 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('still lets the owner take hours off yesterday: shrinking frees space', () => {
    const { project, blockId } = yesterdaysWork();

    patchProject(project.id, { totalMinutes: 90, today: WED }, db);

    expect(listBlocks(db).find((row) => row.id === blockId)?.durationMinutes).toBe(90);
    expect(calendar()).toEqual([`${TUE} 12:00-13:30 Puerta`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('no transaction may store a row that runs past the end of its day', () => {
  // The belt to the LIFO fix's braces. A rendering crash from bad stored data must be
  // impossible, not merely unreachable through the paths that were fixed — so the guard
  // sits on the write itself, where every row goes through regardless of what produced it.

  it('refuses a resize that would push a past row past midnight, and writes nothing', () => {
    // Reachable by hand: *Block Resize* is deliberately offered on past rows so
    // yesterday can be corrected, and over HTTP the duration is not capped by the
    // drag layer's own limit.
    const puerta = job('Puerta', 2, BLUE, WED);
    moveBlock(puerta.blocks[0].id, { date: TUE, startMinutes: 12 * 60, today: WED }, db);
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 13 * 60, today: WED }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('row-exceeds-day');
    expect(error.messageKey).toBe('errors.rowExceedsDay');
    expect(error.details).toMatchObject({ date: TUE, startTime: '12:00' });
    expect(calendar()).toEqual(before);
    expect(listProjects(db)[0].totalMinutes).toBe(2 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses the INSERT and the UPDATE alike, so no caller can slip past it', () => {
    const puerta = job('Puerta', 2, BLUE, WED);
    const stored = listBlocks(db)[0];
    const overrunning = {
      id: 'imposible',
      projectId: puerta.project.id,
      date: WED,
      startMinutes: 23 * 60,
      durationMinutes: 2 * 60,
      locked: false,
      manualDuration: false,
      handPlaced: false,
    };

    const inserted = refusal(() => insertBlock(overrunning, db));
    expect(inserted.status).toBe(409);
    expect(inserted.code).toBe('row-exceeds-day');
    expect(inserted.details).toMatchObject({ startTime: '23:00', durationMinutes: 2 * 60 });

    const updated = refusal(() => updateBlock({ ...overrunning, id: stored.id }, db));
    expect(updated.code).toBe('row-exceeds-day');

    // Nothing was written by either attempt.
    expect(calendar()).toEqual([`${WED} 08:00-10:00 Puerta`]);
  });

  it('accepts a row that ends exactly at midnight, which is inside the day', () => {
    const puerta = job('Puerta', 2, BLUE, WED);
    const stored = listBlocks(db)[0];

    expect(() =>
      updateBlock(
        {
          id: stored.id,
          projectId: puerta.project.id,
          date: WED,
          startMinutes: 22 * 60,
          durationMinutes: 2 * 60,
          locked: true,
          manualDuration: false,
          handPlaced: false,
        },
        db,
      ),
    ).not.toThrow();
    expect(calendar()).toEqual([`${WED} 22:00-24:00 Puerta [locked]`]);
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
