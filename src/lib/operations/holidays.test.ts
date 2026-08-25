import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from '../db';
import { PROJECT_COLORS } from '../projectColors';
import { writeSettings } from '../settings';
import type { HolidaySource } from '../holidays/fetch';
import { listBlocks } from '../repositories/blocks';
import { listDayOverrides, upsertDayOverride } from '../repositories/dayOverrides';
import { listCachedHolidays, readHolidayCheck } from '../repositories/holidays';
import { createProject } from './projects';
import { reopenDays } from './absences';
import { applyHolidayAnswers, readHolidayState, runHolidayCheck } from './holidays';
import { LAST_FRI, MON, SAT, TUE, WED } from '../../testing/fixtures';

const BLUE = PROJECT_COLORS[0];
/** A Monday well inside the fixture week, so "now" and `today` describe the same calendar. */
const NOW = new Date('2026-08-10T08:00:00Z');

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

interface Row {
  date: string;
  type: 'LABORAL' | 'LOCAL';
  description?: string;
}

/** A source shaped exactly like the Junta's payload, and by default naming nothing. */
function sourceWith(rows: readonly Row[], names: Record<string, string> = {}): HolidaySource {
  return {
    dates: () =>
      Promise.resolve(
        rows.map((row) => ({
          id: row.date,
          dateformat: `${row.date}T00:00:00Z`,
          event: 'VEVENT',
          date: Number(row.date.replace(/-/g, '')),
          description:
            row.description ??
            (row.type === 'LOCAL' ? 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)' : 'AÑO NUEVO'),
          municipality: row.type === 'LOCAL' ? 'PRIEGO DE CÓRDOBA' : '',
          province: row.type === 'LOCAL' ? 'CÓRDOBA' : '',
          year: row.date.slice(0, 4),
          type: row.type,
        })),
      ),
    names: () =>
      Promise.resolve(
        Object.keys(names).length === 0
          ? null
          : { holidays: Object.entries(names).map(([date, name]) => ({ date, name: { es: name } })) },
      ),
  };
}

function job(name: string, hours: number, today = MON) {
  return createProject({ name, color: BLUE, totalMinutes: hours * 60, today }, db);
}

function noteOn(date: string): string | undefined {
  return listDayOverrides(db).find((day) => day.date === date)?.note;
}

// ---------------------------------------------------------------------------

