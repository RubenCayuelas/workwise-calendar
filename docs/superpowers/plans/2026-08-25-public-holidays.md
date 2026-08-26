# Public Holidays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shop's municipality is set in Settings and the app closes its public holidays by itself, named after the holiday, asking before it moves any work.

**Architecture:** A weekly check (the shape `takeAutomaticBackup` already uses) fetches dates from the Junta de Andalucía's open-data endpoint and names from festivos.io, caches them in a new `holidays` table, and writes `day_overrides` rows through the absence machinery that already exists. A day the app wrote and nobody has touched since stays the app's to rename or reopen; anything the owner edited is theirs forever. Closing a day stops refusing because work sits on it and asks instead — displace, or keep it here and padlock it.

**Tech Stack:** Next.js 16, TypeScript, `better-sqlite3`, vitest, CSS Modules, i18next. No new dependency — the fetches use the platform `fetch` in Node 22.

**Spec:** `docs/superpowers/specs/2026-08-25-public-holidays-design.md` — read it before Task 1 and keep it open; every task argues from a section of it.

## Global Constraints

- **Node 22 exactly.** `scripts/require-node-22.mjs` refuses anything else.
- **All four gates pass before every commit**: `npm run type-check`, `npm test`, `npm run lint`, `npm run build`. A task's "Commit" step means all four are green.
- **Code, comments and identifiers in English. UI strings only in `public/locales/{es,en}/common.json`**, both key sets identical (`src/lib/locales.test.ts` enforces it). Test data uses the repo's fixed job names (`Railing`, `Staircase`, `Door`, …) and gap reasons (`Fair`, `Breakdown`, …).
- **Dates are local `YYYY-MM-DD` from `src/lib/dates.ts`.** Never derive a calendar day from a UTC timestamp.
- **Integer minutes everywhere inside the engine.** Decimal hours only at the database boundary.
- **One transaction per operation.** A refusal writes nothing.
- **Recomposing twice changes nothing.**
- **No test may open `data/calendar.db`** — `openDatabase` refuses it under vitest. Use `openDatabase(':memory:')` or point `WORKWISE_DB_PATH` at a temp file.
- **No test may reach the network.** Both HTTP sources are injected, never called for real.
- **No `SPEC.md §` or `DECISIONS.md §` pointer in a code comment.** The docs test refuses it.
- **Commits: Conventional Commits, subject only, no body, no self-attribution.** Scope for this work: `holidays`, and `absences` for Task 7-8.
- **Version on the last task: `0.21.1` → `0.22.0`** in `package.json` and `desktop/package.json`, with a CHANGELOG entry.
- Branch: `feat/public-holidays`, already created from `dev`.

## File Structure

**New, pure (no I/O, no database) — `src/lib/holidays/`:**

| file | one responsibility |
|---|---|
| `municipalities.ts` | GENERATED. The 785 Andalusian municipalities: `{ ine, name, provinceIne }`, plus the hand-checked overrides that map a Junta name onto an INE code. |
| `juntaDataset.ts` | The Junta payload → `JuntaRow[]`, and the filter that picks one municipality's rows. Includes `juntaKey`, the normalisation both sides are compared through. |
| `officialNames.ts` | The dataset's upper-case strings → proper Spanish, for when festivos.io has no answer. |
| `festivosIo.ts` | The festivos.io payload → `Map<date, name>`. |
| `compose.ts` | Dates from one, names from the other, fallbacks → `Holiday[]`. |
| `fetch.ts` | The only impure module here: two HTTP calls behind one `HolidaySource` interface, so every other module is testable without a network. |

**New, stateful:**

| file | one responsibility |
|---|---|
| `src/lib/repositories/holidays.ts` | The `holidays` cache and the `holiday_checks` row. |
| `src/lib/operations/holidays.ts` | The pass: is it due, what to write, what to maintain, what to ask about. |
| `app/api/holidays/route.ts` | `GET` the state line, `POST` the check. |
| `app/api/holidays/apply/route.ts` | `POST` the panel's answers. |
| `src/components/settings/HolidaysSection.tsx` | The Settings section. |
| `src/components/calendar/HolidayPanel.tsx` | Displace-or-keep, one line per day. |

**Modified:** `src/lib/migrations.ts` (two tables), `src/lib/settings.ts` + `src/types/index.ts` (two keys), `src/lib/operations/absences.ts` (the refusal becomes a question; `keepWork`; per-day rows on the preview), `src/lib/api-client.ts`, `src/components/settings/SettingsScreen.tsx`, `src/components/calendar/CalendarScreen.tsx`, both locale files, `docs/SPEC.md`, `docs/DECISIONS.md`, `CHANGELOG.md`.

**New script:** `scripts/generate-andalusian-municipalities.mjs`.

---

### Task 1: The cache tables

**Files:**
- Modify: `src/lib/migrations.ts` (the `SCHEMA` string, after `day_overrides`)
- Create: `src/lib/repositories/holidays.ts`
- Test: `src/lib/repositories/holidays.test.ts`

**Interfaces:**
- Consumes: `getDb`, `type Db` from `../db`; `prepared` from `./statements`.
- Produces:
  ```ts
  export interface CachedHoliday { date: string; name: string; level: HolidayLevel }
  export type HolidayLevel = 'national' | 'regional' | 'local';
  export interface HolidayCheck { municipality: string; checkedAt: string; succeeded: boolean }

  export function listCachedHolidays(db?: Db): CachedHoliday[];
  export function findCachedHoliday(date: string, db?: Db): CachedHoliday | undefined;
  export function replaceCachedHolidays(holidays: readonly CachedHoliday[], db?: Db): void;
  export function readHolidayCheck(db?: Db): HolidayCheck | undefined;
  export function recordHolidayCheck(check: HolidayCheck, db?: Db): void;
  ```

**Why two tables:** the cache says *what the app last wrote and where it reaches*; the check row says *when we last tried and whether it worked*. A failed check writes no holiday rows, so it has nowhere else to be recorded, and `Settings` has to be able to say "último intento el …". Neither belongs in the typed `Settings` object, which mirrors the form.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/repositories/holidays.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from '../db';
import {
  findCachedHoliday,
  listCachedHolidays,
  readHolidayCheck,
  recordHolidayCheck,
  replaceCachedHolidays,
} from './holidays';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

