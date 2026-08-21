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
  MAX_HISTORY_STEPS,
  readHistoryState,
  redoNext,
  restartHistory,
  undoLast,
  withHistory,
} from './history';
import { deleteBlock, insertBlock, listBlocks, updateBlock } from './repositories/blocks';
import { deleteProject, insertProject, listProjects, updateProject } from './repositories/projects';
import { insertGap, listGaps } from './repositories/gaps';
import { upsertDayOverride } from './repositories/dayOverrides';
import { PROJECT_COLORS } from './projectColors';
import { hhmmToMinutes } from './dates';

const MON = '2026-08-10';
const TUE = '2026-08-11';
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
    const { blockId } = seedJob('Barandilla');
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
    const { blockId } = seedJob('Barandilla');
    withHistory(db, { kind: 'block.move', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: TUE, startMinutes: t('09:00'), durationMinutes: 120, locked: false }, db);
    });

    expect(undoLast(db).focusDate).toBe(MON);
  });
});

describe('what earns a step', () => {
  it('records one step for a request that changed something', () => {
    const { blockId } = seedJob('Barandilla');
    withHistory(db, { kind: 'block.lock', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: true }, db);
    });

    // The floor plus the step: the first step of a timeline needs the state it started from.
    expect(depth()).toBe(2);
    expect(readHistoryState(db).undo).toEqual({ kind: 'block.lock', args: { name: 'Barandilla' } });
  });

  it('records nothing when the request changed nothing the owner can see', () => {
    const { blockId } = seedJob('Barandilla');
    // The same placement rewritten: the updated_at trigger fires and nothing else moves.
    withHistory(db, { kind: 'block.resize', blockId }, () => {
      updateBlock({ id: blockId, projectId: listProjects(db)[0].id, date: MON, startMinutes: t('08:00'), durationMinutes: 120, locked: false }, db);
    });

    expect(depth()).toBe(0);
    expect(readHistoryState(db).undo).toBeNull();
  });

  it('records nothing when the work throws, because the transaction took the row with it', () => {
    const { blockId } = seedJob('Barandilla');
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
    const { projectId, blockId } = seedJob('Barandilla');
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
    const { projectId, blockId } = seedJob('Barandilla');
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
    seedJob('Barandilla');
    expect(readHistoryState(db)).toEqual({ undo: null, redo: null, clearedBySettings: false });
    expect(undoLast(db)).toEqual({ changed: false, step: null, focusDate: null, drifted: false });
    expect(redoNext(db)).toEqual({ changed: false, step: null, focusDate: null, drifted: false });
  });
});

describe('the depth', () => {
  it(`keeps ${MAX_HISTORY_STEPS} undoable steps and forgets the oldest`, () => {
    const { projectId, blockId } = seedJob('Barandilla');
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
    const { projectId } = seedJob('Barandilla');
    withHistory(db, { kind: 'project.delete', projectId }, () => {
      deleteProject(projectId, db);
    });
    expect(listProjects(db)).toEqual([]);

    expect(readHistoryState(db).undo).toEqual({
      kind: 'project.delete',
      args: { name: 'Barandilla' },
    });
    expect(undoLast(db).step).toEqual({ kind: 'project.delete', args: { name: 'Barandilla' } });
    expect(listProjects(db).map((project) => project.name)).toEqual(['Barandilla']);
  });

  it('carries no name for an absence, which is not a job', () => {
    insertGap({ id: id('g'), date: MON, startMinutes: t('10:00'), durationMinutes: 60 }, db);
    withHistory(db, { kind: 'gap.create' }, () => {
      insertGap({ id: id('g'), date: TUE, startMinutes: t('10:00'), durationMinutes: 60, reason: 'Avería' }, db);
    });

    expect(readHistoryState(db).undo).toEqual({ kind: 'gap.create', args: {} });
    undoLast(db);
    expect(listGaps(db).map((gap) => gap.date)).toEqual([MON]);
  });
});

describe('a calendar that moved outside the line', () => {
  it('is never clobbered: the line is emptied and the request says so', () => {
    const { projectId, blockId } = seedJob('Barandilla');
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
});

describe('a settings save starts a new line', () => {
  it('leaves nothing to undo, and says why', () => {
    const { projectId, blockId } = seedJob('Barandilla');
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
    const { projectId, blockId } = seedJob('Barandilla');
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
      redo: { kind: 'block.move', args: { name: 'Barandilla' } },
      clearedBySettings: true,
    });
  });
});

describe('a closed day is calendar too', () => {
  it('comes back with its note', () => {
    withHistory(db, { kind: 'absence.closeDays' }, () => {
      upsertDayOverride({ date: MON, isClosed: true, capacityHours: null, note: 'Feria' }, db);
    });

    expect(undoLast(db).changed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM day_overrides').get()).toEqual({ n: 0 });

    expect(redoNext(db).changed).toBe(true);
    expect(db.prepare('SELECT date, is_closed, note FROM day_overrides').all()).toEqual([
      { date: MON, is_closed: 1, note: 'Feria' },
    ]);
  });
});

describe('what the line never holds', () => {
  it('leaves settings and the applied data migrations alone', () => {
    const { projectId, blockId } = seedJob('Barandilla');
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
    insertProject({ id: id('p'), name: 'Barandilla', color: PROJECT_COLORS[0], totalMinutes: 120 }, first);
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
