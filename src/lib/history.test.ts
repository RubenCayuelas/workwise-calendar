/**
 * The undo timeline as a MECHANISM: a line of calendar states with a cursor, one step per
 * request that changed something. That each operation records the right step, and that a
 * settings save empties the line, is specified in `operations.test.ts`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from './db';
import {
  CAPTURED_TABLES,
  MAX_HISTORY_STEPS,
  readHistoryState,
  redoNext,
  restartHistory,
  undoLast,
  withHistory,
} from './history';
import { AppError } from './errors';
import { assertProjectHours } from './scheduler';
import { deleteBlock, insertBlock, listBlocks, updateBlock } from './repositories/blocks';
import { deleteProject, insertProject, listProjects, updateProject } from './repositories/projects';
import { insertGap, listGaps } from './repositories/gaps';
import { upsertDayOverride } from './repositories/dayOverrides';
import {
  deleteBlock as deleteBlockRow,
  moveBlock,
  resizeBlock,
  setBlockLock,
  splitBlock,
} from './operations/blocks';
import { createProject, deleteProject as deleteProjectRow, patchProject } from './operations/projects';
import { createGap, deleteGap } from './operations/gaps';
import { reopenDays, saveAbsence } from './operations/absences';
import { PROJECT_COLORS } from './projectColors';
import { hhmmToMinutes } from './dates';
import { FRI, LAST_FRI, MON, NEXT_MON, SAT, SUN, THU, TUE, WED } from '../testing/fixtures';

const t = hhmmToMinutes;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

// --- fixtures -------------------------------------------------------------

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, '0')}`;
}

/** A job with one block, written OUTSIDE the timeline: the calendar the session starts with. */
function seedJob(name: string, date = MON, startMinutes = t('08:00'), minutes = 120): {
  projectId: string;
  blockId: string;
} {
  const projectId = id('p');
  const blockId = id('b');
  insertProject({ id: projectId, name, color: PROJECT_COLORS[0], totalMinutes: minutes }, db);
  insertBlock({ id: blockId, projectId, date, startMinutes, durationMinutes: minutes, locked: false }, db);
  return { projectId, blockId };
}

/** Every stored row, exactly as SQLite holds it — timestamps and ids included. */
function rawRows(): unknown[] {
  return [
    db.prepare('SELECT * FROM projects ORDER BY id').all(),
    db.prepare('SELECT * FROM blocks ORDER BY id').all(),
    db.prepare('SELECT * FROM gaps ORDER BY id').all(),
    db.prepare('SELECT * FROM day_overrides ORDER BY date').all(),
  ];
}

function calendar(): string[] {
  return listBlocks(db).map(
    (block) => `${block.date} ${block.startMinutes} +${block.durationMinutes}${block.locked ? ' [locked]' : ''}`,
  );
}

function depth(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n;
}

// --- the mechanism --------------------------------------------------------

describe('a step restores the rows exactly as they were', () => {
  it('gives back the id, the timestamps and the queue order, not an equivalent row', () => {
    const { blockId } = seedJob('Railing');
    // Stamped by hand, and NOT with `now`: CURRENT_TIMESTAMP has one-second resolution and this
    // test runs in milliseconds, so a restore that re-stamped every row would produce the same
    // strings and the assertion below would pass while proving nothing. (Setting a DIFFERENT value
    // leaves the updated_at trigger alone, which is the same latitude the restore relies on.)
    db.prepare("UPDATE projects SET created_at = '2020-01-02 03:04:05', updated_at = '2020-01-02 03:04:06'").run();
    db.prepare("UPDATE blocks SET created_at = '2020-01-02 03:04:07', updated_at = '2020-01-02 03:04:08'").run();
    const before = rawRows();

    withHistory(db, { kind: 'block.move', blockId }, () => {
      deleteBlock(blockId, db);
      insertBlock(
        { id: id('b'), projectId: listProjects(db)[0].id, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: true },
        db,
      );
    });
    expect(calendar()).toEqual([`${TUE} ${t('09:00')} +120 [locked]`]);

    const outcome = undoLast(db);

    expect(outcome.changed).toBe(true);
    // The whole point: a re-INSERT through the repositories would stamp created_at with now
    // and change the queue's tiebreak.
    expect(rawRows()).toEqual(before);
  });

  it('names the day the restore touched, so the week can be shown', () => {
    const { blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });

    expect(undoLast(db).focusDate).toBe(MON);
  });
});