describe('the holiday check', () => {
  it('closes a holiday with nothing on it, silently', async () => {
    const result = await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    expect(result.closed).toEqual([TUE]);
    expect(result.pending).toEqual([]);
    expect(listDayOverrides(db)).toEqual([
      { date: TUE, isClosed: true, capacityHours: null, note: 'Año Nuevo' },
    ]);
  });

  it('writes a holiday that falls on a SATURDAY', async () => {
    const result = await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: SAT, type: 'LABORAL' }]) },
      db,
    );

    // The engine plans nothing on a weekend either way; the header naming the day is the point.
    expect(result.closed).toEqual([SAT]);
  });

  it('never writes before today', async () => {
    const result = await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: LAST_FRI, type: 'LABORAL' }]) },
      db,
    );

    expect(result.closed).toEqual([]);
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('running it twice changes nothing', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    const second = await runHolidayCheck({ today: MON, now: NOW, force: true, source }, db);

    expect(second.closed).toEqual([]);
    expect(second.renamed).toEqual([]);
    expect(second.reopened).toEqual([]);
    expect(listDayOverrides(db)).toHaveLength(1);
  });

  it('is skipped while the switch is off', async () => {
    writeSettings({ holidaysEnabled: false }, db);

    const result = await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    expect(result.skipped).toBe('disabled');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('is not due again within seven days, and force overrides that', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    const soon = new Date('2026-08-12T08:00:00Z');
    expect((await runHolidayCheck({ today: MON, now: soon, source }, db)).skipped).toBe('not-due');
    expect(
      (await runHolidayCheck({ today: MON, now: soon, force: true, source }, db)).skipped,
    ).toBeUndefined();
  });

  it('is due again once the seven days have passed', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    const later = new Date('2026-08-18T08:00:00Z');
    expect((await runHolidayCheck({ today: MON, now: later, source }, db)).skipped).toBeUndefined();
  });

  it('leaves the cache alone and says offline when the source cannot be reached', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    const dead: HolidaySource = {
      dates: () => Promise.resolve(null),
      names: () => Promise.resolve(null),
    };
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: dead }, db);

    expect(result.skipped).toBe('offline');
    expect(listCachedHolidays(db)).toHaveLength(1);
    expect(readHolidayCheck(db)?.succeeded).toBe(false);
  });

  it('discards a truncated body whole rather than closing half the days', async () => {
    const broken: HolidaySource = {
      dates: () =>
        Promise.resolve([
          { date: 20260811, description: 'AÑO NUEVO', municipality: '', province: '', type: 'LABORAL' },
          'oops',
        ]),
      names: () => Promise.resolve(null),
    };

    const result = await runHolidayCheck({ today: MON, now: NOW, source: broken }, db);

    expect(result.skipped).toBe('offline');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('leaves a day the owner already closed exactly as it is', async () => {
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Breakdown' }, db);

    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    expect(noteOn(TUE)).toBe('Breakdown');
  });

  it('takes the name festivos.io gives over the fallback', async () => {
    const source = sourceWith([{ date: TUE, type: 'LOCAL' }], { [TUE]: 'Feria Real de Priego de Córdoba' });

    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(noteOn(TUE)).toBe('Feria Real de Priego de Córdoba');
  });

  it('names a local day generically while nobody has published its real name', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LOCAL' }]) },
      db,
    );

    expect(noteOn(TUE)).toBe('Fiesta local');
  });

  it('writes the note in the language the owner is READING', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, language: 'en', source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    // Stored user data from the moment it is written, so it is composed once, in their language.
    expect(noteOn(TUE)).toBe("New Year's Day");
  });

  it('does not write a holiday that has work on it — it ASKS', async () => {
    job('Railing', 6);

    const result = await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: MON, type: 'LABORAL' }]) },
      db,
    );

    expect(result.closed).toEqual([]);
    expect(result.pending.map((day) => day.date)).toEqual([MON]);
    expect(result.pending[0].name).toBe('Año Nuevo');
    expect(result.pending[0].rows[0].name).toBe('Railing');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('closes the quiet days of the same pass while the busy one waits', async () => {
    job('Railing', 6);

    const result = await runHolidayCheck(
      {
        today: MON,
        now: NOW,
        source: sourceWith([
          { date: MON, type: 'LABORAL' },
          { date: WED, type: 'LABORAL' },
        ]),
      },
      db,
    );

    expect(result.pending.map((day) => day.date)).toEqual([MON]);
    expect(result.closed).toEqual([WED]);
  });

  it('reports what is loaded and how far it reaches', async () => {
    await runHolidayCheck(
      {
        today: MON,
        now: NOW,
        source: sourceWith([
          { date: TUE, type: 'LABORAL' },
          { date: '2026-12-25', type: 'LABORAL', description: 'NATIVIDAD DEL SEÑOR' },
        ]),
      },
      db,
    );

    const state = readHolidayState(db);
    expect(state.municipalityName).toBe('Priego de Córdoba (Córdoba)');
    expect(state.count).toBe(2);
    expect(state.knownThrough).toBe('2026-12-25');
    expect(state.lastCheckSucceeded).toBe(true);
  });
});

describe('answering the panel', () => {
  it('displaces the work when the answer is no', async () => {
    job('Railing', 6);
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: MON, type: 'LABORAL' }]) },
      db,
    );

    const result = applyHolidayAnswers([{ date: MON, keep: false }], { today: MON }, db);

    expect(result.closed).toEqual([MON]);
    expect(listBlocks(db).some((block) => block.date === MON)).toBe(false);
    expect(noteOn(MON)).toBe('Año Nuevo');
  });

  it('padlocks and keeps the work when the answer is yes', async () => {
    job('Railing', 6);
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: MON, type: 'LABORAL' }]) },
      db,
    );

    applyHolidayAnswers([{ date: MON, keep: true }], { today: MON }, db);

    const onMonday = listBlocks(db).filter((block) => block.date === MON);
    expect(onMonday).toHaveLength(1);
    expect(onMonday[0].locked).toBe(true);
    expect(noteOn(MON)).toBe('Año Nuevo');
  });

  it('writes nothing for a date the check never asked about', () => {
    const result = applyHolidayAnswers([{ date: TUE, keep: false }], { today: MON }, db);

    expect(result.closed).toEqual([]);
    expect(listDayOverrides(db)).toEqual([]);
  });
});

