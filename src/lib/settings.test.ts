import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db';
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  dayShapeFromSettings,
  maxDayCapacityHours,
  normalizeSettings,
  readSettings,
  serializeSettings,
  validateSettings,
  writeSettings,
} from './settings';
import type { Settings } from '../types';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('the schema', () => {
  it('creates every table the app needs, migrations being idempotent', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(['projects', 'blocks', 'gaps', 'settings', 'day_overrides']),
    );
  });

  it('cascades blocks when their project is deleted', () => {
    db.prepare("INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Barandilla', '#185FA5', 4)").run();
    db.prepare(
      "INSERT INTO blocks (id, project_id, date, start_time, duration) VALUES ('b1', 'p1', '2026-08-11', '08:00', 4)",
    ).run();

    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('touches updated_at on UPDATE, which a column default never does', () => {
    db.prepare("INSERT INTO projects (id, name, color, total_hours, created_at, updated_at) VALUES ('p1', 'Portón', '#D85A30', 6, '2020-01-01 00:00:00', '2020-01-01 00:00:00')").run();

    db.prepare("UPDATE projects SET name = 'Portón corredera' WHERE id = 'p1'").run();

    const row = db.prepare("SELECT updated_at FROM projects WHERE id = 'p1'").get() as { updated_at: string };
    expect(row.updated_at).not.toBe('2020-01-01 00:00:00');
  });

  it('refuses a block with no duration and a locked flag that is not 0 or 1', () => {
    db.prepare("INSERT INTO projects (id, name, color) VALUES ('p1', 'Escalera', '#1D9E75')").run();
    expect(() =>
      db.prepare("INSERT INTO blocks (id, project_id, date, start_time, duration) VALUES ('b1', 'p1', '2026-08-11', '08:00', 0)").run(),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO blocks (id, project_id, date, start_time, duration, locked) VALUES ('b2', 'p1', '2026-08-11', '08:00', 2, 7)").run(),
    ).toThrow();
  });
});