describe('the holiday cache', () => {
  it('is empty on a fresh calendar', () => {
    expect(listCachedHolidays(db)).toEqual([]);
    expect(readHolidayCheck(db)).toBeUndefined();
  });

  it('stores holidays in date order and finds one by its day', () => {
    replaceCachedHolidays(
      [
        { date: '2026-12-25', name: 'Natividad del Señor', level: 'national' },
        { date: '2026-09-03', name: 'Feria Real de Priego de Córdoba', level: 'local' },
      ],
      db,
    );

    expect(listCachedHolidays(db).map((holiday) => holiday.date)).toEqual([
      '2026-09-03',
      '2026-12-25',
    ]);
    expect(findCachedHoliday('2026-09-03', db)?.name).toBe('Feria Real de Priego de Córdoba');
    expect(findCachedHoliday('2026-09-04', db)).toBeUndefined();
  });

  it('REPLACES rather than merges, so a date that stopped being a holiday leaves the cache', () => {
    replaceCachedHolidays([{ date: '2026-06-04', name: 'Fiesta local', level: 'local' }], db);
    replaceCachedHolidays([{ date: '2026-06-11', name: 'Fiesta local', level: 'local' }], db);

    expect(listCachedHolidays(db).map((holiday) => holiday.date)).toEqual(['2026-06-11']);
  });

  it('keeps one check row, overwritten each time', () => {
    recordHolidayCheck({ municipality: '14055', checkedAt: '2026-08-25T09:00:00Z', succeeded: false }, db);
    recordHolidayCheck({ municipality: '14055', checkedAt: '2026-08-25T10:00:00Z', succeeded: true }, db);

    expect(readHolidayCheck(db)).toEqual({
      municipality: '14055',
      checkedAt: '2026-08-25T10:00:00Z',
      succeeded: true,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/repositories/holidays.test.ts`
Expected: FAIL — `Cannot find module './holidays'`.

- [ ] **Step 3: Add the tables to the schema**

In `src/lib/migrations.ts`, inside the `SCHEMA` template literal, immediately after the `day_overrides` block:

```sql
-- The last successful holiday check: which dates are public holidays and what each is
-- called. It is a CACHE and never the calendar itself -- the calendar is day_overrides.
-- `name` doubles as the app's record of what it last wrote on that day, which is how a
-- later check can tell a day the owner has since renamed from one it still owns.
CREATE TABLE IF NOT EXISTS holidays (
  date  TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  level TEXT NOT NULL
);

-- When the app last tried to fetch them, and whether it worked. A FAILED check writes no
-- holiday rows, so this is the only place it can be recorded, and Settings has to be able
-- to say when the last attempt was. One row, enforced by the CHECK.
CREATE TABLE IF NOT EXISTS holiday_checks (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  municipality TEXT NOT NULL,
  checked_at   TEXT NOT NULL,
  succeeded    INTEGER NOT NULL CHECK (succeeded IN (0, 1))
);
```

- [ ] **Step 4: Write the repository**

```ts
// src/lib/repositories/holidays.ts
/**
 * The `holidays` cache and the single `holiday_checks` row. Neither is the calendar: the calendar is
 * `day_overrides`, and these two say what the last check found and when it ran.
 */

import { getDb, type Db } from '../db';
import { prepared } from './statements';

export type HolidayLevel = 'national' | 'regional' | 'local';

export interface CachedHoliday {
  date: string;
  name: string;
  level: HolidayLevel;
}

export interface HolidayCheck {
  municipality: string;
  /** An ISO instant, not a calendar day: it is compared against a clock, never against a date. */
  checkedAt: string;
  succeeded: boolean;
}

interface HolidayRow {
  date: string;
  name: string;
  level: string;
}

interface CheckRow {
  municipality: string;
  checked_at: string;
  succeeded: number;
}

export function listCachedHolidays(db: Db = getDb()): CachedHoliday[] {
  return prepared<HolidayRow>(db, 'SELECT date, name, level FROM holidays ORDER BY date')
    .all()
    .map(mapRow);
}

export function findCachedHoliday(date: string, db: Db = getDb()): CachedHoliday | undefined {
  const row = prepared<HolidayRow>(db, 'SELECT date, name, level FROM holidays WHERE date = ?').get(date);
  return row === undefined ? undefined : mapRow(row);
}

/**
 * The whole cache at once. Replacing rather than merging is what lets a date that stopped being a
 * holiday be noticed: a merge would keep it for ever and the calendar would keep a phantom closed day.
 */
export function replaceCachedHolidays(holidays: readonly CachedHoliday[], db: Db = getDb()): void {
  const insert = prepared(db, 'INSERT INTO holidays (date, name, level) VALUES (?, ?, ?)');
  db.transaction(() => {
    prepared(db, 'DELETE FROM holidays').run();
    for (const holiday of holidays) insert.run(holiday.date, holiday.name, holiday.level);
  })();
}

export function readHolidayCheck(db: Db = getDb()): HolidayCheck | undefined {
  const row = prepared<CheckRow>(
    db,
    'SELECT municipality, checked_at, succeeded FROM holiday_checks WHERE id = 1',
  ).get();
  return row === undefined
    ? undefined
    : { municipality: row.municipality, checkedAt: row.checked_at, succeeded: row.succeeded !== 0 };
}

export function recordHolidayCheck(check: HolidayCheck, db: Db = getDb()): void {
  prepared(
    db,
    `INSERT INTO holiday_checks (id, municipality, checked_at, succeeded) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       municipality = excluded.municipality,
       checked_at   = excluded.checked_at,
       succeeded    = excluded.succeeded`,
  ).run(check.municipality, check.checkedAt, check.succeeded ? 1 : 0);
}

function mapRow(row: HolidayRow): CachedHoliday {
  return { date: row.date, name: row.name, level: row.level as HolidayLevel };
}
```

- [ ] **Step 5: Run the test and the gates**

Run: `npx vitest run src/lib/repositories/holidays.test.ts && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migrations.ts src/lib/repositories/holidays.ts src/lib/repositories/holidays.test.ts
git commit -m "feat(holidays): cache the holiday list and the last check"
```

---

### Task 2: Two settings keys

**Files:**
- Modify: `src/types/index.ts` (the `Settings` interface)
- Modify: `src/lib/settings.ts` (`DEFAULT_SETTINGS`, `serializeSettings`, `normalizeSettings`, `validateSettings`)
- Test: `src/lib/settings.test.ts` (append)

**Interfaces:**
- Produces: `Settings.holidaysEnabled: boolean` (default `true`) and `Settings.holidaysMunicipality: string` (default `'14055'`, an INE code: five digits).

The INE code is validated as **exactly five digits** and nothing more. Whether it names a real municipality is Task 3's business, and `readSettings` must never fail on a value a hand edit put there — it repairs to the default, like every other field.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/settings.test.ts
describe('the holiday settings', () => {
  it('default to Priego de Córdoba, switched on', () => {
    expect(DEFAULT_SETTINGS.holidaysEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.holidaysMunicipality).toBe('14055');
  });

  it('repairs a corrupt municipality on the way IN', () => {
    expect(normalizeSettings({ holidaysMunicipality: 'Priego' }).holidaysMunicipality).toBe('14055');
    expect(normalizeSettings({ holidaysMunicipality: '1405' }).holidaysMunicipality).toBe('14055');
    expect(normalizeSettings({ holidaysMunicipality: '04003' }).holidaysMunicipality).toBe('04003');
  });

  it('REFUSES on the way out what the read path would have repaired', () => {
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, holidaysMunicipality: 'Priego' }),
    ).toThrow(SettingsValidationError);
  });

  it('round-trips: what writeSettings returns is what readSettings gives back', () => {
    const written = writeSettings({ holidaysEnabled: false, holidaysMunicipality: '41091' });
    expect(readSettings()).toEqual(written);
  });
});
```

The last test needs a database. Follow the file's existing harness — if `settings.test.ts` has no `openDatabase` setup, put that one case in a `describe` with `beforeEach(() => { db = openDatabase(':memory:'); })` / `afterEach(() => { db.close(); closeDb(); })` and pass `db` to both calls.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/settings.test.ts`
Expected: FAIL — `holidaysEnabled` does not exist on `Settings`.

- [ ] **Step 3: Add the two fields**

In `src/types/index.ts`, at the end of the `Settings` interface:

```ts
  /** Whether the app closes the municipality's public holidays by itself. On by default. */
  holidaysEnabled: boolean;
  /** The INE code of the municipality whose holidays are fetched. Five digits. */
  holidaysMunicipality: string;
```

In `src/lib/settings.ts`:

```ts
// DEFAULT_SETTINGS, after backupsKept:
  holidaysEnabled: true,
  holidaysMunicipality: '14055',

// near HEX_COLOR_PATTERN:
/** An INE municipality code. Five digits, leading zero included: Almería's start `04`. */
const INE_CODE_PATTERN = /^\d{5}$/;

// serializeSettings, after backupsKept:
    holidaysEnabled: settings.holidaysEnabled ? 'true' : 'false',
    holidaysMunicipality: settings.holidaysMunicipality,

// normalizeSettings, inside the parsed object:
    holidaysEnabled: parseBoolean(raw.holidaysEnabled, DEFAULT_SETTINGS.holidaysEnabled),
    holidaysMunicipality: parseIneCode(
      raw.holidaysMunicipality,
      DEFAULT_SETTINGS.holidaysMunicipality,
    ),

// validateSettings, before the final return:
  if (!INE_CODE_PATTERN.test(settings.holidaysMunicipality)) {
    throw new SettingsValidationError(
      'holidaysMunicipality',
      `"${settings.holidaysMunicipality}" is not a five-digit INE municipality code`,
    );
  }

// with the other parsers at the bottom:
function parseIneCode(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return INE_CODE_PATTERN.test(trimmed) ? trimmed : fallback;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/settings.test.ts && npm run type-check`
Expected: PASS. `type-check` will now flag every place that builds a whole `Settings` literal — fix each by adding the two fields (the compiler names them).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Anything comparing a whole `Settings` object needs the two new keys.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/settings.ts src/lib/settings.test.ts
git commit -m "feat(holidays): add the municipality and the on/off switch to settings"
```

---

### Task 3: The municipality list, and the nine names that do not match

**Files:**
- Create: `scripts/generate-andalusian-municipalities.mjs`
- Create: `src/lib/holidays/municipalities.ts` (generated, then checked in)
- Test: `src/lib/holidays/municipalities.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Municipality { ine: string; name: string; provinceIne: string }
  export const ANDALUSIAN_MUNICIPALITIES: readonly Municipality[];   // 785 entries
  export const ANDALUSIAN_PROVINCES: Readonly<Record<string, string>>; // '14' -> 'Córdoba'
  export function findMunicipality(ine: string): Municipality | undefined;
  export const JUNTA_NAME_OVERRIDES: Readonly<Record<string, string>>; // juntaKey -> ine
  ```

**Measured on 2026-08-25, and the reason this task exists:** `https://festivos.io/v1/2026/index.json` lists 8,132 municipalities with `{ine, name, province_ine, ccaa}`; 785 of them are `ES-AN`. The Junta dataset names 774 Andalusian municipalities in 2026 and **names them differently**: `EL EJIDO` against INE's `Ejido, El`, `VÉLEZ BLANCO` against `Vélez-Blanco`. Normalising (strip accents, upper-case, move a trailing article to the front, reduce everything else to single spaces) matches **765 of 774**. The remaining **nine** are genuine differences — including `BEJIJAR` against `Begíjar`, which differs by a letter and no normalisation will ever reconcile — so they are a hand-checked table:

| Junta name (normalised key) | INE |
|---|---|
| `ZAHARA DE LA SIERRA\|CADIZ` | `11042` |
| `DOMINGO PEREZ\|GRANADA` | `18915` |
| `HUETOR SANTILLAN\|GRANADA` | `18099` |
| `POLOPOS LA MAMOLA\|GRANADA` | `18162` |
| `CORTELAZOR LA REAL\|HUELVA` | `21026` |
| `BEJIJAR\|JAEN` | `23014` |
| `HORNOS DE SEGURA\|JAEN` | `23043` |
| `LA VINUELA\|MALAGA` | `29099` |
| `ALANIS DE LA SIERRA\|SEVILLA` | `41002` |

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/holidays/municipalities.test.ts
import { describe, expect, it } from 'vitest';
import {
  ANDALUSIAN_MUNICIPALITIES,
  ANDALUSIAN_PROVINCES,
  JUNTA_NAME_OVERRIDES,
  findMunicipality,
} from './municipalities';

describe('the Andalusian municipality list', () => {
  it('holds every municipality of the eight provinces', () => {
    expect(ANDALUSIAN_MUNICIPALITIES.length).toBe(785);
    expect(Object.keys(ANDALUSIAN_PROVINCES).sort()).toEqual([
      '04', '11', '14', '18', '21', '23', '29', '41',
    ]);
  });

  it('finds the shop by its INE code, which is the default setting', () => {
    expect(findMunicipality('14055')).toEqual({
      ine: '14055',
      name: 'Priego de Córdoba',
      provinceIne: '14',
    });
  });

  it('answers nothing for a code that is not Andalusian', () => {
    expect(findMunicipality('28079')).toBeUndefined();
  });

  it('every INE code is five digits and unique', () => {
    const codes = ANDALUSIAN_MUNICIPALITIES.map((municipality) => municipality.ine);
    expect(codes.every((code) => /^\d{5}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every override points at a municipality that is in the list', () => {
    for (const ine of Object.values(JUNTA_NAME_OVERRIDES)) {
      expect(findMunicipality(ine), `override for ${ine}`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/holidays/municipalities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the generator**

```js
// scripts/generate-andalusian-municipalities.mjs
/**
 * Regenerates src/lib/holidays/municipalities.ts from festivos.io's directory of Spanish
 * municipalities. Run by hand -- the list changes when Spain creates or merges a municipality, which
 * is roughly never, so this is not part of the build.
 *
 *   node scripts/generate-andalusian-municipalities.mjs
 */
import fs from 'fs';
import path from 'path';

const INDEX_URL = 'https://festivos.io/v1/2026/index.json';
const OUT = path.join(process.cwd(), 'src', 'lib', 'holidays', 'municipalities.ts');

const PROVINCES = {
  '04': 'Almería', '11': 'Cádiz', '14': 'Córdoba', '18': 'Granada',
  '21': 'Huelva', '23': 'Jaén', '29': 'Málaga', '41': 'Sevilla',
};

const response = await fetch(INDEX_URL, { redirect: 'follow' });
if (!response.ok) throw new Error(`${INDEX_URL} answered ${response.status}`);
const index = await response.json();

const municipalities = index.municipalities
  .filter((entry) => entry.ccaa === 'ES-AN')
  .map((entry) => ({ ine: entry.ine, name: entry.name, provinceIne: entry.province_ine }))
  .sort((a, b) => a.ine.localeCompare(b.ine));

const lines = municipalities
  .map((m) => `  { ine: '${m.ine}', name: ${JSON.stringify(m.name)}, provinceIne: '${m.provinceIne}' },`)
  .join('\n');

fs.writeFileSync(
  OUT,
  `${HEADER}\nexport const ANDALUSIAN_PROVINCES: Readonly<Record<string, string>> = ${JSON.stringify(
    PROVINCES,
    null,
    2,
  )};\n\nexport const ANDALUSIAN_MUNICIPALITIES: readonly Municipality[] = [\n${lines}\n];\n${FOOTER}`,
  'utf8',
);
console.log(`${municipalities.length} municipalities written to ${OUT}`);
```

`HEADER` and `FOOTER` are string constants in the script holding the interface, the overrides table and `findMunicipality` — everything in the emitted file that is not the list itself. Write them so the emitted file is exactly what Step 4 describes.

- [ ] **Step 4: Generate the file and add the overrides by hand**

Run: `node scripts/generate-andalusian-municipalities.mjs`

The emitted `src/lib/holidays/municipalities.ts` must look like this (list abridged):

```ts
/**
 * GENERATED by scripts/generate-andalusian-municipalities.ts from festivos.io's directory. Do not
 * edit the list by hand -- edit JUNTA_NAME_OVERRIDES, which is hand-checked and is the only part of
 * this file a human owns.
 */

export interface Municipality {
  ine: string;
  name: string;
  provinceIne: string;
}

export const ANDALUSIAN_PROVINCES: Readonly<Record<string, string>> = {
  '04': 'Almería', '11': 'Cádiz', '14': 'Córdoba', '18': 'Granada',
  '21': 'Huelva', '23': 'Jaén', '29': 'Málaga', '41': 'Sevilla',
};

export const ANDALUSIAN_MUNICIPALITIES: readonly Municipality[] = [
  { ine: '04001', name: 'Abla', provinceIne: '04' },
  // … 783 more …
  { ine: '41102', name: 'Villaverde del Río', provinceIne: '41' },
];

/**
 * The nine municipalities the Junta dataset names differently from INE, measured over the 2026 rows:
 * 765 of 774 match once both sides are normalised, and these nine never will -- `BEJIJAR` against
 * `Begíjar` differs by a letter. The key is `juntaKey(name, province)`.
 */
export const JUNTA_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  'ZAHARA DE LA SIERRA|CADIZ': '11042',
  'DOMINGO PEREZ|GRANADA': '18915',
  'HUETOR SANTILLAN|GRANADA': '18099',
  'POLOPOS LA MAMOLA|GRANADA': '18162',
  'CORTELAZOR LA REAL|HUELVA': '21026',
  'BEJIJAR|JAEN': '23014',
  'HORNOS DE SEGURA|JAEN': '23043',
  'LA VINUELA|MALAGA': '29099',
  'ALANIS DE LA SIERRA|SEVILLA': '41002',
};

const BY_INE = new Map(ANDALUSIAN_MUNICIPALITIES.map((municipality) => [municipality.ine, municipality]));

export function findMunicipality(ine: string): Municipality | undefined {
  return BY_INE.get(ine);
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/lib/holidays/municipalities.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-andalusian-municipalities.mjs src/lib/holidays/municipalities.ts src/lib/holidays/municipalities.test.ts
git commit -m "feat(holidays): bring in the Andalusian municipality list"
```

---

### Task 4: Reading the Junta dataset

**Files:**
- Create: `src/lib/holidays/juntaDataset.ts`
- Test: `src/lib/holidays/juntaDataset.test.ts`

**Interfaces:**
- Consumes: `ANDALUSIAN_PROVINCES`, `JUNTA_NAME_OVERRIDES`, `findMunicipality` from `./municipalities`.
- Produces:
  ```ts
  export interface JuntaHoliday { date: string; officialName: string; level: 'regional' | 'local' }
  export function juntaKey(name: string, province: string): string;
  export function parseJuntaDataset(payload: unknown): JuntaHoliday[] | null;  // null = unusable
  export function holidaysForMunicipality(payload: unknown, ine: string): JuntaHoliday[] | null;
  ```

**The shape, verbatim from the real response:**

```json
{"id":"20269176","dateformat":"2026-09-03T00:00:00Z","event":"VEVENT","date":20260903,
 "description":"FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)",
 "municipality":"PRIEGO DE CÓRDOBA","province":"CÓRDOBA","year":"2026","type":"LOCAL"}
```

`date` is an **integer** `YYYYMMDD`, not a string, and `dateformat` is a UTC instant that must be ignored — deriving the calendar day from it is the trap invariant 6 exists for. `type` is `LABORAL` (all of Andalucía → `level: 'regional'`) or `LOCAL` (one municipality). A `LABORAL` row has `municipality: ""`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/holidays/juntaDataset.test.ts
import { describe, expect, it } from 'vitest';
import { holidaysForMunicipality, juntaKey, parseJuntaDataset } from './juntaDataset';

const REGIONAL = {
  id: '20269165', dateformat: '2026-02-28T00:00:00Z', event: 'VEVENT', date: 20260228,
  description: 'DÍA DE ANDALUCÍA', municipality: '', province: '', year: '2026', type: 'LABORAL',
};

const PRIEGO_LOCAL = {
  id: '20269176', dateformat: '2026-09-03T00:00:00Z', event: 'VEVENT', date: 20260903,
  description: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)',
  municipality: 'PRIEGO DE CÓRDOBA', province: 'CÓRDOBA', year: '2026', type: 'LOCAL',
};

const OTHER_TOWN_LOCAL = { ...PRIEGO_LOCAL, id: '1', date: 20260615,
  municipality: 'LUCENA', province: 'CÓRDOBA', description: 'FIESTA LOCAL EN LUCENA (CÓRDOBA)' };

describe('parsing the Junta dataset', () => {
  it('reads the integer date as a local calendar day, never the UTC instant', () => {
    expect(parseJuntaDataset([REGIONAL])).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
    ]);
  });

  it('returns null for a body that is not a list of rows', () => {
    expect(parseJuntaDataset({ rows: [] })).toBeNull();
    expect(parseJuntaDataset('<html>502 Bad Gateway</html>')).toBeNull();
    expect(parseJuntaDataset(null)).toBeNull();
  });

  it('DISCARDS THE WHOLE BODY when a row is malformed', () => {
    expect(parseJuntaDataset([REGIONAL, { ...PRIEGO_LOCAL, date: 20261332 }])).toBeNull();
    expect(parseJuntaDataset([REGIONAL, { ...PRIEGO_LOCAL, type: 'ESCOLAR' }])).toBeNull();
  });

  it('keeps every regional day and only the named town’s local ones', () => {
    const holidays = holidaysForMunicipality([REGIONAL, PRIEGO_LOCAL, OTHER_TOWN_LOCAL], '14055');
    expect(holidays).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
      { date: '2026-09-03', officialName: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)', level: 'local' },
    ]);
  });

  it('matches a town INE writes with the article at the end', () => {
    const ejido = { ...PRIEGO_LOCAL, date: 20260815, municipality: 'EL EJIDO', province: 'ALMERÍA' };
    expect(holidaysForMunicipality([ejido], '04902')?.length).toBe(1);
  });

  it('matches the nine the Junta spells its own way', () => {
    const begijar = { ...PRIEGO_LOCAL, date: 20260501, municipality: 'BEJIJAR', province: 'JAÉN' };
    expect(holidaysForMunicipality([begijar], '23014')?.length).toBe(1);
  });

  it('answers an empty list, not null, for a town with no local days', () => {
    expect(holidaysForMunicipality([REGIONAL], '14055')).toEqual([
      { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
    ]);
  });
});

describe('juntaKey', () => {
  it('strips accents, upper-cases, and moves a trailing article to the front', () => {
    expect(juntaKey('Ejido, El', 'Almería')).toBe(juntaKey('EL EJIDO', 'ALMERÍA'));
    expect(juntaKey('Vélez-Blanco', 'Almería')).toBe(juntaKey('VÉLEZ BLANCO', 'ALMERÍA'));
  });
});
```

`04902` is El Ejido's INE code — confirm it against `ANDALUSIAN_MUNICIPALITIES` while writing the test and use whatever the generated list says.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/holidays/juntaDataset.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

```ts
// src/lib/holidays/juntaDataset.ts
/**
 * The Junta de Andalucía's open-data work calendar, turned into dates. It is the SOURCE OF TRUTH for
 * WHICH days are holidays; it names the twelve regional ones and does not name a local one.
 */

import { isValidDate } from '../dates';
import {
  ANDALUSIAN_PROVINCES,
  JUNTA_NAME_OVERRIDES,
  findMunicipality,
} from './municipalities';

export interface JuntaHoliday {
  date: string;
  /** The dataset's own words, upper case. `officialNames.ts` turns it into something readable. */
  officialName: string;
  level: 'regional' | 'local';
}

interface RawRow {
  date: number;
  description: string;
  municipality: string;
  province: string;
  type: string;
}

/**
 * The comparison both sides of the municipality match go through. INE writes `Ejido, El` and
 * `Vélez-Blanco`; the Junta writes `EL EJIDO` and `VÉLEZ BLANCO`.
 */
export function juntaKey(name: string, province: string): string {
  return `${normalize(name)}|${normalize(province)}`;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/^(.*),\s*(EL|LA|LOS|LAS)$/, '$2 $1')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Every row, or `null`. A single malformed row discards the WHOLE body: a partial list would close
 * some days and silently leave others open, with nothing on screen to say which.
 */
export function parseJuntaDataset(payload: unknown): JuntaHoliday[] | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const holidays: JuntaHoliday[] = [];
  for (const entry of payload) {
    const row = asRow(entry);
    if (row === null) return null;
    const date = toLocalDate(row.date);
    if (date === null) return null;
    holidays.push({
      date,
      officialName: row.description.trim(),
      level: row.type === 'LABORAL' ? 'regional' : 'local',
    });
  }
  return holidays;
}

/** The regional days plus the local ones of `ine`, in calendar order, with no duplicate date. */
export function holidaysForMunicipality(payload: unknown, ine: string): JuntaHoliday[] | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const wanted: JuntaHoliday[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    const row = asRow(entry);
    if (row === null) return null;
    const date = toLocalDate(row.date);
    if (date === null) return null;
    if (row.type === 'LOCAL' && ineOf(row) !== ine) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    wanted.push({
      date,
      officialName: row.description.trim(),
      level: row.type === 'LABORAL' ? 'regional' : 'local',
    });
  }
  return wanted.sort((a, b) => a.date.localeCompare(b.date));
}

/** Which municipality a LOCAL row belongs to, by name, since the dataset carries no INE code. */
function ineOf(row: RawRow): string | undefined {
  const key = juntaKey(row.municipality, row.province);
  const override = JUNTA_NAME_OVERRIDES[key];
  if (override !== undefined) return override;
  for (const municipality of matchesByName(key)) return municipality;
  return undefined;
}

const BY_JUNTA_KEY = new Map<string, string>();
function matchesByName(key: string): string[] {
  if (BY_JUNTA_KEY.size === 0) {
    for (const [ine, name] of municipalityNames()) BY_JUNTA_KEY.set(name, ine);
  }
  const found = BY_JUNTA_KEY.get(key);
  return found === undefined ? [] : [found];
}

function* municipalityNames(): Generator<[string, string]> {
  const { ANDALUSIAN_MUNICIPALITIES } = require('./municipalities') as typeof import('./municipalities');
  for (const municipality of ANDALUSIAN_MUNICIPALITIES) {
    yield [municipality.ine, juntaKey(municipality.name, ANDALUSIAN_PROVINCES[municipality.provinceIne] ?? '')];
  }
}

function asRow(value: unknown): RawRow | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== 'number') return null;
  if (typeof row.description !== 'string') return null;
  if (typeof row.municipality !== 'string' || typeof row.province !== 'string') return null;
  if (row.type !== 'LABORAL' && row.type !== 'LOCAL') return null;
  return {
    date: row.date,
    description: row.description,
    municipality: row.municipality,
    province: row.province,
    type: row.type,
  };
}

/** `20260903` -> `"2026-09-03"`. `dateformat` is a UTC instant and is deliberately not read. */
function toLocalDate(value: number): string | null {
  const digits = String(value);
  if (!/^\d{8}$/.test(digits)) return null;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return isValidDate(date) ? date : null;
}
```

**Replace the `require`/generator pair above with a plain top-level import and a module-level `Map` built once** — it is written that way here only to show the two lookups; `require` in a TypeScript module will fail lint. The implementer writes:

```ts
import { ANDALUSIAN_MUNICIPALITIES, ANDALUSIAN_PROVINCES, JUNTA_NAME_OVERRIDES } from './municipalities';

const BY_JUNTA_KEY = new Map<string, string>(
  ANDALUSIAN_MUNICIPALITIES.map((municipality) => [
    juntaKey(municipality.name, ANDALUSIAN_PROVINCES[municipality.provinceIne] ?? ''),
    municipality.ine,
  ]),
);

function ineOf(row: RawRow): string | undefined {
  const key = juntaKey(row.municipality, row.province);
  return JUNTA_NAME_OVERRIDES[key] ?? BY_JUNTA_KEY.get(key);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/holidays/juntaDataset.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/holidays/juntaDataset.ts src/lib/holidays/juntaDataset.test.ts
git commit -m "feat(holidays): read the Junta dataset into dates"
```

---

### Task 5: Naming a holiday

**Files:**
- Create: `src/lib/holidays/officialNames.ts`
- Create: `src/lib/holidays/festivosIo.ts`
- Create: `src/lib/holidays/compose.ts`
- Test: `src/lib/holidays/compose.test.ts`

**Interfaces:**
- Consumes: `JuntaHoliday` from `./juntaDataset`; `CachedHoliday` from `../repositories/holidays`.
- Produces:
  ```ts
  // officialNames.ts
  export const GENERIC_LOCAL_NAME = 'Fiesta local';
  export function readableOfficialName(upperCase: string): string | undefined;

  // festivosIo.ts
  export function parseFestivosIo(payload: unknown): Map<string, string>;  // date -> name.es

  // compose.ts
  export function composeHolidays(
    dates: readonly JuntaHoliday[],
    names: ReadonlyMap<string, string>,
  ): CachedHoliday[];
  ```

**The festivos.io shape, verbatim:** `{ "holidays": [ { "date": "2026-09-01", "name": { "es": "…" }, "level": "national" } ] }`. Anything else in the body is ignored, and a body that cannot be read is **an empty map, not an error** — a missing name is never a failed check.

The twelve regional strings the Junta uses, upper-case, are a written table because Spanish title-casing is not an algorithm: `AÑO NUEVO`, `EPIFANÍA DEL SEÑOR`, `DÍA DE ANDALUCÍA`, `JUEVES SANTO`, `VIERNES SANTO`, `FIESTA DEL TRABAJO`, `FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN`, `ASUNCIÓN DE LA VIRGEN`, `FIESTA NACIONAL DE ESPAÑA`, `FIESTA DE TODOS LOS SANTOS`, `TODOS LOS SANTOS`, `DÍA DE LA CONSTITUCIÓN ESPAÑOLA`, `INMACULADA CONCEPCIÓN`, `DÍA DE LA INMACULADA CONCEPCIÓN`, `NATIVIDAD DEL SEÑOR`. Both spellings of Asunción, Todos los Santos and Inmaculada appear — 2026 and 2027 word three of them differently, which is why the table is keyed by the exact string and not by the date.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/holidays/compose.test.ts
import { describe, expect, it } from 'vitest';
import { composeHolidays } from './compose';
import { parseFestivosIo } from './festivosIo';
import { GENERIC_LOCAL_NAME } from './officialNames';
import type { JuntaHoliday } from './juntaDataset';

const DATES: JuntaHoliday[] = [
  { date: '2026-02-28', officialName: 'DÍA DE ANDALUCÍA', level: 'regional' },
  { date: '2026-09-03', officialName: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)', level: 'local' },
];

describe('parsing festivos.io', () => {
  it('reads the Spanish name of every holiday it lists', () => {
    const names = parseFestivosIo({
      holidays: [
        { date: '2026-09-03', name: { es: 'Feria Real de Priego de Córdoba' }, level: 'local' },
        { date: '2026-02-28', name: { es: 'Día de Andalucía' }, level: 'regional' },
      ],
    });
    expect(names.get('2026-09-03')).toBe('Feria Real de Priego de Córdoba');
  });

  it('is an EMPTY MAP and never a throw for a body it cannot read', () => {
    expect(parseFestivosIo(null).size).toBe(0);
    expect(parseFestivosIo({ error: 'Not Found' }).size).toBe(0);
    expect(parseFestivosIo({ holidays: [{ date: 'nope', name: {} }] }).size).toBe(0);
  });
});

describe('composing a holiday', () => {
  it('prefers the name festivos.io gives', () => {
    const names = new Map([['2026-09-03', 'Feria Real de Priego de Córdoba']]);
    expect(composeHolidays(DATES, names)).toEqual([
      { date: '2026-02-28', name: 'Día de Andalucía', level: 'regional' },
      { date: '2026-09-03', name: 'Feria Real de Priego de Córdoba', level: 'local' },
    ]);
  });

  it('falls back to the written table for a regional day', () => {
    expect(composeHolidays(DATES, new Map())[0].name).toBe('Día de Andalucía');
  });

  it('falls back to a GENERIC name for a local day, which is the normal first state', () => {
    expect(composeHolidays(DATES, new Map())[1].name).toBe(GENERIC_LOCAL_NAME);
  });

  it('falls back to the dataset’s own words for a regional string nobody has written down', () => {
    const odd: JuntaHoliday[] = [{ date: '2028-03-19', officialName: 'SAN JOSÉ', level: 'regional' }];
    expect(composeHolidays(odd, new Map())[0].name).toBe('SAN JOSÉ');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/holidays/compose.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the three modules**

```ts
// src/lib/holidays/officialNames.ts
/**
 * The dataset writes every name in upper case and gives a local holiday no name at all. Spanish
 * title-casing is not an algorithm -- `DÍA DE LA CONSTITUCIÓN ESPAÑOLA` keeps two words lower and
 * capitalises a third -- so the fifteen strings the calendar actually uses are written out.
 *
 * Both spellings of three of them appear: 2026 says `FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN` where 2027
 * says `ASUNCIÓN DE LA VIRGEN`, which is why the key is the exact string and not the date.
 */

/** What a local holiday is called until festivos.io publishes its real name. */
export const GENERIC_LOCAL_NAME = 'Fiesta local';

const NAMES: Readonly<Record<string, string>> = {
  'AÑO NUEVO': 'Año Nuevo',
  'EPIFANÍA DEL SEÑOR': 'Epifanía del Señor',
  'DÍA DE ANDALUCÍA': 'Día de Andalucía',
  'JUEVES SANTO': 'Jueves Santo',
  'VIERNES SANTO': 'Viernes Santo',
  'FIESTA DEL TRABAJO': 'Fiesta del Trabajo',
  'FESTIVIDAD DE ASUNCIÓN DE LA VIRGEN': 'Asunción de la Virgen',
  'ASUNCIÓN DE LA VIRGEN': 'Asunción de la Virgen',
  'FIESTA NACIONAL DE ESPAÑA': 'Fiesta Nacional de España',
  'FIESTA DE TODOS LOS SANTOS': 'Todos los Santos',
  'TODOS LOS SANTOS': 'Todos los Santos',
  'DÍA DE LA CONSTITUCIÓN ESPAÑOLA': 'Día de la Constitución Española',
  'INMACULADA CONCEPCIÓN': 'Inmaculada Concepción',
  'DÍA DE LA INMACULADA CONCEPCIÓN': 'Inmaculada Concepción',
  'NATIVIDAD DEL SEÑOR': 'Natividad del Señor',
};

export function readableOfficialName(upperCase: string): string | undefined {
  return NAMES[upperCase.trim()];
}
```

```ts
// src/lib/holidays/festivosIo.ts
/**
 * festivos.io, read for ONE thing: the human name of a day. Its own `source.ref` on the Andalusian
 * local rows names the Junta dataset, so it is a naming layer over the same official data rather
 * than a second opinion about the dates -- and it publishes a year months after the Junta does.
 *
 * A body it cannot read is an EMPTY MAP and never a throw: a missing name is not a failed check.
 */

import { isValidDate } from '../dates';

export function parseFestivosIo(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (payload === null || typeof payload !== 'object') return names;
  const holidays = (payload as { holidays?: unknown }).holidays;
  if (!Array.isArray(holidays)) return names;

  for (const entry of holidays) {
    if (entry === null || typeof entry !== 'object') continue;
    const { date, name } = entry as { date?: unknown; name?: unknown };
    if (typeof date !== 'string' || !isValidDate(date)) continue;
    if (name === null || typeof name !== 'object') continue;
    const spanish = (name as { es?: unknown }).es;
    if (typeof spanish !== 'string' || spanish.trim() === '') continue;
    names.set(date, spanish.trim());
  }
  return names;
}
```

```ts
// src/lib/holidays/compose.ts
/**
 * Dates from the Junta, names from festivos.io, and a fallback for every date the second one does
 * not reach -- which for a local holiday is the NORMAL first state, since the date is published
 * months before anyone names it.
 */

import type { CachedHoliday } from '../repositories/holidays';
import type { JuntaHoliday } from './juntaDataset';
import { GENERIC_LOCAL_NAME, readableOfficialName } from './officialNames';

export function composeHolidays(
  dates: readonly JuntaHoliday[],
  names: ReadonlyMap<string, string>,
): CachedHoliday[] {
  return dates.map((holiday) => ({
    date: holiday.date,
    name: names.get(holiday.date) ?? fallbackName(holiday),
    level: holiday.level,
  }));
}

function fallbackName(holiday: JuntaHoliday): string {
  if (holiday.level === 'local') return GENERIC_LOCAL_NAME;
  return readableOfficialName(holiday.officialName) ?? holiday.officialName;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/holidays/compose.test.ts && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/holidays/officialNames.ts src/lib/holidays/festivosIo.ts src/lib/holidays/compose.ts src/lib/holidays/compose.test.ts
git commit -m "feat(holidays): name a holiday, with a fallback for the year not yet published"
```

---

### Task 6: The two HTTP calls

**Files:**
- Create: `src/lib/holidays/fetch.ts`
- Test: `src/lib/holidays/fetch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HolidaySource {
    /** The whole Junta dataset, parsed JSON, or `null` if it could not be had. */
    dates(): Promise<unknown | null>;
    /** festivos.io for one municipality and year, parsed JSON, or `null`. */
    names(ine: string, year: number): Promise<unknown | null>;
  }
  export const HTTP_SOURCE: HolidaySource;
  export const JUNTA_URL: string;
  export function festivosIoUrl(ine: string, year: number): string;
  ```

**The trap, measured:** the Junta URL answers **302** to `https://www.juntadeandalucia.es/ssdigitales/festa/download-pro/dataset-work-calendar.json`. A fetch that does not follow redirects gets a 145-byte nginx page and every date silently disappears. Node's `fetch` follows by default; `redirect: 'follow'` is written out anyway so a later edit cannot remove it by accident.

Every call is bounded by `AbortSignal.timeout(20_000)` — the shop PC must not hang on a dead host at start-up — and a failure of any kind (timeout, non-2xx, unparseable JSON) comes back as `null`. Nothing here throws.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/holidays/fetch.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_SOURCE, JUNTA_URL, festivosIoUrl } from './fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => handler(String(input))));
}

describe('the holiday source', () => {
  it('asks the Junta for the whole dataset, following redirects', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(new Response('[{"date":20260101}]', { status: 200 }));
      }),
    );

    await expect(HTTP_SOURCE.dates()).resolves.toEqual([{ date: 20260101 }]);
    expect(seen[0]?.redirect).toBe('follow');
  });

  it('builds the festivos.io URL from the INE code and the year', () => {
    expect(festivosIoUrl('14055', 2026)).toBe('https://festivos.io/v1/2026/municipio/14055.json');
  });

  it('answers null on a non-2xx, and never throws', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));
    await expect(HTTP_SOURCE.names('14055', 2027)).resolves.toBeNull();
  });

  it('answers null on a body that is not JSON', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 200 }));
    await expect(HTTP_SOURCE.dates()).resolves.toBeNull();
  });

  it('answers null when the request throws', async () => {
    stubFetch(() => Promise.reject(new Error('ENOTFOUND')));
    await expect(HTTP_SOURCE.dates()).resolves.toBeNull();
  });

  it('names the official endpoint, which is the one that carries the furthest year', () => {
    expect(JUNTA_URL).toContain('datos.juntadeandalucia.es');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/holidays/fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

```ts
// src/lib/holidays/fetch.ts
/**
 * The only module here that touches the network. Everything else takes a payload, so the whole
 * feature is testable without one.
 *
 * `JUNTA_URL` answers 302 to juntaandalucia.es/ssdigitales/...; a fetch that does not follow the
 * redirect gets a 145-byte nginx page and every date silently disappears.
 */

/** Official, CC BY 4.0, no key. Ignores every query parameter and always returns the whole file. */
export const JUNTA_URL = 'https://datos.juntadeandalucia.es/api/v0/work-calendar/all?format=json';

/** The shop PC must not hang on a dead host while the app is starting. */
const TIMEOUT_MS = 20_000;

export function festivosIoUrl(ine: string, year: number): string {
  return `https://festivos.io/v1/${year}/municipio/${ine}.json`;
}

export interface HolidaySource {
  dates(): Promise<unknown | null>;
  names(ine: string, year: number): Promise<unknown | null>;
}

export const HTTP_SOURCE: HolidaySource = {
  dates: () => getJson(JUNTA_URL),
  names: (ine, year) => getJson(festivosIoUrl(ine, year)),
};

/** Every failure is `null`: a timeout, a 404, a redirect to an error page, a body that is not JSON. */
async function getJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/holidays/fetch.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/holidays/fetch.ts src/lib/holidays/fetch.test.ts
git commit -m "feat(holidays): fetch the dates and the names, failing to null"
```

---

### Task 7: Closing a day asks instead of refusing

**Files:**
- Modify: `src/lib/operations/absences.ts` (`assertDayCanClose`, `AbsenceInput`, `writeAbsence`)
- Modify: `src/lib/errors.ts` (`ERROR_MESSAGE_KEYS`), `public/locales/{es,en}/common.json`
- Test: `src/lib/operations.test.ts` (the closed-days `describe`)

**Interfaces:**
- Produces: `AbsenceInput.keepWork?: readonly string[]` — the dates on which the day's movable work is padlocked and kept instead of displaced. Unknown dates in the list are ignored, not refused.

**The rule this changes.** `assertDayCanClose` throws 409 `closed-day-over-fixed-block` for a conflict of any reason. From now on **only `past` refuses.** A closed day is a weekend to the engine, and a weekend has always held padlocked work; `locked` and `weekend` conflicts stop being refusals and the day closes around them.

`ERROR_MESSAGE_KEYS.closedDayOverLockedBlock` and `…WeekendBlock` are now unreachable — **delete both keys and both pairs of locale strings**, or `locales.test.ts` will keep asserting a sentence nothing can produce. `closedDayOverPastBlock` stays.

- [ ] **Step 1: Write the failing tests**

Add to the closed-days section of `src/lib/operations.test.ts`:

```ts
it('closes a day around work the engine cannot move, instead of refusing', () => {
  const railing = addJob(db, 'Railing', 6);
  lockBlockOn(db, railing, TUE);

  const result = saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, reason: 'Fair', today: MON }, db);

  expect(result.dates).toEqual([TUE]);
  expect(listBlocks(db).filter((block) => block.date === TUE)).toHaveLength(1);
});