describe('what a later check maintains', () => {
  it('RENAMES a day it still owns when the name finally arrives', async () => {
    const dates: Row[] = [{ date: TUE, type: 'LOCAL' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    expect(noteOn(TUE)).toBe('Fiesta local');

    const named = sourceWith(dates, { [TUE]: 'Feria Real de Priego de Córdoba' });
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    expect(result.renamed).toEqual([TUE]);
    expect(noteOn(TUE)).toBe('Feria Real de Priego de Córdoba');
  });

  it('a rename MOVES NO HOURS and does not reopen the day', async () => {
    job('Railing', 6);
    const dates: Row[] = [{ date: MON, type: 'LOCAL' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    applyHolidayAnswers([{ date: MON, keep: true }], { today: MON }, db);

    const before = listBlocks(db).map((block) => ({ ...block }));

    const named = sourceWith(dates, { [MON]: 'Feria Real de Priego de Córdoba' });
    await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    // Reopening and rewriting would look identical afterwards while shuffling the queue in between.
    expect(listBlocks(db)).toEqual(before);
    expect(listDayOverrides(db)[0].isClosed).toBe(true);
    expect(noteOn(MON)).toBe('Feria Real de Priego de Córdoba');
  });

  it('NEVER renames a day whose note the owner rewrote', async () => {
    const dates: Row[] = [{ date: TUE, type: 'LOCAL' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    const named = sourceWith(dates, { [TUE]: 'Feria Real de Priego de Córdoba' });
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    expect(result.renamed).toEqual([]);
    expect(noteOn(TUE)).toBe('Fair');
  });

  it('REOPENS a day that stopped being a holiday, while it still carries the app’s note', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );

    const moved = sourceWith([{ date: WED, type: 'LABORAL' }]);
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: moved }, db);

    expect(result.reopened).toEqual([TUE]);
    expect(result.closed).toEqual([WED]);
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([WED]);
  });

  it('does NOT reopen a day the owner has since renamed', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    const moved = sourceWith([{ date: WED, type: 'LABORAL' }]);
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: moved }, db);

    expect(result.reopened).toEqual([]);
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([TUE, WED]);
  });

  it('the KNOWN defect: a reopened holiday comes back on the next check', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);
    reopenDays({ from: TUE, to: TUE, today: MON }, db);

    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source }, db);

    // Recorded as an open decision, not a feature: a reopened day leaves no row, so «never written»
    // and «written and undone» are the same picture.
    expect(result.closed).toEqual([TUE]);
  });
});

describe('changing the municipality', () => {
  it('reopens the old town’s future days and brings the new town’s', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LOCAL' }]) },
      db,
    );
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([TUE]);

    writeSettings({ holidaysMunicipality: '04003' }, db);
    // Adra's own local day, which the Priego rows never named.
    const adra: HolidaySource = {
      dates: () =>
        Promise.resolve([
          {
            id: '1',
            dateformat: `${WED}T00:00:00Z`,
            event: 'VEVENT',
            date: Number(WED.replace(/-/g, '')),
            description: 'FIESTA LOCAL EN ADRA (ALMERÍA)',
            municipality: 'ADRA',
            province: 'ALMERÍA',
            year: '2026',
            type: 'LOCAL',
          },
        ]),
      names: () => Promise.resolve(null),
    };

    const result = await runHolidayCheck({ today: MON, now: NOW, source: adra }, db);

    expect(result.reopened).toEqual([TUE]);
    expect(result.closed).toEqual([WED]);
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([WED]);
  });

  it('leaves a day the owner closed by hand, and one whose note they rewrote', async () => {
    upsertDayOverride({ date: MON, isClosed: true, capacityHours: null, note: 'Breakdown' }, db);
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LOCAL' }]) },
      db,
    );
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    writeSettings({ holidaysMunicipality: '04003' }, db);
    const empty: HolidaySource = {
      dates: () =>
        Promise.resolve([
          {
            id: '1',
            dateformat: `${WED}T00:00:00Z`,
            event: 'VEVENT',
            date: Number(WED.replace(/-/g, '')),
            description: 'AÑO NUEVO',
            municipality: '',
            province: '',
            year: '2026',
            type: 'LABORAL',
          },
        ]),
      names: () => Promise.resolve(null),
    };

    await runHolidayCheck({ today: MON, now: NOW, source: empty }, db);

    expect(noteOn(MON)).toBe('Breakdown');
    expect(noteOn(TUE)).toBe('Fair');
  });

  it('checks straight away when the municipality changed, without waiting a week', async () => {
    await runHolidayCheck(
      { today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL' }]) },
      db,
    );
    writeSettings({ holidaysMunicipality: '04003' }, db);

    const soon = new Date('2026-08-11T08:00:00Z');
    const result = await runHolidayCheck(
      { today: MON, now: soon, source: sourceWith([{ date: WED, type: 'LABORAL' }]) },
      db,
    );

    expect(result.skipped).toBeUndefined();
  });
});