describe('readSettings', () => {
  it('returns the seeded defaults on a fresh database', () => {
    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('parses TEXT storage into real booleans and numbers', () => {
    const settings = readSettings(db);
    expect(settings.period2Enabled).toBe(true);
    expect(settings.defaultDayCapacity).toBe(10);
    expect(settings.planningHorizonWeeks).toBe(8);
  });

  it('falls back per key when a row is corrupt, without throwing', () => {
    const set = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    set.run('not a time', 'period1Start');
    set.run('maybe', 'period2Enabled');
    set.run('abc', 'planningHorizonWeeks');
    set.run('red', 'gapColor');

    const settings = readSettings(db);
    expect(settings.period1Start).toBe(DEFAULT_SETTINGS.period1Start);
    expect(settings.period2Enabled).toBe(DEFAULT_SETTINGS.period2Enabled);
    expect(settings.planningHorizonWeeks).toBe(DEFAULT_SETTINGS.planningHorizonWeeks);
    expect(settings.gapColor).toBe(DEFAULT_SETTINGS.gapColor);
  });

  it('clamps a margin and a horizon that are out of range', () => {
    expect(normalizeSettings({ visualMarginTop: '9' }).visualMarginTop).toBe(2);
    expect(normalizeSettings({ visualMarginBottom: '-3' }).visualMarginBottom).toBe(0);
    expect(normalizeSettings({ planningHorizonWeeks: '0' }).planningHorizonWeeks).toBe(1);
  });

  it('repairs a morning that ends before it starts', () => {
    const settings = normalizeSettings({ period1Start: '14:00', period1End: '08:00' });
    expect(settings.period1Start).toBe(DEFAULT_SETTINGS.period1Start);
    expect(settings.period1End).toBe(DEFAULT_SETTINGS.period1End);
  });
});

describe('the capacity is never touched alone', () => {
  it('never lets auto-fill claim more hours than the shift covers', () => {
    expect(maxDayCapacityHours(DEFAULT_SETTINGS)).toBe(10);
    // The READ path still repairs a stored row above the shift: a hand edit must not be
    // able to make `capacityMinutes` claim hours the periods do not have.
    expect(normalizeSettings({ defaultDayCapacity: '12' }).defaultDayCapacity).toBe(10);
  });

  /**
   * THE TRAP, as the owner hit it. Their capacity read 6 h against a 10 h shift and they
   * had never chosen 6: switching the afternoon off re-capped it, switching the afternoon
   * back on left it there, and the shop planned mornings only for weeks with nothing said.
   *
   * The rule now: the capacity is what the owner last chose, at every step.
   */
  it('refuses a shift that cannot buy the stored capacity, then keeps the number the owner chose', () => {
    expect(readSettings(db).defaultDayCapacity).toBe(10);

    // Switching the afternoon off would leave 10 h of capacity on a 6 h shift. Refused,
    // and nothing is written — not the capacity, not the toggle that came with it.
    expect(() => writeSettings({ period2Enabled: false }, db)).toThrow(SettingsValidationError);
    expect(readSettings(db).defaultDayCapacity).toBe(10);
    expect(readSettings(db).period2Enabled).toBe(true);

    // The owner is asked and answers: 6 h, sent WITH the shorter shift, in one write.
    const off = writeSettings({ period2Enabled: false, defaultDayCapacity: 6 }, db);
    expect(off.defaultDayCapacity).toBe(6);
    expect(readSettings(db).defaultDayCapacity).toBe(6);

    // Switching the afternoon back on does not restore 10 h either — that would be the
    // same silent adjustment in the other direction. 6 h is what they last chose.
    const on = writeSettings({ period2Enabled: true }, db);
    expect(on.defaultDayCapacity).toBe(6);
    expect(readSettings(db).defaultDayCapacity).toBe(6);
    expect(maxDayCapacityHours(readSettings(db))).toBe(10);
  });

  it('refuses shrinking the period times below the capacity, and names the field', () => {
    try {
      writeSettings({ period2End: '17:30' }, db);
      expect.unreachable('an 8 h shift cannot buy the stored 10 h capacity');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      expect((error as SettingsValidationError).field).toBe('defaultDayCapacity');
      // The refusal names the ceiling, so a caller is never left guessing the number.
      expect((error as SettingsValidationError).message).toContain('8 h');
    }
    expect(readSettings(db).period2End).toBe('19:30');

    expect(writeSettings({ period2End: '17:30', defaultDayCapacity: 8 }, db).defaultDayCapacity).toBe(8);
  });

  it('leaves a capacity below the shift alone — stopping early is the point', () => {
    expect(writeSettings({ defaultDayCapacity: 8 }, db).defaultDayCapacity).toBe(8);
    // And a longer shift does not raise it back to the new ceiling.
    expect(writeSettings({ period2End: '20:30' }, db).defaultDayCapacity).toBe(8);
    expect(maxDayCapacityHours(readSettings(db))).toBe(11);
  });

  it('accepts a capacity that exactly fills the shift', () => {
    expect(writeSettings({ period2Enabled: false, defaultDayCapacity: 6 }, db).defaultDayCapacity).toBe(6);
    expect(() =>
      writeSettings({ period2Enabled: false, defaultDayCapacity: 6.5 }, db),
    ).toThrow(SettingsValidationError);
  });

  /**
   * THE SIBLING, found by asking every field the same question: is there a value the
   * WRITE path accepts and the READ path then quietly changes? For nine of the ten
   * settings, no. For this one there were two — the floor and the granularity — and the
   * read path's repair was doing the same job the re-cap used to do, in the other
   * direction: `writeSettings({ defaultDayCapacity: 0.5 })` returned 0.5, stored "0.5",
   * and every later read said 1. Half an hour of auto-fill a day, from nowhere.
   *
   * `clampCapacityToShift` says the effective range is `[min(1, shift), shift]` in whole
   * minutes, so that is what a write has to refuse outside of. Then the repair really is
   * the no-op its comment claims for anything that came through here.
   */
  it('refuses a capacity below the floor the read path would raise it to', () => {
    expect(() => writeSettings({ defaultDayCapacity: 0.5 }, db)).toThrow(SettingsValidationError);
    expect(() => writeSettings({ defaultDayCapacity: 0.001 }, db)).toThrow(SettingsValidationError);
    expect(readSettings(db).defaultDayCapacity).toBe(10);

    // The floor is the shift itself when the shift is shorter than an hour, so a
    // half-hour morning can still be filled to the brim.
    expect(
      writeSettings(
        { period1End: '08:30', period2Enabled: false, defaultDayCapacity: 0.5 },
        db,
      ).defaultDayCapacity,
    ).toBe(0.5);
  });

  it('refuses a capacity that is not a whole number of minutes', () => {
    expect(() => writeSettings({ defaultDayCapacity: 5.7777 }, db)).toThrow(SettingsValidationError);
    // Halves and quarters are what the form produces, and 20 minutes is a third of an hour.
    expect(writeSettings({ defaultDayCapacity: 6.5 }, db).defaultDayCapacity).toBe(6.5);
    expect(writeSettings({ defaultDayCapacity: 1 / 3 + 6 }, db).defaultDayCapacity).toBe(1 / 3 + 6);
  });

  /**
   * The invariant behind both refusals, stated once: for every field, what a write
   * returns is what the next read gives back. Anything else and the response the Settings
   * screen renders is not the configuration the engine is running.
   */
  it('never returns a value the next read would disagree with', () => {
    const cases: Array<Partial<Settings>> = [
      { defaultDayCapacity: 6 },
      { defaultDayCapacity: 6.5 },
      { defaultDayCapacity: 10 },
      { visualMarginTop: 0, visualMarginBottom: 2 },
      { visualMarginTop: 1.5 },
      { planningHorizonWeeks: 1 },
      { planningHorizonWeeks: 104 },
      { gapColor: '#aabbcc' },
      { period1Start: '07:00', period1End: '13:00' },
      { period2Enabled: false, defaultDayCapacity: 6 },
      { period2Enabled: true, period2Start: '15:00', period2End: '18:00', defaultDayCapacity: 9 },
    ];

    for (const patch of cases) {
      const written = writeSettings(patch, db);
      expect(readSettings(db)).toEqual(written);
    }
  });
});

describe('writeSettings', () => {
  it('persists a partial change and leaves the rest untouched', () => {
    writeSettings({ gapColor: '#aabbcc' }, db);
    const settings = readSettings(db);
    expect(settings.gapColor).toBe('#AABBCC');
    expect(settings.period1Start).toBe(DEFAULT_SETTINGS.period1Start);
  });

  it('rejects a malformed value, naming the field for the form', () => {
    expect(() => writeSettings({ period1Start: '8 in the morning' }, db)).toThrow(SettingsValidationError);
    expect(() => writeSettings({ gapColor: 'grey' }, db)).toThrow(SettingsValidationError);
    expect(() => writeSettings({ visualMarginTop: 3 }, db)).toThrow(SettingsValidationError);
    expect(() => writeSettings({ planningHorizonWeeks: 0 }, db)).toThrow(SettingsValidationError);
    expect(() => writeSettings({ planningHorizonWeeks: 2.5 }, db)).toThrow(SettingsValidationError);

    try {
      writeSettings({ period1End: '07:00' }, db);
      expect.unreachable('an end before the start must be rejected');
    } catch (error) {
      expect((error as SettingsValidationError).field).toBe('period1End');
    }
  });

  it('rejects an afternoon that overlaps the morning', () => {
    expect(() => writeSettings({ period2Start: '13:00' }, db)).toThrow(SettingsValidationError);
  });

  it('ignores the afternoon times while the afternoon is disabled', () => {
    // A 12 h morning would clash with the default 15:30 afternoon, but the
    // afternoon is off, so its stored times are simply not consulted.
    const settings = writeSettings({ period2Enabled: false, period1End: '20:00' }, db);
    expect(settings.period1End).toBe('20:00');
    expect(settings.defaultDayCapacity).toBe(10);
  });

  it('does not write anything when validation fails', () => {
    expect(() => writeSettings({ period1Start: 'nope' }, db)).toThrow();
    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('dayShapeFromSettings', () => {
  it('resolves the split shift and the visual margins into minutes', () => {
    const shape = dayShapeFromSettings(DEFAULT_SETTINGS);

    expect(shape.periods).toEqual([
      { startMinutes: 480, endMinutes: 840 },
      { startMinutes: 930, endMinutes: 1170 },
    ]);
    expect(shape.shiftMinutes).toBe(600);
    expect(shape.capacityMinutes).toBe(600);
    // 07:00 to 20:30, matching the timeline in the wireframe.
    expect(shape.timelineStartMinutes).toBe(420);
    expect(shape.timelineEndMinutes).toBe(1230);
  });

  it('ends the day when the morning ends if the afternoon is off', () => {
    const shape = dayShapeFromSettings({ ...DEFAULT_SETTINGS, period2Enabled: false });
    expect(shape.periods).toHaveLength(1);
    expect(shape.shiftMinutes).toBe(360);
    expect(shape.capacityMinutes).toBe(360);
    expect(shape.timelineEndMinutes).toBe(900);
  });
});

describe('serialization', () => {
  it('writes every key as TEXT and reads it back unchanged', () => {
    const serialized = serializeSettings(DEFAULT_SETTINGS);
    expect(Object.values(serialized).every((value) => typeof value === 'string')).toBe(true);
    expect(normalizeSettings(serialized)).toEqual(DEFAULT_SETTINGS);
  });

  it('uppercases the gap colour so comparisons are stable', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, gapColor: '#d3d1c7' }).gapColor).toBe('#D3D1C7');
  });
});
