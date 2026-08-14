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

    // 07:59, which is what the drag layer sends for "drop this at the top of Monday":
    // 08:00 is taken by Puerta, so `rankFor` nudges the rank by a single minute. One
    // minute above the morning is a TIE-BREAK, not a request for the margin, which is
    // why the pin needs at least a quarter of an hour of it — see MIN_MANUAL_ONLY_MINUTES.
    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 8 * 60 - 1, today: MON }, db);

    expect(result.block?.handPlaced).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`, `${MON} 10:00-14:00 Puerta`]);
  });

  it('pins a drop into a visual margin, because the engine would pull it straight back', () => {
    // The owner's report C: "yo debo poder extender y colocar tareas en esas franjas si
    // yo quiero, de forma manual." An unmarked margin row is reflowed into the periods on
    // the very same save, so the margins were configurable and unusable. The mark is the
    // one the buffer and the weekend already use, and *back to automatic* releases it.
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);

    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);

    expect(result.block?.handPlaced).toBe(true);
    expect(calendar()).toEqual([
      // Half in the margin, half in the morning, exactly where it was dropped — and the
      // hour it holds inside the period is an obstacle Puerta flows around.
      `${MON} 07:00-09:00 Barandilla`,
      `${MON} 09:00-13:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('gives a margin row back to the engine on release', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 07:00-09:00 Barandilla`]);

    releaseBlock(barandilla.blocks[0].id, { today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`]);
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

    // Dropped at the top of Monday's work: 07:59 is the RANK the drag layer sends when
    // 08:00 is already taken, not a final time. The reflow settles the row at the top of
    // the periods and everything behind it shifts. (A drop a quarter of an hour or more
    // INTO the margin is a different gesture: it pins — see the margin tests above.)
    moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 8 * 60 - 1, today: MON }, db);

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

  it("stores a resize across the lunch break as two rows — the owner's worked example", () => {
    // "arrastro hasta las 17:30 una tarea que empezaba a las 10 ... sería de 10 a 14 y de
    // 15:30 a 17:30." The drag layer sends 6 h of NET working minutes; the break adds
    // nothing, and the row is stored cut at it like everything else on the calendar.
    job('Porton', 2);
    const barandilla = job('Barandilla', 14, GREEN);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla`,
      `${MON} 15:30-19:30 Barandilla`,
      `${TUE} 08:00-14:00 Barandilla`,
    ]);

    const result = resizeBlock(barandilla.blocks[0].id, { durationMinutes: 6 * 60, today: MON }, db);

    // The row the request named holds the first segment; the second is a row of its own.
    expect(result.block?.durationMinutes).toBe(4 * 60);
    expect(result.block?.manualDuration).toBe(true);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla`,
      `${MON} 15:30-17:30 Barandilla`,
      // A transfer, not growth: the 2 h the stretch gave up went to the job's last rows,
      // and the stretch closes Monday for its job, so they stay on Tuesday.
      `${TUE} 08:00-14:00 Barandilla`,
      `${TUE} 15:30-17:30 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(14 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // And back again, symmetrically: the same edge dragged up to 12:00 takes the stretch
    // back into the morning and the afternoon row is gone.
    resizeBlock(barandilla.blocks[0].id, { durationMinutes: 4 * 60, today: MON }, db);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla`,
      `${TUE} 08:00-14:00 Barandilla`,
      `${TUE} 15:30-19:30 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(14 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('lets a resize reach into the bottom margin, and the row stays there', () => {
    // Report C for the resize. Without the pin the reflow pulls the row back inside the
    // periods on this very save, which is what made the margins unusable by hand.
    job('Porton', 6);
    const puerta = job('Puerta', 2, GREEN);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Porton`, `${MON} 15:30-17:30 Puerta`]);

    // 15:30 to 20:30 — an hour past the last period, into the grey band the Settings
    // screen offers and no gesture could reach.
    const result = resizeBlock(puerta.blocks[0].id, { durationMinutes: 5 * 60, today: MON }, db);

    expect(result.block?.handPlaced).toBe(true);
    expect(result.block?.manualDuration).toBe(true);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Porton`, `${MON} 15:30-20:30 Puerta`]);
    // Nothing farther in the job to draw from, so this is the one case that grows the
    // estimate — 2 h to 5 h — and the hours invariant still holds.
    expect(listProjects(db).find((project) => project.name === 'Puerta')?.totalMinutes).toBe(5 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // It survives an unrelated save, which is the whole point of the mark.
    job('Reja', 2);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Porton`,
      `${MON} 15:30-20:30 Puerta`,
      `${TUE} 08:00-10:00 Reja`,
    ]);

    // Auto-fill still cannot reach the margin: Monday's stop line is the 10 h of periods,
    // not the 12 h the manual window covers.
    expect(readWeek(MON, { today: MON }, db).days[0].capacityMinutes).toBe(10 * 60);
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

  it('refuses a resize that would push a past row past the day, and writes nothing', () => {
    // Reachable by hand: *Block Resize* is deliberately offered on past rows so
    // yesterday can be corrected, and over HTTP the duration is not capped by the
    // drag layer's own limit. The END OF THE DAY now catches this one first — 25:00 is
    // past midnight and 20:30 comes long before it — so the refusal is the same 409
    // with the better sentence, and the midnight guard below is the backstop.
    const puerta = job('Puerta', 2, BLUE, WED);
    moveBlock(puerta.blocks[0].id, { date: TUE, startMinutes: 12 * 60, today: WED }, db);
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 13 * 60, today: WED }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('row-past-day-end');
    expect(error.messageKey).toBe('errors.rowPastDayEnd');
    expect(error.details).toMatchObject({ date: TUE, startTime: '12:00', dayEndTime: '20:30' });
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
// The end of the day, on every gesture that can reach past it
// ---------------------------------------------------------------------------
//
// Invariant 3 of the battery, and CLAUDE.md's own words twice over: a stored block never
// straddles "a non-working interval (lunch break, END OF DAY)", and the bottom-edge drag
// "stops at the end of the day's last manual window". The reproductions below are the
// owner's, replayed: every one of them answered 200 and stored a row hanging below the
// grid's own last rule.

describe('the end of the day is a line no write may cross', () => {
  it('refuses a resize whose stretch would run past the last manual window', () => {
    // Over HTTP the drag layer's cap is not in the way, and the server had none at all:
    // 12 h from 08:00 stored `08:00-14:00` + `15:30-21:30`.
    job('Uno', 6, BLUE, THU);
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 12 * 60, today: THU }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('row-past-day-end');
    expect(error.messageKey).toBe('errors.rowPastDayEnd');
    expect(error.details).toMatchObject({ date: THU, startTime: '15:30', dayEndTime: '20:30' });
    expect(calendar()).toEqual(before);
    expect(listProjects(db)[0].totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('accepts the resize that reaches exactly the end of the day', () => {
    job('Uno', 6, BLUE, THU);

    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 11 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno`, `${THU} 15:30-20:30 Uno`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses a split whose fragment would run past the end of the day', () => {
    // The scissors' second click goes through `rankFor`, which was not clamped at all:
    // 60 min at 19:45 stored `19:45-20:45`, and 210 min at 19:30 stored `19:30-23:00`.
    job('Uno', 10, BLUE, THU);
    const afternoon = listBlocks(db)[1];
    const before = calendar();

    for (const attempt of [
      { durationMinutes: 60, startMinutes: 19 * 60 + 45 },
      { durationMinutes: 210, startMinutes: 19 * 60 + 30 },
    ]) {
      const error = refusal(() => splitBlock(afternoon.id, { ...attempt, date: THU, today: THU }, db));
      expect(error.code, `${attempt.durationMinutes} at ${attempt.startMinutes}`).toBe('row-past-day-end');
      expect(calendar()).toEqual(before);
    }
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses a drop whose row would run past the end of the day, on a day that pins', () => {
    // 6 h released at 13:15 on the buffer: `13:15-14:00` + `15:30-20:45`.
    job('Uno', 6, BLUE, THU);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(listBlocks(db)[0].id, { date: FRI, startMinutes: 13 * 60 + 15, today: THU }, db),
    );

    expect(error.code).toBe('row-past-day-end');
    expect(calendar()).toEqual(before);
  });

  it('takes the same drop one quarter earlier, where it fits', () => {
    job('Uno', 6, BLUE, THU);

    moveBlock(listBlocks(db)[0].id, { date: FRI, startMinutes: 13 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${FRI} 13:00-14:00 Uno`, `${FRI} 15:30-20:30 Uno`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses a same-job merge the day cannot hold, instead of storing one row through lunch', () => {
    // Repeating one drop used to compound: `Sat 13:00-23:00, 10 h`, straight through the
    // lunch band and 2.5 h past the end of the day, with hours conserved so nothing warned.
    const grande = job('Grande', 10, BLUE, THU);
    // The unit's two halves, dropped on Saturday one after the other: the first lands as
    // `12:00-14:00` + `15:30-19:30`, and the second then merges into BOTH of them.
    moveBlock(grande.blocks[0].id, { date: SAT, startMinutes: 12 * 60, today: THU }, db);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(grande.blocks[1].id, { date: SAT, startMinutes: 13 * 60, today: THU }, db),
    );

    expect(error.code).toBe('merge-exceeds-day');
    expect(error.messageKey).toBe('errors.mergeExceedsDay');
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('still lets a row that a settings change stranded outside the windows be saved', () => {
    // CLAUDE.md: setting the bottom margin to 0 under a hand-placed row keeps the hours
    // already in it. So the guard refuses a gesture that makes the overrun WORSE, and
    // never one that leaves it alone or moves the row somewhere legal.
    const uno = job('Uno', 1, BLUE, THU);
    moveBlock(uno.blocks[0].id, { date: THU, startMinutes: 19 * 60 + 30, today: THU }, db);
    updateSettings({ visualMarginBottom: 0 }, { today: THU }, db);
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno`]);

    // The same length again: accepted, marks and all.
    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 60, today: THU }, db);
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno`]);

    // Longer: refused, because that is new time outside every window.
    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 90, today: THU }, db),
    );
    expect(error.code).toBe('row-past-day-end');
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno`]);

    // And it can still be dragged back inside the day, where a Mon-Thu drop is a RANK: the
    // row rejoins the pool and the reflow settles it at the top of the day.
    moveBlock(listBlocks(db)[0].id, { date: THU, startMinutes: 10 * 60, today: THU }, db);
    expect(calendar()).toEqual([`${THU} 08:00-09:00 Uno`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('a drop names the whole unit, so a unit moves in ONE transaction', () => {
  it('moves both halves of a lunch-split unit, and lands where the ghost drew it', () => {
    // One PATCH per row with a full reflow between them left part of the unit behind: the
    // reflow re-laid the job's remaining hours onto DIFFERENT ids, so the second request
    // moved whatever row now carried the id the drag had captured. The message then said
    // no hour was lost, which was true, while an hour of the unit had not moved.
    job('Uno', 5, BLUE, THU);
    const dos = job('Dos', 3, GREEN, THU);
    expect(calendar()).toEqual([
      `${THU} 08:00-13:00 Uno`,
      `${THU} 13:00-14:00 Dos`,
      `${THU} 15:30-17:30 Dos`,
    ]);

    const unit = listBlocks(db).filter((row) => row.projectId === dos.project.id);
    const result = moveBlock(
      unit[0].id,
      { date: SAT, startMinutes: 8 * 60, today: THU, unitBlockIds: unit.map((row) => row.id) },
      db,
    );

    expect(calendar()).toEqual([`${THU} 08:00-13:00 Uno`, `${SAT} 08:00-11:00 Dos`]);
    expect(result.blocks.map((row) => row.durationMinutes)).toEqual([3 * 60]);
    expect(
      listProjects(db).map((project) => `${project.name} ${project.totalMinutes}`).sort(),
    ).toEqual(['Dos 180', 'Uno 300']);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('cuts the unit at the lunch break when it lands across it', () => {
    const uno = job('Uno', 6, BLUE, THU);
    resizeBlock(uno.blocks[0].id, { durationMinutes: 8 * 60, today: THU }, db);
    const unit = listBlocks(db);
    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno`, `${THU} 15:30-17:30 Uno`]);

    moveBlock(
      unit[0].id,
      { date: SAT, startMinutes: 10 * 60, today: THU, unitBlockIds: unit.map((row) => row.id) },
      db,
    );

    expect(calendar()).toEqual([`${SAT} 10:00-14:00 Uno`, `${SAT} 15:30-19:30 Uno`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('moves the whole unit onto the buffer, where the reflow is live between requests', () => {
    // The day that made the race visible. Friday IS in the movable pool, so one request
    // per row re-laid the job's remaining hours onto different ids in between and the
    // second request moved whatever row had inherited the id the drag captured. One
    // transaction, one reflow: both halves land and the estimate never moves.
    const uno = job('Uno', 6, BLUE, THU);
    resizeBlock(uno.blocks[0].id, { durationMinutes: 8 * 60, today: THU }, db);
    const unit = listBlocks(db);
    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno`, `${THU} 15:30-17:30 Uno`]);

    const result = moveBlock(
      unit[0].id,
      { date: FRI, startMinutes: 10 * 60, today: THU, unitBlockIds: unit.map((row) => row.id) },
      db,
    );

    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Uno`, `${FRI} 15:30-19:30 Uno`]);
    expect(result.blocks.reduce((total, row) => total + row.durationMinutes, 0)).toBe(8 * 60);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('ignores an id that is not part of the unit, and one that no longer exists', () => {
    job('Uno', 4, BLUE, THU);
    const dos = job('Dos', 2, GREEN, THU);
    const rows = listBlocks(db);

    moveBlock(
      dos.blocks[0].id,
      { date: SAT, startMinutes: 9 * 60, today: THU, unitBlockIds: [rows[0].id, 'gone'] },
      db,
    );

    // Uno stayed where it was: it is another job, whatever the request claimed.
    expect(calendar()).toEqual([`${THU} 08:00-12:00 Uno`, `${SAT} 09:00-11:00 Dos`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('the scissors keep the calendar on the quarter hour', () => {
  it('refuses a fragment, or a remainder, shorter than one snap step', () => {
    job('Tiny', 0.5, BLUE, THU);
    const row = listBlocks(db)[0];

    const tooSmall = refusal(() =>
      splitBlock(row.id, { durationMinutes: 5, date: THU, startMinutes: 9 * 60, today: THU }, db),
    );
    expect(tooSmall.status).toBe(409);
    expect(tooSmall.code).toBe('split-below-minimum');
    expect(tooSmall.messageKey).toBe('errors.splitBelowMinimum');

    const remainderTooSmall = refusal(() =>
      splitBlock(row.id, { durationMinutes: 25, date: THU, startMinutes: 9 * 60, today: THU }, db),
    );
    expect(remainderTooSmall.code).toBe('split-below-minimum');

    expect(calendar()).toEqual([`${THU} 08:00-08:30 Tiny`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes a quarter of an hour, which is the smallest thing the calendar can draw', () => {
    job('Tiny', 0.5, BLUE, THU);
    const row = listBlocks(db)[0];

    splitBlock(row.id, { durationMinutes: 15, date: SAT, startMinutes: 9 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-08:15 Tiny`, `${SAT} 09:00-09:15 Tiny`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('a drop onto a gap', () => {
  it('slides clear of it on the buffer, keeping the day the owner aimed at', () => {
    // Gaps and blocks are one occupancy set, so the drop may not share those minutes —
    // but Friday is a day the engine reflows, and there a refusal was a dead end: the
    // owner aimed at a Friday, and the answer has to be a Friday. So the drop gives up
    // the exact minute (never the day) and lands at the first slot clear of the gap.
    job('Uno', 2, BLUE, THU);
    const dos = job('Dos', 1, GREEN, THU);
    createGap({ date: FRI, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: THU }, db);

    const result = moveBlock(dos.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-10:00 Uno`, `${FRI} 11:00-12:00 Dos`]);
    // Still the owner's Friday: the slide keeps the pin, so the engine never takes it back.
    expect(result.block?.handPlaced).toBe(true);
    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('is refused on the WEEKEND, where nothing will ever separate the two', () => {
    // The one place the exact minute IS the promise: the engine lays nothing out on a
    // Saturday, so a drop there is a literal placement and a collision with a gap is a
    // real, permanent conflict. Sliding it would move the row the owner aimed with.
    job('Uno', 2, BLUE, THU);
    const dos = job('Dos', 1, GREEN, THU);
    createGap({ date: SAT, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: THU }, db);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(dos.blocks[0].id, { date: SAT, startMinutes: 10 * 60, today: THU }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('overlaps-gap');
    expect(error.messageKey).toBe('errors.dropOverGap');
    expect(error.details).toMatchObject({ date: SAT, startTime: '10:00', endTime: '11:00', reason: 'Avería' });
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes the same drop in the free time beside it', () => {
    job('Uno', 2, BLUE, THU);
    const dos = job('Dos', 1, GREEN, THU);
    createGap({ date: FRI, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: THU }, db);

    moveBlock(dos.blocks[0].id, { date: FRI, startMinutes: 11 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-10:00 Uno`, `${FRI} 11:00-12:00 Dos`]);
  });

  it('leaves a Monday-Thursday drop alone: the reflow keeps auto work off the gap', () => {
    job('Uno', 2, BLUE, THU);
    const dos = job('Dos', 1, GREEN, THU);
    createGap({ date: NEXT_MON, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: THU }, db);

    moveBlock(dos.blocks[0].id, { date: NEXT_MON, startMinutes: 10 * 60, today: THU }, db);

    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// «Aún no cabe» — the drop that was refused for a room the reflow was about to make
// ---------------------------------------------------------------------------
//
// The owner's report, in full: «cuando intento mover algo se coloca antes de
// recalcularse, por lo que si lo intento pasar al día siguiente en el que ahora no hay
// hueco pero si lo muevo se recalcula y queda disponible, no lo puedo asignar
// directamente porque "aún no cabe"». The refusal measured the drop against the calendar
// as it stood at that instant, and the answer was circular: the room on the target day is
// made BY the move, because the row leaves a hole on its own day and the work behind it
// moves up into it.

describe('a drop onto a day that is full at the moment it is released', () => {
  /**
   * Monday and Tuesday both full at the 10 h stop line, and a gap in one of Tuesday's
   * visual margins — the slot a drop PINS itself in, and therefore the one that used to
   * be refused.
   *
   *   MON  08:00-14:00 Uno (6 h)   TUE  08:00-12:00 Tres (4 h)
   *        15:30-19:30 Dos (4 h)        12:00-14:00 + 15:30-19:30 Cuatro (6 h)
   */
  function fullWeek(gap: { startMinutes: number; reason: string }) {
    job('Uno', 6, BLUE, MON);
    const dos = job('Dos', 4, GREEN, MON);
    job('Tres', 4, PROJECT_COLORS[2], MON);
    job('Cuatro', 6, PROJECT_COLORS[3], MON);
    createGap({ date: TUE, durationMinutes: 60, today: MON, ...gap }, db);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Uno`,
      `${MON} 15:30-19:30 Dos`,
      `${TUE} 08:00-12:00 Tres`,
      `${TUE} 12:00-14:00 Cuatro`,
      `${TUE} 15:30-19:30 Cuatro`,
    ]);
    return dos;
  }

  it('lands there anyway, slid clear of the gap: the reflow is what makes the room', () => {
    // «Quiero empezar el martes con esto»: the drop is aimed at the top margin, which is
    // manual-only time and therefore PINS the row — and the shop does not open until
    // 08:00, which is what the gap says. It used to answer 409 `overlaps-gap`, «Ahí no
    // cabe», with Tuesday visibly full underneath it.
    const dos = fullWeek({ startMinutes: 7 * 60, reason: 'Apertura' });

    const result = moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 7 * 60, today: MON }, db);

    // Tuesday had no free minute when the mouse was released. It has one now BECAUSE of
    // the move: Dos left a hole on Monday, Tres moved up into it, and Cuatro shifted into
    // the morning Tres had been holding.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Uno`,
      `${MON} 15:30-19:30 Tres`,
      `${TUE} 08:00-12:00 Dos`,
      `${TUE} 12:00-14:00 Cuatro`,
      `${TUE} 15:30-19:30 Cuatro`,
    ]);
    // The gap kept its minutes and the drop kept its day: it gave up the hour it could
    // not have and landed at the first one it could. The slot was asked for by hand, so
    // it stays hand-placed — *back to automatic* is the way out.
    expect(result.block?.date).toBe(TUE);
    expect(result.block?.startMinutes).toBe(8 * 60);
    expect(result.block?.handPlaced).toBe(true);
    expect(
      listProjects(db).map((project) => `${project.name} ${project.totalMinutes}`).sort(),
    ).toEqual(['Cuatro 360', 'Dos 240', 'Tres 240', 'Uno 360']);
    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('gives up the exact slot rather than the day when the day has no clear one', () => {
    // The same drop at the other end: 16:30 is the latest a 4 h row may start and still
    // end inside the day, so it is where the ghost sits when the owner aims at the bottom
    // of a full Tuesday — and it reaches into a margin the gap covers to the last minute.
    // There is nowhere on Tuesday to slide to, so the drop gives up its PIN instead of the
    // day: an ordinary queue rank, which is what a Monday-Thursday drop always was.
    const dos = fullWeek({ startMinutes: 19 * 60 + 30, reason: 'Cierre' });

    const result = moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 16 * 60 + 30, today: MON }, db);

    // Dos took the rank it was dropped at, inside Cuatro's afternoon row, so Cuatro was
    // cut and continues behind it (*A Drop That Overlaps*) — with its 6 h intact.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Uno`,
      `${MON} 15:30-19:30 Tres`,
      `${TUE} 08:00-11:00 Cuatro`,
      `${TUE} 11:00-14:00 Dos`,
      `${TUE} 15:30-16:30 Dos`,
      `${TUE} 16:30-19:30 Cuatro`,
    ]);
    expect(result.block?.date).toBe(TUE);
    expect(result.block?.handPlaced).toBe(false);
    expect(result.displacedProjectIds).toHaveLength(1);
    expect(
      listProjects(db).map((project) => `${project.name} ${project.totalMinutes}`).sort(),
    ).toEqual(['Cuatro 360', 'Dos 240', 'Tres 240', 'Uno 360']);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('is still refused when the row being dragged is LOCKED', () => {
    // The one promise a re-rank would break. A locked row keeps the exact slot wherever it
    // lands, so nothing will ever separate it from the gap: here "does it fit" really is
    // the question, and the answer is no.
    const dos = fullWeek({ startMinutes: 19 * 60 + 30, reason: 'Cierre' });
    setBlockLock(dos.blocks[0].id, true, { today: MON }, db);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 16 * 60 + 30, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('overlaps-gap');
    expect(error.details).toMatchObject({ date: TUE, startTime: '19:30', endTime: '20:30', reason: 'Cierre' });
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('a resize that rewrites a LOCKED row says so', () => {
  it('names the locked continuation the stretch had to lengthen', () => {
    // `stretchFrom` includes a continuation regardless of `locked`, and the response used
    // to carry `touchedLockedBlockIds: []` — so the UI showed no warning at all, against
    // two stated promises ("a locked block is never grown silently", "never silent").
    const unit = job('U', 10, BLUE, THU);
    const afternoon = listBlocks(db)[1];
    setBlockLock(afternoon.id, true, { today: THU }, db);

    const result = resizeBlock(listBlocks(db)[0].id, { durationMinutes: 11 * 60, today: THU }, db);

    expect(result.touchedLockedBlockIds).toEqual([afternoon.id]);
    expect(calendar()).toEqual([`${THU} 08:00-14:00 U`, `${THU} 15:30-20:30 U [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(11 * 60);
    expect(unit.project.id).toBe(listProjects(db)[0].id);
    expect(() => assertProjectHours(db)).not.toThrow();
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