describe('what earns a step', () => {
  it('records one step for a request that changed something', () => {
    const { blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.lock', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: true }, db);
    });

    // The floor plus the step: the first step of a timeline needs the state it started from.
    expect(depth()).toBe(2);
    expect(readHistoryState(db).undo).toEqual({ kind: 'block.lock', args: { name: 'Railing' } });
  });

  it('records nothing when the request changed nothing the owner can see', () => {
    const { blockId } = seedJob('Railing');
    // The same placement rewritten: the updated_at trigger fires and nothing else moves.
    withHistory(db, { kind: 'block.resize', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: false }, db);
    });

    expect(depth()).toBe(0);
    expect(readHistoryState(db).undo).toBeNull();
  });

  it('records nothing when the work throws, because the transaction took the row with it', () => {
    const { blockId } = seedJob('Railing');
    const before = rawRows();

    expect(() =>
      withHistory(db, { kind: 'block.delete', blockId }, () => {
        deleteBlock(blockId, db);
        throw new Error('refused');
      }),
    ).toThrow('refused');

    expect(depth()).toBe(0);
    expect(rawRows()).toEqual(before);
  });
});

describe('walking the line', () => {
  it('goes back and forward through several steps', () => {
    const { projectId, blockId } = seedJob('Railing');
    const move = (date: string, startMinutes: number): void => {
      withHistory(db, { kind: 'block.move', blockId }, () => {
        updateBlock({ id: blockId, projectId, date, startMinutes, durationMinutes: 120, locked: false }, db);
      });
    };

    move(TUE, t('09:00'));
    move(TUE, t('11:00'));
    move(MON, t('15:30'));
    expect(calendar()).toEqual([`${MON} ${t('15:30')} +120`]);

    expect(undoLast(db).changed).toBe(true);
    expect(calendar()).toEqual([`${TUE} ${t('11:00')} +120`]);
    expect(undoLast(db).changed).toBe(true);
    expect(calendar()).toEqual([`${TUE} ${t('09:00')} +120`]);
    expect(undoLast(db).changed).toBe(true);
    expect(calendar()).toEqual([`${MON} ${t('08:00')} +120`]);

    // The floor is restorable, not undoable.
    expect(undoLast(db).changed).toBe(false);
    expect(readHistoryState(db).undo).toBeNull();

    expect(redoNext(db).changed).toBe(true);
    expect(calendar()).toEqual([`${TUE} ${t('09:00')} +120`]);
    expect(redoNext(db).changed).toBe(true);
    expect(redoNext(db).changed).toBe(true);
    expect(calendar()).toEqual([`${MON} ${t('15:30')} +120`]);
    expect(redoNext(db).changed).toBe(false);
  });

  it('drops the redo tail when a new mutation arrives after an undo', () => {
    const { projectId, blockId } = seedJob('Railing');
    const move = (date: string, startMinutes: number): void => {
      withHistory(db, { kind: 'block.move', blockId }, () => {
        updateBlock({ id: blockId, projectId, date, startMinutes, durationMinutes: 120, locked: false }, db);
      });
    };

    move(TUE, t('09:00'));
    move(TUE, t('11:00'));
    undoLast(db);
    expect(readHistoryState(db).redo).not.toBeNull();

    move(MON, t('19:00'));

    expect(readHistoryState(db).redo).toBeNull();
    expect(redoNext(db).changed).toBe(false);
    expect(calendar()).toEqual([`${MON} ${t('19:00')} +120`]);
  });

  it('says nothing to undo on a line that has never been written to', () => {
    seedJob('Railing');
    expect(readHistoryState(db)).toEqual({ undo: null, redo: null, clearedBySettings: false });
    expect(undoLast(db)).toEqual({ changed: false, step: null, focusDate: null, drifted: false });
    expect(redoNext(db)).toEqual({ changed: false, step: null, focusDate: null, drifted: false });
  });
});