it('still refuses over the PAST, which stays frozen', () => {
  const railing = addJob(db, 'Railing', 6);
  insertBlock({ /* a row on LAST_FRI */ }, db);

  expect(() => saveAbsence({ kind: 'closed-days', from: LAST_FRI, to: LAST_FRI, today: MON }, db))
    .toThrow(AppError);
});

it('displaces movable work by default', () => {
  addJob(db, 'Railing', 6);
  saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, today: MON }, db);

  expect(listBlocks(db).some((block) => block.date === TUE)).toBe(false);
});

it('KEEPS the work and padlocks it when the date is named in keepWork', () => {
  addJob(db, 'Railing', 6);

  saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, keepWork: [TUE], today: MON }, db);

  const onTuesday = listBlocks(db).filter((block) => block.date === TUE);
  expect(onTuesday).toHaveLength(1);
  expect(onTuesday[0].locked).toBe(true);
});

it('keepWork never touches a day it does not name', () => {
  addJob(db, 'Railing', 16);
  saveAbsence({ kind: 'closed-days', from: TUE, to: WED, keepWork: [TUE], today: MON }, db);

  expect(listBlocks(db).filter((block) => block.date === WED)).toHaveLength(0);
  expect(listBlocks(db).filter((block) => block.date === TUE)[0]?.locked).toBe(true);
});

