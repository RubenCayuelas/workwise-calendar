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

/** The gaps as calendar lines, so a day's shape can be read next to its blocks. */
function gapLines(): string[] {
  return listGaps(db).map(
    (gap) =>
      `${gap.date} ${minutesToHHmm(gap.startMinutes)}-${minutesToHHmm(
        gap.startMinutes + gap.durationMinutes,
      )} ${gap.reason ?? ''}`.trimEnd(),
  );
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
    expect(listBlocks(db).every((block) => !block.locked)).toBe(true);
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

  it('honours a Friday chosen by hand, padlocking the rows that land on it', () => {
    // 44 h fills Monday to Thursday and spills onto NEXT Monday (a new job skips the
    // colchón), so the queue already runs past this Friday: `autoLock` does not fire, and
    // the padlock the DAY earns is what keeps the buffer from self-cleaning the row away.
    job('Puerta', 44);
    const created = dated('Barandilla', 4, FRI);
    const row = listBlocks(db).find((block) => block.date === FRI);

    expect(row).toMatchObject({ startMinutes: 8 * 60, durationMinutes: 240, locked: true });
    expect(created.placement).toMatchObject({ day: 'buffer', dayLock: true, autoLock: false });

    // And it survives the create-then-reflow churn that used to undo a Friday drop.
    job('Reja', 2);
    expect(listBlocks(db).find((block) => block.date === FRI)?.id).toBe(row?.id);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('honours a Saturday, where the engine places nothing at all', () => {
    job('Puerta', 20);
    dated('Barandilla', 4, SAT);
    const row = listBlocks(db).find((block) => block.date === SAT);

    // Beyond the work planned AND on a day the engine never uses, so both reasons for a
    // padlock apply and the row carries the one padlock they both mean.
    expect(row).toMatchObject({
      startMinutes: 8 * 60,
      durationMinutes: 240,
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

    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta [locked]`]);
    expect(result.block?.locked).toBe(true);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('survives the churn that used to undo it: another job created, then deleted', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    const barandilla = job('Barandilla', 4, GREEN);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Barandilla`, `${FRI} 10:00-14:00 Puerta [locked]`]);

    deleteProject(barandilla.project.id, { today: MON }, db);
    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('comes home when the padlock comes off, and only then', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    // *Back to automatic* is about the LENGTH now: it leaves the buffer row where the
    // owner put it, because the padlock is what is holding it there and the padlock is
    // visible on the row.
    const released = releaseBlock(puerta.blocks[0].id, { today: MON }, db);
    expect(released.block?.locked).toBe(true);
    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta [locked]`]);

    const unlocked = setBlockLock(puerta.blocks[0].id, false, { today: MON }, db);
    expect(unlocked.block?.locked).toBe(false);
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

    expect(result.block?.locked).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`, `${MON} 10:00-14:00 Puerta`]);
  });

  it('padlocks a drop into a visual margin, because the engine would pull it straight back', () => {
    // The owner's report C: "yo debo poder extender y colocar tareas en esas franjas si
    // yo quiero, de forma manual." An unpadlocked margin row is reflowed into the periods
    // on the very same save, so the margins were configurable and unusable. The padlock is
    // the mark the buffer and the weekend already use, and pressing it is the way back.
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);

    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([
      // Half in the margin, half in the morning, exactly where it was dropped — and the
      // hour it holds inside the period is an obstacle Puerta flows around.
      `${MON} 07:00-09:00 Barandilla [locked]`,
      `${MON} 09:00-13:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('gives a margin row back to the engine when the padlock comes off', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 07:00-09:00 Barandilla [locked]`]);

    // *Back to automatic* is about the LENGTH and leaves the row in the margin, which is
    // where the owner put it. The padlock is the way back, and it is on the row.
    releaseBlock(barandilla.blocks[0].id, { today: MON }, db);
    expect(calendar()).toEqual([`${MON} 07:00-09:00 Barandilla [locked]`]);

    setBlockLock(barandilla.blocks[0].id, false, { today: MON }, db);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`]);
  });

  it('padlocks a weekend drop too, where the engine already kept its hands off', () => {
    const puerta = job('Puerta', 4);

    const result = moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 9 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([`${SAT} 09:00-13:00 Puerta [locked]`]);
  });

  it('KEEPS the padlock when the row is dragged back into the auto-fill week', () => {
    // A drop adds the padlock and never takes it away. Dragging the row back to Tuesday
    // moves it there and leaves it fixed, because a gesture that silently unlocked work
    // the owner had pinned would make the padlock mean two things at once. The way back is
    // the padlock itself.
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);

    const result = moveBlock(puerta.blocks[0].id, { date: TUE, startMinutes: 10 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([`${TUE} 10:00-14:00 Puerta [locked]`]);

    setBlockLock(puerta.blocks[0].id, false, { today: MON }, db);
    // Back under the engine, which settles it at the top of the week.
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);
  });

  it('gives the scissors the same rule: a fragment dropped on Friday stays there', () => {
    const puerta = job('Puerta', 8);

    splitBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, date: FRI, startMinutes: 9 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${FRI} 09:00-11:00 Puerta [locked]`,
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

  it("asks what to do with the hours a job's last block frees, and writes nothing yet", () => {
    const puerta = job('Puerta', 8);
    const before = calendar();
    const last = puerta.blocks[puerta.blocks.length - 1];

    const error = refusal(() => resizeBlock(last.id, { durationMinutes: 60, today: MON }, db));

    expect(error.status).toBe(409);
    expect(error.code).toBe('shrink-needs-choice');
    expect(error.messageKey).toBe('errors.shrinkNeedsChoice');
    // Everything the dialog needs, in ONE round trip: the hours it is about, and the ways
    // out that really exist — in minutes, like everything else the API speaks.
    expect(error.details).toMatchObject({
      blockId: last.id,
      projectId: puerta.project.id,
      freedMinutes: 60,
      choices: ['reduce-total', 'new-block'],
    });
    expect(calendar()).toEqual(before);
  });

  it('takes the freed hours off the job when the owner answers `reduce-total`', () => {
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];

    resizeBlock(last.id, { durationMinutes: 60, freedHours: 'reduce-total', today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-14:00 Puerta`, `${MON} 15:30-16:30 Puerta`]);
    expect(listProjects(db)[0].totalMinutes).toBe(7 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('leaves the freed hours as a block of their own when the owner answers `new-block`', () => {
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];

    resizeBlock(last.id, { durationMinutes: 60, freedHours: 'new-block', today: MON }, db);

    // The job still has its 8 h: 6 + 1 where the owner drew them, and the freed hour on
    // the next day the engine fills — a loose block for them to place.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-16:30 Puerta`,
      `${TUE} 08:00-09:00 Puerta`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
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

    expect(result.block?.locked).toBe(true);
    expect(result.block?.manualDuration).toBe(true);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Porton`, `${MON} 15:30-20:30 Puerta [locked]`]);
    // Nothing farther in the job to draw from, so this is the one case that grows the
    // estimate — 2 h to 5 h — and the hours invariant still holds.
    expect(listProjects(db).find((project) => project.name === 'Puerta')?.totalMinutes).toBe(5 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // It survives an unrelated save, which is the whole point of the mark.
    job('Reja', 2);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Porton`,
      `${MON} 15:30-20:30 Puerta [locked]`,
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

  it('answers a shrink that has nowhere to put the hours with a question, never a no-op', () => {
    // The other half of the same fix: where the transfer is genuinely impossible the
    // caller gets a 409 with an i18n key, never a 200 with the row unchanged — and now
    // that 409 is a question rather than a wall. Nothing is written until it is answered,
    // marks included.
    const puerta = job('Puerta', 8);
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(puerta.blocks[puerta.blocks.length - 1].id, { durationMinutes: 60, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('shrink-needs-choice');
    expect(error.messageKey).toBe('errors.shrinkNeedsChoice');
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

    moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 10:00-14:00 Puerta [locked]`,
      `${SAT} 15:30-17:30 Puerta [locked]`,
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
  /**
   * A 2 h job whose single row sits on yesterday at 12:00, today being Wednesday.
   *
   * Written straight onto the row rather than dragged there: no gesture can reach a past
   * day any more (see *the past is read-only to the block gestures*), and what these tests
   * are about is what the app does with a record that is ALREADY there — the row was
   * ordinary work on Tuesday until Wednesday came round.
   */
  function yesterdaysWork() {
    const puerta = job('Puerta', 2, BLUE, WED);
    const blockId = listBlocks(db)[0].id;
    updateBlock(
      {
        id: blockId,
        projectId: puerta.project.id,
        date: TUE,
        startMinutes: 12 * 60,
        durationMinutes: 2 * 60,
        locked: false,
        manualDuration: false,
      },
      db,
    );
    expect(calendar()).toEqual([`${TUE} 12:00-14:00 Puerta`]);
    return { project: puerta.project, blockId };
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

describe('the past is read-only to the block gestures', () => {
  // Decided with the owner on 2026-08-13, and the cost was named: it removes "correcting
  // yesterday", which is the case *Block Resize* was designed for. The past is the record
  // of what the shop did, and a gesture on it edits a day no schedule can still change.

  /** Yesterday's row: ordinary Tuesday work, until Wednesday came round. */
  function yesterday() {
    const puerta = job('Puerta', 4, BLUE, TUE);
    const blockId = listBlocks(db)[0].id;
    expect(calendar()).toEqual([`${TUE} 08:00-12:00 Puerta`]);
    return { project: puerta.project, blockId };
  }

  it('refuses every gesture on a past row, and writes nothing', () => {
    const { blockId } = yesterday();
    const before = calendar();

    const gestures: Array<[string, () => unknown]> = [
      ['move', () => moveBlock(blockId, { date: WED, startMinutes: 8 * 60, today: WED }, db)],
      ['resize', () => resizeBlock(blockId, { durationMinutes: 5 * 60, today: WED }, db)],
      ['split', () => splitBlock(blockId, { durationMinutes: 60, date: WED, startMinutes: 8 * 60, today: WED }, db)],
      ['lock', () => setBlockLock(blockId, true, { today: WED }, db)],
      ['delete', () => deleteBlock(blockId, { today: WED }, db)],
    ];

    for (const [name, gesture] of gestures) {
      const error = refusal(gesture);
      expect(error.status, name).toBe(409);
      expect(error.code, name).toBe('past-block-frozen');
      expect(error.messageKey, name).toBe('errors.pastBlockFrozen');
      expect(calendar(), name).toEqual(before);
    }
    expect(listProjects(db)[0].totalMinutes).toBe(4 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('still lets the job be edited in its form, where the hours land on a future day', () => {
    // The way out the owner kept. Yesterday's 4 h are the record; the 2 h added now are
    // work still to do, so they get a row of their own on a day that can still change.
    const { project, blockId } = yesterday();

    patchProject(project.id, { totalMinutes: 6 * 60, today: WED }, db);

    expect(calendar()).toEqual([`${TUE} 08:00-12:00 Puerta`, `${WED} 08:00-10:00 Puerta`]);
    expect(listBlocks(db).find((row) => row.id === blockId)?.durationMinutes).toBe(4 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('still lets a stale ruler be handed back, since that moves nothing', () => {
    // *Back to automatic* only clears a mark the engine no longer consults on a past day.
    // Refusing it would strand the mark in the job panel with no undo beside it.
    const puerta = job('Puerta', 4, BLUE, TUE);
    resizeBlock(puerta.blocks[0].id, { durationMinutes: 3 * 60, freedHours: 'reduce-total', today: TUE }, db);
    expect(listBlocks(db)[0].manualDuration).toBe(true);

    releaseBlock(listBlocks(db)[0].id, { today: WED }, db);

    expect(listBlocks(db)[0].manualDuration).toBe(false);
    expect(calendar()).toEqual([`${TUE} 08:00-11:00 Puerta`]);
  });
});

describe('a drop onto another row\'s start goes BEFORE it', () => {
  it('lets the drop win the tie, instead of the older row keeping its place', () => {
    // A rank that TIES is decided by `created_at`, so a drop released exactly on an
    // existing start silently lost to the older row and the drag looked ignored. Landing
    // on a start means "put me before this one": the row underneath stays whole and
    // follows. Nothing is cut, so no sliver row is created either.
    const alfa = job('Alfa', 2, BLUE, MON);
    const beta = job('Beta', 2, GREEN, MON);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Alfa`, `${MON} 10:00-12:00 Beta`]);
    // `created_at` has one-second resolution, so two jobs created in the same tick tie on
    // it as well and the order falls to a random UUID. Alfa is made the older row on
    // purpose: it is the one that used to win the tie and swallow the drop.
    db.prepare('UPDATE blocks SET created_at = ? WHERE id = ?').run(
      '2026-08-01 08:00:00',
      alfa.blocks[0].id,
    );

    moveBlock(beta.blocks[0].id, { date: MON, startMinutes: 8 * 60, today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-10:00 Beta`, `${MON} 10:00-12:00 Alfa`]);
    expect(listBlocks(db)).toHaveLength(2);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('still cuts a row the drop lands INSIDE, which is how a cut is asked for', () => {
    job('Alfa', 4, BLUE, MON);
    const beta = job('Beta', 2, GREEN, MON);

    moveBlock(beta.blocks[0].id, { date: MON, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Alfa`,
      `${MON} 10:00-12:00 Beta`,
      `${MON} 12:00-14:00 Alfa`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('no transaction may store a row that runs past the end of its day', () => {
  // The belt to the LIFO fix's braces. A rendering crash from bad stored data must be
  // impossible, not merely unreachable through the paths that were fixed — so the guard
  // sits on the write itself, where every row goes through regardless of what produced it.

  it('refuses a resize on a past row before the day-end guard is even reached', () => {
    // This used to be the reachable-by-hand case: *Block Resize* was offered on past rows
    // so yesterday could be corrected, and over HTTP the duration is not capped by the
    // drag layer. The gesture is now refused for being on the past at all, which is a
    // strictly earlier line than the end of the day; the guard below is what keeps the
    // shape unstorable whatever produces it.
    const puerta = job('Puerta', 2, BLUE, WED);
    updateBlock(
      {
        id: puerta.blocks[0].id,
        projectId: puerta.project.id,
        date: TUE,
        startMinutes: 12 * 60,
        durationMinutes: 2 * 60,
        locked: false,
        manualDuration: false,
      },
      db,
    );
    const before = calendar();

    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 13 * 60, today: WED }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('past-block-frozen');
    expect(error.messageKey).toBe('errors.pastBlockFrozen');
    expect(error.details).toMatchObject({ date: TUE, today: WED });
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

    // The stretch reaches the bottom margin, so both of its rows come back padlocked.
    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno [locked]`, `${THU} 15:30-20:30 Uno [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('sends a split whose fragment would run past the end of the day to the next day', () => {
    // The scissors' second click goes through `rankFor`, which was not clamped at all:
    // 60 min at 19:45 stored `19:45-20:45`, and 210 min at 19:30 stored `19:30-23:00`.
    // Both were then refused; aiming past the end of a day now means the day after, so
    // the fragment lands on Friday's morning — and, being a Friday, keeps its padlock.
    job('Uno', 10, BLUE, THU);
    const afternoon = listBlocks(db)[1];

    splitBlock(afternoon.id, { durationMinutes: 60, startMinutes: 19 * 60 + 45, date: THU, today: THU }, db);

    expect(calendar()).toEqual([
      `${THU} 08:00-14:00 Uno`,
      `${THU} 15:30-18:30 Uno`,
      `${FRI} 08:00-09:00 Uno [locked]`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(10 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('sends a drop aimed below what the day holds to the next day, instead of refusing', () => {
    // 6 h released at 13:15 needs `13:15-14:00` + `15:30-20:45`, a quarter of an hour
    // past the end of the day. The owner, on being shown the refusal: «Que se rechaza, de
    // qué friki. Pasa al siguiente día. ¿Sabes cómo funciona un calendario?»
    //
    // Thursday's next day is the Friday colchón, and landing there padlocks the row like
    // any other Friday drop — so the roll is visible in what is stored, at the top of
    // Friday's periods rather than in its top margin.
    job('Uno', 6, BLUE, THU);

    const result = moveBlock(listBlocks(db)[0].id, { date: THU, startMinutes: 13 * 60 + 15, today: THU }, db);

    expect(calendar()).toEqual([`${FRI} 08:00-14:00 Uno [locked]`]);
    expect(result.block?.date).toBe(FRI);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('does NOT roll a drop off a day the engine does not lay out', () => {
    // The weekend is a day the owner named on purpose and the exact minute is the whole
    // promise there, so the same aim keeps its day and meets the end-of-day refusal.
    job('Uno', 6, BLUE, THU);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(listBlocks(db)[0].id, { date: SAT, startMinutes: 13 * 60 + 15, today: THU }, db),
    );

    expect(error.code).toBe('row-past-day-end');
    expect(calendar()).toEqual(before);
  });

  it('takes the same drop one quarter earlier, where it fits', () => {
    job('Uno', 6, BLUE, THU);

    moveBlock(listBlocks(db)[0].id, { date: FRI, startMinutes: 13 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${FRI} 13:00-14:00 Uno [locked]`, `${FRI} 15:30-20:30 Uno [locked]`]);
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
    // CLAUDE.md: setting the bottom margin to 0 under a padlocked row keeps the hours
    // already in it. So the guard refuses a gesture that makes the overrun WORSE, and
    // never one that leaves it alone or moves the row somewhere legal.
    const uno = job('Uno', 1, BLUE, THU);
    moveBlock(uno.blocks[0].id, { date: THU, startMinutes: 19 * 60 + 30, today: THU }, db);
    updateSettings({ visualMarginBottom: 0 }, { today: THU }, db);
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno [locked]`]);

    // The same length again: accepted, marks and all.
    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 60, today: THU }, db);
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno [locked]`]);

    // Longer: refused, because that is new time outside every window.
    const error = refusal(() =>
      resizeBlock(listBlocks(db)[0].id, { durationMinutes: 90, today: THU }, db),
    );
    expect(error.code).toBe('row-past-day-end');
    expect(calendar()).toEqual([`${THU} 19:30-20:30 Uno [locked]`]);

    // And it can still be dragged back inside the day. It keeps the padlock the margin
    // drop gave it — a drop never takes one off — so it lands on the exact minute rather
    // than taking a rank, and pressing the padlock is what hands it back to the engine.
    moveBlock(listBlocks(db)[0].id, { date: THU, startMinutes: 10 * 60, today: THU }, db);
    expect(calendar()).toEqual([`${THU} 10:00-11:00 Uno [locked]`]);

    setBlockLock(listBlocks(db)[0].id, false, { today: THU }, db);
    expect(calendar()).toEqual([`${THU} 08:00-09:00 Uno`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The lunch break is not a slot: a gesture aimed at it means 15:30
// ---------------------------------------------------------------------------
//
// The OTHER edge of the same line, and it was open in the other direction. The manual
// windows are `07:00-14:00` and `15:30-20:30`, so 14:00 is the exclusive END of the first
// and before the start of the second: it belongs to no window, the segmenter found no
// boundary to cut against, and the drop was stored WHOLE —
//
//     dropped at 13:30  ->  `13:30-14:00 (30m)` + `15:30-17:00 (90m)`   correct
//     dropped at 14:00  ->  `14:00 +120m -> 16:00`                       one illegal row
//
// — running straight through the break and claiming two hours of work where ninety minutes
// of it is lunch. It was never an off-by-one at the edge: every minute from 14:00 to 15:29
// did it, and so did the scissors' target.
//
// The rule, in one line: A GESTURE AIMED AT A MINUTE WITH NO WORKING TIME MEANS THE NEXT
// MINUTE THAT HAS SOME (`firstWorkingMinute`). Aiming at 14:00 asks for a slot that does not
// exist, and the break is already an arithmetic dead zone for a resize — 14:00, 15:00 and
// 15:29 all commit the same duration — so answering all three with 15:30 is the reading the
// gesture already had everywhere else. It is deliberately NOT the visual margins' latitude:
// a margin is workable time the owner chose and a row may sit in one, while the break is not
// workable at all.
//
// The cases below are the boundary minutes, never a sample from the middle.

describe('the lunch break is not a slot', () => {
  it('stores a drop aimed anywhere in the break from 15:30, on a day that keeps the minute', () => {
    // Saturday keeps the exact minute a drop asks for, so what is stored here is the whole
    // promise: an error on this day is permanent.
    for (const startMinutes of [14 * 60, 14 * 60 + 1, 14 * 60 + 30, 15 * 60, 15 * 60 + 29]) {
      db.close();
      db = openDatabase(':memory:');
      const uno = job('Uno', 2);

      moveBlock(uno.blocks[0].id, { date: SAT, startMinutes, today: MON }, db);

      expect(calendar(), `released at ${minutesToHHmm(startMinutes)}`).toEqual([
        `${SAT} 15:30-17:30 Uno [locked]`,
      ]);
      expect(() => assertProjectHours(db)).not.toThrow();
    }
  });

  it('still cuts a drop released on the last minute of the morning', () => {
    // 13:45 IS working time, so it is its own answer and the break is where it is cut. This is
    // the case that always worked, and it has to keep working: the fix must move the minutes
    // with no work in them and nothing else.
    const uno = job('Uno', 2);

    moveBlock(uno.blocks[0].id, { date: SAT, startMinutes: 13 * 60 + 45, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 13:45-14:00 Uno [locked]`,
      `${SAT} 15:30-17:15 Uno [locked]`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('does not padlock a Monday-Thursday drop aimed at the break, because 15:30 is a period', () => {
    // It used to, and it had to: the row was stored where it was released, and the engine's
    // only possible answer to a row in the lunch band is to undo the drop. Read as 15:30 the
    // request is an ordinary one, so the drop is a queue RANK like any other Mon-Thu drop and
    // the reflow settles it — which is the documented rule, not a new one.
    job('Uno', 2);
    const dos = job('Dos', 2, GREEN);

    const result = moveBlock(dos.blocks[0].id, { date: WED, startMinutes: 14 * 60, today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-10:00 Uno`, `${MON} 10:00-12:00 Dos`]);
    expect(result.block?.locked).toBe(false);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('padlocks it at 15:30 when the DAY is what pins the drop', () => {
    // The Friday colchón and the weekend still pin, because there the pin is about the day.
    const uno = job('Uno', 2);

    moveBlock(uno.blocks[0].id, { date: FRI, startMinutes: 15 * 60, today: MON }, db);

    expect(calendar()).toEqual([`${FRI} 15:30-17:30 Uno [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('sends the scissors\' fragment to 15:30 too', () => {
    // The fragment IS a drop, so it takes the same reading. It used to store `14:00 +120m`.
    const uno = job('Uno', 6);

    splitBlock(
      uno.blocks[0].id,
      { durationMinutes: 2 * 60, date: SAT, startMinutes: 14 * 60, today: MON },
      db,
    );

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Uno`, `${SAT} 15:30-17:30 Uno [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('rolls a drop the afternoon cannot hold to the next day, measured from 15:30', () => {
    // 5 h from 15:30 reaches 20:30, the day's last minute; 5 h 15 reaches past it. Thursday's
    // next day is the colchón, so the roll shows up in what is stored — and it is the roll,
    // not a row hanging below the grid.
    const uno = job('Uno', 5.25, BLUE, THU);
    const unit = listBlocks(db);

    moveBlock(
      unit[0].id,
      { date: THU, startMinutes: 14 * 60, unitBlockIds: unit.map((row) => row.id), today: THU },
      db,
    );

    expect(calendar()).toEqual([`${FRI} 08:00-13:15 Uno [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes a row a settings change stranded in the break out of it on the next resize', () => {
    // The one way a row can still START in the break: the owner shortens the morning under a
    // row that was legally placed. Nothing rewrites it where it sits — the past-and-present
    // rows keep their hours — but the moment a gesture rewrites its LENGTH, the new segments
    // are laid out from the first minute that can hold work, so the row stops crossing the
    // break instead of being grown further through it.
    const uno = job('Uno', 2, BLUE, THU);
    // The capacity travels with the shorter shift: 5 h of morning plus 4 h of afternoon is
    // 9 h, and a 10 h capacity on a 9 h shift is refused rather than re-capped.
    updateSettings(
      { period1End: '13:00', period2Start: '15:30', defaultDayCapacity: 9 },
      { today: THU },
      db,
    );
    // Recomposed against the shorter morning, the row is back inside a period; put it in the
    // break by hand, where the settings change can leave one.
    updateBlock(
      {
        id: uno.blocks[0].id,
        projectId: uno.project.id,
        date: THU,
        startMinutes: 14 * 60,
        durationMinutes: 2 * 60,
        locked: true,
        manualDuration: false,
      },
      db,
    );
    expect(calendar()).toEqual([`${THU} 14:00-16:00 Uno [locked]`]);

    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 3 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 15:30-18:30 Uno [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(3 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('leaves a GAP across the break exactly where it was put', () => {
    // A gap's `duration` is CLOCK minutes, not net working time — "stop the day here" makes
    // one straight across the comida on purpose, and the grid draws it over the seam. So the
    // rule above must not touch it: gaps are the one row that MAY span a break.
    createGap({ date: THU, startMinutes: 14 * 60, durationMinutes: 120, reason: 'Averia', today: THU }, db);

    expect(gapLines()).toEqual([`${THU} 14:00-16:00 Averia`]);
  });

  it('leaves the hole after the last window alone when the afternoon is switched off', () => {
    // The day becomes `07:00-15:00` — the morning and its two margins — and the hole after it
    // runs to midnight. There is no later working minute to offer, so the release stands and
    // the day's own end is what answers: a roll on a day the engine lays out, a refusal on one
    // it does not.
    updateSettings({ period2Enabled: false, defaultDayCapacity: 6 }, { today: THU }, db);
    const uno = job('Uno', 2, BLUE, THU);

    // On a day the engine lays out, the roll answers: Thursday's next day is the colchón, and
    // landing there padlocks the row like any other Friday drop.
    moveBlock(uno.blocks[0].id, { date: THU, startMinutes: 18 * 60, today: THU }, db);
    expect(calendar()).toEqual([`${FRI} 08:00-10:00 Uno [locked]`]);

    // On a day it does not lay out there is nowhere to roll to, so the end-of-day guard is
    // what answers, and it writes nothing.
    const error = refusal(() =>
      moveBlock(listBlocks(db)[0].id, { date: SAT, startMinutes: 18 * 60, today: THU }, db),
    );
    expect(error.code).toBe('row-past-day-end');
    expect(calendar()).toEqual([`${FRI} 08:00-10:00 Uno [locked]`]);
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

    expect(calendar()).toEqual([`${THU} 08:00-13:00 Uno`, `${SAT} 08:00-11:00 Dos [locked]`]);
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

    expect(calendar()).toEqual([`${SAT} 10:00-14:00 Uno [locked]`, `${SAT} 15:30-19:30 Uno [locked]`]);
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

    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Uno [locked]`, `${FRI} 15:30-19:30 Uno [locked]`]);
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
    expect(calendar()).toEqual([`${THU} 08:00-12:00 Uno`, `${SAT} 09:00-11:00 Dos [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('moves a run that SPANS DAYS whole, grabbed by its last day', () => {
    // The defect the drag layer measured on the running app: the ghost drew the whole
    // run and the drop delivered only the day the grabbed row sat on, because the unit
    // was computed inside one date. A run crosses midnight exactly as `buildQueue`
    // does — nothing workable of another job between the pieces — so the day boundary
    // is not a separator and never was.
    job('Ventanas', 11, BLUE, WED);
    const run = listBlocks(db);
    expect(calendar()).toEqual([
      `${WED} 08:00-14:00 Ventanas`,
      `${WED} 15:30-19:30 Ventanas`,
      `${THU} 08:00-09:00 Ventanas`,
    ]);

    // Grab the Thursday hour — the LAST row of the run, the one the report used.
    const result = moveBlock(
      run[2].id,
      { date: SAT, startMinutes: 8 * 60, today: WED, unitBlockIds: run.map((row) => row.id) },
      db,
    );

    expect(calendar()).toEqual([
      `${SAT} 08:00-14:00 Ventanas [locked]`,
      `${SAT} 15:30-20:30 Ventanas [locked]`,
    ]);
    expect(result.blocks.reduce((total, row) => total + row.durationMinutes, 0)).toBe(11 * 60);
    expect(listProjects(db)[0].totalMinutes).toBe(11 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('stops the run at the job the owner put between the pieces', () => {
    // The owner's own rule: a separation is a division they made on purpose, so the drag
    // respects it and stops there. Dos is dropped into the middle of Wednesday, cutting
    // Uno in two; grabbing Uno's first piece must move that piece and nothing after Dos,
    // however much the request claims.
    job('Uno', 11, BLUE, WED);
    const dos = job('Dos', 1, GREEN, WED);
    moveBlock(dos.blocks[0].id, { date: WED, startMinutes: 10 * 60, today: WED }, db);
    expect(calendar()).toEqual([
      `${WED} 08:00-10:00 Uno`,
      `${WED} 10:00-11:00 Dos`,
      `${WED} 11:00-14:00 Uno`,
      `${WED} 15:30-19:30 Uno`,
      `${THU} 08:00-10:00 Uno`,
    ]);

    const all = listBlocks(db);
    const head = all[0];
    moveBlock(
      head.id,
      {
        date: SAT,
        startMinutes: 8 * 60,
        today: WED,
        // Every row of the job, including the four on the far side of Dos.
        unitBlockIds: all.filter((row) => row.projectId === head.projectId).map((row) => row.id),
      },
      db,
    );

    // Only the 2 h before Dos travelled. The rest is still Uno's, still on the week, and
    // the reflow closed the hole the head left behind.
    expect(calendar()).toEqual([
      `${WED} 08:00-09:00 Dos`,
      `${WED} 09:00-14:00 Uno`,
      `${WED} 15:30-19:30 Uno`,
      `${SAT} 08:00-10:00 Uno [locked]`,
    ]);
    expect(listProjects(db).map((project) => project.totalMinutes).sort()).toEqual([60, 660]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('treats a padlocked row as an obstacle inside a run, not as a separator', () => {
    // `buildQueue` skips fixed work without closing the run, so the drag must too — the
    // reflow flows around it either way, and a drag that stopped there would disagree
    // with the layout it is about to produce.
    job('Uno', 11, BLUE, WED);
    const dos = job('Dos', 1, GREEN, WED);
    moveBlock(dos.blocks[0].id, { date: WED, startMinutes: 10 * 60, today: WED }, db);
    const separator = listBlocks(db).find((row) => row.projectId === dos.project.id)!;
    setBlockLock(separator.id, true, { today: WED }, db);
    expect(calendar()).toEqual([
      `${WED} 08:00-10:00 Uno`,
      `${WED} 10:00-11:00 Dos [locked]`,
      `${WED} 11:00-14:00 Uno`,
      `${WED} 15:30-19:30 Uno`,
      `${THU} 08:00-10:00 Uno`,
    ]);

    const all = listBlocks(db);
    const head = all[0];
    moveBlock(
      head.id,
      {
        date: SAT,
        startMinutes: 8 * 60,
        today: WED,
        unitBlockIds: all.filter((row) => row.projectId === head.projectId).map((row) => row.id),
      },
      db,
    );

    // All 11 h travelled, across the padlock and across the night. Dos did not move.
    expect(calendar()).toEqual([
      `${WED} 10:00-11:00 Dos [locked]`,
      `${SAT} 08:00-14:00 Uno [locked]`,
      `${SAT} 15:30-20:30 Uno [locked]`,
    ]);
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

    expect(calendar()).toEqual([`${THU} 08:00-08:15 Tiny`, `${SAT} 09:00-09:15 Tiny [locked]`]);
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

    expect(calendar()).toEqual([`${THU} 08:00-10:00 Uno`, `${FRI} 11:00-12:00 Dos [locked]`]);
    // Still the owner's Friday: the slide keeps the padlock, so the engine never takes it
    // back — and the padlock is on the row for the owner to press when they want it back.
    expect(result.block?.locked).toBe(true);
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

    expect(calendar()).toEqual([`${THU} 08:00-10:00 Uno`, `${FRI} 11:00-12:00 Dos [locked]`]);
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
      `${TUE} 08:00-12:00 Dos [locked]`,
      `${TUE} 12:00-14:00 Cuatro`,
      `${TUE} 15:30-19:30 Cuatro`,
    ]);
    // The gap kept its minutes and the drop kept its day: it gave up the hour it could
    // not have and landed at the first one it could. The slot was asked for by hand, so it
    // comes back padlocked — pressing the padlock is the way out.
    expect(result.block?.date).toBe(TUE);
    expect(result.block?.startMinutes).toBe(8 * 60);
    expect(result.block?.locked).toBe(true);
    expect(
      listProjects(db).map((project) => `${project.name} ${project.totalMinutes}`).sort(),
    ).toEqual(['Cuatro 360', 'Dos 240', 'Tres 240', 'Uno 360']);
    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('refuses, naming the gap, when the day has no clear slot for a padlocking drop', () => {
    // The same drop at the other end: 16:30 is the latest a 4 h row may start and still
    // end inside the day, so it is where the ghost sits when the owner aims at the bottom
    // of a full Tuesday — and it reaches into a margin the gap covers to the last minute.
    // The margin is what padlocks the drop, and a padlocked drop lands literally: there is
    // nowhere on Tuesday to slide to, so the answer is the gap's name. It used to give up
    // the pin and settle as a queue rank; it may not now, because giving up the pin means
    // taking off a padlock the owner would see on the row.
    const dos = fullWeek({ startMinutes: 19 * 60 + 30, reason: 'Cierre' });
    const before = calendar();

    const error = refusal(() =>
      moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 16 * 60 + 30, today: MON }, db),
    );

    expect(error.code).toBe('overlaps-gap');
    expect(error.details).toMatchObject({ date: TUE, reason: 'Cierre' });
    expect(calendar()).toEqual(before);
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
    // Both rows padlocked: the afternoon one already was, and the stretch reached the
    // bottom margin, which padlocks what it writes.
    expect(calendar()).toEqual([`${THU} 08:00-14:00 U [locked]`, `${THU} 15:30-20:30 U [locked]`]);
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

// ---------------------------------------------------------------------------
// The margin collision, which the third mark used to hide
// ---------------------------------------------------------------------------
//
// Reproduced by dragging, 2026-08-14, at both widths. `Corto 1 h` sat in Tuesday's
// bottom margin and `Alfa 2 h` was dropped onto the same margin. Alfa was pinned at
// `18:30-20:30` and Corto was silently evicted to Monday 08:00 WITH ITS MARK CLEARED —
// the engine deciding, on its own, that the hours a human had parked in the margin now
// belonged at the front of the week. Three sentences of *A Hand-Placed Row* said that
// could not happen.
//
// It cannot happen now, and not because a rule was added: a row in a margin carries a
// PADLOCK, and a drop that lands on a padlocked row of another job has always been
// refused with the row named. The defect went away with the concept.

describe('the margin collision the third mark used to hide', () => {
  it('refuses a drop onto a padlocked margin row, names it, and writes nothing', () => {
    const corto = job('Corto', 1, GREEN);
    // 19:30-20:30 — the whole of Tuesday's bottom margin, so the drop padlocks it.
    moveBlock(corto.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db);
    const alfa = job('Alfa', 2);
    const before = calendar();
    expect(before).toContain(`${TUE} 19:30-20:30 Corto [locked]`);

    // 18:30-20:30: an hour of the afternoon and the whole margin, straight over Corto.
    const error = refusal(() =>
      moveBlock(alfa.blocks[0].id, { date: TUE, startMinutes: 18 * 60 + 30, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('overlaps-locked-block');
    expect(error.details).toMatchObject({
      projectName: 'Corto',
      date: TUE,
      startTime: '19:30',
      endTime: '20:30',
    });
    // Nothing at all: Corto did not move to Monday, Alfa did not take the margin, and no
    // mark was cleared anywhere.
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes the same drop in the margin at the other end, where nothing is in the way', () => {
    // The other half of the answer: the refusal is about the row in the way, not about the
    // margins, which are exactly where the owner is allowed to work by hand.
    const corto = job('Corto', 1, GREEN);
    moveBlock(corto.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db);
    const alfa = job('Alfa', 2);

    const result = moveBlock(alfa.blocks[0].id, { date: TUE, startMinutes: 7 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([
      `${TUE} 07:00-09:00 Alfa [locked]`,
      `${TUE} 19:30-20:30 Corto [locked]`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('a drop onto the weekend, where the engine may not reflow', () => {
  it('merges two rows of the SAME job into one, summing the hours', () => {
    const puerta = job('Puerta', 8);
    splitBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, date: SAT, startMinutes: 9 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Puerta`, `${SAT} 09:00-11:00 Puerta [locked]`]);

    // The second 2 h land ON the first fragment. Sum, not union: 09:00-13:00 is 4 h — and
    // the padlock both fragments carry survives the fold rather than refusing it.
    const result = splitBlock(
      listBlocks(db)[0].id,
      { durationMinutes: 2 * 60, date: SAT, startMinutes: 10 * 60, today: MON },
      db,
    );

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`, `${SAT} 09:00-13:00 Puerta [locked]`]);
    expect(result.mergedBlockIds).toHaveLength(1);
    expect(result.displacedProjectIds).toEqual([]);
    // Four hours on Saturday plus four on Monday: the estimate never moved.
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('cuts ANOTHER job and pushes its tail after the drop, keeping its hours', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: SAT, startMinutes: 9 * 60, today: MON }, db);
    // Unpadlocked afterwards: the drop that put it on Saturday padlocked it, and a
    // padlocked row is never cut — that is the refusal two tests below. What is being
    // tested here is the OTHER weekend row, held there by the day alone.
    setBlockLock(listBlocks(db)[0].id, false, { today: MON }, db);
    const puerta = job('Puerta', 1);

    const result = moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 10 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 09:00-10:00 Barandilla`,
      `${SAT} 10:00-11:00 Puerta [locked]`,
      `${SAT} 11:00-12:00 Barandilla`,
    ]);
    expect(result.displacedProjectIds).toEqual([barandilla.project.id]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(2 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('carries a Saturday tail that no longer fits onto Sunday, never into the week', () => {
    const barandilla = job('Barandilla', 1, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: SAT, startMinutes: 18 * 60 + 30, today: MON }, db);
    setBlockLock(listBlocks(db)[0].id, false, { today: MON }, db);
    const puerta = job('Puerta', 1);

    moveBlock(puerta.blocks[0].id, { date: SAT, startMinutes: 18 * 60 + 30, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 18:30-19:30 Puerta [locked]`,
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

  it('refuses a drop INTO the past and writes nothing', () => {
    // The past stopped being a drop target on 2026-08-13: it is the record of what the
    // shop did, and a gesture that writes there edits a day no schedule can change.
    const puerta = job('Puerta', 1);
    const before = calendar();

    const error = refusal(() =>
      moveBlock(puerta.blocks[0].id, { date: LAST_FRI, startMinutes: 18 * 60 + 30, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('drop-onto-past-day');
    expect(error.messageKey).toBe('errors.dropOntoPastDay');
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('answers with `block: null` when the merge absorbed the very row that was moved', () => {
    const puerta = job('Puerta', 4);
    splitBlock(puerta.blocks[0].id, { durationMinutes: 60, date: SAT, startMinutes: 9 * 60, today: MON }, db);
    const monday = listBlocks(db).find((row) => row.date === MON);

    // The Monday row is dropped ON TOP of the fragment, and ranks after it, so the
    // fragment survives with the summed hours and the moved id is gone.
    const result = moveBlock(monday!.id, { date: SAT, startMinutes: 9 * 60 + 30, today: MON }, db);

    expect(calendar()).toEqual([`${SAT} 09:00-13:00 Puerta [locked]`]);
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
  it('refuses a shift the stored capacity cannot fit, writing nothing at all', () => {
    // The trap, over the operation that the Settings screen actually calls: switching the
    // afternoon off against a 10 h capacity is a 400, not a quiet re-cap to 6 h. The
    // calendar is untouched with it — the settings write and the reflow are one
    // transaction, so a refused save cannot leave the week half-moved.
    job('Escalera', 12);
    const before = calendar();

    const error = refusal(() => updateSettings({ period2Enabled: false }, { today: MON }, db));

    expect(error.status).toBe(400);
    expect(error.field).toBe('defaultDayCapacity');
    expect(readSettings(db).period2Enabled).toBe(true);
    expect(readSettings(db).defaultDayCapacity).toBe(10);
    expect(calendar()).toEqual(before);
  });

  it('lowers the capacity and reflows when the owner sends both together', () => {
    job('Escalera', 12);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Escalera`,
      `${MON} 15:30-19:30 Escalera`,
      `${TUE} 08:00-10:00 Escalera`,
    ]);

    // What the confirmation dialog sends: the shorter shift AND the capacity it can buy.
    const result = updateSettings(
      { period2Enabled: false, defaultDayCapacity: 6 },
      { today: MON },
      db,
    );

    expect(result.settings.defaultDayCapacity).toBe(6);
    expect(readSettings(db).defaultDayCapacity).toBe(6);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Escalera`,
      `${TUE} 08:00-14:00 Escalera`,
    ]);

    // And putting the afternoon back does NOT restore 10 h: 6 h is the owner's number now.
    const back = updateSettings({ period2Enabled: true }, { today: MON }, db);
    expect(back.settings.defaultDayCapacity).toBe(6);
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
      { period1Start: undefined, gapColor: undefined, period2Enabled: false, defaultDayCapacity: 6 },
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

  it('leaves its PAST rows behind as gaps, so nothing on those days moves', () => {
    // The owner's requirement, 2026-08-13: deleting a job must not rewrite what the shop
    // actually did, nor pull later work backwards into the hole. Monday and Tuesday are
    // behind us; Wednesday is today.
    const puerta = pastAndFuture();
    job('Barandilla', 4, GREEN, WED);

    const result = deleteProject(puerta.project.id, { today: WED }, db);

    // The two worked days keep their shape — the hours are still occupied, as gaps — and
    // only Wednesday's row disappears, which is what lets Barandilla move up into it.
    expect(calendar()).toEqual([`${WED} 08:00-12:00 Barandilla`]);
    expect(gapLines()).toEqual([
      `${MON} 08:00-12:00 Trabajo «Puerta» eliminado`,
      `${TUE} 08:00-12:00 Trabajo «Puerta» eliminado`,
    ]);
    expect(result.preservedGapIds).toHaveLength(2);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('writes the job name into the gap, in the language the owner was reading', () => {
    // The name has to be COMPOSED AT DELETION TIME: the project row is gone a moment
    // later and its blocks went with it, so there is nothing left to look it up in. The
    // sentence is therefore frozen in one language — a gap's reason is user data, the
    // same field that holds "Avería torno", and it stays editable like any other.
    const puerta = pastAndFuture();

    deleteProject(puerta.project.id, { today: WED, language: 'en' }, db);

    expect(listGaps(db).map((gap) => gap.reason)).toEqual([
      'Job «Puerta» deleted',
      'Job «Puerta» deleted',
    ]);
  });

  it('leaves nothing behind for a job that had not started yet', () => {
    const puerta = job('Puerta', 4, BLUE, WED);

    const result = deleteProject(puerta.project.id, { today: WED }, db);

    expect(result.preservedGapIds).toEqual([]);
    expect(listGaps(db)).toEqual([]);
  });

  /**
   * A 12 h job worked on Monday and Tuesday and still running today, Wednesday — one row
   * a day, which is what the 4 h stop line is for.
   */
  function pastAndFuture() {
    updateSettings({ defaultDayCapacity: 4 }, { today: MON }, db);
    const puerta = job('Puerta', 12, BLUE, MON);
    expect(calendar()).toEqual([
      `${MON} 08:00-12:00 Puerta`,
      `${TUE} 08:00-12:00 Puerta`,
      `${WED} 08:00-12:00 Puerta`,
    ]);
    return puerta;
  }
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
