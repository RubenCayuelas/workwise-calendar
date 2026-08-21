// The data layer's specification: repositories, the scheduler seam and the operations the API routes
// wrap. `composition.test.ts` proves the engine's rules; these prove what a snapshot has to survive
// on the way to SQLite — the hours invariant in integer minutes, a refusal writing NOTHING, hours
// crossing the REAL <-> minutes boundary. In-memory db, explicit `today`, the week 10-16 Aug 2026.

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
import { deleteBlock, moveBlock, resizeBlock, setBlockLock, splitBlock } from './operations/blocks';
import { createGap, deleteGap, patchGap } from './operations/gaps';
import { previewAbsence, reopenDays, saveAbsence } from './operations/absences';
import { updateSettings } from './operations/settings';
import { readWeek } from './operations/views';
import { deleteBlocks, insertBlock, listBlocks, updateBlock } from './repositories/blocks';
import { listGaps } from './repositories/gaps';
import { listDayOverrides, upsertDayOverride } from './repositories/dayOverrides';
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

  it('fills the hours the day has left and carries the rest to the next one', () => {
    job('Puerta', 8);
    // Monday has 2 h of its 10 h stop line left: the job takes them and finishes on Tuesday.
    job('Barandilla', 4, GREEN);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${MON} 17:30-19:30 Barandilla`,
      `${TUE} 08:00-10:00 Barandilla`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('skips the Friday colchon and lands on next Monday', () => {
    // 40 h fills Mon-Thu at the stop line; the remaining 4 h are a NEW job's, so they skip Friday.
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
    // The project row is inserted before the engine runs, so only the rollback keeps it from
    // existing with no hours on the calendar.
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
    // The queue already runs past this Friday, so `autoLock` does not fire: the padlock the DAY
    // earns is what keeps the buffer from self-cleaning the row away.
    job('Puerta', 44);
    const created = dated('Barandilla', 4, FRI);
    const row = listBlocks(db).find((block) => block.date === FRI);

    expect(row).toMatchObject({ startMinutes: 8 * 60, durationMinutes: 240, locked: true });
    expect(created.placement).toMatchObject({ day: 'buffer', dayLock: true, autoLock: false });

    // And it survives the create-then-reflow churn, which is where a Friday drop is lost.
    job('Reja', 2);
    expect(listBlocks(db).find((block) => block.date === FRI)?.id).toBe(row?.id);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('honours a Saturday, where the engine places nothing at all', () => {
    job('Puerta', 20);
    dated('Barandilla', 4, SAT);
    const row = listBlocks(db).find((block) => block.date === SAT);

    // Beyond the planned work AND on a day the engine never uses: both reasons for a padlock apply.
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

  it('writes a painted band on the minute it was painted on, padlocked', () => {
    job('Puerta', 20);
    const created = createProject(
      {
        name: 'Barandilla',
        color: BLUE,
        totalMinutes: 2 * 60,
        startDate: WED,
        startMinutes: 16 * 60,
        today: MON,
      },
      db,
    );

    expect(
      created.blocks.map((block) => `${block.date} ${block.startMinutes} ${block.locked}`),
    ).toEqual([`${WED} ${16 * 60} true`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('previews a painted band exactly as the save then writes it', () => {
    job('Puerta', 20);

    for (const [startDate, startMinutes] of [
      [WED, 16 * 60],
      // Across the comida, so the preview has to carry both rows.
      [WED, 13 * 60],
      // Into the bottom margin, which auto-fill never enters.
      [NEXT_MON, 19 * 60],
      // More hours than the day can hold: the tail has to match too.
      [NEXT_TUE, 17 * 60],
    ] as const) {
      const totalMinutes = startMinutes === 17 * 60 ? 8 * 60 : 2 * 60;
      const preview = previewProjectCreation(
        { startDate, startMinutes, totalMinutes, today: MON },
        db,
      );
      const created = createProject(
        { name: `Painted ${startDate} ${startMinutes}`, color: BLUE, totalMinutes, startDate, startMinutes, today: MON },
        db,
      );

      expect(
        created.blocks.map((block) => ({
          date: block.date,
          startMinutes: block.startMinutes,
          durationMinutes: block.durationMinutes,
          locked: block.locked,
        })),
        `preview drifted for ${startDate} ${startMinutes}`,
      ).toEqual(preview.rows);

      deleteProject(created.project.id, { today: MON }, db);
    }
  });

  it('refuses a painted band over a padlocked row and writes nothing', () => {
    const puerta = job('Puerta', 4);
    const first = listBlocks(db).filter((block) => block.projectId === puerta.project.id)[0];
    setBlockLock(first.id, true, { today: MON }, db);
    const before = calendar();

    expect(() =>
      createProject(
        {
          name: 'Barandilla',
          color: BLUE,
          totalMinutes: 2 * 60,
          startDate: first.date,
          startMinutes: first.startMinutes,
          today: MON,
        },
        db,
      ),
    ).toThrow();

    // Nothing at all: not the rows, and not the project row either.
    expect(calendar()).toEqual(before);
    expect(listProjects(db).some((project) => project.name === 'Barandilla')).toBe(false);
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
// A drop onto the Friday colchón, which the engine must not undo
// ---------------------------------------------------------------------------

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

  it('comes home when the padlock comes off, which is the only undo there is', () => {
    const puerta = job('Puerta', 4);
    moveBlock(puerta.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${FRI} 10:00-14:00 Puerta [locked]`]);

    const unlocked = setBlockLock(puerta.blocks[0].id, false, { today: MON }, db);
    expect(unlocked.block?.locked).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-12:00 Puerta`]);
  });

  it('leaves an ordinary weekday drop unmarked — it re-ranks the queue, it does not pin', () => {
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);

    // 07:59 is what the drag layer sends for "drop this at the top of Monday": 08:00 is taken, so
    // `rankFor` nudges by a minute. One minute of margin is a TIE-BREAK, not a request for it.
    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 8 * 60 - 1, today: MON }, db);

    expect(result.block?.locked).toBe(false);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Barandilla`, `${MON} 10:00-14:00 Puerta`]);
  });

  it('padlocks a drop into a visual margin, because the engine would pull it straight back', () => {
    // An unpadlocked margin row is reflowed back into the periods on the very same save, which made
    // the margins configurable and unusable. The padlock is the mark, and pressing it is the way back.
    job('Puerta', 4);
    const barandilla = job('Barandilla', 2, GREEN);

    const result = moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([
      // Half in the margin, half in the morning: the hour inside the period is an obstacle.
      `${MON} 07:00-09:00 Barandilla [locked]`,
      `${MON} 09:00-13:00 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('gives a margin row back to the engine when the padlock comes off', () => {
    const barandilla = job('Barandilla', 2, GREEN);
    moveBlock(barandilla.blocks[0].id, { date: MON, startMinutes: 7 * 60, today: MON }, db);
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
    // A drop adds the padlock and never takes it away, or the padlock would mean two things at
    // once. The way back is the padlock itself.
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

    // 07:59 is the RANK the drag layer sends when 08:00 is taken, not a final time. (A drop a
    // quarter of an hour or more INTO the margin is a different gesture: it pins.)
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
    const last = puerta.blocks[puerta.blocks.length - 1];
    // The edge only sizes a row the engine does not lay out, so the padlock comes first.
    setBlockLock(last.id, true, { today: MON }, db);
    const before = calendar();

    const error = refusal(() => resizeBlock(last.id, { durationMinutes: 60, today: MON }, db));

    expect(error.status).toBe(409);
    expect(error.code).toBe('shrink-needs-choice');
    expect(error.messageKey).toBe('errors.shrinkNeedsChoice');
    // Everything the dialog needs in ONE round trip, in minutes like the rest of the API.
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
    setBlockLock(last.id, true, { today: MON }, db);

    resizeBlock(last.id, { durationMinutes: 60, freedHours: 'reduce-total', today: MON }, db);

    expect(calendar()).toEqual([`${MON} 08:00-14:00 Puerta`, `${MON} 15:30-16:30 Puerta [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(7 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('leaves the freed hours as a block of their own when the owner answers `new-block`', () => {
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];
    setBlockLock(last.id, true, { today: MON }, db);

    resizeBlock(last.id, { durationMinutes: 60, freedHours: 'new-block', today: MON }, db);

    // Still 8 h: 6 + 1 where the owner drew them, and the freed hour as a row of its own.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-16:30 Puerta [locked]`,
      `${MON} 16:30-17:30 Puerta`,
    ]);
    expect(listProjects(db)[0].totalMinutes).toBe(8 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('raises the estimate when the last block is enlarged', () => {
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];
    setBlockLock(last.id, true, { today: MON }, db);

    const result = resizeBlock(last.id, { durationMinutes: 4 * 60, today: MON }, db);

    expect(result.summary.queuedMinutes).toBe(10 * 60);
    expect(listProjects(db)[0].totalMinutes).toBe(10 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes the hours from the job on an unlocked row, and asks once there are none left', () => {
    // One meaning on every row: a transfer inside the job. The padlock is not a precondition; it
    // decides whether the geometry survives, which is the owner's to press.
    //
    // 10,5 h lays out as `Mon 6 h` + `Mon 4 h` + `Tue 0,5 h`, so the stretch grown here — both
    // Monday rows, 10 h — has a counterparty of exactly half an hour.
    const puerta = job('Puerta', 10.5);
    const morning = puerta.blocks[0];
    expect(morning.durationMinutes).toBe(6 * 60);

    // One hour is more than that half, so the rest is put to the owner and NOTHING is written.
    const before = calendar();
    const error = refusal(() => resizeBlock(morning.id, { durationMinutes: 11 * 60, today: MON }, db));
    expect(error.status).toBe(409);
    expect(error.code).toBe('grow-needs-choice');
    expect(error.details?.choices).toEqual(['add-to-total']);
    expect(error.details?.freedMinutes).toBe(30);
    expect(calendar()).toEqual(before);

    // Answered, the job pays what it can and the estimate covers exactly the rest.
    resizeBlock(morning.id, { durationMinutes: 11 * 60, today: MON, freedHours: 'add-to-total' }, db);
    expect(listProjects(db)[0].totalMinutes).toBe(11 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // And it reached past 19:30 into the margin, so the rows it wrote came back padlocked — without
    // that, auto-fill would pull them back inside the shift on the next pass.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Puerta [locked]`,
      `${MON} 15:30-20:30 Puerta [locked]`,
    ]);
  });
  it("stores a resize across the lunch break as two rows — the owner's worked example", () => {
    // The drag layer sends 6 h of NET working minutes: the break adds nothing and the row is stored
    // cut at it like everything else on the calendar.
    job('Porton', 2);
    const barandilla = job('Barandilla', 14, GREEN);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla`,
      `${MON} 15:30-19:30 Barandilla`,
      `${TUE} 08:00-14:00 Barandilla`,
    ]);

    setBlockLock(barandilla.blocks[0].id, true, { today: MON }, db);
    const result = resizeBlock(barandilla.blocks[0].id, { durationMinutes: 6 * 60, today: MON }, db);

    // The named row holds the first segment; the second carries the same padlock.
    expect(result.block?.durationMinutes).toBe(4 * 60);
    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla [locked]`,
      `${MON} 15:30-17:30 Barandilla [locked]`,
      // A transfer, not growth: the 2 h given up went to the job's last row.
      `${MON} 17:30-19:30 Barandilla`,
      `${TUE} 08:00-14:00 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(14 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // And back symmetrically: dragged up to 12:00, the afternoon row is gone.
    resizeBlock(barandilla.blocks[0].id, { durationMinutes: 4 * 60, today: MON }, db);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Porton`,
      `${MON} 10:00-14:00 Barandilla [locked]`,
      `${MON} 15:30-19:30 Barandilla`,
      `${TUE} 08:00-14:00 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(14 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('lets a resize reach into the bottom margin, and the row stays there', () => {
    // The padlock keeps the reflow from pulling the row back inside the periods — and since it is
    // also what allows the resize at all, no second mark is needed here.
    job('Porton', 6);
    const puerta = job('Puerta', 2, GREEN);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Porton`, `${MON} 15:30-17:30 Puerta`]);

    // 15:30 to 20:30: an hour past the last period, into the grey band no gesture could reach.
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);
    const result = resizeBlock(puerta.blocks[0].id, { durationMinutes: 5 * 60, today: MON }, db);

    expect(result.block?.locked).toBe(true);
    expect(calendar()).toEqual([`${MON} 08:00-14:00 Porton`, `${MON} 15:30-20:30 Puerta [locked]`]);
    // Nothing farther in the job to draw from, so this is the one case that grows the estimate.
    expect(listProjects(db).find((project) => project.name === 'Puerta')?.totalMinutes).toBe(5 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();

    // It survives an unrelated save, which is the whole point of the padlock.
    job('Reja', 2);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Porton`,
      `${MON} 15:30-20:30 Puerta [locked]`,
      `${TUE} 08:00-10:00 Reja`,
    ]);

    // Auto-fill cannot reach the margin: Monday's stop line is the 10 h of periods, not 12 h.
    expect(readWeek(MON, { today: MON }, db).days[0].capacityMinutes).toBe(10 * 60);
  });

  it('lets the whole day be used again, and the padlock is what gives the length back', () => {
    const puerta = job('Puerta', 8);
    job('Barandilla', 4, GREEN);
    const automatic = calendar();
    expect(automatic).toEqual([
      `${MON} 08:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${MON} 17:30-19:30 Barandilla`,
      `${TUE} 08:00-10:00 Barandilla`,
    ]);

    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);
    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta [locked]`,
      // STRICT ORDER, UNBROKEN, and the day is used to its stop line: Puerta's remaining hours take
      // the room its shrunk row freed. Ending the day at 10:00 is what a GAP is for.
      `${MON} 10:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
      `${MON} 17:30-19:30 Barandilla`,
      `${TUE} 08:00-10:00 Barandilla`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();

    // Pressing the padlock hands the row back, length included.
    setBlockLock(puerta.blocks[0].id, false, { today: MON }, db);
    expect(calendar()).toEqual(automatic);
    // By id, not by position: two jobs created in the same second are ordered by their random ids.
    expect(listProjects(db).find((project) => project.id === puerta.project.id)?.totalMinutes).toBe(
      8 * 60,
    );
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('keeps a padlocked length through an unrelated save, a new job and a delete', () => {
    const puerta = job('Puerta', 8);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);
    resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db);
    const sizedId = puerta.blocks[0].id;

    const barandilla = job('Barandilla', 2, GREEN);
    createGap({ date: THU, startMinutes: 8 * 60, durationMinutes: 60, today: MON }, db);
    deleteProject(barandilla.project.id, { today: MON }, db);

    const stored = listBlocks(db).find((row) => row.id === sizedId);
    expect(stored?.durationMinutes).toBe(2 * 60);
    expect(stored?.locked).toBe(true);
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Puerta [locked]`,
      `${MON} 10:00-14:00 Puerta`,
      `${MON} 15:30-17:30 Puerta`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('answers a shrink that has nowhere to put the hours with a question, never a no-op', () => {
    // Where the transfer is genuinely impossible the caller gets a 409 with an i18n key that is a
    // QUESTION, never a 200 with the row unchanged. Nothing is written until it is answered.
    const puerta = job('Puerta', 8);
    const last = puerta.blocks[puerta.blocks.length - 1];
    setBlockLock(last.id, true, { today: MON }, db);
    const before = calendar();

    const error = refusal(() => resizeBlock(last.id, { durationMinutes: 60, today: MON }, db));

    expect(error.status).toBe(409);
    expect(error.code).toBe('shrink-needs-choice');
    expect(error.messageKey).toBe('errors.shrinkNeedsChoice');
    expect(calendar()).toEqual(before);
  });

  it('cuts a movable row a drop lands in, so the day reads A, B, A', () => {
    // Dropped onto Wednesday 10:00, inside Barandilla's 08:00-14:00 row: it used to land at 15:30,
    // after the whole block, and push Barandilla to Thursday.
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
    // The displaced job used to move WHOLE to the next day, leaving the day empty behind it.
    job('Barandilla', 12, GREEN, THU);
    const marquesina = job('Marquesina', 2, BLUE, THU);
    const dropped = listBlocks(db).find((row) => row.projectId === marquesina.project.id);

    moveBlock(dropped!.id, { date: THU, startMinutes: 10 * 60, today: THU }, db);

    expect(calendar()).toEqual([
      `${THU} 08:00-10:00 Barandilla`,
      `${THU} 10:00-12:00 Marquesina`,
      // The 10 h tail fills forward from where it was cut instead of landing whole on Monday.
      `${THU} 12:00-14:00 Barandilla`,
      `${THU} 15:30-19:30 Barandilla`,
      `${NEXT_MON} 08:00-12:00 Barandilla`,
    ]);
    expect(listProjects(db).find((project) => project.name === 'Barandilla')?.totalMinutes).toBe(12 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('stores a drop that crosses the lunch break as two rows', () => {
    // A 360 min drop at 10:00 was stored as ONE row through 14:00-15:30. `duration` is net working
    // time, so the grid, the overlap arithmetic and auto-merge all assume that cannot happen.
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

    // The 2 h took a new place in the queue, behind Barandilla. It does NOT stay on Wednesday: an
    // unlocked fragment settles contiguously, so parking hours on a day means locking them.
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
// A row on TODAY becomes a past row overnight, so any job carrying yesterday's work was one
// hours-edit away from a dead app: the growth landed on the past row and stored `12:00-25:00`.
// Two independent fixes — the LIFO growth target agrees with the movable pool, AND no transaction
// can store a row running past the end of its day whatever produced it.

describe('raising the hours of a job whose only row is in the frozen past', () => {
  /**
   * A 2 h job whose single row sits on yesterday at 12:00, today being Wednesday. Written straight
   * onto the row rather than dragged: no gesture reaches a past day, and what is under test is what
   * the app does with a record that is ALREADY there.
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
      },
      db,
    );
    expect(calendar()).toEqual([`${TUE} 12:00-14:00 Puerta`]);
    return { project: puerta.project, blockId };
  }

  it('gives the added hours their own row instead of inflating yesterday', () => {
    const { project, blockId } = yesterdaysWork();

    patchProject(project.id, { totalMinutes: 6 * 60, today: WED }, db);

    // Yesterday is the RECORD: 2 h unchanged. The 4 h are a row of their own, placed by the engine.
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
    // The cost was named when this was decided: it removes "correcting yesterday", which is the case
    // *Block Resize* was designed for.

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
    // The way out: yesterday's 4 h are the record, the 2 h added now get a row on a day that changes.
    const { project, blockId } = yesterday();

    patchProject(project.id, { totalMinutes: 6 * 60, today: WED }, db);

    expect(calendar()).toEqual([`${TUE} 08:00-12:00 Puerta`, `${WED} 08:00-10:00 Puerta`]);
    expect(listBlocks(db).find((row) => row.id === blockId)?.durationMinutes).toBe(4 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('leaves a padlock a row carried into the past exactly where it is', () => {
    // Nothing is stranded: `isMovable` asks the date before the flag, so a past padlock reads the same
    // either way, and there is no second mark to hand back.
    const puerta = job('Puerta', 4, BLUE, TUE);
    setBlockLock(puerta.blocks[0].id, true, { today: TUE }, db);
    resizeBlock(puerta.blocks[0].id, { durationMinutes: 3 * 60, freedHours: 'reduce-total', today: TUE }, db);
    expect(listBlocks(db)[0].durationMinutes).toBe(3 * 60);

    // The next day it is a record. The padlock stays, and the padlock itself is refused.
    const error = refusal(() => setBlockLock(listBlocks(db)[0].id, false, { today: WED }, db));
    expect(error.code).toBe('past-block-frozen');
    expect(listBlocks(db)[0].locked).toBe(true);
    expect(calendar()).toEqual([`${TUE} 08:00-11:00 Puerta [locked]`]);
  });
});

describe('a drop onto another row\'s start goes BEFORE it', () => {
  it('lets the drop win the tie, instead of the older row keeping its place', () => {
    // A tie is decided by `created_at`, so a drop released exactly on an existing start silently lost
    // to the older row. Landing on a start means "put me before this one", and nothing is cut.
    const alfa = job('Alfa', 2, BLUE, MON);
    const beta = job('Beta', 2, GREEN, MON);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Alfa`, `${MON} 10:00-12:00 Beta`]);
    // `created_at` has one-second resolution, so same-tick rows tie on it too and the order falls to a
    // random UUID. Alfa is made the older row on purpose: it is the one that used to swallow the drop.
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
  // The guard sits on the WRITE, so a rendering crash from bad stored data is impossible rather than
  // merely unreachable through the paths that were fixed.

  it('refuses a resize on a past row before the day-end guard is even reached', () => {
    // Over HTTP the duration is not capped by the drag layer. The gesture is refused for being on the
    // past — a strictly earlier line — and the guard below is what keeps the shape unstorable.
    const puerta = job('Puerta', 2, BLUE, WED);
    updateBlock(
      {
        id: puerta.blocks[0].id,
        projectId: puerta.project.id,
        date: TUE,
        startMinutes: 12 * 60,
        durationMinutes: 2 * 60,
        locked: false,
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
// Every reproduction below answered 200 and stored a row hanging below the grid's own last rule.

describe('the end of the day is a line no write may cross', () => {
  it('refuses a resize whose stretch would run past the last manual window', () => {
    // Over HTTP the drag layer's cap is not in the way: 12 h from 08:00 stored `08:00-14:00` +
    // `15:30-21:30`. The row is padlocked first, because that is the only kind the edge sizes.
    job('Uno', 6, BLUE, THU);
    setBlockLock(listBlocks(db)[0].id, true, { today: THU }, db);
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
    setBlockLock(listBlocks(db)[0].id, true, { today: THU }, db);

    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 11 * 60, today: THU }, db);

    // Both rows carry the target's padlock: what holds a hand-made shape has to hold all of it.
    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno [locked]`, `${THU} 15:30-20:30 Uno [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('sends a split whose fragment would run past the end of the day to the next day', () => {
    // The scissors' second click goes through `rankFor`, which was not clamped: 60 min at 19:45 stored
    // `19:45-20:45`. Aiming past the end of a day means the day after, so the fragment takes Friday.
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

  it('sends a PADLOCKED drop aimed below what the day holds to the next day, instead of refusing', () => {
    // 6 h at 13:15 needs `13:15-14:00` + `15:30-20:45`, a quarter of an hour past the end of the day,
    // so it rolls. Thursday's next day is the colchón. The row is padlocked first: only a drop that
    // lands LITERALLY has a footprint that has to fit a day.
    job('Uno', 6, BLUE, THU);
    const row = listBlocks(db)[0];
    setBlockLock(row.id, true, { today: THU }, db);

    const result = moveBlock(row.id, { date: THU, startMinutes: 13 * 60 + 15, today: THU }, db);

    expect(calendar()).toEqual([`${FRI} 08:00-14:00 Uno [locked]`]);
    expect(result.block?.date).toBe(FRI);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('leaves the SAME aim on the day it was made when the drop is only a queue rank', () => {
    // An unlocked Mon-Thu release writes a RANK, and the engine carries the overflow itself, so there
    // is nothing here for another DATE to solve. Rolling it answered 200 with the calendar unmoved.
    job('Uno', 6, BLUE, THU);

    const result = moveBlock(listBlocks(db)[0].id, { date: THU, startMinutes: 13 * 60 + 15, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-14:00 Uno`]);
    expect(result.block?.locked).toBe(false);
    expect(result.changed).toBe(false);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('does NOT roll a drop off a day the engine does not lay out', () => {
    // On the weekend the exact minute is the whole promise, so the same aim keeps its day.
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
    // Repeating one drop used to compound: `Sat 13:00-23:00, 10 h`, hours conserved so nothing warned.
    const grande = job('Grande', 10, BLUE, THU);
    // The two halves dropped on Saturday one after the other: the second merges into BOTH.
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
    // A row stranded outside the windows keeps its hours, so the guard refuses only a gesture that
    // makes the overrun WORSE.
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

    // Still draggable back inside the day, and it keeps the padlock the margin drop gave it, so it
    // lands on the exact minute rather than taking a rank.
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
// The manual windows are `07:00-14:00` and `15:30-20:30`, so 14:00 is the exclusive END of the
// first and before the start of the second: it belonged to no window, the segmenter found no
// boundary, and `dropped at 14:00` stored `14:00 +120m -> 16:00` — one row through the break. Every
// minute from 14:00 to 15:29 did it, and so did the scissors' target. The cases below are the
// boundary minutes, never a sample from the middle.

describe('the lunch break is not a slot', () => {
  it('stores a drop aimed anywhere in the break from 15:30, on a day that keeps the minute', () => {
    // Saturday keeps the exact minute, so what is stored here is the whole promise.
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
    // 13:45 IS working time, so it is its own answer: the fix must move only the minutes with none.
    const uno = job('Uno', 2);

    moveBlock(uno.blocks[0].id, { date: SAT, startMinutes: 13 * 60 + 45, today: MON }, db);

    expect(calendar()).toEqual([
      `${SAT} 13:45-14:00 Uno [locked]`,
      `${SAT} 15:30-17:15 Uno [locked]`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('does not padlock a Monday-Thursday drop aimed at the break, because 15:30 is a period', () => {
    // Read as 15:30 the request is ordinary, so the drop is a queue RANK like any other Mon-Thu drop.
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
    // The fragment IS a drop, so it takes the same reading.
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

  it('rolls a PADLOCKED drop the afternoon cannot hold to the next day, measured from 15:30', () => {
    // 5 h from 15:30 reaches 20:30, the day's last minute; 5 h 15 reaches past it. A padlocked row
    // lands literally, so its footprint has to fit — and Thursday's next day is the colchón.
    job('Uno', 5.25, BLUE, THU);
    const unit = listBlocks(db);
    setBlockLock(unit[0].id, true, { today: THU }, db);

    moveBlock(
      unit[0].id,
      { date: THU, startMinutes: 14 * 60, unitBlockIds: unit.map((row) => row.id), today: THU },
      db,
    );

    expect(calendar()).toEqual([`${FRI} 08:00-13:15 Uno [locked]`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes a row a settings change stranded in the break out of it on the next resize', () => {
    // The one way a row can still START in the break: the owner shortens the morning under a row that
    // was legally placed. Nothing rewrites it where it sits, but a gesture that rewrites its LENGTH
    // lays the new segments out from the first minute that can hold work.
    const uno = job('Uno', 2, BLUE, THU);
    // The capacity travels with the shorter shift: a 10 h capacity on a 9 h shift is refused.
    updateSettings(
      { period1End: '13:00', period2Start: '15:30', defaultDayCapacity: 9 },
      { today: THU },
      db,
    );
    // Recomposed, the row is back inside a period; put it in the break by hand.
    updateBlock(
      {
        id: uno.blocks[0].id,
        projectId: uno.project.id,
        date: THU,
        startMinutes: 14 * 60,
        durationMinutes: 2 * 60,
        locked: true,
      },
      db,
    );
    expect(calendar()).toEqual([`${THU} 14:00-16:00 Uno [locked]`]);

    resizeBlock(listBlocks(db)[0].id, { durationMinutes: 3 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 15:30-18:30 Uno [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(3 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('moves a GAP aimed at the break to the first minute that can hold work', () => {
    // A gap's `duration` is NET working minutes now, so a gap is no longer the one row that may span
    // a break: it reads a non-working start exactly as a drop does, and nothing happens in the comida.
    createGap({ date: THU, startMinutes: 14 * 60, durationMinutes: 120, reason: 'Averia', today: THU }, db);

    expect(gapLines()).toEqual([`${THU} 15:30-17:30 Averia`]);
  });

  it('leaves the hole after the last window alone when the afternoon is switched off', () => {
    // The day becomes `07:00-15:00` and the hole after it runs to midnight: no later working minute
    // to offer, so the release stands and the day's own end answers.
    updateSettings({ period2Enabled: false, defaultDayCapacity: 6 }, { today: THU }, db);
    const uno = job('Uno', 2, BLUE, THU);

    // On a day the engine lays out the roll answers: Thursday's next day is the colchón.
    moveBlock(uno.blocks[0].id, { date: THU, startMinutes: 18 * 60, today: THU }, db);
    expect(calendar()).toEqual([`${FRI} 08:00-10:00 Uno [locked]`]);

    // On a day it does not, the end-of-day guard answers and writes nothing.
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
    // One PATCH per row with a reflow between them left part of the unit behind: the reflow re-laid
    // the job's hours onto DIFFERENT ids, so the second request moved whatever row held the id.
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
    // An 8 h job is cut at the break by the engine itself: two rows, one unit, no padlock.
    job('Uno', 8, BLUE, THU);
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
    // Friday IS in the movable pool, which is what made the race visible: one request per row re-laid
    // the remaining hours onto different ids in between. One transaction, one reflow.
    job('Uno', 8, BLUE, THU);
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
    // The ghost drew the whole run and the drop delivered only the grabbed row's day, because the unit
    // was computed inside one date. A run crosses midnight exactly as `buildQueue` does.
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
    // A separation is a division made on purpose, so the drag stops there: grabbing Uno's first piece
    // moves that piece and nothing after Dos, however much the request claims.
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

    // Only the 2 h before Dos travelled, and the reflow closed the hole the head left.
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
    // `buildQueue` skips fixed work without closing the run, so the drag must too.
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
    // Gaps and blocks are one occupancy set, but Friday reflows and the owner aimed at a Friday: the
    // drop gives up the exact minute, never the day, and lands at the first slot clear of the gap.
    job('Uno', 2, BLUE, THU);
    const dos = job('Dos', 1, GREEN, THU);
    createGap({ date: FRI, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: THU }, db);

    const result = moveBlock(dos.blocks[0].id, { date: FRI, startMinutes: 10 * 60, today: THU }, db);

    expect(calendar()).toEqual([`${THU} 08:00-10:00 Uno`, `${FRI} 11:00-12:00 Dos [locked]`]);
    // Still the owner's Friday: the slide keeps the padlock, so the engine never takes it back.
    expect(result.block?.locked).toBe(true);
    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('is refused on the WEEKEND, where nothing will ever separate the two', () => {
    // The engine lays nothing out on a Saturday, so a collision there is a permanent conflict.
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
// Fill and overflow — the owner's own case, end to end
// ---------------------------------------------------------------------------
//
// `test 3` is 6 h and Monday holds 4 h of free afternoon. Dropping it there answered 200 and changed
// NOTHING, while the ghost had said «6 h no pueden empezar después de las …». Three things were
// wrong at once: the drop rolled onto a day it was already on, the engine would not split it, and
// the response could not tell the client that nothing had happened.

describe("the owner's case: 6 h dropped into a Monday holding 4 h", () => {
  const SPLIT = [
    `${MON} 08:00-14:00 test 1 [locked]`,
    `${MON} 15:30-19:30 test 3`,
    `${TUE} 08:00-10:00 test 3`,
  ];

  /**
   * Their calendar at the moment they dragged: Monday's morning padlocked, its whole afternoon free,
   * and `test 3` sitting on Tuesday as ONE row. The last part is written by hand and has to be — the
   * new engine never produces that state, so no sequence of gestures reaches it.
   */
  function theirCalendar(): string {
    const uno = job('test 1', 6, BLUE, MON);
    setBlockLock(uno.blocks[0].id, true, { today: MON }, db);
    const tres = job('test 3', 6, GREEN, MON);
    const own = listBlocks(db).filter((row) => row.projectId === tres.project.id);
    updateBlock({ ...own[0], date: TUE, startMinutes: 8 * 60, durationMinutes: 6 * 60 }, db);
    deleteBlocks(
      own.slice(1).map((row) => row.id),
      db,
    );

    expect(calendar()).toEqual([`${MON} 08:00-14:00 test 1 [locked]`, `${TUE} 08:00-14:00 test 3`]);
    expect(() => assertProjectHours(db)).not.toThrow();
    return own[0].id;
  }

  it('stores 4 h on Monday and 2 h on the next day it can use', () => {
    const tres = theirCalendar();

    const result = moveBlock(tres, { date: MON, startMinutes: 15 * 60 + 30, today: MON }, db);

    // Four hours of Monday's afternoon and two on Tuesday, where it used to answer 200 unmoved.
    expect(calendar()).toEqual(SPLIT);
    // A Mon-Thu drop inside the periods is a rank: no padlock, and no roll onto another day.
    expect(result.block?.locked).toBe(false);
    expect(result.block?.date).toBe(MON);
    // Both rows, in calendar order, so the client can say «4 h el lunes, 2 h el martes».
    expect(result.changed).toBe(true);
    expect(
      result.placedBlockIds.map((id) => {
        const row = result.blocks.find((candidate) => candidate.id === id);
        return `${row?.date} ${row?.durationMinutes}`;
      }),
    ).toEqual([`${MON} 240`, `${TUE} 120`]);
    expect(listProjects(db).find((project) => project.name === 'test 3')?.totalMinutes).toBe(6 * 60);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('says nothing changed when the drop asks for the calendar it already has', () => {
    // The same gesture again, named the way the grid names it — the WHOLE run. The hours are already
    // where the queue puts them, so `changed` is the only honest way to know that. It pins why
    // `changed` is asked of the ROWS: folding a run deletes and inserts rows, so ids would say true.
    const tres = theirCalendar();
    const first = moveBlock(tres, { date: MON, startMinutes: 15 * 60 + 30, today: MON }, db);

    const again = moveBlock(
      first.placedBlockIds[0],
      { date: MON, startMinutes: 15 * 60 + 30, unitBlockIds: first.placedBlockIds, today: MON },
      db,
    );

    expect(again.changed).toBe(false);
    expect(again.placedBlockIds).toHaveLength(2);
    expect(calendar()).toEqual(SPLIT);
  });

  it('recomposing the result changes nothing: the split is a fixed point', () => {
    const tres = theirCalendar();
    moveBlock(tres, { date: MON, startMinutes: 15 * 60 + 30, today: MON }, db);

    // Two unrelated saves, each of which re-runs the reflow over the whole calendar.
    createGap(
      { date: NEXT_TUE, startMinutes: 8 * 60, durationMinutes: 60, reason: 'Gestoría', today: MON },
      db,
    );
    deleteGap(listGaps(db)[0].id, { today: MON }, db);

    expect(calendar()).toEqual(SPLIT);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Every gesture answers for itself
// ---------------------------------------------------------------------------
//
// `changed` and `placedBlockIds` are on every block mutation, because the same silence is reachable
// from every gesture that hands its hours to the reflow.

describe('what a block mutation says about itself', () => {
  it('names both rows a resize left behind, and reports the write', () => {
    const puerta = job('Puerta', 8);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    // 9 h from 08:00 is 08:00-14:00 plus 15:30-18:30: one stretch, two rows.
    const result = resizeBlock(puerta.blocks[0].id, { durationMinutes: 9 * 60, today: MON }, db);

    expect(result.changed).toBe(true);
    expect(result.placedBlockIds).toHaveLength(2);
    expect(
      result.placedBlockIds.map((id) => result.blocks.find((row) => row.id === id)?.startMinutes),
    ).toEqual([8 * 60, 15 * 60 + 30]);
  });

  it('reports the padlock as a change even though nothing moved a minute', () => {
    const puerta = job('Puerta', 2);

    const locked = setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);
    expect(locked.changed).toBe(true);
    expect(locked.placedBlockIds).toEqual([puerta.blocks[0].id]);

    // And the same call twice over writes nothing the second time.
    expect(setBlockLock(puerta.blocks[0].id, true, { today: MON }, db).changed).toBe(false);
  });

  it('reports nothing for a resize that asked for the length the row already had', () => {
    // The one place a successful gesture writes nothing: there is no mark left for it to set.
    const puerta = job('Puerta', 2);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    expect(resizeBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, today: MON }, db).changed).toBe(false);
    expect(
      resizeBlock(puerta.blocks[0].id, { durationMinutes: 60, freedHours: 'reduce-total', today: MON }, db)
        .changed,
    ).toBe(true);
  });

  it('answers for the FRAGMENT after the scissors, not for the row that was cut', () => {
    const puerta = job('Puerta', 8);

    const result = splitBlock(
      puerta.blocks[0].id,
      { durationMinutes: 2 * 60, date: SAT, startMinutes: 9 * 60, today: MON },
      db,
    );

    expect(result.changed).toBe(true);
    const fragment = listBlocks(db).find((row) => row.date === SAT);
    expect(result.placedBlockIds).toEqual([fragment?.id]);
  });

  it('has no row to name when a merge absorbed the one that was dropped', () => {
    const puerta = job('Puerta', 8);
    splitBlock(puerta.blocks[0].id, { durationMinutes: 2 * 60, date: SAT, startMinutes: 9 * 60, today: MON }, db);

    const result = splitBlock(
      listBlocks(db)[0].id,
      { durationMinutes: 2 * 60, date: SAT, startMinutes: 10 * 60, today: MON },
      db,
    );

    expect(result.mergedBlockIds).toHaveLength(1);
    expect(result.placedBlockIds).toEqual([]);
    expect(result.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A drop refused for room the reflow was about to make
// ---------------------------------------------------------------------------
//
// The refusal measured the drop against the calendar as it stood at that instant, and the answer was
// circular: the room on the target day is made BY the move, because the row leaves a hole on its own
// day and the work behind it moves up into that.

describe('a drop onto a day that is full at the moment it is released', () => {
  /**
   * Monday and Tuesday both full at the 10 h stop line, and a gap in one of Tuesday's visual margins
   * — the slot a drop PINS itself in, and therefore the one that used to be refused.
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
    // The drop is aimed at the top margin, which is manual-only time and therefore PINS the row, and
    // the shop does not open until 08:00, which is what the gap says. It used to be `overlaps-gap`.
    const dos = fullWeek({ startMinutes: 7 * 60, reason: 'Apertura' });

    const result = moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 7 * 60, today: MON }, db);

    // Tuesday has a free minute now BECAUSE of the move: Dos left a hole on Monday, Tres moved up
    // into it, and Cuatro shifted into the morning Tres had been holding.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Uno`,
      `${MON} 15:30-19:30 Tres`,
      `${TUE} 08:00-12:00 Dos [locked]`,
      `${TUE} 12:00-14:00 Cuatro`,
      `${TUE} 15:30-19:30 Cuatro`,
    ]);
    // The gap kept its minutes and the drop kept its day, and the slot asked for by hand padlocks.
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
    // An hour released at 19:30 STARTS in the bottom margin, so it lands literally, straight onto a
    // gap covering the whole margin. Forward is 20:30, the end of the day, so there is nowhere to
    // slide: it may not give up the pin, because that means taking off a padlock the owner would see.
    const uno = job('Uno', 1, BLUE, MON);
    createGap(
      { date: TUE, startMinutes: 19 * 60 + 30, durationMinutes: 60, reason: 'Cierre', today: MON },
      db,
    );
    const before = calendar();

    const error = refusal(() =>
      moveBlock(uno.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db),
    );

    expect(error.code).toBe('overlaps-gap');
    expect(error.details).toMatchObject({ date: TUE, reason: 'Cierre' });
    expect(calendar()).toEqual(before);
    expect(listProjects(db).map((project) => project.totalMinutes)).toEqual([60]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes a drop whose footprint only REACHES the margin as an ordinary rank', () => {
    // 16:30 is inside the afternoon, so the row asks for no manual-only time: the minutes past 19:30
    // are hours the reflow carries on. The gap covering that margin is nothing to do with this drop.
    const dos = fullWeek({ startMinutes: 19 * 60 + 30, reason: 'Cierre' });

    const result = moveBlock(dos.blocks[0].id, { date: TUE, startMinutes: 16 * 60 + 30, today: MON }, db);

    expect(result.block?.locked).toBe(false);
    // Cuatro's afternoon row was cut at 16:30, so the queue reads `Cuatro, Dos, Cuatro`.
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Uno`,
      `${MON} 15:30-19:30 Tres`,
      `${TUE} 08:00-11:00 Cuatro`,
      `${TUE} 11:00-14:00 Dos`,
      `${TUE} 15:30-16:30 Dos`,
      `${TUE} 16:30-19:30 Cuatro`,
    ]);
    expect(listGaps(db)).toHaveLength(1);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('is still refused when the row being dragged is LOCKED', () => {
    // A locked row keeps its exact slot, so nothing will ever separate it from the gap: here "does it
    // fit" really is the question.
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
    // `stretchFrom` takes a continuation whatever its padlock, and the response used to carry
    // `touchedLockedBlockIds: []`, so the UI showed no warning at all.
    const unit = job('U', 10, BLUE, THU);
    const [morning, afternoon] = listBlocks(db);
    setBlockLock(afternoon.id, true, { today: THU }, db);
    setBlockLock(morning.id, true, { today: THU }, db);

    const result = resizeBlock(morning.id, { durationMinutes: 11 * 60, today: THU }, db);

    expect(result.touchedLockedBlockIds).toEqual([afternoon.id]);
    // Both rows padlocked, and both were before: the padlock is what let the edge size them.
    expect(calendar()).toEqual([`${THU} 08:00-14:00 U [locked]`, `${THU} 15:30-20:30 U [locked]`]);
    expect(listProjects(db)[0].totalMinutes).toBe(11 * 60);
    expect(unit.project.id).toBe(listProjects(db)[0].id);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The margin collision, which the third mark used to hide
// ---------------------------------------------------------------------------
//
// The defect: `Corto 1 h` sat in Tuesday's bottom margin and a drop of another job was allowed to
// EVICT it silently. A row in a margin now carries a PADLOCK, and a drop onto a padlocked row of
// another job is refused with the row named, so the eviction went away with the third mark.

describe('the margin collision the third mark used to hide', () => {
  it('refuses a drop onto a padlocked margin row, names it, and writes nothing', () => {
    const corto = job('Corto', 1, GREEN);
    // 19:30-20:30 — the whole of Tuesday's bottom margin, so the drop padlocks it.
    moveBlock(corto.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db);
    const alfa = job('Alfa', 1);
    const before = calendar();
    expect(before).toContain(`${TUE} 19:30-20:30 Corto [locked]`);

    // The same minute and the same hour of margin: Alfa pins too, and 20:30 leaves nowhere to slide.
    const error = refusal(() =>
      moveBlock(alfa.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('overlaps-locked-block');
    expect(error.details).toMatchObject({
      projectName: 'Corto',
      date: TUE,
      startTime: '19:30',
      endTime: '20:30',
    });
    // Nothing at all: Corto did not move to Monday and Alfa did not take the margin.
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('does not refuse a drop that merely REACHES that margin — it is a rank', () => {
    // Corto keeps its padlock, its day and its minute, because the engine never touches a padlocked
    // row. Alfa is laid out inside the periods.
    const corto = job('Corto', 1, GREEN);
    moveBlock(corto.blocks[0].id, { date: TUE, startMinutes: 19 * 60 + 30, today: MON }, db);
    const alfa = job('Alfa', 2);

    // 18:30-20:30: an hour of the afternoon and the whole margin, straight over Corto.
    const result = moveBlock(alfa.blocks[0].id, { date: TUE, startMinutes: 18 * 60 + 30, today: MON }, db);

    expect(result.block?.locked).toBe(false);
    // A rank, so the reflow decides the clock: Alfa settles at the front of the week, where it
    // already was, and `changed` is what tells the client so.
    expect(calendar()).toEqual([
      `${MON} 08:00-10:00 Alfa`,
      `${TUE} 19:30-20:30 Corto [locked]`,
    ]);
    expect(result.changed).toBe(false);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('takes the same drop in the margin at the other end, where nothing is in the way', () => {
    // The refusal is about the row in the way, not about the margins.
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

    // Sum, not union: 09:00-13:00 is 4 h, and the padlock both fragments carry survives the fold.
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
    // Unpadlocked first: a padlocked row is never cut. What is tested is the OTHER weekend row,
    // held there by the day alone.
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
    // The move is written before the engine runs, so only the rollback keeps the calendar as it was.
    expect(calendar()).toEqual(before);
  });

  it('refuses a drop INTO the past and writes nothing', () => {
    // The past is the record of what the shop did, so it is not a drop target.
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

    // Dropped ON TOP of the fragment and ranked after it: the fragment survives with the summed hours.
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

describe("a gap's hours are net working minutes, so a gap is cut at the comida too", () => {
  it('stores an all-day gap as TWO rows sharing one reason', () => {
    // 12 h and not 10: a gap is a hand gesture, so it is read over the MANUAL WINDOWS and may use
    // the visual margins. `07:00-14:00` is 7 h and `15:30-20:30` is 5 h.
    const saved = createGap(
      { date: MON, startMinutes: 7 * 60, durationMinutes: 12 * 60, reason: 'Feria', today: MON },
      db,
    );

    expect(gapLines()).toEqual([`${MON} 07:00-14:00 Feria`, `${MON} 15:30-20:30 Feria`]);
    // Both rows come back, in clock order, and `gap` is the first of them.
    expect(saved.gaps).toHaveLength(2);
    expect(saved.gap.id).toBe(saved.gaps[0].id);
    expect(saved.gaps.map((gap) => gap.durationMinutes)).toEqual([7 * 60, 5 * 60]);
  });

  it('refuses hours no day can hold, at the end of the last manual window', () => {
    const error = refusal(() =>
      createGap({ date: MON, startMinutes: 8 * 60, durationMinutes: 13 * 60, today: MON }, db),
    );

    // Not midnight: the line is the end of the day for every hand gesture, 20:30 here.
    expect(error.code).toBe('row-past-day-end');
    expect(listGaps(db)).toEqual([]);
  });

  it('may sit entirely inside a visual margin', () => {
    // Margins accept every hand gesture, and this one costs the day nothing plannable: it is
    // outside the periods, so `plannableMinutes` is untouched.
    createGap({ date: MON, startMinutes: 7 * 60, durationMinutes: 60, reason: 'Taller', today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 07:00-08:00 Taller`]);
    expect(readWeek(MON, { today: MON }, db).days[0].plannableMinutes).toBe(10 * 60);
  });

  it('leaves two gaps that merely TOUCH as two gaps', () => {
    // Each carries its own reason and merging one into the other would destroy it.
    createGap({ date: MON, startMinutes: 9 * 60, durationMinutes: 60, reason: 'Avería', today: MON }, db);
    createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Gestiones', today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 09:00-10:00 Avería`, `${MON} 10:00-11:00 Gestiones`]);
  });

  it('costs the day exactly its net minutes, counted as ONE occupancy set with the blocks', () => {
    job('Puerta', 4);
    // 8 h from 10:00 reaches 19:30: 4 h of morning left plus the whole afternoon.
    createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, reason: 'Feria', today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 10:00-14:00 Feria`, `${MON} 15:30-19:30 Feria`]);
    // The day has 10 plannable hours and the gap holds 8 of them, so 2 are left — and the job's
    // 4 h fill those two and carry on to Tuesday.
    expect(readWeek(MON, { today: MON }, db).days[0].plannableMinutes).toBe(2 * 60);
    expect(calendar()).toEqual([`${MON} 08:00-10:00 Puerta`, `${TUE} 08:00-10:00 Puerta`]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('is refused by a locked row its SECOND half lands on', () => {
    // The whole point of asking the refusal of each stored ROW: read as one clock interval the
    // candidate would be 10:00-18:00, which names nothing at 18:00-19:30 and saves on top of it.
    const porton = job('Porton', 1.5);
    // Padlocked first, so the drop is a literal placement rather than a queue rank.
    setBlockLock(porton.blocks[0].id, true, { today: MON }, db);
    moveBlock(porton.blocks[0].id, { date: MON, startMinutes: 18 * 60, today: MON }, db);
    expect(calendar()).toEqual([`${MON} 18:00-19:30 Porton [locked]`]);

    const error = refusal(() =>
      createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, today: MON }, db),
    );

    expect(error.code).toBe('gap-over-fixed-block');
    expect(error.messageKey).toBe('errors.gapOverLockedBlock');
    expect(error.details).toMatchObject({ projectName: 'Porton', date: MON, startTime: '18:00' });
    expect(listGaps(db)).toEqual([]);
  });

  it('does not name a row the gap stops short of', () => {
    // The mirror of the case above, and the reason the refusal has to be per ROW in both
    // directions: 3 h from 10:00 is 10:00-13:00 and stops there, so the padlocked row that starts
    // at 15:30 is not in the way and the gap saves.
    const porton = job('Porton', 2);
    setBlockLock(porton.blocks[0].id, true, { today: MON }, db);
    moveBlock(porton.blocks[0].id, { date: MON, startMinutes: 15 * 60 + 30, today: MON }, db);

    createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 3 * 60, reason: 'Feria', today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 10:00-13:00 Feria`]);
    expect(calendar()).toEqual([`${MON} 15:30-17:30 Porton [locked]`]);
  });

  it('cuts a PATCH at the comida too, giving the far half its own row', () => {
    const saved = createGap(
      { date: MON, startMinutes: 12 * 60, durationMinutes: 60, reason: 'Avería', today: MON },
      db,
    );

    const patched = patchGap(saved.gap.id, { durationMinutes: 4 * 60, today: MON }, db);

    // The row named keeps its id and takes the first half; the far half is a new row with the
    // same reason, because the two halves are ONE gap.
    expect(gapLines()).toEqual([`${MON} 12:00-14:00 Avería`, `${MON} 15:30-17:30 Avería`]);
    expect(patched.gap.id).toBe(saved.gap.id);
    expect(patched.gaps.map((gap) => gap.reason)).toEqual(['Avería', 'Avería']);
  });

  it('EXTENDS the far half a unit already has instead of inserting a second one', () => {
    // Measured over HTTP on 2026-08-19: the PATCH updated the row named and blindly inserted every
    // further segment, so re-saving the same geometry left THREE rows on disk, two of them
    // overlapping, and reported only two.
    const saved = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, reason: 'Feria', today: MON },
      db,
    );
    const afternoonId = saved.gaps[1].id;

    const patched = patchGap(saved.gap.id, { durationMinutes: 8 * 60, today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 10:00-14:00 Feria`, `${MON} 15:30-19:30 Feria`]);
    // The same two rows, so nothing that referred to either half is orphaned.
    expect(patched.gaps.map((gap) => gap.id)).toEqual([saved.gap.id, afternoonId]);
  });

  it('DELETES the far half when the hours no longer reach across the comida', () => {
    const saved = createGap(
      { date: MON, startMinutes: 12 * 60, durationMinutes: 4 * 60, reason: 'Avería', today: MON },
      db,
    );
    expect(gapLines()).toHaveLength(2);

    const patched = patchGap(saved.gap.id, { durationMinutes: 60, today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 12:00-13:00 Avería`]);
    expect(patched.gaps.map((gap) => gap.id)).toEqual([saved.gap.id]);
  });

  it('is addressed by ANY of its rows: naming either half edits the same absence', () => {
    // An absence is (day, start, NET duration), so shortening it to 5 h leaves 4 h in the morning and
    // 1 h after the comida — and it does not matter which half the caller named. The alternative,
    // letting a PATCH mean "this ROW becomes 1 h", cannot express growing a half across the break
    // without inventing a second row, which is the defect this replaced.
    const first = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, reason: 'Feria', today: MON },
      db,
    );
    patchGap(first.gaps[1].id, { durationMinutes: 5 * 60, today: MON }, db);
    const namingTheAfternoon = gapLines();

    // One delete per UNIT, not per row: deleting takes both halves, so iterating the rows would
    // ask for a row the previous call already removed.
    while (listGaps(db).length > 0) deleteGap(listGaps(db)[0].id, { today: MON }, db);

    const second = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, reason: 'Feria', today: MON },
      db,
    );
    patchGap(second.gaps[0].id, { durationMinutes: 5 * 60, today: MON }, db);

    expect(namingTheAfternoon).toEqual([`${MON} 10:00-14:00 Feria`, `${MON} 15:30-16:30 Feria`]);
    expect(gapLines()).toEqual(namingTheAfternoon);
  });

  it('carries a reason change to every row of the unit, and keeps the unit together', () => {
    // A unit has ONE reason. Editing one half's reason used to split the unit in two — the seam and
    // the `sigue…` marks gone, the far half still showing the old text.
    const saved = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 8 * 60, reason: 'Puente', today: MON },
      db,
    );

    const patched = patchGap(saved.gap.id, { reason: 'Feria', today: MON }, db);

    expect(gapLines()).toEqual([`${MON} 10:00-14:00 Feria`, `${MON} 15:30-19:30 Feria`]);
    expect(patched.gaps.map((gap) => gap.unitId)).toEqual([saved.gap.unitId, saved.gap.unitId]);
  });

  it('keeps two gaps that TOUCH in different units, whatever their reasons', () => {
    // Reachable in production, and the reason a unit is keyed on data rather than on the reason
    // text: `deleteProject` writes one gap per past row with the SAME composed reason, so a job cut
    // at the comida yesterday leaves two adjacent gaps that must not be drawn — or edited — as one.
    const first = createGap(
      { date: MON, startMinutes: 9 * 60, durationMinutes: 60, reason: 'Avería', today: MON },
      db,
    );
    const second = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: MON },
      db,
    );

    expect(first.gap.unitId).not.toBe(second.gap.unitId);
    // Growing the first one over the second is nobody's reconciliation: the second is its own gap.
    patchGap(first.gap.id, { durationMinutes: 30, today: MON }, db);
    expect(gapLines()).toEqual([`${MON} 09:00-09:30 Avería`, `${MON} 10:00-11:00 Avería`]);
  });

  it('gives one unit id to the gaps a deleted job leaves on one past day', () => {
    // Two halves of one past row are one absence, so they are drawn joined; two different days are
    // two units.
    const barandilla = createProject(
      { name: 'Barandilla', color: GREEN, totalMinutes: 8 * 60, startDate: LAST_FRI, today: MON },
      db,
    );
    expect(listBlocks(db).filter((block) => block.date === LAST_FRI)).toHaveLength(2);

    deleteProject(barandilla.project.id, { today: MON }, db);

    const units = new Set(listGaps(db).map((gap) => gap.unitId));
    expect(listGaps(db)).toHaveLength(2);
    expect(units.size).toBe(1);
  });

  it('refuses an absence written over another absence, naming it', () => {
    // Gaps and blocks are ONE occupancy set, so an absence may not be written over an absence either.
    // Nothing enforced it while a gap could only be typed; a drag makes the collision trivial, and two
    // overlapping absences are indistinguishable from a write-path bug.
    createGap({ date: MON, startMinutes: 9 * 60, durationMinutes: 2 * 60, reason: 'Gestiones', today: MON }, db);

    const overlapping = (): unknown =>
      createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 60, reason: 'Avería', today: MON }, db);

    expect(overlapping).toThrow(AppError);
    try {
      overlapping();
    } catch (error) {
      expect((error as AppError).code).toBe('gap-over-gap');
      // The absence in the way is named by its own clock, so the sentence can point at it.
      expect((error as AppError).details?.startTime).toBe('09:00');
    }
    // Nothing written by the refusal.
    expect(gapLines()).toEqual([`${MON} 09:00-11:00 Gestiones`]);
  });

  it('lets an absence be MOVED onto the clock it already occupies', () => {
    // Its own rows are not obstacles to it: without excluding the unit, every drag of a gap onto a
    // minute overlapping where it already is would refuse itself.
    const saved = createGap(
      { date: MON, startMinutes: 10 * 60, durationMinutes: 2 * 60, reason: 'Feria', today: MON },
      db,
    );
    patchGap(saved.gap.id, { startMinutes: 11 * 60, today: MON }, db);
    expect(gapLines()).toEqual([`${MON} 11:00-13:00 Feria`]);
  });

  it('never stores a gap that straddles a break, over 400 generated writes', () => {
    // The invariant the whole round rests on, asserted where the only public gate is. Every reader of
    // a stored gap adds `start + duration` to get its clock end — correct ONLY while a row sits inside
    // one window — and occupancy never throws, so a write path that regressed here would corrupt
    // placement in silence. A property, not three examples, because the interesting inputs are the
    // ones nobody would think to type: a start inside the comida, a duration longer than the day, a
    // start in a margin.
    const windows = [
      { startMinutes: 7 * 60, endMinutes: 14 * 60 },
      { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
    ];
    const insideOneWindow = (gap: { startMinutes: number; durationMinutes: number }): boolean =>
      windows.some(
        (w) =>
          gap.startMinutes >= w.startMinutes && gap.startMinutes + gap.durationMinutes <= w.endMinutes,
      );

    let seed = 20260819;
    const next = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };

    let written = 0;
    let refused = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const startMinutes = next(96) * 15;
      const durationMinutes = (next(56) + 1) * 15;
      let created;
      try {
        created = createGap({ date: MON, startMinutes, durationMinutes, today: MON }, db);
      } catch (error) {
        // A refusal is a legitimate answer; storing an illegal row is not.
        expect(error).toBeInstanceOf(AppError);
        refused += 1;
        continue;
      }

      for (const row of created.gaps) {
        expect(
          insideOneWindow(row),
          `created ${minutesToHHmm(row.startMinutes)} +${row.durationMinutes}m from ${minutesToHHmm(startMinutes)} +${durationMinutes}m`,
        ).toBe(true);
      }
      // Every row of one write is one absence.
      expect(new Set(created.gaps.map((row) => row.unitId)).size).toBe(1);
      written += 1;

      // And the same must hold after an EDIT, which is the path that used to duplicate rows.
      try {
        const patched = patchGap(created.gap.id, { durationMinutes: (next(56) + 1) * 15, today: MON }, db);
        for (const row of patched.gaps) expect(insideOneWindow(row)).toBe(true);
        expect(listGaps(db).length).toBe(patched.gaps.length);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
      }

      while (listGaps(db).length > 0) deleteGap(listGaps(db)[0].id, { today: MON }, db);
    }

    // The generator has to actually reach both sides of the guard, or the property proves nothing.
    expect(written).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(0);
  });

  // The grid's two gestures, which the form's `edit` is deliberately not: an absence is DRAGGED and
  // RESIZED, and both are frozen in the past where the form is not.
  it('drags the whole unit to the minute it was released on, cut at the comida', () => {
    const saved = createGap(
      { date: MON, startMinutes: 9 * 60, durationMinutes: 4 * 60, reason: 'Avería', today: MON },
      db,
    );

    const moved = patchGap(
      saved.gap.id,
      { action: 'move', date: TUE, startMinutes: 12 * 60, today: MON },
      db,
    );

    // One absence, two rows, one reason — and 4 h of NET time either side of the break.
    expect(gapLines()).toEqual([`${TUE} 12:00-14:00 Avería`, `${TUE} 15:30-17:30 Avería`]);
    expect(moved.gaps.map((row) => row.unitId)).toEqual([saved.gap.unitId, saved.gap.unitId]);
    expect(moved.gap.id).toBe(saved.gap.id);
  });

  it('reads a drag aimed at the comida as the first minute that can hold work', () => {
    // Nothing happens during the break by definition, so the owner accepted that the whole band
    // means 15:30. The GHOST says it before the release; the stored start proves it.
    const saved = createGap({ date: MON, startMinutes: 9 * 60, durationMinutes: 60, today: MON }, db);

    const moved = patchGap(
      saved.gap.id,
      { action: 'move', date: MON, startMinutes: 14 * 60 + 30, today: MON },
      db,
    );

    expect(moved.gap.startMinutes).toBe(15 * 60 + 30);
    expect(gapLines()).toEqual([`${MON} 15:30-16:30`]);
  });

  it('moves the unit whichever of its rows the drag names', () => {
    const saved = createGap(
      { date: MON, startMinutes: 12 * 60, durationMinutes: 4 * 60, reason: 'Feria', today: MON },
      db,
    );
    expect(gapLines()).toHaveLength(2);

    // The afternoon half named: the absence still moves whole, and it is still 4 h.
    patchGap(saved.gaps[1].id, { action: 'move', date: TUE, startMinutes: 8 * 60, today: MON }, db);

    expect(gapLines()).toEqual([`${TUE} 08:00-12:00 Feria`]);
  });

  it('resizes ABSOLUTELY across the comida, and never asks what to do with the hours', () => {
    // No counterparty and no total to protect, so `shrink-needs-choice` cannot happen here: the
    // duration is simply the number the edge was dragged to.
    const saved = createGap(
      { date: MON, startMinutes: 12 * 60, durationMinutes: 60, reason: 'Avería', today: MON },
      db,
    );

    const grown = patchGap(saved.gap.id, { action: 'resize', durationMinutes: 4 * 60, today: MON }, db);
    expect(gapLines()).toEqual([`${MON} 12:00-14:00 Avería`, `${MON} 15:30-17:30 Avería`]);

    // And back: the far half is DELETED rather than left on disk reading as an absence of its own.
    const shrunk = patchGap(grown.gap.id, { action: 'resize', durationMinutes: 30, today: MON }, db);
    expect(gapLines()).toEqual([`${MON} 12:00-12:30 Avería`]);
    expect(shrunk.gaps.map((row) => row.id)).toEqual([saved.gap.id]);
    expect(listGaps(db)).toHaveLength(1);
  });

  it('refuses both gestures on a gap that is already past, and still EDITS it', () => {
    // The past is the record of what the shop did: it is corrected in the form, not dragged.
    const saved = createGap(
      { date: LAST_FRI, startMinutes: 9 * 60, durationMinutes: 60, reason: 'Avería', today: MON },
      db,
    );

    expect(
      refusal(() => patchGap(saved.gap.id, { action: 'move', date: TUE, startMinutes: 8 * 60, today: MON }, db)).code,
    ).toBe('past-gap-frozen');
    expect(
      refusal(() => patchGap(saved.gap.id, { action: 'resize', durationMinutes: 120, today: MON }, db)).code,
    ).toBe('past-gap-frozen');
    expect(gapLines()).toEqual([`${LAST_FRI} 09:00-10:00 Avería`]);

    // The way in is the form, which says nothing about a gesture.
    patchGap(saved.gap.id, { reason: 'Avería torno', durationMinutes: 120, today: MON }, db);
    expect(gapLines()).toEqual([`${LAST_FRI} 09:00-11:00 Avería torno`]);
  });

  it('refuses a gap dragged ONTO a past day', () => {
    const saved = createGap({ date: TUE, startMinutes: 9 * 60, durationMinutes: 60, today: MON }, db);

    const error = refusal(() =>
      patchGap(saved.gap.id, { action: 'move', date: LAST_FRI, startMinutes: 9 * 60, today: MON }, db),
    );

    expect(error.code).toBe('drop-onto-past-day');
    expect(gapLines()).toEqual([`${TUE} 09:00-10:00`]);
  });

  it('pushes unlocked work forward on a drag, and is refused by a padlocked row', () => {
    // The refusals are the ones a gap already had, now reachable from a gesture.
    const puerta = job('Puerta', 4);
    const porton = job('Porton', 2, GREEN);
    setBlockLock(porton.blocks[0].id, true, { today: MON }, db);
    const saved = createGap({ date: TUE, startMinutes: 8 * 60, durationMinutes: 2 * 60, today: MON }, db);

    // Puerta fills 08:00-12:00 and Porton is padlocked at 12:00-14:00: the gap takes the morning
    // and Puerta flows around the lock, exactly as it would for a gap typed into the form.
    patchGap(saved.gap.id, { action: 'move', date: MON, startMinutes: 8 * 60, today: MON }, db);
    expect(calendar()).toEqual([
      `${MON} 10:00-12:00 Puerta`,
      `${MON} 12:00-14:00 Porton [locked]`,
      `${MON} 15:30-17:30 Puerta`,
    ]);

    // And onto the padlocked row it is refused, naming the job, with nothing written.
    const error = refusal(() =>
      patchGap(saved.gap.id, { action: 'move', date: MON, startMinutes: 13 * 60, today: MON }, db),
    );
    expect(error.code).toBe('gap-over-fixed-block');
    expect(error.details).toMatchObject({ projectName: 'Porton', reason: 'locked' });
    expect(gapLines()).toEqual([`${MON} 08:00-10:00`]);
  });

  it('recomposes twice to the same calendar with a segmented gap on the day', () => {
    job('Puerta', 6);
    createGap({ date: MON, startMinutes: 10 * 60, durationMinutes: 6 * 60, reason: 'Feria', today: MON }, db);
    const once = calendar();

    createGap({ date: NEXT_TUE, startMinutes: 8 * 60, durationMinutes: 60, today: MON }, db);
    deleteGap(listGaps(db).find((gap) => gap.date === NEXT_TUE)!.id, { today: MON }, db);

    expect(calendar()).toEqual(once);
    expect(() => assertProjectHours(db)).not.toThrow();
  });
});

describe('settings', () => {
  it('refuses a shift the stored capacity cannot fit, writing nothing at all', () => {
    // Switching the afternoon off against a 10 h capacity is a 400, not a quiet re-cap to 6 h. The
    // settings write and the reflow are one transaction, so a refused save leaves the week untouched.
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
    // A PATCH route passes the fields it did not find as explicit `undefined`, which a spread merge
    // does not skip: this used to wipe `period1Start` and then fail validating it.
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
    // Deleting a job must not rewrite what the shop did, nor pull later work back into the hole.
    const puerta = pastAndFuture();
    job('Barandilla', 4, GREEN, WED);

    const result = deleteProject(puerta.project.id, { today: WED }, db);

    // The worked days keep their shape as gaps; only Wednesday's row goes.
    expect(calendar()).toEqual([`${WED} 08:00-12:00 Barandilla`]);
    expect(gapLines()).toEqual([
      `${MON} 08:00-12:00 Trabajo «Puerta» eliminado`,
      `${TUE} 08:00-12:00 Trabajo «Puerta» eliminado`,
    ]);
    expect(result.preservedGapIds).toHaveLength(2);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('writes the job name into the gap, in the language the owner was reading', () => {
    // COMPOSED AT DELETION TIME: the project row and its blocks are gone a moment later, so there is
    // nothing left to look the name up in. The sentence is frozen in one language; the reason is
    // user data and stays editable.
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

  /** A 12 h job worked Monday and Tuesday and still running today, Wednesday: one row a day. */
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
    // Plannable is the ENGINE's number, so unlocked work does not reduce it; occupancy is
    // `bookedMinutes`.
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

// ---------------------------------------------------------------------------
// Closing days: the mechanism that was wired engine-deep and had no way in
// ---------------------------------------------------------------------------

describe('closing a range of days', () => {
  it('closes the owner`s own week in ONE call and writes one row per day', () => {
    const result = saveAbsence(
      { kind: 'closed-days', from: '2026-09-01', to: '2026-09-04', reason: 'Feria', today: MON },
      db,
    );

    expect(result.dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    expect(listDayOverrides(db).map((day) => `${day.date} ${day.isClosed ? 'closed' : 'open'} ${day.note}`)).toEqual([
      '2026-09-01 closed Feria',
      '2026-09-02 closed Feria',
      '2026-09-03 closed Feria',
      '2026-09-04 closed Feria',
    ]);
  });

  it('skips Saturday and Sunday, and says which days it skipped', () => {
    const result = saveAbsence({ kind: 'closed-days', from: THU, to: NEXT_MON, today: MON }, db);

    expect(result.dates).toEqual([THU, FRI, NEXT_MON]);
    expect(result.skippedDates).toEqual([SAT, SUN]);
  });

  it('empties the closed day and carries its hours forward, buffer untouched', () => {
    job('Nave', 30);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Nave`,
      `${MON} 15:30-19:30 Nave`,
      `${TUE} 08:00-14:00 Nave`,
      `${TUE} 15:30-19:30 Nave`,
      `${WED} 08:00-14:00 Nave`,
      `${WED} 15:30-19:30 Nave`,
    ]);

    saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, reason: 'Feria', today: MON }, db);

    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Nave`,
      `${MON} 15:30-19:30 Nave`,
      `${WED} 08:00-14:00 Nave`,
      `${WED} 15:30-19:30 Nave`,
      `${THU} 08:00-14:00 Nave`,
      `${THU} 15:30-19:30 Nave`,
    ]);
    expect(() => assertProjectHours(db)).not.toThrow();
  });

  it('names the hours it displaced and the day they land on', () => {
    job('Nave', 30);

    const result = saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, today: MON }, db);

    expect(result.displaced).toEqual([
      { projectId: result.displaced[0].projectId, name: 'Nave', minutes: 10 * 60, landsOn: THU },
    ]);
  });

  it('is refused, writing nothing, when the day holds a row the engine cannot move', () => {
    const puerta = job('Puerta', 4);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    const error = refusal(() =>
      saveAbsence({ kind: 'closed-days', from: MON, to: WED, reason: 'Feria', today: MON }, db),
    );

    expect(error.code).toBe('closed-day-over-fixed-block');
    // Its own sentence, about the DAY: reusing the gap's said «ese hueco pisa…» about a closed day.
    expect(error.messageKey).toBe('errors.closedDayOverLockedBlock');
    expect(error.details?.projectName).toBe('Puerta');
    // The whole range rolls back, Wednesday included: one gesture, one transaction.
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('rolls the whole range back when the hours no longer fit the horizon', () => {
    updateSettings({ planningHorizonWeeks: 2 }, { today: MON }, db);
    job('Nave', 70);
    const before = calendar();

    const error = refusal(() =>
      saveAbsence({ kind: 'closed-days', from: MON, to: WED, today: MON }, db),
    );

    expect(error.code).toBe('horizon-exceeded');
    // Nothing on disk: the overrides used to survive the failed reflow, and every later write
    // answered the same 409 — including the deletion of the job that would not fit.
    expect(listDayOverrides(db)).toEqual([]);
    expect(calendar()).toEqual(before);
    expect(() => assertProjectHours(db)).not.toThrow();
    // And a close that DOES fit still goes through afterwards.
    expect(saveAbsence({ kind: 'closed-days', from: WED, to: WED, today: MON }, db).dates).toEqual([WED]);
  });

  it('reopens the days it closed and lets the queue fill them again', () => {
    job('Nave', 30);
    saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, today: MON }, db);
    expect(calendar()).not.toContain(`${TUE} 08:00-14:00 Nave`);

    const reopened = reopenDays({ from: MON, to: FRI, today: MON }, db);

    expect(reopened.dates).toEqual([TUE]);
    expect(listDayOverrides(db)).toEqual([]);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Nave`,
      `${MON} 15:30-19:30 Nave`,
      `${TUE} 08:00-14:00 Nave`,
      `${TUE} 15:30-19:30 Nave`,
      `${WED} 08:00-14:00 Nave`,
      `${WED} 15:30-19:30 Nave`,
    ]);
  });

  it('keeps a hand-entered capacity when it closes and when it reopens', () => {
    upsertDayOverride({ date: TUE, isClosed: false, capacityHours: 4, note: undefined }, db);

    saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, reason: 'Feria', today: MON }, db);
    expect(listDayOverrides(db)[0]).toMatchObject({ isClosed: true, capacityHours: 4, note: 'Feria' });

    reopenDays({ from: TUE, to: TUE, today: MON }, db);
    expect(listDayOverrides(db)[0]).toMatchObject({ isClosed: false, capacityHours: 4 });
  });

  it('reports the day as closed to the week view, with its note', () => {
    saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, reason: 'Feria', today: MON }, db);

    const day = readWeek(MON, { today: MON }, db).days[1];

    expect(day.isClosed).toBe(true);
    expect(day.note).toBe('Feria');
    expect(day.plannableMinutes).toBe(0);
  });
});

describe('a range of gaps', () => {
  it('writes the same absence on every day of the range, cut at the comida', () => {
    const result = saveAbsence(
      {
        kind: 'gap',
        from: MON,
        to: WED,
        startMinutes: 13 * 60,
        durationMinutes: 3 * 60,
        reason: 'Gestiones',
        today: MON,
      },
      db,
    );

    expect(gapLines()).toEqual([
      `${MON} 13:00-14:00 Gestiones`,
      `${MON} 15:30-17:30 Gestiones`,
      `${TUE} 13:00-14:00 Gestiones`,
      `${TUE} 15:30-17:30 Gestiones`,
      `${WED} 13:00-14:00 Gestiones`,
      `${WED} 15:30-17:30 Gestiones`,
    ]);
    // Two rows a day, and each day is ONE absence.
    expect(new Set(result.gaps.map((gap) => gap.unitId)).size).toBe(3);
  });

  it('is refused as a whole when one day of it is held by a padlocked row', () => {
    const puerta = job('Puerta', 4);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    const error = refusal(() =>
      saveAbsence(
        { kind: 'gap', from: LAST_FRI, to: TUE, startMinutes: 9 * 60, durationMinutes: 60, today: MON },
        db,
      ),
    );

    expect(error.messageKey).toBe('errors.gapOverLockedBlock');
    expect(listGaps(db)).toEqual([]);
  });
});

describe('the absence preview', () => {
  it('answers what the save will do and writes nothing at all', () => {
    job('Nave', 30);

    const preview = previewAbsence({ kind: 'closed-days', from: TUE, to: TUE, today: MON }, db);

    expect(preview.dates).toEqual([TUE]);
    expect(preview.displaced).toEqual([
      { projectId: preview.displaced[0].projectId, name: 'Nave', minutes: 10 * 60, landsOn: THU },
    ]);
    expect(preview.lastOccupiedBefore).toBe(WED);
    expect(preview.lastOccupiedAfter).toBe(THU);
    // Nothing was written: no override, and the calendar is untouched.
    expect(listDayOverrides(db)).toEqual([]);
    expect(calendar()).toEqual([
      `${MON} 08:00-14:00 Nave`,
      `${MON} 15:30-19:30 Nave`,
      `${TUE} 08:00-14:00 Nave`,
      `${TUE} 15:30-19:30 Nave`,
      `${WED} 08:00-14:00 Nave`,
      `${WED} 15:30-19:30 Nave`,
    ]);
  });

  it('draws the rows a painted gap would be stored as, and writes nothing', () => {
    const preview = previewAbsence(
      { kind: 'gap', from: WED, to: WED, startMinutes: 13 * 60, durationMinutes: 3 * 60, today: MON },
      db,
    );

    expect(preview.rows).toEqual([
      { date: WED, startMinutes: 13 * 60, durationMinutes: 60 },
      { date: WED, startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 },
    ]);
    expect(listGaps(db)).toEqual([]);
  });

  it('refuses exactly as the save would, so the screen never offers an impossible save', () => {
    const puerta = job('Puerta', 4);
    setBlockLock(puerta.blocks[0].id, true, { today: MON }, db);

    const error = refusal(() =>
      previewAbsence({ kind: 'closed-days', from: MON, to: MON, today: MON }, db),
    );

    expect(error.code).toBe('closed-day-over-fixed-block');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('says which days of the range are already closed', () => {
    saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, reason: 'Feria', today: MON }, db);

    const preview = previewAbsence({ kind: 'closed-days', from: MON, to: WED, today: MON }, db);

    expect(preview.alreadyClosedDates).toEqual([TUE]);
  });

  it('refuses a range that runs backwards, and one longer than the cap', () => {
    // Two different mistakes, two codes: one sentence for both left an uninterpolated `{{maxDays}}`
    // on screen, because a backwards range has no day limit to name.
    expect(refusal(() => previewAbsence({ kind: 'closed-days', from: WED, to: MON }, db)).code).toBe(
      'range-backwards',
    );
    expect(
      refusal(() => previewAbsence({ kind: 'closed-days', from: MON, to: '2027-08-10' }, db)).code,
    ).toBe('invalid-range');
  });
});

describe('a closed day is as literal as a weekend', () => {
  it('keeps a row dropped on it, padlocked, instead of ranking it into the next open day', () => {
    const puerta = job('Puerta', 2);
    saveAbsence({ kind: 'closed-days', from: THU, to: THU, reason: 'Feria', today: MON }, db);

    const result = moveBlock(puerta.blocks[0].id, { date: THU, startMinutes: 9 * 60, today: MON }, db);

    // Before the fix the drop was read as a queue RANK — the row came back on the next Monday,
    // unlocked, with no refusal and nothing said.
    expect(calendar()).toEqual([`${THU} 09:00-11:00 Puerta [locked]`]);
    expect(result.block?.locked).toBe(true);
  });

  it('never auto-recovers it: the padlock is what holds it there', () => {
    const puerta = job('Puerta', 2);
    saveAbsence({ kind: 'closed-days', from: THU, to: THU, today: MON }, db);
    moveBlock(puerta.blocks[0].id, { date: THU, startMinutes: 9 * 60, today: MON }, db);

    job('Barandilla', 4, GREEN);

    expect(calendar()).toEqual([`${MON} 08:00-12:00 Barandilla`, `${THU} 09:00-11:00 Puerta [locked]`]);
  });
});