it('keepWork never reaches the past and never clears a padlock', () => {
  const railing = addJob(db, 'Railing', 6);
  lockBlockOn(db, railing, TUE);

  saveAbsence({ kind: 'closed-days', from: TUE, to: TUE, today: MON }, db);

  expect(listBlocks(db).filter((block) => block.date === TUE)[0]?.locked).toBe(true);
});
```

Reuse the file's own helpers for `addJob` and for padlocking a row (`updateBlock` with `locked: true`, or `setBlockLock`). Do not invent new ones.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/operations.test.ts -t 'closes a day around work'`
Expected: FAIL — the save throws `closed-day-over-fixed-block`.

- [ ] **Step 3: Narrow the refusal and add `keepWork`**

In `src/lib/operations/absences.ts`:

```ts
// AbsenceInput gains:
  /**
   * Dates whose work stays where it is instead of being displaced. Every movable row on such a day
   * is PADLOCKED, because the padlock is the only thing that holds a row on a day the engine plans
   * nothing on. A date not in the range is ignored.
   */
  keepWork?: readonly string[];

// assertDayCanClose becomes:
/**
 * A closed day is a weekend to the engine, and a weekend has always held padlocked work. Only the
 * PAST refuses: it cannot be written to at all, so a day with a past row on it could not be closed
 * even if the owner asked for it.
 */
function assertDayCanClose(date: string, today: string, db: Db): void {
  // Asked of the DATE and NOT of the conflict's `reason`. A padlocked row on a past day is
  // classified `locked`, because the reason names the block's own state first, so
  // `.filter((c) => c.reason === 'past')` lets exactly the case that matters through and a past
  // day becomes closeable. Measured: the test for the frozen past is what catches it.
  if (compareDates(date, today) >= 0) return;

  const conflicts = findGapConflicts(
    listBlocks(db),
    { date, startMinutes: 0, durationMinutes: MINUTES_PER_DAY },
    today,
  );
  if (conflicts.length === 0) return;

  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  const headline = conflicts[0];
  throw conflict('closed-day-over-fixed-block', ERROR_MESSAGE_KEYS.closedDayOverPastBlock, {
    details: {
      projectName: names.get(headline.projectId) ?? '',
      date: headline.date,
      startTime: minutesToHHmm(headline.startMinutes),
      endTime: minutesToHHmm(headline.startMinutes + headline.durationMinutes),
      reason: headline.reason,
    },
  });
}

/**
 * Padlocks the movable rows of a day the caller asked to keep. Never the past, and never a row that
 * is padlocked already -- setting a flag that is set is a no-op, but reaching a past row is not.
 */
function keepWorkOn(dates: readonly string[], today: string, db: Db): void {
  for (const date of dates) {
    if (compareDates(date, today) < 0) continue;
    for (const block of listBlocks(db)) {
      if (block.date !== date || block.locked) continue;
      updateBlock({ ...block, locked: true }, db);
    }
  }
}
```