describe('the depth', () => {
  it(`keeps ${MAX_HISTORY_STEPS} undoable steps and forgets the oldest`, () => {
    const { projectId, blockId } = seedJob('Railing');
    for (let step = 1; step <= MAX_HISTORY_STEPS + 10; step += 1) {
      withHistory(db, { kind: 'block.resize', blockId }, () => {
        updateBlock({ id: blockId, projectId, date: MON, startMinutes: t('08:00'), durationMinutes: 15 * step, locked: false }, db);
        updateProject(projectId, { totalMinutes: 15 * step }, db);
      });
    }

    expect(depth()).toBe(MAX_HISTORY_STEPS + 1);
    let undone = 0;
    while (undoLast(db).changed) undone += 1;
    expect(undone).toBe(MAX_HISTORY_STEPS);
  });
});

describe('the label', () => {
  it('still names a job the step deleted', () => {
    const { projectId } = seedJob('Railing');
    withHistory(db, { kind: 'project.delete', projectId }, () => {
      deleteProject(projectId, db);
    });
    expect(listProjects(db)).toEqual([]);

    expect(readHistoryState(db).undo).toEqual({
      kind: 'project.delete',
      args: { name: 'Railing' },
    });
    expect(undoLast(db).step).toEqual({ kind: 'project.delete', args: { name: 'Railing' } });
    expect(listProjects(db).map((project) => project.name)).toEqual(['Railing']);
  });

  it('carries no name for an absence, which is not a job', () => {
    insertGap({ id: id('g'), date: MON, startMinutes: t('10:00'), durationMinutes: 60 }, db);
    withHistory(db, { kind: 'gap.create' }, () => {
      insertGap({ id: id('g'), date: TUE, startMinutes: t('10:00'), durationMinutes: 60, reason: 'Breakdown' }, db);
    });

    expect(readHistoryState(db).undo).toEqual({ kind: 'gap.create', args: {} });
    undoLast(db);
    expect(listGaps(db).map((gap) => gap.date)).toEqual([MON]);
  });
});

describe('what a state has to hold', () => {
  it('carries every column of every table it is responsible for', () => {
    for (const { table, columns } of CAPTURED_TABLES) {
      const stored = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      // A column added to the schema and not added here is captured by nothing, so every restore
      // resets it to its default with nothing said.
      expect(columns.split(',').map((column) => column.trim()), table).toEqual(stored);
    }
  });

  it('tells two writes apart even when the free text swaps a separator', () => {
    const projectId = id('p');
    insertProject(
      { id: projectId, name: 'Door', description: '2 leaves|steel', color: PROJECT_COLORS[0], totalMinutes: 120 },
      db,
    );
    insertBlock({ id: id('b'), projectId, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: false }, db);

    // Joined with a bare `|`, `Door` + `2 leaves|steel` and `Door|2 leaves` + `steel` are the SAME
    // string, so this edit earned no step — and the next undo then reverted the gesture before it,
    // deleting the job.
    withHistory(db, { kind: 'project.update', projectId }, () => {
      updateProject(projectId, { name: 'Door|2 leaves', description: 'steel' }, db);
    });

    expect(readHistoryState(db).undo).toEqual({
      kind: 'project.update',
      args: { name: 'Door' },
    });
    expect(undoLast(db).changed).toBe(true);
    expect(listProjects(db).map((project) => [project.name, project.description])).toEqual([
      ['Door', '2 leaves|steel'],
    ]);
  });
});