and inside `writeAbsence`'s `closed-days` branch, **before** the `upsertDayOverride` loop:

```ts
    keepWorkOn(input.keepWork ?? [], today, db);
```

Delete `CONFLICT_KEYS` and the two now-unreachable keys from `ERROR_MESSAGE_KEYS`, and their four locale strings.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/operations.test.ts src/lib/locales.test.ts`
Expected: PASS. Existing cases that asserted the two deleted refusals must be **rewritten to the new behaviour**, not deleted — they are the proof the day now closes.

- [ ] **Step 5: Run every gate**

Run: `npm test && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/operations/absences.ts src/lib/errors.ts src/lib/operations.test.ts public/locales
git commit -m "feat(absences): close a day around fixed work instead of refusing"
```

---

### Task 8: The preview says what is on each day

**Files:**
- Modify: `src/lib/operations/absences.ts` (`AbsencePreview`, `previewAbsence`)
- Test: `src/lib/operations.test.ts` (the preview `describe`)

**Interfaces:**
- Produces:
  ```ts
  export interface DayWorkRow { projectId: string; name: string; minutes: number; locked: boolean }
  export interface DayWork { date: string; rows: DayWorkRow[] }
  // AbsencePreview gains:
  //   /** Work sitting on each day of the range BEFORE the write. Empty days are omitted. */
  //   daysWithWork: DayWork[];
  ```

Read **before** the dry run, from `listBlocks`, so it describes the calendar the owner is looking at rather than the one the rolled-back write briefly made. Rows are summed per project per day, so a job split across the lunch break is one line and not two.

- [ ] **Step 1: Write the failing test**

```ts
it('names the work sitting on each day of the range, summed per job', () => {
  addJob(db, 'Railing', 6);
  addJob(db, 'Staircase', 4);

  const preview = previewAbsence({ kind: 'closed-days', from: MON, to: TUE, today: MON }, db);

  expect(preview.daysWithWork.map((day) => day.date)).toEqual([MON, TUE]);
  expect(preview.daysWithWork[0].rows.map((row) => row.name)).toEqual(['Railing', 'Staircase']);
  expect(preview.daysWithWork[0].rows[0].minutes).toBe(360);
  expect(preview.daysWithWork[0].rows[0].locked).toBe(false);
});