describe('a calendar that moved outside the line', () => {
  it('is never clobbered: the line is emptied and the request says so', () => {
    const { projectId, blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });

    // Something wrote without going through the timeline: a hand-edited file, a second process.
    insertGap({ id: id('g'), date: MON, startMinutes: t('10:00'), durationMinutes: 60 }, db);
    const before = rawRows();

    const outcome = undoLast(db);

    expect(outcome).toEqual({ changed: false, step: null, focusDate: null, drifted: true });
    expect(rawRows()).toEqual(before);
    expect(readHistoryState(db).undo).toBeNull();
  });

  it('is not clobbered by a LATER undo either: the next write starts a new line', () => {
    const { projectId, blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });

    // Something wrote without going through the line...
    insertGap({ id: id('g'), date: MON, startMinutes: t('10:00'), durationMinutes: 60 }, db);
    // ...and then an ordinary gesture followed it. Checking for drift only at restore time caught
    // this for exactly one gesture: afterwards the cursor matched the disk again, and undoing that
    // gesture deleted the foreign absence with `drifted: false` and nothing said.
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: MON, startMinutes: t('15:30'), durationMinutes: 120, locked: false }, db);
    });

    const outcome = undoLast(db);

    expect(outcome.changed).toBe(true);
    expect(outcome.drifted).toBe(false);
    // The gesture is undone — back to where the first step left it — and the absence the line never
    // saw is still there.
    expect(calendar()).toEqual([`${TUE} ${t('09:00')} +120`]);
    expect(listGaps(db).map((gap) => gap.date)).toEqual([MON]);
    // And there is nothing further back: the drifted write floored a new line.
    expect(readHistoryState(db).undo).toBeNull();
  });
});

describe('a settings save starts a new line', () => {
  it('leaves nothing to undo, and says why', () => {
    const { projectId, blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });
    expect(readHistoryState(db).undo).not.toBeNull();

    restartHistory(db);

    expect(readHistoryState(db)).toEqual({ undo: null, redo: null, clearedBySettings: true });
    expect(undoLast(db).changed).toBe(false);
    // And the floor is the calendar as the save left it, so the next step can come back to it.
    expect(calendar()).toEqual([`${TUE} ${t('09:00')} +120`]);
  });

  it('is the floor the next step comes back to', () => {
    const { projectId, blockId } = seedJob('Railing');
    restartHistory(db);
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });

    expect(undoLast(db).changed).toBe(true);
    expect(calendar()).toEqual([`${MON} ${t('08:00')} +120`]);
    // And back at the floor the reason still holds: there is nothing further to undo BECAUSE
    // the settings save is where the line begins.
    expect(readHistoryState(db)).toEqual({
      undo: null,
      redo: { kind: 'block.move', args: { name: 'Railing' } },
      clearedBySettings: true,
    });
  });
});