it('omits a day with nothing on it', () => {
  const preview = previewAbsence({ kind: 'closed-days', from: MON, to: TUE, today: MON }, db);
  expect(preview.daysWithWork).toEqual([]);
});

it('says a row is padlocked, so the panel can offer no choice about it', () => {
  const railing = addJob(db, 'Railing', 6);
  lockBlockOn(db, railing, MON);

  const preview = previewAbsence({ kind: 'closed-days', from: MON, to: MON, today: MON }, db);
  expect(preview.daysWithWork[0].rows[0].locked).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/operations.test.ts -t 'names the work sitting'`
Expected: FAIL — `daysWithWork` does not exist.

- [ ] **Step 3: Implement it**

```ts
// in src/lib/operations/absences.ts, near displacedWork:

export interface DayWorkRow {
  projectId: string;
  name: string;
  /** Net working minutes of this job on this day, summed across its rows. */
  minutes: number;
  locked: boolean;
}

export interface DayWork {
  date: string;
  rows: DayWorkRow[];
}

/**
 * What sits on each day of the range as it stands NOW. Read before the dry run, so it describes the
 * calendar the owner is looking at rather than the one the rolled-back write briefly made.
 */
function workByDay(dates: readonly string[], db: Db): DayWork[] {
  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  const wanted = new Set(dates);
  const byDate = new Map<string, Map<string, DayWorkRow>>();

  for (const block of listBlocks(db)) {
    if (!wanted.has(block.date)) continue;
    let rows = byDate.get(block.date);
    if (rows === undefined) {
      rows = new Map<string, DayWorkRow>();
      byDate.set(block.date, rows);
    }
    const existing = rows.get(block.projectId);
    if (existing === undefined) {
      rows.set(block.projectId, {
        projectId: block.projectId,
        name: names.get(block.projectId) ?? '',
        minutes: block.durationMinutes,
        locked: block.locked,
      });
    } else {
      existing.minutes += block.durationMinutes;
      // One padlocked row is enough to make the day's work unmovable, so the flag is an OR.
      existing.locked = existing.locked || block.locked;
    }
  }

  return dates
    .filter((date) => byDate.has(date))
    .map((date) => ({ date, rows: [...(byDate.get(date) ?? new Map()).values()] }));
}
```

In `previewAbsence`, before `dryRun`, capture `const daysWithWork = workByDay(resolveRange(input).dates, db);` and return it on the preview.

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run src/lib/operations.test.ts && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/absences.ts src/lib/operations.test.ts
git commit -m "feat(absences): report the work sitting on each day of a range"
```

---

### Task 9: The pass — what it writes

**Files:**
- Create: `src/lib/operations/holidays.ts`
- Test: `src/lib/operations/holidays.test.ts`

**Interfaces:**
- Consumes: `HolidaySource`, `HTTP_SOURCE` (Task 6); `holidaysForMunicipality` (Task 4); `composeHolidays`, `parseFestivosIo` (Task 5); the repository (Task 1); `saveAbsence` and `AbsenceInput.keepWork` (Task 7); `workByDay` via `previewAbsence` (Task 8).
- Produces:
  ```ts
  export const CHECK_EVERY_DAYS = 7;

  export interface PendingHoliday { date: string; name: string; rows: DayWorkRow[] }

  export interface HolidayCheckResult {
    /** Why nothing happened, so the UI can stay quiet rather than guess. */
    skipped?: 'disabled' | 'not-due' | 'offline';
    /** Days closed with no question asked. */
    closed: string[];
    /** Days renamed in place — never reopened and rewritten. */
    renamed: string[];
    /** Days reopened because they stopped being holidays. */
    reopened: string[];
    /** Days that have work on them and are waiting for an answer. NOTHING was written for these. */
    pending: PendingHoliday[];
    /** Days that could not be written, with the code that refused them. */
    refused: Array<{ date: string; code: string }>;
    state: HolidayState;
  }

  export interface HolidayState {
    enabled: boolean;
    municipality: string;
    municipalityName: string;
    count: number;
    /** The furthest holiday the app knows about, or null. */
    knownThrough: string | null;
    lastCheckedAt: string | null;
    lastCheckSucceeded: boolean;
  }

  export function readHolidayState(db?: Db): HolidayState;
  export function runHolidayCheck(
    options?: { today?: string; now?: Date; force?: boolean; source?: HolidaySource },
    db?: Db,
  ): Promise<HolidayCheckResult>;
  export function applyHolidayAnswers(
    answers: ReadonlyArray<{ date: string; keep: boolean }>,
    options?: { today?: string },
    db?: Db,
  ): HolidayCheckResult;
  ```

`source` and `now` are injected so **no test reaches the network or the clock**. `force: true` is the *Consultar ahora* button and skips the not-due check but not the disabled one.

**Order of operations, and it is load-bearing:**

1. `holidaysEnabled` off → `skipped: 'disabled'`, nothing else runs.
2. Not `force`, and `readHolidayCheck().checkedAt` is less than `CHECK_EVERY_DAYS` old → `skipped: 'not-due'`.
3. Fetch. `dates()` null or unparseable → record the failed check, `skipped: 'offline'`, **leave the cache exactly as it is**.
4. **Read the old cache now**, before anything replaces it. It is the only record of what the app wrote.
5. Compose the new list. For every future date decide: nothing there → close; a row there whose note equals the old cache's name → rename in place or leave; anything else → leave alone. A future cached date that is no longer a holiday and still carries the app's note → reopen.
6. Write, in one transaction, and only then `replaceCachedHolidays` and `recordHolidayCheck`.

- [ ] **Step 1: Write the failing tests — the writing half**

```ts
// src/lib/operations/holidays.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from '../db';
import { writeSettings } from '../settings';
import { listDayOverrides } from '../repositories/dayOverrides';
import { listCachedHolidays, readHolidayCheck } from '../repositories/holidays';
import type { HolidaySource } from '../holidays/fetch';
import { runHolidayCheck } from './holidays';
import { MON, TUE, WED, SAT } from '../../testing/fixtures';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

/** A source that answers with rows shaped exactly like the Junta's, and no names at all. */
function sourceWith(rows: Array<{ date: string; type: 'LABORAL' | 'LOCAL'; description: string }>): HolidaySource {
  return {
    dates: () =>
      Promise.resolve(
        rows.map((row) => ({
          id: row.date,
          dateformat: `${row.date}T00:00:00Z`,
          event: 'VEVENT',
          date: Number(row.date.replaceAll('-', '')),
          description: row.description,
          municipality: row.type === 'LOCAL' ? 'PRIEGO DE CÓRDOBA' : '',
          province: row.type === 'LOCAL' ? 'CÓRDOBA' : '',
          year: row.date.slice(0, 4),
          type: row.type,
        })),
      ),
    names: () => Promise.resolve(null),
  };
}

const NOW = new Date('2026-08-10T08:00:00Z');

describe('the holiday check', () => {
  it('closes a holiday with nothing on it, silently', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);

    const result = await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(result.closed).toEqual([TUE]);
    expect(result.pending).toEqual([]);
    expect(listDayOverrides(db)).toEqual([
      { date: TUE, isClosed: true, capacityHours: null, note: 'Año Nuevo' },
    ]);
  });

  it('writes a holiday that falls on a SATURDAY', async () => {
    const source = sourceWith([{ date: SAT, type: 'LABORAL', description: 'NATIVIDAD DEL SEÑOR' }]);

    const result = await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(result.closed).toEqual([SAT]);
  });

  it('never writes before today', async () => {
    const source = sourceWith([{ date: '2026-08-05', type: 'LABORAL', description: 'AÑO NUEVO' }]);

    const result = await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(result.closed).toEqual([]);
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('running it twice changes nothing', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);

    await runHolidayCheck({ today: MON, now: NOW, source }, db);
    const second = await runHolidayCheck({ today: MON, now: NOW, force: true, source }, db);

    expect(second.closed).toEqual([]);
    expect(listDayOverrides(db)).toHaveLength(1);
  });

  it('is skipped while the switch is off', async () => {
    writeSettings({ holidaysEnabled: false }, db);
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);

    expect((await runHolidayCheck({ today: MON, now: NOW, source }, db)).skipped).toBe('disabled');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('is not due again within seven days, and force overrides that', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    const soon = new Date('2026-08-12T08:00:00Z');
    expect((await runHolidayCheck({ today: MON, now: soon, source }, db)).skipped).toBe('not-due');
    expect((await runHolidayCheck({ today: MON, now: soon, force: true, source }, db)).skipped)
      .toBeUndefined();
  });

  it('leaves the cache alone and says offline when the source cannot be reached', async () => {
    const good = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);
    await runHolidayCheck({ today: MON, now: NOW, source: good }, db);

    const dead: HolidaySource = { dates: () => Promise.resolve(null), names: () => Promise.resolve(null) };
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: dead }, db);

    expect(result.skipped).toBe('offline');
    expect(listCachedHolidays(db)).toHaveLength(1);
    expect(readHolidayCheck(db)?.succeeded).toBe(false);
  });

  it('discards a truncated body whole rather than closing half the days', async () => {
    const broken: HolidaySource = {
      dates: () => Promise.resolve([{ date: 20260811, description: 'AÑO NUEVO', type: 'LABORAL' }, 'oops']),
      names: () => Promise.resolve(null),
    };

    expect((await runHolidayCheck({ today: MON, now: NOW, source: broken }, db)).skipped).toBe('offline');
    expect(listDayOverrides(db)).toEqual([]);
  });

  it('leaves a day the owner already closed exactly as it is', async () => {
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Breakdown' }, db);
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);

    await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(listDayOverrides(db)[0].note).toBe('Breakdown');
  });

  it('does not write a holiday that has work on it — it asks', async () => {
    addJob(db, 'Railing', 6);            // lands on MON
    const source = sourceWith([{ date: MON, type: 'LABORAL', description: 'AÑO NUEVO' }]);

    const result = await runHolidayCheck({ today: MON, now: NOW, source }, db);

    expect(result.closed).toEqual([]);
    expect(result.pending.map((day) => day.date)).toEqual([MON]);
    expect(result.pending[0].rows[0].name).toBe('Railing');
    expect(listDayOverrides(db)).toEqual([]);
  });
});

describe('answering the panel', () => {
  it('displaces the work when the answer is no', () => { /* applyHolidayAnswers([{date: MON, keep: false}]) */ });
  it('padlocks and keeps the work when the answer is yes', () => { /* keep: true */ });
});
```

Write `addJob` and `upsertDayOverride` imports the way `operations.test.ts` does; do not invent a new fixture week.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/operations/holidays.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the operation**

Implement `src/lib/operations/holidays.ts` against the interface block above and the order of operations listed before Step 1. Points the tests pin down and the implementer must not drift from:

- `CHECK_EVERY_DAYS = 7`, compared as **elapsed milliseconds** against `readHolidayCheck()?.checkedAt`, exactly as `backupIsDue` does — never a calendar-day subtraction.
- The years fetched are every year present in the Junta payload; nothing filters by year, because the payload is the horizon.
- A holiday is **pending** when `previewAbsence`-style day work is non-empty for its date. Reuse `workByDay` — export it from `operations/absences.ts` rather than writing a second one.
- Writing is one call to `saveAbsence({ kind: 'closed-days', from, to, reason, keepWork, today })` **per date**, because each holiday carries its own reason. Wrap the whole loop in `runTransaction` so one refusal cannot leave half the holidays written; catch an `AppError` per date, record it in `refused`, and carry on with the rest — a horizon failure on 8 December must not cost the other thirteen.
- `replaceCachedHolidays` and `recordHolidayCheck` run **after** the write loop, inside the same transaction.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/operations/holidays.test.ts && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/holidays.ts src/lib/operations/holidays.test.ts src/lib/operations/absences.ts
git commit -m "feat(holidays): close the holidays a check finds, asking where work sits"
```

---

### Task 10: The pass — what it maintains

**Files:**
- Modify: `src/lib/operations/holidays.ts`
- Test: `src/lib/operations/holidays.test.ts` (append)

This is the section of the spec most likely to be broken by a plausible-looking change, so its tests are the ones to write first and hardest.

- [ ] **Step 1: Write the failing tests**

```ts
describe('what a later check maintains', () => {
  it('RENAMES a day it still owns when the name finally arrives', async () => {
    const dates = [{ date: TUE, type: 'LOCAL' as const, description: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    expect(listDayOverrides(db)[0].note).toBe('Fiesta local');

    const named: HolidaySource = {
      ...sourceWith(dates),
      names: () => Promise.resolve({ holidays: [{ date: TUE, name: { es: 'Feria Real de Priego de Córdoba' } }] }),
    };
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    expect(result.renamed).toEqual([TUE]);
    expect(listDayOverrides(db)[0].note).toBe('Feria Real de Priego de Córdoba');
  });

  it('a rename MOVES NO HOURS and does not reopen the day', async () => {
    addJob(db, 'Railing', 6);
    const dates = [{ date: MON, type: 'LOCAL' as const, description: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    applyHolidayAnswers([{ date: MON, keep: true }], { today: MON }, db);

    const before = listBlocks(db).map((block) => ({ ...block }));

    const named: HolidaySource = {
      ...sourceWith(dates),
      names: () => Promise.resolve({ holidays: [{ date: MON, name: { es: 'Feria Real de Priego de Córdoba' } }] }),
    };
    await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    expect(listBlocks(db)).toEqual(before);
    expect(listDayOverrides(db)[0].isClosed).toBe(true);
    expect(listDayOverrides(db)[0].note).toBe('Feria Real de Priego de Córdoba');
  });

  it('NEVER renames a day whose note the owner rewrote', async () => {
    const dates = [{ date: TUE, type: 'LOCAL' as const, description: 'FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)' }];
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith(dates) }, db);
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    const named: HolidaySource = {
      ...sourceWith(dates),
      names: () => Promise.resolve({ holidays: [{ date: TUE, name: { es: 'Feria Real de Priego de Córdoba' } }] }),
    };
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: named }, db);

    expect(result.renamed).toEqual([]);
    expect(listDayOverrides(db)[0].note).toBe('Fair');
  });

  it('REOPENS a day that stopped being a holiday, while it still carries the app’s note', async () => {
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]) }, db);

    const moved = sourceWith([{ date: WED, type: 'LABORAL', description: 'AÑO NUEVO' }]);
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: moved }, db);

    expect(result.reopened).toEqual([TUE]);
    expect(result.closed).toEqual([WED]);
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([WED]);
  });

  it('does NOT reopen a day the owner has since renamed', async () => {
    await runHolidayCheck({ today: MON, now: NOW, source: sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]) }, db);
    upsertDayOverride({ date: TUE, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    const moved = sourceWith([{ date: WED, type: 'LABORAL', description: 'AÑO NUEVO' }]);
    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source: moved }, db);

    expect(result.reopened).toEqual([]);
    expect(listDayOverrides(db).map((day) => day.date)).toEqual([TUE, WED]);
  });

  it('the KNOWN defect: a reopened holiday comes back on the next check', async () => {
    const source = sourceWith([{ date: TUE, type: 'LABORAL', description: 'AÑO NUEVO' }]);
    await runHolidayCheck({ today: MON, now: NOW, source }, db);
    reopenDays({ from: TUE, to: TUE, today: MON }, db);

    const result = await runHolidayCheck({ today: MON, now: NOW, force: true, source }, db);

    // Recorded as an open decision, not a feature: a reopened day leaves no row to tell it apart
    // from one that was never written.
    expect(result.closed).toEqual([TUE]);
  });
});

describe('changing the municipality', () => {
  it('reopens the old town’s future days and brings the new town’s', async () => { /* … */ });
  it('leaves a day the owner closed by hand, and one whose note they rewrote', async () => { /* … */ });
});
```

Write the two municipality cases out in full — the same shape as the reopen tests above, with `writeSettings({ holidaysMunicipality: … })` between the two checks.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/operations/holidays.test.ts -t 'maintains'`
Expected: FAIL — `renamed` and `reopened` are always empty.

- [ ] **Step 3: Implement the maintenance**

Add to `src/lib/operations/holidays.ts`, called from `runHolidayCheck` between steps 4 and 6 of the order of operations:

```ts
/**
 * Whether this day is still the app's to touch: it is closed, and its note is EXACTLY what the last
 * check wrote there. Anything else -- a note the owner rewrote, a day they closed themselves, a day
 * with no row -- is theirs, and the app never writes on it again.
 */
function stillOwnedByTheApp(date: string, cachedName: string | undefined, db: Db): boolean {
  if (cachedName === undefined) return false;
  const stored = findDayOverride(date, db);
  return stored !== undefined && stored.isClosed && stored.note === cachedName;
}

/**
 * A rename is an UPDATE of the note and nothing else: no reflow, no preview, `is_closed` and
 * `capacity_hours` untouched. Reopening and rewriting would land on the same date looking identical
 * while releasing the day in between, shuffling the queue and asking again about work whose
 * displace-or-keep answer was already given.
 */
function renameDay(date: string, name: string, db: Db): void {
  const stored = findDayOverride(date, db);
  if (stored === undefined) return;
  upsertDayOverride({ ...stored, note: name }, db);
}
```

The reopen half calls the existing `reopenDays({ from: date, to: date, today })`, guarded by `stillOwnedByTheApp`, and only for dates on or after today.

- [ ] **Step 4: Run the tests and every gate**

Run: `npm test && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/holidays.ts src/lib/operations/holidays.test.ts
git commit -m "feat(holidays): rename and retire the days the app still owns"
```

---

### Task 11: The routes and the client

**Files:**
- Create: `app/api/holidays/route.ts`, `app/api/holidays/apply/route.ts`
- Modify: `src/lib/api-client.ts`
- Test: `src/lib/api-client.test.ts` (append, following the file's existing stub-fetch pattern)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/api-client.ts
  export type { HolidayCheckResult, HolidayState, PendingHoliday } from './operations/holidays';
  export function getHolidayState(options?: RequestOptions): Promise<HolidayState>;
  export function runHolidayCheck(force?: boolean, options?: RequestOptions): Promise<HolidayCheckResult>;
  export function answerHolidays(
    answers: ReadonlyArray<{ date: string; keep: boolean }>,
    options?: RequestOptions,
  ): Promise<HolidayCheckResult>;
  ```

- [ ] **Step 1: Write the routes**

```ts
// app/api/holidays/route.ts
/**
 * GET  -> the Settings line: which town, how many holidays, how far they reach, when we last looked.
 * POST -> run the check. `{ force: true }` is the "Consultar ahora" button and skips the weekly wait.
 */

import { readJsonBody, readFlag, route } from '@/src/lib/api';
import { readHolidayState, runHolidayCheck } from '@/src/lib/operations/holidays';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => readHolidayState());
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request).catch(() => ({}));
  const force = readFlag(body, 'force') ?? false;
  return route(() => runHolidayCheck({ force }));
}
```

```ts
// app/api/holidays/apply/route.ts
/**
 * POST { answers: [{ date, keep }] } -> writes the days the panel asked about. `keep` padlocks the
 * work and closes the day around it; `false` closes it and lets the reflow carry the work forward.
 */