describe('a closed day is calendar too', () => {
  it('comes back with its note', () => {
    withHistory(db, { kind: 'absence.closeDays' }, () => {
      upsertDayOverride({ date: MON, isClosed: true, capacityHours: null, note: 'Fair' }, db);
    });

    expect(undoLast(db).changed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM day_overrides').get()).toEqual({ n: 0 });

    expect(redoNext(db).changed).toBe(true);
    expect(db.prepare('SELECT date, is_closed, note FROM day_overrides').all()).toEqual([
      { date: MON, is_closed: 1, note: 'Fair' },
    ]);
  });
});

describe('what the line never holds', () => {
  it('leaves settings and the applied data migrations alone', () => {
    const { projectId, blockId } = seedJob('Railing');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });
    const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const migrations = db.prepare('SELECT name FROM data_migrations ORDER BY name').all();

    undoLast(db);

    expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(settings);
    expect(db.prepare('SELECT name FROM data_migrations ORDER BY name').all()).toEqual(migrations);
  });

  it('is emptied when the database is opened, so a line lasts one run of the app', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-history-'));
    const file = path.join(directory, 'calendar.db');

    const first = openDatabase(file);
    insertProject({ id: id('p'), name: 'Railing', color: PROJECT_COLORS[0], totalMinutes: 120 }, first);
    const projectId = listProjects(first)[0].id;
    const blockId = id('b');
    insertBlock({ id: blockId, projectId, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: false }, first);
    withHistory(first, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, first);
    });
    expect((first.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n).toBe(2);
    first.close();

    const second = openDatabase(file);
    expect((second.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n).toBe(0);
    // The calendar itself is untouched: only the line it could be walked back along is gone.
    expect(listBlocks(second).map((block) => block.date)).toEqual([TUE]);
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The property: every generated session walks back to where it started
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every mutable row as SQLite holds it. This exact comparison is what the property is about. */
function stateOf(handle: Db): unknown {
  return [
    handle.prepare('SELECT * FROM projects ORDER BY id').all(),
    handle.prepare('SELECT * FROM blocks ORDER BY id').all(),
    handle.prepare('SELECT * FROM gaps ORDER BY id').all(),
    handle.prepare('SELECT * FROM day_overrides ORDER BY date').all(),
  ];
}

/**
 * The calendar as the OWNER sees it: no ids, no timestamps. The two ENDS of a walk are compared
 * this way and the stops in between exactly, because a gesture whose reflow recreates the same
 * rows with new ids changes nothing visible and so earns no step — after it the raw rows differ
 * from the cursor's while the calendar does not.
 */
function visibleOf(handle: Db): string[] {
  const names = new Map(listProjects(handle).map((project) => [project.id, project.name]));
  return [
    ...listProjects(handle).map(
      (project) => `P|${project.name}|${project.color}|${project.totalMinutes}`,
    ),
    ...listBlocks(handle).map(
      (block) =>
        `B|${names.get(block.projectId) ?? '?'}|${block.date}|${block.startMinutes}|${block.durationMinutes}|${block.locked}`,
    ),
    ...listGaps(handle).map(
      (gap) => `G|${gap.date}|${gap.startMinutes}|${gap.durationMinutes}|${gap.reason ?? ''}`,
    ),
    ...(
      handle.prepare('SELECT date, is_closed, note FROM day_overrides').all() as {
        date: string;
        is_closed: number;
        note: string | null;
      }[]
    ).map((row) => `D|${row.date}|${row.is_closed}|${row.note ?? ''}`),
  ].sort();
}

/** Where the cursor sits; -1 on an empty line. */
function cursorSeq(handle: Db): number {
  const row = handle.prepare('SELECT MAX(seq) AS seq FROM history WHERE undone = 0').get() as {
    seq: number | null;
  };
  return row.seq ?? -1;
}

const GENERATED_DAYS = [LAST_FRI, MON, TUE, WED, THU, FRI, SAT, SUN, NEXT_MON];
const GENERATED_NAMES = ['Staircase', 'Shutter', 'Railing', 'Gate'];

/** The gestures the generator draws from. The name is what the per-case guard counts. */
const GESTURES = [
  'project.create',
  'block.move',
  'block.resize',
  'block.lock',
  'block.split',
  'block.delete',
  'project.update',
  'project.delete',
  'gap.create',
  'gap.delete',
  'absence',
] as const;

type Gesture = (typeof GESTURES)[number];

/**
 * A calendar for the session to mutate. Without it the generator was drawing block and project
 * gestures against an empty database and returning from its own guards: measured, 77% of the
 * mutations were no-ops, so the property was mostly walking lines built from creations — never the
 * reflowed multi-job calendar a restore that does not recompose is actually risky on.
 */
function seedSession(handle: Db, random: () => number, recorded: () => void): void {
  const jobs = 1 + Math.floor(random() * 3);
  for (let job = 0; job < jobs; job += 1) {
    createProject(
      {
        name: `${GENERATED_NAMES[job % GENERATED_NAMES.length]} ${job}`,
        color: PROJECT_COLORS[job % PROJECT_COLORS.length],
        totalMinutes: (1 + Math.floor(random() * 7)) * 60,
        today: MON,
      },
      handle,
    );
    recorded();
  }
}

/**
 * One gesture, chosen at random and aimed at whatever the calendar happens to hold. Returns which
 * one it was, so the guard below can see that each is really running. A refusal is a legitimate
 * outcome and is thrown to the caller, which asserts it wrote nothing.
 *
 * `updateSettings` is deliberately absent — it EMPTIES the line by design, which is a different
 * property and has its own test above.
 */
function mutateAtRandom(handle: Db, random: () => number, step: number): Gesture | null {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const blocks = listBlocks(handle);
  const gaps = listGaps(handle);
  const projects = listProjects(handle);
  const block = blocks.length === 0 ? undefined : pick(blocks);
  const today = MON;
  const gesture = GESTURES[Math.floor(random() * GESTURES.length)];

  switch (gesture) {
    case 'project.create':
      createProject(
        {
          name: `${pick(GENERATED_NAMES)} ${step}`,
          color: pick(PROJECT_COLORS),
          totalMinutes: (1 + Math.floor(random() * 8)) * 60,
          today,
        },
        handle,
      );
      return gesture;
    case 'block.move':
      if (block === undefined) return null;
      moveBlock(block.id, { date: pick(GENERATED_DAYS), startMinutes: t('08:00') + Math.floor(random() * 20) * 30, today }, handle);
      return gesture;
    case 'block.resize':
      if (block === undefined) return null;
      resizeBlock(block.id, { durationMinutes: (1 + Math.floor(random() * 8)) * 30, today }, handle);
      return gesture;
    case 'block.lock':
      if (block === undefined) return null;
      setBlockLock(block.id, !block.locked, { today }, handle);
      return gesture;
    case 'block.split':
      if (block === undefined) return null;
      splitBlock(
        block.id,
        { durationMinutes: 30, date: pick(GENERATED_DAYS), startMinutes: t('10:00'), today },
        handle,
      );
      return gesture;
    case 'block.delete':
      if (block === undefined) return null;
      deleteBlockRow(block.id, { today }, handle);
      return gesture;
    case 'project.update':
      if (projects.length === 0) return null;
      patchProject(pick(projects).id, { totalMinutes: (1 + Math.floor(random() * 10)) * 60, today }, handle);
      return gesture;
    case 'project.delete':
      if (projects.length === 0) return null;
      deleteProjectRow(pick(projects).id, { today }, handle);
      return gesture;
    case 'gap.create':
      createGap(
        {
          date: pick(GENERATED_DAYS),
          startMinutes: t('08:00') + Math.floor(random() * 16) * 30,
          durationMinutes: (1 + Math.floor(random() * 4)) * 30,
          reason: 'Breakdown',
          today,
        },
        handle,
      );
      return gesture;
    case 'gap.delete':
      if (gaps.length === 0) return null;
      deleteGap(pick(gaps).id, { today }, handle);
      return gesture;
    default: {
      const from = pick(GENERATED_DAYS);
      if (random() < 0.5) saveAbsence({ kind: 'closed-days', from, reason: 'Fair', today }, handle);
      else reopenDays({ from, today }, handle);
      return 'absence';
    }
  }
}

/**
 * Chosen deliberately, not by what the timeout allows: each session opens and migrates a database
 * and every gesture runs a full reflow, so this is the count that keeps the file well inside the
 * 30 s per-test budget on a slower machine while still exercising every gesture hundreds of times.
 */
const SESSIONS = 500;
const STEPS_PER_SESSION = 8;

describe('the line holds over generated sessions', () => {
  it(`walks ${SESSIONS} of them back to where they started, and forward again`, () => {
    for (let seed = 1; seed <= SESSIONS; seed += 1) {
      const handle = openDatabase(':memory:');
      try {
        const random = seededRandom(seed);
        const where = `seed ${seed}`;
        // Keyed on the cursor the state belongs to, so every stop on the way back is checked
        // and not only the two ends.
        const states = new Map<number, unknown>([[0, stateOf(handle)]]);
        const startVisible = visibleOf(handle);
        const remember = (): void => {
          states.set(cursorSeq(handle), stateOf(handle));
        };
        // The seed jobs are steps like any other, so the walk back covers them too and ends on the
        // empty floor. What they buy is the rest of the session: a calendar for the block and
        // project gestures to aim at.
        seedSession(handle, random, remember);

        for (let step = 0; step < STEPS_PER_SESSION; step += 1) {
          const before = stateOf(handle);
          const cursorBefore = cursorSeq(handle);
          try {
            mutateAtRandom(handle, random, step);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            // A refusal writes nothing — the rule the whole data layer is built on.
            expect(stateOf(handle), `${where}: a refusal wrote something`).toEqual(before);
            expect(cursorSeq(handle), `${where}: a refusal left a step`).toBe(cursorBefore);
            continue;
          }
          const cursor = cursorSeq(handle);
          if (cursor !== cursorBefore) states.set(cursor, stateOf(handle));
          expect(() => assertProjectHours(handle), `${where}: hours not conserved`).not.toThrow();
        }

        const endVisible = visibleOf(handle);
        const top = cursorSeq(handle);

        let walked = 0;
        while (undoLast(handle).changed) {
          walked += 1;
          const cursor = cursorSeq(handle);
          expect(stateOf(handle), `${where}: undo to ${cursor} did not restore it`).toEqual(
            states.get(cursor),
          );
          expect(() => assertProjectHours(handle), `${where}: undo broke the hours`).not.toThrow();
        }
        expect(visibleOf(handle), `${where}: the walk back missed the floor`).toEqual(startVisible);
        expect(walked, `${where}: walked ${walked} steps back out of ${top}`).toBe(Math.max(top, 0));

        while (redoNext(handle).changed) {
          const cursor = cursorSeq(handle);
          expect(stateOf(handle), `${where}: redo to ${cursor} did not restore it`).toEqual(
            states.get(cursor),
          );
        }
        expect(visibleOf(handle), `${where}: the walk forward missed the end`).toEqual(endVisible);
      } finally {
        handle.close();
        closeDb();
      }
    }
  });

  it('generates the sessions these properties are about, gesture by gesture', () => {
    let steps = 0;
    let refusals = 0;
    let skipped = 0;
    const ran = new Map<Gesture, number>(GESTURES.map((gesture) => [gesture, 0]));

    for (let seed = 1; seed <= SESSIONS; seed += 1) {
      const handle = openDatabase(':memory:');
      try {
        const random = seededRandom(seed);
        seedSession(handle, random, () => {});
        for (let step = 0; step < STEPS_PER_SESSION; step += 1) {
          const cursorBefore = cursorSeq(handle);
          let gesture: Gesture | null;
          try {
            gesture = mutateAtRandom(handle, random, step);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            refusals += 1;
            continue;
          }
          if (gesture === null) {
            skipped += 1;
            continue;
          }
          ran.set(gesture, (ran.get(gesture) ?? 0) + 1);
          if (cursorSeq(handle) !== cursorBefore) steps += 1;
        }
      } finally {
        handle.close();
        closeDb();
      }
    }

    // PER GESTURE, not in aggregate. Counting only totals hid that the block and project gestures
    // were returning from their own guards on an empty calendar: the three that need no calendar
    // satisfied both totals on their own, so a generator whose block gestures never ran once would
    // still have passed.
    for (const gesture of GESTURES) {
      expect(ran.get(gesture), `${gesture} never ran`).toBeGreaterThan(SESSIONS / 20);
    }
    expect(steps, 'too few writes actually changed anything').toBeGreaterThan(SESSIONS * 2);
    expect(refusals, 'the refusal path is never exercised').toBeGreaterThan(20);
    // The guards above are only meaningful while the generator is not mostly aiming at nothing.
    expect(skipped, 'most draws still hit their own guard').toBeLessThan(SESSIONS);
  });
});