import { badRequest, ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { readJsonBody, route } from '@/src/lib/api';
import { applyHolidayAnswers } from '@/src/lib/operations/holidays';
import { isValidDate } from '@/src/lib/dates';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const raw = body.answers;
  if (!Array.isArray(raw) || raw.length > 64) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidPayload, { field: 'answers' });
  }
  const answers = raw.map((entry) => {
    const value = entry as { date?: unknown; keep?: unknown };
    if (typeof value.date !== 'string' || !isValidDate(value.date) || typeof value.keep !== 'boolean') {
      throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidPayload, { field: 'answers' });
    }
    return { date: value.date, keep: value.keep };
  });
  return route(() => applyHolidayAnswers(answers));
}
```

The `throw` before `route()` escapes the wrapper — move both validations **inside** the `route(() => { … })` callback so a bad payload comes back as a 400 body instead of an unhandled rejection. Check how `app/api/absences/route.ts` orders this and copy it exactly.

- [ ] **Step 2: Add the three client functions**

Follow the shape of `runAutomaticBackup` in `src/lib/api-client.ts`, next to it, with the same `RequestOptions` plumbing and the type re-exports at the top of the file.

- [ ] **Step 3: Write and run the client test**

Append to `src/lib/api-client.test.ts` a case per function asserting the method, path and body, in the style the file already uses.

Run: `npx vitest run src/lib/api-client.test.ts && npm run build`
Expected: PASS, and the build must list the two new routes.

- [ ] **Step 4: Commit**

```bash
git add app/api/holidays src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "feat(holidays): expose the check and its answers over the API"
```

---

### Task 12: The Settings section

**Files:**
- Create: `src/components/settings/HolidaysSection.tsx`
- Modify: `src/components/settings/SettingsScreen.tsx`, `src/components/settings/shift.ts` (draft validation), `public/locales/{es,en}/common.json`
- Test: `src/components/settings/shift.test.ts` (the draft rule for the municipality)

The section sits between *Copias de seguridad* and *Idioma*, built with the file's own `Section` and `Field` components — read `BackupsSection.tsx` first and follow it, including how it reads its own server state on mount.

**The Spanish strings** (English mirrors are the implementer's, and both key sets must match):

```json
"holidaysSection": "Festivos",
"holidaysHint": "El taller cierra los festivos de su municipio. Los trae la app; los que tengan trabajo encima preguntan antes de mover nada.",
"holidaysEnabled": "Cerrar los festivos automáticamente",
"holidaysMunicipality": "Municipio",
"holidaysMunicipalityHint": "Solo Andalucía, por ahora.",
"holidaysLoaded": "{{count}} festivos · hasta el {{through}}",
"holidaysLoadedNone": "Todavía no hay festivos cargados",
"holidaysCheckedAt": "Consultado el {{date}}",
"holidaysCheckFailed": "No se han podido consultar. Último intento el {{date}}",
"holidaysCheckNow": "Consultar ahora",
"holidaysAttribution": "Datos: Junta de Andalucía y festivos.io (CC BY 4.0)"
```

The attribution is **required by both licences** and is not optional decoration.

- [ ] **Step 1: Write the failing test for the draft rule**

```ts
// src/components/settings/shift.test.ts
it('flags a municipality that is not five digits', () => {
  expect(draftIssues({ ...DEFAULT_SETTINGS, holidaysMunicipality: 'Priego' }).holidaysMunicipality)
    .toBe('range');
});

it('accepts a five-digit code', () => {
  expect(draftIssues({ ...DEFAULT_SETTINGS, holidaysMunicipality: '14055' }).holidaysMunicipality)
    .toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/components/settings/shift.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the rule, the section and the strings**

The picker is a `<select>` over `ANDALUSIAN_MUNICIPALITIES`, labelled `name (province)`, sorted by name with `localeCompare('es')`. It is a static import — the list is bundled, so the picker works offline.

- [ ] **Step 4: Run the gates**

Run: `npm test && npm run type-check && npm run lint && npm run build`
Expected: PASS, `locales.test.ts` included.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings public/locales
git commit -m "feat(holidays): add the Festivos section to Settings"
```

---

### Task 13: The panel

**Files:**
- Create: `src/components/calendar/HolidayPanel.tsx`, `src/components/calendar/HolidayPanel.module.css`
- Modify: `src/components/calendar/CalendarScreen.tsx`, `public/locales/{es,en}/common.json`

**Where it hooks in:** the effect at `src/components/calendar/CalendarScreen.tsx:852` that fires `runAutomaticBackup` once per visit. Add a sibling effect that calls `runHolidayCheck()` the same way — one `AbortController`, silent when it is skipped, the failure surfaced rather than swallowed. When the result has a non-empty `pending`, open the panel.

**The panel**, per the spec:

- One line per day: the date, the holiday's name, and the work on it.
- A day whose rows are **all movable** gets a two-way choice, `Desplazar` selected.
- A day with **any padlocked row** gets no choice and a sentence saying the day will close with the work where it is.
- One `Guardar` sends every answer in one `answerHolidays` call; padlocked days are sent as `keep: true`.
- Closing the panel without saving writes nothing and is not an error.
- After a successful save, refetch the week — a reflow rewrites rows in weeks the response never mentions.

**The Spanish strings:**

```json
"holidayPanelTitle": "Festivos con trabajo encima",
"holidayPanelBody": "Estos días son festivo y hay trabajo en ellos. Elige qué hacer con cada uno.",
"holidayPanelDisplace": "Desplazar",
"holidayPanelKeep": "Mantener aquí",
"holidayPanelKeepHint": "Se queda donde está, con candado.",
"holidayPanelFixed": "El día se cierra con el trabajo donde está.",
"holidayPanelSave": "Guardar",
"holidayPanelHours": "{{hours}} de {{job}}"
```

- [ ] **Step 1: Write the panel's pure logic and its test**

Any decision the panel makes goes in a plain module beside it and is tested there, the way `closeDayOffer.ts` and `offWeek.ts` are — components in this repo are not unit-tested, their logic is. Extract at minimum:

```ts
// src/components/calendar/holidayAnswers.ts
/** A day with a padlocked row has no choice to offer: the padlock is cleared by the padlock alone. */
export function dayIsForced(rows: readonly DayWorkRow[]): boolean;

/** Every day's answer, with a forced day answered `keep` whatever the control shows. */
export function answersFrom(
  pending: readonly PendingHoliday[],
  chosen: ReadonlyMap<string, boolean>,
): Array<{ date: string; keep: boolean }>;
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `npx vitest run src/components/calendar/holidayAnswers.test.ts`

- [ ] **Step 3: Build the panel and wire the effect**

Use `SidePanel` or `ConfirmDialog` from `src/components/ui/` — whichever the existing absence flows use for a decision like this. Do not introduce a fourth dialog shape.

- [ ] **Step 4: Drive it in a browser**

Run `npm run dev` with `WORKWISE_DB_PATH` pointed at a scratch file — **never `data/`** — seed a job on a day, force a check, and confirm: the panel opens, `Desplazar` moves the work, `Mantener aquí` padlocks it and closes the day around it, and closing the panel writes nothing.

- [ ] **Step 5: Run the gates and commit**

```bash
npm test && npm run type-check && npm run lint && npm run build
git add src/components/calendar public/locales
git commit -m "feat(holidays): ask before a holiday moves work"
```

---

### Task 14: The documents and the version

**Files:**
- Modify: `docs/SPEC.md`, `docs/DECISIONS.md`, `CHANGELOG.md`, `package.json`, `desktop/package.json`

- [ ] **Step 1: SPEC.md**

A new `### Public Holidays` under *Gap Management*, present tense, no history: the municipality setting, the weekly check, what is written, what is asked, what is maintained, and what happens offline. Amend `#### Closing Days` where it says a close is refused over a fixed block — that rule is gone but for the past.

- [ ] **Step 2: DECISIONS.md**

One entry, **Rule / Why / Rejected**, `§` pointers resolving to real headings:

- *Public Holidays Are Closed Days The App Owns Until You Touch Them* — the ownership rule, why a rename is an `UPDATE`, why the Junta dates and the festivos.io names, why the horizon is the source's.
- Amend *A Long Absence Is One Gesture, and a Closed Day Has a Screen* where it justifies the refusal that has just been removed.
- Add to **Open Decisions → STILL OPEN**: *the owner reopens an automatic holiday because the shop is working that day, and the next check closes it again; the app cannot tell that reopening from a day that was never written. The `holidays` table is where a "dismissed" column would go.*

- [ ] **Step 3: CHANGELOG and version**

`0.22.0` in both `package.json` and `desktop/package.json`, and an entry written as what is different to use — not how it was built.

- [ ] **Step 4: Run the docs test and every gate**

Run: `npx vitest run src/lib/docs.test.ts && npm test && npm run type-check && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md package.json desktop/package.json
git commit -m "docs(holidays): specify the automatic holidays and bump to 0.22.0"
```

---

## Self-Review

**Spec coverage.** §1 closed-day-not-gap → Task 9. §2 sources → Tasks 4-6. §2.3 horizon is the source's → Task 9 (no year filter). §3 Settings → Tasks 2, 3, 12. §4 storage → Task 1. §5 composing → Task 5. §6 the pass → Task 9. §6.1 maintenance and the rename-is-an-`UPDATE` rule → Task 10. §6.2 panel → Tasks 8, 13. §7 municipality change → Task 10. §8 the refusal becomes a question → Task 7. §9 failure modes → Task 9 (offline, truncated body, per-date refusal). §10 the recorded defect → Task 10's test and Task 14's DECISIONS entry. §11 out of scope → nothing to build. §12 testing → spread across every task; the weekend case is in Task 9 and the `absenceRange` trap is avoided by writing one date at a time. §13 files → the File Structure table. §14 shipping → Task 14.

**Two things a reviewer should push back on.** Task 4's first draft of `ineOf` is written twice — once wrong with `require`, once right — deliberately, because the wrong one is what an implementer reaches for; if that reads as sloppy, delete the first. And Task 9 writes one `saveAbsence` per date rather than one call for the whole set, which costs a reflow per holiday inside one transaction; if that measures badly on a fourteen-holiday first run, the fix is a batched write that groups dates by reason, not a loop outside the transaction.
