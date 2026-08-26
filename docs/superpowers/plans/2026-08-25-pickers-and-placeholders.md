# Pickers and Placeholders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 84-to-140-option day dropdown with a month calendar in a popover, replace the 96-option hour dropdown with a typed `HH:mm` field, and make the three example-shaped placeholders instruct instead.

**Architecture:** Two new shared controls under `src/components/ui/` — `DayPicker` (a `<button>` trigger plus a portalled month-grid popover, with a range mode for the absence panel) and `TimeField` (the exported `Input` plus `−`/`+` buttons) — replacing `DateSelect` at 4 call sites and `TimeSelect` at 7. Everything decidable lives in seven pure sibling `.ts` modules with their own tests, because vitest runs in `environment: 'node'` over `src/**/*.test.ts` only and nothing in this repository is ever rendered in a test. The two marks the client cannot derive — a day being closed, and whether the engine still has room on it — come from one new read route, `GET /api/days?from=&to=`, whose logic lives in `src/lib/operations/views.ts` beside `readWeek` so it can be tested at all.

**Tech Stack:** Next.js 16 (Turbopack), React 18, TypeScript 5, `better-sqlite3`, vitest 4, `react-i18next`, `@tabler/icons-react`, plain CSS Modules against `public/brand/workwise-tokens.css`. No date library, and none is added.

**Spec:** `docs/superpowers/specs/2026-08-25-pickers-and-placeholders-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

**The gates.** All four pass before every commit: `npx tsc --noEmit`, `npm test`, `npx eslint .`, `npm run build`. Node **22 exactly** — `scripts/require-node-22.mjs` refuses anything else. The measured baseline of this branch, after the rebase onto `origin/dev` at `8669fea`, is **44 test files, 1178 tests, 0 failures**; a task that lowers the count has deleted a test it must account for.

**Never a native input.** No `<input type="date">` and no `<input type="time">` anywhere: both render in the BROWSER's locale, not the page's, and the measured defect is Settings drawing `08:00 AM` beside a grid reading `08:00–14:00`.

**The quarter hour is the grid.** `TIME_STEP_MINUTES` = 15 in `src/components/ui/timeOptions.ts`, held equal to the drag layer's `SNAP_MINUTES` and to `MIN_ROW_MINUTES` by `timeOptions.test.ts`. **That test is not touched and that constant is not renamed** — it is the only thing pinning the three together. The last legal time is **23:45**: `hhmmToMinutes` reads `24:00` as 1440, and a value that big stops the grid drawing its band while the field still looks legal.

**Two values that must survive untouched.** A day stored outside the picker's window is always selectable — otherwise editing an old gap moves its date on save. A time unchanged since the field took focus is returned verbatim and never snapped — otherwise a hand-edited `08:10` in `settings` becomes `08:15` by tabbing through Settings, and a Settings save recomposes the calendar and empties the undo line.

**Every marked day stays selectable.** No mark disables a cell. The owner's decision, in their words: *«Dejar elegirlo, pero cumplirlo de verdad»*. Only days outside the window are unselectable, which is exactly today's reachable set.

**The reach does not change.** `planningWindow` and three constants in `src/components/ui/dateOptions.ts` survive untouched: `PICKER_PAST_WEEKS` 4, `PICKER_FUTURE_WEEKS` 8, `PICKER_MAX_FUTURE_WEEKS` 16. The module's private `MAX_OPTION_DAYS` 400 dies with `dayOptionDates`, which was its only reader — a calendar has no option count to cap. New caps: `MAX_DAY_MARK_DAYS` 200 for the read route; the existing `MAX_ABSENCE_DAYS` 120 still bounds a range.

**Styling.** Plain CSS Modules against the brand tokens; **never a hardcoded colour**, always a token, so the dark theme stays cheap. Hairline `0.5px` borders, `--radius` corners. Icons from `@tabler/icons-react`, bundled, no CDN. One new token, `--ww-z-popover: 45`, beside `--ww-z-panel: 40`, `--ww-z-dialog: 50` and `--ww-z-toast: 60`.

**Minimal and of the same family**, asked for by the owner on 2026-08-25: no legend, no explanatory labels, no hatch, one hint line under a field and never two, lowercase where Spanish wants it (`agosto 2026`), weekday letters from `Intl` and never a hand-written list, and no state to learn beyond the six marks the owner asked for.

**i18n.** All code, comments and identifiers in English. UI strings only in `public/locales/{es,en}/common.json`, with the two key sets and every `{{…}}` held identical by `src/lib/locales.test.ts`. Spanish register, from the file itself: «tú» and the imperative for instructions, the infinitive with no full stop for buttons and tooltips, a full stop only where there is a finite verb, « · » (`units.listSeparator`) as the separator, «» for quotes, and the single character «…».

**Tests.** vitest, `environment: 'node'`, `include: ['src/**/*.test.ts']`, 30 s timeout. No DOM, no jsdom, no testing-library: nothing can be rendered, so anything decidable goes in a pure sibling module. The shared calendar is `src/testing/fixtures.ts` — read it and use its dates rather than declaring new ones. Test data uses the repo's own vocabulary: jobs `Railing`, `Staircase`, `Door`, `Shutter`, `Grille`, `Shed`, `Casing`, `Capping`; gap reasons `Fair`, `Breakdown`, `Errands`. **Never open `data/calendar.db` from a test** (invariant 11) — point `WORKWISE_DB_PATH` at a scratch file when driving the app.

**Comments.** A comment carries a unit, an origin, a caller obligation, a trap the next reader would walk into, or a measured defect — and nothing else. Never a `SPEC.md §` or `DECISIONS.md §` pointer in code.

**Commits.** Conventional Commits, **subject only**: `type(scope): subject`, imperative, ~72 characters, **no body**, no self-attribution, no trailer. Scopes in this plan: `pickers`, `time`, `dates`, `absences`, `api`, `i18n`, `docs`.

**One base name may never differ from another only in case.** The pure sibling of `TimeField.tsx` is **`timeTyping.ts`**, not `timeField.ts`. On Windows — the platform the installer builds and the shop runs — `import './TimeField'` probes `TimeField.ts` before `TimeField.tsx`, and a case-insensitive filesystem answers that probe with `timeField.ts`, so `ui/index.ts` would re-export the pure module and the build would break there while staying green on Linux. The repo has no such pair today (`TimeSelect.tsx`/`timeOptions.ts`, `DateSelect.tsx`/`dateOptions.ts`) and must not gain one.

**Version.** This ships, so `0.21.1` → **`0.22.0`** in **both** `package.json` and `desktop/package.json` — and in both lockfiles, which have drifted (`package-lock.json` says `0.20.1`, `desktop/package-lock.json` says `0.19.1`) — with a `## 0.22.0 — …` entry at the top of `CHANGELOG.md` written in terms of what is different to use. Run `npx vitest run src/lib/docs.test.ts` after touching any of `CLAUDE.md`, `CHANGELOG.md`, `README.md`, `docs/SPEC.md` or `docs/DECISIONS.md`.

**This branch was rebased onto `origin/dev` at `8669fea` mid-planning**, which brought in the client's job palette and the rule that **a gap is HATCHED** (SPEC § *Calendar View*, DECISIONS § *A Gap Is Hatched, the Lunch-Break Band Is Not*). That rule sharpens rather than contradicts this plan: a gap is hatched because it is one rectangle that must be told apart from a block beside it, while the lunch band is left plain because it spans seven columns in a part of the day carrying no information. The picker's 42 cells are the second case, so **a closed day in the picker is the dim `--ww-surface-alt` the grid already uses for a closed column** — never a hatch.

## Where the tasks touch each other

Ten places where one task's decision reaches into another's. Read the ones that name your task before you start it.

1. **Order is not free.** The month arithmetic (Tasks 2-4) must land before Tasks 5-8 and 13, which import it — those fail on the import, not on an assertion. Task 13's last test imports `MAX_DAY_MARK_DAYS` from Task 10. Task 18 needs seven earlier artefacts to typecheck: `startOfMonth`, `monthYear`/`weekdayNarrow`, `monthGrid`, `monthReach`, `dayPickerKeys`, `pickerDays`, `popoverBox`, plus `getDayMarks` and `DaysView`. Task 21 is prose and must land after the components exist, because SPEC.md is present tense and may not describe a screen that is not there. Task 22 is last: its `npm test` is the first run that sees every slice together.

2. **`src/components/ui/index.ts` is edited by exactly three tasks** — Task 15 (adding the `useFieldBinding` export), Task 17 (dropping `TimeSelect`, adding `TimeField`) and Task 19 (dropping `DateSelect` and the two dead option builders, adding `DayPicker`). No other task touches it. The pure modules `dayPickerKeys`, `dayRange`, `pickerDays`, `popoverBox`, `dayPickerTitle` and `timeTyping` are **not** exported from it: they are siblings their component imports by relative path, the way `Field.tsx` imports `stepper.ts`.

3. **`useFieldBinding` is exported once and extended once.** Task 15 makes it public. Task 18 adds `labelId` to it and to `FieldContextValue`, and puts `id={labelId}` on `Field`'s `<label>` — which is what makes the trigger's `aria-labelledby` pointable at all. If Task 15's diff already carries `labelId`, do not add it twice.

4. **`labelId` is an OPTIONAL prop.** All four call sites pass nothing and inherit it through `FieldContext`; the prop exists only for a picker rendered outside a `Field`. Task 20 passes none, deliberately.

5. **`DaysView` and `DayMarkView` reach the client as TYPES ONLY**, re-exported from `src/lib/api-client.ts` on its existing `export type { WeekBlock, WeekDay, WeekView } from './operations/views';` line. Nothing in `src/components/` may import `src/lib/operations/views.ts` at runtime: it reaches `../db`, which reaches `better-sqlite3`, and a value import would drag a native module into the browser bundle. `pickerDays.ts` names `MAX_DAY_MARK_DAYS` in prose and only its **test** imports it.

6. **`readDays` returns an array; `pickerDays.DayMark` is a record value.** `DaysView.days` is `DayMarkView[]`, keyed by `date`; the fetch inside `DayPicker` is what turns it into `DayMarks`. No record-shaped variant is added to the server view — `WeekView.days` is an array, and a second shape in one module is the thing that drifts.

7. **The 120-day cap is never clamped in the UI.** `rangeCells` inherits `absenceRange`'s 120-day walk, so a longer span paints only its first 120 cells and its tail is neither included nor skipped. That is correct: the refusal is the server's 400 `invalid-range`, shown in the range field's error slot. A picker that clamped the second click would make that refusal unreachable and the owner would never learn why the range was refused. The day count under the field comes from `previewAbsence`, never from `rangeCells`.

8. **Two locale keys go dark and their sentences must follow.** After Task 20 nothing renders `absenceForm.from` («Desde») or `absenceForm.to` («Hasta»), but `errors.rangeBackwards` and `errors.invalidRange` quote both words inside their text — so those two sentences would name labels the screen no longer shows. Task 21 rewrites them and only then are the two keys deleted; until then they stay, because `locales.test.ts` holds the two key sets identical and a half-done deletion fails it.

9. **Four code comments still name the dead controls** — `src/lib/validation.ts:58`, `src/components/calendar/geometry.ts:17`, `src/components/ui/dateOptions.ts:2` and `src/components/ui/timeOptions.ts:1-6`. Task 17 owns the two that say `TimeSelect`, Task 19 the two that say `DateSelect`, including `dateOptions.ts`'s module header, which today describes a dropdown that will not exist.

10. **Task 20a comes before Task 20, and that is why it is lettered.** Task 18 ships `DayPicker` as a single-day control; Task 20 wires an absence panel field that consumes a range mode. Task 20a is the range mode itself — it turns `DayPickerProps` into a discriminated union on `range`, so a single-day call site keeps compiling untouched, and it extends `dayRange.ts` with the paint, the discard and the notice key. Run it where it sits on the page. Everything numbered after it keeps its number, so a reference to "Task 21" elsewhere still means the SPEC edits.

11. **The dot is `hasRoom`; the hover sentence is the number.** `day.freeHours` shows whenever `freeMinutes > 0`, and `day.full` only on a day the engine actually works. They are deliberately not the same test: beyond the horizon `hasRoom` is false while the minutes are genuinely free, and «Día completo» would then be the one untrue thing on the tooltip.

---


### Task 1: The three placeholders say what to write

**Files:**
- Modify: `public/locales/es/common.json:152,223,281`
- Modify: `public/locales/en/common.json:152,223,281`
- Test: `src/lib/locales.test.ts` (unchanged — no assertion in it pins any of these three values)

**Interfaces:**
- Consumes: nothing. This is the first task of the slice.
- Produces: no new signature. The three i18n keys keep their exact paths and stay free of `{{…}}` interpolation, so every later task and every existing caller reads them unchanged: `t('jobPanel.namePlaceholder')` in `src/components/jobs/JobFields.tsx:72`, and `t(bulk && kind === 'closed-days' ? 'absenceForm.notePlaceholder' : 'gapForm.reasonPlaceholder')` in `src/components/jobs/AbsencePanel.tsx:715-719`.

- [ ] **Step 1: Prove no test asserts the old strings**

This is a copy change to two JSON bundles. There is no test that can be made to fail first: `src/lib/locales.test.ts` never resolves these three keys, and no other suite reads them. So the guard is a grep, run BEFORE the edit — if either command prints a hit inside a `*.test.ts` that resolves one of these keys, stop and update that assertion in the same commit.

```bash
# 1. Does any test resolve these three keys at all?
grep -rn --include='*.test.ts' -e 'namePlaceholder' -e 'reasonPlaceholder' -e 'notePlaceholder' src

# 2. Does the OLD copy appear anywhere outside the bundles?
grep -rn --include='*.ts' --include='*.tsx' --include='*.md' \
  -e 'Puerta metálica' -e 'Metal door' -e 'Avería del torno' -e 'Lathe breakdown' \
  src app docs CLAUDE.md CHANGELOG.md
```

Expected, exactly:

- Command 1 prints **nothing**. No test resolves `jobPanel.namePlaceholder`, `gapForm.reasonPlaceholder` or `absenceForm.notePlaceholder`.
- Command 2 prints only: the three rows of the table in `docs/superpowers/specs/2026-08-25-pickers-and-placeholders-design.md` (lines 10, 64, 66), which is the design being implemented and describes the old value on purpose; `src/types/index.ts:60` (`/** Free text such as "Lathe breakdown". May be absent. */`), which documents `Gap.reason` and is not the placeholder; and the `reason: 'Lathe breakdown'` rows in `src/lib/composition.test.ts`, `src/lib/operations.test.ts` and `src/components/calendar/useBlockDrag.test.ts`, which are stored gap reasons from the repo's own test-data vocabulary. **None of the three is an assertion of a locale value, so none of them changes.**

- [ ] **Step 2: Run the locale suite and record the baseline**

Run: `npx vitest run src/lib/locales.test.ts`
Expected: **PASS — 8 tests.** It cannot fail before the edit, and saying so plainly beats pretending otherwise: of its eight assertions, four touch these keys and none pins their text — `hold exactly the same keys in both languages` (parity of key paths only), `has no empty string anywhere` (the values must merely be non-blank), `keeps every interpolation placeholder identical across languages` (both new values carry zero `{{…}}`, as both old ones did), and `words the wireframe strings exactly`, which pins ten values verbatim — `header.week`, `summary.bookedFridayFree`, `grid.bandsLegend`, `block.continuesBelow`, `block.continuesAbove`, `block.overflow`, `day.frozen`, `day.buffer`, `grid.free`, `jobPanel.blocks_other` — and **not one of these three**, so there is nothing in it to update. What the suite is worth here is afterwards: still 8/8 proves both bundles were edited at the same three key paths, that neither value went blank, and that no `{{…}}` was introduced on one side only.

- [ ] **Step 3: Rewrite the three Spanish values**

In `public/locales/es/common.json`, three single-line replacements. Nothing else in the file moves — same keys, same order, same indentation, no trailing-comma change (`notePlaceholder` stays the last key of `absenceForm`).

Line 152, inside `"jobPanel"`:

```json
    "namePlaceholder": "Ponle un nombre que reconozcas",
```

Line 223, inside `"gapForm"`:

```json
    "reasonPlaceholder": "Qué ocupa esas horas",
```

Line 281, inside `"absenceForm"`:

```json
    "notePlaceholder": "Por qué cierras esos días"
```

`"descriptionPlaceholder": "Notas, medidas, material…"` on line 154 is **not touched**.

- [ ] **Step 4: Rewrite the three English values**

In `public/locales/en/common.json`, the same three keys at the same three line numbers.

Line 152, inside `"jobPanel"`:

```json
    "namePlaceholder": "Give it a name you will recognise",
```

Line 223, inside `"gapForm"`:

```json
    "reasonPlaceholder": "What takes up those hours",
```

Line 281, inside `"absenceForm"`:

```json
    "notePlaceholder": "Why you are closing those days"
```

`"descriptionPlaceholder": "Notes, measurements, material…"` on line 154 is **not touched**.

- [ ] **Step 5: Run every suite that reads the bundles**

Run: `npx vitest run src/lib/locales.test.ts src/components/jobs/summary.test.ts src/lib/api-client.test.ts src/lib/projectColors.test.ts`
Expected: PASS. `src/lib/locales.test.ts` back at 8/8 is the parity proof from Step 2; the other three are the only suites that read `public/locales/*/common.json` — `summary.test.ts` interpolates the `summary.*` values, `api-client.test.ts` the `errors.*` ones, `projectColors.test.ts` the `colors.*` ones — and each must be untouched by this edit.

- [ ] **Step 6: Commit**

```bash
git add public/locales/es/common.json public/locales/en/common.json
git commit -m "feat(i18n): make the three placeholders say what to write"
```


### Task 2: The four month helpers in `src/lib/dates.ts`

**Files:**
- Modify: `src/lib/dates.ts:157` (a new `Month arithmetic` section between `isoWeekYear` and `compareDates`)
- Test: `src/lib/dates.test.ts` (imports at `1-20`, a new `describe` after `127`)

**Interfaces:**
- Consumes: `parseDate(date: string): DateParts` and `formatDate(parts: DateParts): string`, both already in `src/lib/dates.ts` — `formatDate` normalises out-of-range parts, which is the whole lever here
- Produces: `startOfMonth(date: string): string`, `endOfMonth(date: string): string`, `addMonths(date: string, months: number): string`, `isSameMonth(a: string, b: string): boolean`

- [ ] **Step 1: Write the failing test**

Replace the import block of `src/lib/dates.test.ts` (lines 1-20) with:

```ts
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  endOfMonth,
  formatDate,
  hhmmToMinutes,
  hoursToMinutes,
  instantToLocalDate,
  isSameMonth,
  isWeekend,
  isoWeekNumber,
  isoWeekYear,
  minutesToHHmm,
  minutesToHours,
  parseDate,
  startOfMonth,
  startOfWeek,
  todayLocal,
  weekDates,
  weekdayOf,
} from './dates';
```

Then insert this block after the `describe('weeks', ...)` block (after line 127, before `describe('clock conversions', ...)`):

```ts
describe('months', () => {
  it('finds the first and the last day of a month, whatever its length', () => {
    expect(startOfMonth('2026-08-12')).toBe('2026-08-01');
    expect(startOfMonth('2026-08-01')).toBe('2026-08-01');
    expect(endOfMonth('2026-08-12')).toBe('2026-08-31');
    expect(endOfMonth('2026-09-15')).toBe('2026-09-30');
    expect(endOfMonth('2026-12-25')).toBe('2026-12-31');
  });

  it('gets February right in a common year and in a leap one', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });

  it('clamps a 31st onto a shorter month instead of rolling into the next one', () => {
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-10-31', -8)).toBe('2026-02-28');
  });

  it('crosses the year in both directions', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-08-12', 12)).toBe('2027-08-12');
    expect(addMonths('2026-08-12', -12)).toBe('2025-08-12');
    expect(addMonths('2026-08-12', 0)).toBe('2026-08-12');
  });

  it('tells two months apart when they share a number but not a year', () => {
    expect(isSameMonth('2026-08-01', '2026-08-31')).toBe(true);
    expect(isSameMonth('2026-08-31', '2026-09-01')).toBe(false);
    expect(isSameMonth('2026-01-15', '2025-01-15')).toBe(false);
    expect(isSameMonth('2027-01-01', '2026-12-31')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/dates.test.ts -t 'clamps a 31st onto a shorter month'`
Expected: FAIL — the file cannot even load: `./dates` exports no `startOfMonth`, `endOfMonth`, `addMonths` or `isSameMonth`, so the import throws before any test runs.

- [ ] **Step 3: Add the month arithmetic to `src/lib/dates.ts`**

Insert between `isoWeekYear` (ends line 157) and `export function compareDates` (line 159):

```ts
// ---------------------------------------------------------------------------
// Month arithmetic
// ---------------------------------------------------------------------------

/** The first day of the month containing `date`. */
export function startOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  return formatDate({ year, month, day: 1 });
}

/** The last day of the month containing `date`. */
export function endOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  // Day 0 of the next month, which formatDate normalises: no table of month lengths, and no leap
  // year rule to keep.
  return formatDate({ year, month: month + 1, day: 0 });
}

/** `date` shifted by whole months, CLAMPED to the target month's last day. */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const shifted = month + Math.trunc(months);
  const lastDay = parseDate(formatDate({ year, month: shifted + 1, day: 0 })).day;
  return formatDate({ year, month: shifted, day: Math.min(day, lastDay) });
}

export function isSameMonth(a: string, b: string): boolean {
  const left = parseDate(a);
  const right = parseDate(b);
  return left.year === right.year && left.month === right.month;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/dates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates.ts src/lib/dates.test.ts
git commit -m "feat(dates): add the month arithmetic the day grid needs"
```

---

### Task 3: `formatMonthYear` and `formatWeekdayNarrow` in `src/lib/format.ts`

**Files:**
- Modify: `src/lib/format.ts:79` (after `formatWeekdayShort`) and `src/lib/format.ts:98` (after `formatMonthShort`)
- Test: `src/lib/format.test.ts` (imports at `3-14`, new cases inside `describe('dates', ...)` after line `121`)

**Interfaces:**
- Consumes: `localDateOf(date: string): Date` and `intlLocaleOf(language: string): string`, both already reached by every formatter in this file
- Produces: `formatMonthYear(date: string, language: string): string`, `formatWeekdayNarrow(date: string, language: string): string`

- [ ] **Step 1: Write the failing test**

Replace the `./format` import of `src/lib/format.test.ts` (lines 3-14) with:

```ts
import {
  INVALID_TIME,
  formatHourNumber,
  formatLongDate,
  formatMediumDate,
  formatMonthShort,
  formatMonthYear,
  formatTime,
  formatWeekdayLong,
  formatWeekdayNarrow,
  formatWeekdayShort,
  localDateOf,
  weekRangeLabel,
} from './format';
```

Then insert these two cases inside `describe('dates', ...)`, after the `'gives the short month the wireframe uses'` case (after line 121, before that describe's closing `});`):

```ts
  it('titles a month without the connector es-ES puts before the year', () => {
    // Intl's own es-ES string is "agosto de 2026": the parts are joined instead, so the title reads
    // as a heading and no Spanish word is spelled out in the code.
    expect(formatMonthYear('2026-08-12', 'es')).toBe('agosto 2026');
    expect(formatMonthYear('2026-12-31', 'es')).toBe('diciembre 2026');
    expect(formatMonthYear('2027-01-05', 'es')).toBe('enero 2027');
    expect(formatMonthYear('2026-08-12', 'en')).toBe('August 2026');
    expect(formatMonthYear('2026-08-12', 'fr')).toBe('agosto 2026');
  });

  it('narrows a weekday to the single letter a month grid heads its columns with', () => {
    const week = [
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ];
    expect(week.map((date) => formatWeekdayNarrow(date, 'es'))).toEqual([
      'L',
      'M',
      'X',
      'J',
      'V',
      'S',
      'D',
    ]);
    // en-GB repeats T and S. That is CLDR's narrow form, not a defect to correct with a hand-kept
    // list — the lists were deleted on 2026-08-20 for drifting from CLDR.
    expect(week.map((date) => formatWeekdayNarrow(date, 'en'))).toEqual([
      'M',
      'T',
      'W',
      'T',
      'F',
      'S',
      'S',
    ]);
    expect(formatWeekdayNarrow('2026-08-12', 'fr')).toBe('X');
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/format.test.ts -t 'titles a month without the connector'`
Expected: FAIL — the file cannot load: `./format` exports no `formatMonthYear` and no `formatWeekdayNarrow`.

- [ ] **Step 3: Add the two formatters to `src/lib/format.ts`**

Insert after `formatWeekdayShort` (ends line 79), before `formatWeekdayLong`:

```ts
/** The single-letter weekday a month grid heads its columns with: "L", "M". */
export function formatWeekdayNarrow(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { weekday: 'narrow' }).format(
    localDateOf(date),
  );
}
```

Insert after `formatMonthShort` (ends line 98), before `formatLongDate`:

```ts
/**
 * The month and year a month grid is titled with: "agosto 2026", "August 2026". Joined from Intl's
 * PARTS rather than its string, which for es-ES is "agosto de 2026" — dropping the literal parts
 * removes a connector that reads as prose in a heading, and does it without a Spanish word here.
 */
export function formatMonthYear(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { month: 'long', year: 'numeric' })
    .formatToParts(localDateOf(date))
    .filter((part) => part.type === 'month' || part.type === 'year')
    .map((part) => part.value)
    .join(' ');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(dates): format a month title and a narrow weekday name"
```

---

### Task 4: `units.week`, and `monthYear`, `weekdayNarrow` and `dayLine` on the `Formatter`

**Files:**
- Modify: `public/locales/es/common.json:31`, `public/locales/en/common.json:31` (a `week` key inside `units`)
- Modify: `src/lib/useFormat.ts:12-23` (imports), `src/lib/useFormat.ts:40-57` (the `Formatter` members), `src/lib/useFormat.ts:112-120` (the returned object)
- Test: `src/lib/locales.test.ts` (imports at `1-7`, two new cases after line `98`)

**Interfaces:**
- Consumes: `formatMonthYear(date, language)` and `formatWeekdayNarrow(date, language)` from Task 3; `formatLongDate(date, language)` and `isoWeekNumber(date)`, both existing
- Produces: `Formatter.monthYear(date: string): string`, `Formatter.weekdayNarrow(date: string): string`, `Formatter.dayLine(date: string): string`, and the locale key `units.week`

- [ ] **Step 1: Write the failing test**

Replace the import block of `src/lib/locales.test.ts` (lines 1-7) with:

```ts
import { describe, expect, it } from 'vitest';
import es from '../../public/locales/es/common.json';
import en from '../../public/locales/en/common.json';
import { EDIT_MESSAGE_KEYS, HORIZON_EXCEEDED_KEY, MANUAL_PLACEMENT_MESSAGE_KEYS } from './composition';
import { isoWeekNumber } from './dates';
import { ERROR_MESSAGE_KEYS } from './errors';
import { formatLongDate } from './format';
import i18next, { SUPPORTED_LANGUAGES, type Language } from './i18n';
import { deletedJobGapReason, textLanguages } from './text';
import { WED } from '../testing/fixtures';
```

Then insert these two cases after the `'words the wireframe strings exactly'` case (after line 98, before the `describe('locale files')` closing `});`):

```ts
  it('words the week label a date field carries under itself', () => {
    // `header.week` carries the week's date range inside it. Under a date field the long date
    // already says the days, so the number has to be available on its own.
    expect(resolve(es as Json, 'units.week')).toBe('Semana {{week}}');
    expect(resolve(en as Json, 'units.week')).toBe('Week {{week}}');
  });

  it('composes the day line a date field shows under itself', () => {
    // `useFormat().dayLine` is a hook and this suite renders nothing, so the pieces it joins are
    // composed here: the sentence is what a reworded key must not break.
    const dayLine = (language: Language): string => {
      const t = i18next.getFixedT(language);
      return [formatLongDate(WED, language), t('units.week', { week: isoWeekNumber(WED) })].join(
        t('units.listSeparator'),
      );
    };
    expect(dayLine('es')).toBe('miércoles 12 de agosto · Semana 33');
    expect(dayLine('en')).toBe('Wednesday 12 August · Week 33');
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/locales.test.ts -t 'words the week label a date field carries'`
Expected: FAIL — `resolve` throws `Not a string key: units.week`, because neither bundle has the key yet.

- [ ] **Step 3: Add the key to both bundles**

In `public/locales/es/common.json`, inside `units`, after `"dayOptionToday"` (line 31):

```json
    "week": "Semana {{week}}",
```

In `public/locales/en/common.json`, inside `units`, after `"dayOptionToday"` (line 31):

```json
    "week": "Week {{week}}",
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/locales.test.ts`
Expected: PASS

- [ ] **Step 5: Put the three members on the `Formatter`**

Replace the import block of `src/lib/useFormat.ts` (lines 12-23) with:

```ts
import { isoWeekNumber } from './dates';
import {
  formatHourNumber,
  formatLongDate,
  formatMediumDate,
  formatMonthShort,
  formatMonthYear,
  formatDayOfMonth,
  formatTime,
  formatWeekdayLong,
  formatWeekdayNarrow,
  formatWeekdayShort,
  weekRangeLabel,
} from './format';
import { DEFAULT_LANGUAGE, intlLocaleOf, isLanguage, type Language } from './i18n';
```

Replace the `Formatter` members from `/** "Mié" */` through `mediumDate` (lines 40-57) with:

```ts
  /** "Mié" */
  weekdayShort(date: string): string;
  /** "L" — the single letter a month grid heads its columns with. */
  weekdayNarrow(date: string): string;
  /** "miércoles" */
  weekdayLong(date: string): string;
  /** "12" */
  dayOfMonth(date: string): string;
  /** "ago" */
  monthShort(date: string): string;
  /** "agosto 2026" */
  monthYear(date: string): string;
  /** The day-header label: "Mié 12". */
  dayHeader(date: string): string;
  /** "Mié 12 ago" — a whole day, short enough for a form control's option. */
  dayOption(date: string): string;
  /** The same with the shop's today marked: "Mié 12 ago · hoy". */
  todayOption(date: string): string;
  /** "jueves 27 de agosto" — for prose such as the summary strip. */
  longDate(date: string): string;
  /** "27 ago 2026" — for lists and confirmations. */
  mediumDate(date: string): string;
  /** "miércoles 12 de agosto · Semana 33" — the line a date field carries under itself. */
  dayLine(date: string): string;
```

Replace the returned object's date block (lines 112-120) with:

```ts
      weekdayShort: (date) => formatWeekdayShort(date, language),
      weekdayNarrow: (date) => formatWeekdayNarrow(date, language),
      weekdayLong: (date) => formatWeekdayLong(date, language),
      dayOfMonth: formatDayOfMonth,
      monthShort: (date) => formatMonthShort(date, language),
      monthYear: (date) => formatMonthYear(date, language),
      dayHeader,
      dayOption,
      todayOption: (date) => t('units.dayOptionToday', { date: dayOption(date) }),
      longDate: (date) => formatLongDate(date, language),
      mediumDate: (date) => formatMediumDate(date, language),
      dayLine: (date) =>
        [formatLongDate(date, language), t('units.week', { week: isoWeekNumber(date) })].join(
          t('units.listSeparator'),
        ),
```

- [ ] **Step 6: Run the gates that can see this file**

Run: `npx tsc --noEmit && npx vitest run src/lib/locales.test.ts src/lib/format.test.ts src/lib/dates.test.ts`
Expected: PASS — `tsc` is what proves the `Formatter` additions compile; no test renders the hook.

- [ ] **Step 7: Commit**

```bash
git add public/locales/es/common.json public/locales/en/common.json src/lib/useFormat.ts src/lib/locales.test.ts
git commit -m "feat(i18n): add the week label and the day line a date field shows"
```


### Task 5: The month grid's 42 days and the marks it decides alone

**Files:**
- Create: `src/components/ui/monthGrid.ts`
- Test: `src/components/ui/monthGrid.test.ts`

**Interfaces:**
- Consumes: `startOfMonth(date: string): string`, `isSameMonth(a: string, b: string): boolean` (added to `src/lib/dates.ts` by the dates slice); the existing `addDays(date: string, days: number): string`, `compareDates(a: string, b: string): number`, `isValidDate(date: string): boolean`, `isWeekend(date: string): boolean`, `startOfWeek(date: string): string`, `weekdayOf(date: string): number`, `MONDAY`; `planningWindow(today: string, horizonWeeks?: number, pastWeeks?: number): DayWindow` and `interface DayWindow { minDate: string; maxDate: string }` from `src/components/ui/dateOptions.ts`, both untouched
- Produces: `export const MONTH_GRID_ROWS = 6`; `export const MONTH_GRID_CELLS = 42`; `export interface MonthCell { date: string; inMonth: boolean; selectable: boolean; isToday: boolean; isWeekend: boolean; isPast: boolean }`; `export interface MonthGridOptions { today: string; window: DayWindow; current?: string }`; `export function monthGrid(month: string, options: MonthGridOptions): MonthCell[]`

- [ ] **Step 1: Write the failing test**

Write `src/components/ui/monthGrid.test.ts`:

```ts
/**
 * The month grid the day picker draws.
 *
 * Six rows always, whatever the month: the popover is then a constant height, so clipping it
 * against the window is arithmetic and not a measurement. And `selectable` is the whole of how
 * far the picker reaches — the day already stored is offered however far outside the window it
 * falls, while a day the window does not reach is drawn and cannot be chosen.
 */

import { describe, expect, it } from 'vitest';
import { MONDAY, addDays, weekdayOf } from '../../lib/dates';
import { planningWindow, type DayWindow } from './dateOptions';
import { MONTH_GRID_CELLS, MONTH_GRID_ROWS, monthGrid, type MonthCell } from './monthGrid';
import { FRI, LAST_WED, MON, SAT, SUN, THU, WED } from '../../testing/fixtures';

// The window the fixtures' week opens with: 2026-07-13 to 2026-10-04.
const WINDOW: DayWindow = planningWindow(WED, 8);

/** Opens on a Saturday and runs 31 days, so August 2026 genuinely needs all six rows. */
const AUGUST = '2026-08-01';
/** Opens on a Sunday: 28 days over five rows. */
const FEB_2026 = '2026-02-01';
/** Opens on a Monday: 28 days over four rows, with no leading neighbour at all. */
const FEB_2027 = '2027-02-01';
/** Half of its grid falls behind the window's `minDate`. */
const JULY = '2026-07-01';
const JANUARY = '2026-01-01';
const OCTOBER = '2026-10-01';

function cellsOf(month: string, current?: string): MonthCell[] {
  return monthGrid(month, { today: WED, window: WINDOW, current });
}

function cellOf(month: string, date: string, current?: string): MonthCell {
  const cell = cellsOf(month, current).find((candidate) => candidate.date === date);
  if (cell === undefined) throw new Error(`${date} is not in the grid of ${month}`);
  return cell;
}

describe('the month grid', () => {
  it('is six rows of seven', () => {
    expect(MONTH_GRID_ROWS).toBe(6);
    expect(MONTH_GRID_CELLS).toBe(MONTH_GRID_ROWS * 7);
  });

  it('draws six Monday-first weeks of consecutive days, whatever the month', () => {
    for (const month of [AUGUST, FEB_2026, FEB_2027, JULY, JANUARY, '2026-11-01']) {
      const cells = cellsOf(month);
      expect(cells).toHaveLength(MONTH_GRID_CELLS);
      expect(weekdayOf(cells[0].date)).toBe(MONDAY);
      cells.forEach((cell, index) => {
        expect(cell.date).toBe(addDays(cells[0].date, index));
      });
    }
  });

  it('reads the month from any day of it', () => {
    expect(cellsOf('2026-08-25')).toEqual(cellsOf(AUGUST));
  });

  it('starts on the Monday before a month that opens on a Sunday', () => {
    const cells = cellsOf(FEB_2026);
    expect(cells[0].date).toBe('2026-01-26');
    expect(cells[0].inMonth).toBe(false);
    expect(cells[6].date).toBe(FEB_2026);
    expect(cells[6].inMonth).toBe(true);
  });

  it('starts on the 1st itself when the month opens on a Monday', () => {
    const cells = cellsOf(FEB_2027);
    expect(cells[0].date).toBe(FEB_2027);
    expect(cells[0].inMonth).toBe(true);
  });

  it('keeps its 42 cells for a month that fills six rows', () => {
    const cells = cellsOf(AUGUST);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells[0].date).toBe('2026-07-27');
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2026-09-06');
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it('keeps its 42 cells for a February over five rows', () => {
    const cells = cellsOf(FEB_2026);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2026-03-08');
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(28);
  });

  it('pads rather than shortens a February that fills four rows', () => {
    const cells = cellsOf(FEB_2027);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(28);
    // The last fourteen cells are all March, so a four-row month keeps the grid's height.
    expect(cells.slice(28).every((cell) => !cell.inMonth)).toBe(true);
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2027-03-14');
  });

  it('marks the neighbour days that fill the first and the last row', () => {
    const neighbours = cellsOf(AUGUST)
      .filter((cell) => !cell.inMonth)
      .map((cell) => cell.date);
    expect(neighbours).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });
});

describe('what the month grid offers', () => {
  it('offers every day of a month the window covers whole', () => {
    expect(cellsOf(AUGUST).every((cell) => cell.selectable)).toBe(true);
  });

  it('refuses the days before the window opens, though it draws them', () => {
    const refused = cellsOf(JULY)
      .filter((cell) => !cell.selectable)
      .map((cell) => cell.date);
    // 2026-06-29 to 2026-07-12: the fortnight of the July grid the window does not reach.
    expect(refused).toHaveLength(14);
    expect(refused[0]).toBe('2026-06-29');
    expect(refused[refused.length - 1]).toBe('2026-07-12');
    expect(cellOf(JULY, WINDOW.minDate).selectable).toBe(true);
  });

  it('refuses the days after the window closes', () => {
    expect(cellOf(OCTOBER, WINDOW.maxDate).selectable).toBe(true);
    expect(cellOf(OCTOBER, '2026-10-05').selectable).toBe(false);
  });

  it('offers the stored day itself, however far outside the window it falls', () => {
    expect(cellOf(JANUARY, '2026-01-09', '2026-01-09').selectable).toBe(true);
    // And only that day: the rest of its month stays as unreachable as before.
    expect(cellOf(JANUARY, '2026-01-08', '2026-01-09').selectable).toBe(false);
  });

  it('offers only what a window narrower than a month reaches', () => {
    const cells = monthGrid(AUGUST, { today: WED, window: { minDate: WED, maxDate: FRI } });
    expect(cells.filter((cell) => cell.selectable).map((cell) => cell.date)).toEqual([
      WED,
      THU,
      FRI,
    ]);
  });

  it('offers nothing but the stored day when the window is not a range', () => {
    const cells = monthGrid(AUGUST, {
      today: WED,
      window: { minDate: '', maxDate: '' },
      current: WED,
    });
    expect(cells.filter((cell) => cell.selectable).map((cell) => cell.date)).toEqual([WED]);
  });
});

describe('the marks the month grid decides without the server', () => {
  it('marks today, and only today', () => {
    expect(cellsOf(AUGUST).filter((cell) => cell.isToday).map((cell) => cell.date)).toEqual([WED]);
    expect(cellsOf(FEB_2027).some((cell) => cell.isToday)).toBe(false);
  });

  it('marks Saturday and Sunday', () => {
    expect(cellOf(AUGUST, SAT).isWeekend).toBe(true);
    expect(cellOf(AUGUST, SUN).isWeekend).toBe(true);
    expect(cellOf(AUGUST, MON).isWeekend).toBe(false);
    expect(cellsOf(AUGUST).filter((cell) => cell.isWeekend)).toHaveLength(12);
  });

  it('marks the days behind today, today itself not among them', () => {
    expect(cellOf(AUGUST, LAST_WED).isPast).toBe(true);
    expect(cellOf(AUGUST, MON).isPast).toBe(true);
    expect(cellOf(AUGUST, WED).isPast).toBe(false);
    expect(cellOf(AUGUST, THU).isPast).toBe(false);
    // The neighbour days of the first row are judged like any other day.
    expect(cellOf(AUGUST, '2026-07-27').isPast).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/monthGrid.test.ts -t 'draws six Monday-first weeks of consecutive days, whatever the month'`
Expected: FAIL — the suite cannot even load: `Failed to resolve import "./monthGrid"`, because `src/components/ui/monthGrid.ts` does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/components/ui/monthGrid.ts`:

```ts
/**
 * The 42 days a month's grid holds, and the marks each one carries without asking the server.
 * Kept out of the component so it can be tested without a DOM.
 *
 * Six rows always, even for a month that fits in four: the popover is then a constant height,
 * so clipping it against the viewport is arithmetic rather than a measurement.
 */

import {
  addDays,
  compareDates,
  isSameMonth,
  isValidDate,
  isWeekend,
  startOfMonth,
  startOfWeek,
} from '../../lib/dates';
import type { DayWindow } from './dateOptions';

const DAYS_PER_WEEK = 7;

export const MONTH_GRID_ROWS = 6;
export const MONTH_GRID_CELLS = MONTH_GRID_ROWS * DAYS_PER_WEEK;

export interface MonthCell {
  date: string;
  /** Belongs to the month being shown, rather than the neighbouring one that fills the row. */
  inMonth: boolean;
  /** Inside the window, or the stored value itself. */
  selectable: boolean;
  isToday: boolean;
  isWeekend: boolean;
  isPast: boolean;
}

export interface MonthGridOptions {
  /** The shop's today; a real date, since `isPast` is measured from it. */
  today: string;
  window: DayWindow;
  /** The stored value, offered however far outside the window it falls. */
  current?: string;
}

/** The six Monday-first weeks covering the month `month` falls in, whatever day of it it names. */
export function monthGrid(month: string, options: MonthGridOptions): MonthCell[] {
  const first = startOfMonth(month);
  const start = startOfWeek(first);
  // A caller's own bounds can arrive empty, and comparing against one would throw mid-render.
  const bounded = isValidDate(options.window.minDate) && isValidDate(options.window.maxDate);

  return Array.from({ length: MONTH_GRID_CELLS }, (_, index) => {
    const date = addDays(start, index);
    const inWindow =
      bounded &&
      compareDates(date, options.window.minDate) >= 0 &&
      compareDates(date, options.window.maxDate) <= 0;

    return {
      date,
      inMonth: isSameMonth(date, first),
      selectable: inWindow || date === options.current,
      isToday: date === options.today,
      isWeekend: isWeekend(date),
      isPast: compareDates(date, options.today) < 0,
    };
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/monthGrid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/monthGrid.ts src/components/ui/monthGrid.test.ts
git commit -m "feat(pickers): draw the day picker month grid"
```

### Task 6: The month the picker opens on, and how far its arrows reach

**Files:**
- Create: `src/components/ui/monthReach.ts`
- Test: `src/components/ui/monthReach.test.ts`

**Interfaces:**
- Consumes: `startOfMonth(date: string): string` and `addMonths(date: string, months: number): string` (added to `src/lib/dates.ts` by the dates slice); the existing `compareDates(a: string, b: string): number` and `isValidDate(date: string): boolean`; `planningWindow(today: string, horizonWeeks?: number, pastWeeks?: number): DayWindow` and `interface DayWindow { minDate: string; maxDate: string }` from `src/components/ui/dateOptions.ts`, both untouched
- Produces: `export interface MonthReach { canPrevious: boolean; canNext: boolean }`; `export function openingMonth(current: string, options: { today: string; window: DayWindow }): string`; `export function monthReach(month: string, window: DayWindow): MonthReach`; `export function stepMonth(month: string, direction: 1 | -1, window: DayWindow): string`

- [ ] **Step 1: Write the failing test**

Write `src/components/ui/monthReach.test.ts`:

```ts
/**
 * Where the day picker opens, and how far its two arrows reach.
 *
 * The window is an affordance and the stored day is the datum: a day saved outside the window
 * opens on its own month, and from there one press reaches the window instead of walking the
 * months in between, which offer nothing to choose.
 */

import { describe, expect, it } from 'vitest';
import { planningWindow, type DayWindow } from './dateOptions';
import { monthReach, openingMonth, stepMonth } from './monthReach';
import { WED } from '../../testing/fixtures';

// 2026-07-13 to 2026-10-04, so the reachable months are July to October 2026.
const WINDOW: DayWindow = planningWindow(WED, 8);

const JULY = '2026-07-01';
const AUGUST = '2026-08-01';
const SEPTEMBER = '2026-09-01';
const OCTOBER = '2026-10-01';

describe('openingMonth', () => {
  it('opens on the month of the day already chosen', () => {
    expect(openingMonth(WED, { today: WED, window: WINDOW })).toBe(AUGUST);
    expect(openingMonth('2026-09-30', { today: WED, window: WINDOW })).toBe(SEPTEMBER);
  });

  it('opens on the month of a stored day the window does not reach', () => {
    expect(openingMonth('2026-01-09', { today: WED, window: WINDOW })).toBe('2026-01-01');
    expect(openingMonth('2027-03-01', { today: WED, window: WINDOW })).toBe('2027-03-01');
  });

  it('falls back to the month of today when there is no day yet', () => {
    expect(openingMonth('', { today: WED, window: WINDOW })).toBe(AUGUST);
    expect(openingMonth('not a date', { today: WED, window: WINDOW })).toBe(AUGUST);
  });

  it('never falls back onto a month the window does not reach', () => {
    expect(openingMonth('', { today: '2026-01-05', window: WINDOW })).toBe(JULY);
    expect(openingMonth('', { today: '2027-05-05', window: WINDOW })).toBe(OCTOBER);
  });
});

describe('monthReach', () => {
  it('moves both ways inside the window', () => {
    expect(monthReach(AUGUST, WINDOW)).toEqual({ canPrevious: true, canNext: true });
    expect(monthReach(SEPTEMBER, WINDOW)).toEqual({ canPrevious: true, canNext: true });
  });

  it('turns an arrow off exactly at the month holding the window end', () => {
    expect(monthReach(JULY, WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach(OCTOBER, WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('reads the month from any day of it', () => {
    expect(monthReach('2026-07-31', WINDOW)).toEqual(monthReach(JULY, WINDOW));
    expect(monthReach(WINDOW.minDate, WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach(WINDOW.maxDate, WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('turns both arrows off when the whole window sits in one month', () => {
    expect(monthReach(AUGUST, { minDate: '2026-08-12', maxDate: '2026-08-14' })).toEqual({
      canPrevious: false,
      canNext: false,
    });
  });

  it('points back into the window from a month outside it', () => {
    expect(monthReach('2026-01-01', WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach('2027-03-01', WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('moves nowhere when the window is not a range', () => {
    expect(monthReach(AUGUST, { minDate: '', maxDate: '' })).toEqual({
      canPrevious: false,
      canNext: false,
    });
  });
});

describe('stepMonth', () => {
  it('moves one month, either way', () => {
    expect(stepMonth(AUGUST, 1, WINDOW)).toBe(SEPTEMBER);
    expect(stepMonth(AUGUST, -1, WINDOW)).toBe(JULY);
  });

  it('returns the same month when the arrow is off', () => {
    expect(stepMonth(JULY, -1, WINDOW)).toBe(JULY);
    expect(stepMonth(OCTOBER, 1, WINDOW)).toBe(OCTOBER);
    expect(stepMonth('2026-07-20', -1, WINDOW)).toBe(JULY);
  });

  it('never leaves the window, however many times it is pressed', () => {
    let month = openingMonth('', { today: WED, window: WINDOW });
    for (let press = 0; press < 12; press += 1) month = stepMonth(month, 1, WINDOW);
    expect(month).toBe(OCTOBER);
    for (let press = 0; press < 12; press += 1) month = stepMonth(month, -1, WINDOW);
    expect(month).toBe(JULY);
  });

  it('reaches the window in one press from the month a stored day opened on', () => {
    expect(stepMonth('2026-01-01', 1, WINDOW)).toBe(JULY);
    expect(stepMonth('2027-03-01', -1, WINDOW)).toBe(OCTOBER);
    // And that month's other arrow, which reports off, still moves nothing.
    expect(stepMonth('2026-01-01', -1, WINDOW)).toBe('2026-01-01');
  });

  it('crosses a year end', () => {
    const yearEnd: DayWindow = { minDate: '2026-11-15', maxDate: '2027-02-10' };
    expect(stepMonth('2026-12-01', 1, yearEnd)).toBe('2027-01-01');
    expect(stepMonth('2027-01-01', -1, yearEnd)).toBe('2026-12-01');
    expect(stepMonth('2027-02-01', 1, yearEnd)).toBe('2027-02-01');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/monthReach.test.ts -t 'turns an arrow off exactly at the month holding the window end'`
Expected: FAIL — the suite cannot load: `Failed to resolve import "./monthReach"`, because `src/components/ui/monthReach.ts` does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/components/ui/monthReach.ts`:

```ts
/**
 * Which month the day picker opens on, and how far its two arrows reach. Kept out of the
 * component so it can be tested without a DOM.
 */

import { addMonths, compareDates, isValidDate, startOfMonth } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

/** Whether each arrow still has a month to reach in its own direction. */
export interface MonthReach {
  canPrevious: boolean;
  canNext: boolean;
}

/**
 * The month whose grid opens, as its 1st. A stored day outside the window opens on ITS month
 * and is never pulled inside: the window is an affordance and the stored day is the datum.
 * `options.today` is the shop's own day, so it is a real date; `current` need not be.
 */
export function openingMonth(
  current: string,
  options: { today: string; window: DayWindow },
): string {
  if (isValidDate(current)) return startOfMonth(current);
  return clampToWindow(startOfMonth(options.today), options.window);
}

export function monthReach(month: string, window: DayWindow): MonthReach {
  // A caller's own bounds can arrive empty, and comparing against one would throw mid-render.
  if (!isValidDate(window.minDate) || !isValidDate(window.maxDate)) {
    return { canPrevious: false, canNext: false };
  }
  const first = startOfMonth(month);
  return {
    canPrevious: compareDates(first, startOfMonth(window.minDate)) > 0,
    canNext: compareDates(first, startOfMonth(window.maxDate)) < 0,
  };
}

/**
 * One month along, and never out of the window. From a month outside it — the one a stored day
 * opened on — this lands on the nearest month the window offers rather than on the next empty
 * one, so a live arrow always changes what can be chosen.
 */
export function stepMonth(month: string, direction: 1 | -1, window: DayWindow): string {
  const first = startOfMonth(month);
  const reach = monthReach(first, window);
  if (direction === 1 ? !reach.canNext : !reach.canPrevious) return first;
  return clampToWindow(addMonths(first, direction), window);
}

function clampToWindow(month: string, window: DayWindow): string {
  if (!isValidDate(window.minDate) || !isValidDate(window.maxDate)) return month;
  const first = startOfMonth(window.minDate);
  const last = startOfMonth(window.maxDate);
  if (compareDates(month, first) < 0) return first;
  if (compareDates(month, last) > 0) return last;
  return month;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/monthReach.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/monthReach.ts src/components/ui/monthReach.test.ts
git commit -m "feat(pickers): hold the month grid inside the picker window"
```


### Task 7: The day picker's keyboard movement

**Files:**
- Create: `src/components/ui/dayPickerKeys.ts`
- Test: `src/components/ui/dayPickerKeys.test.ts`

**Interfaces:**
- Consumes: `addDays(date: string, days: number): string`, `startOfWeek(date: string): string`, `compareDates(a: string, b: string): number` from `src/lib/dates.ts` (all three exist today); `addMonths(date: string, months: number): string` from `src/lib/dates.ts` (added by the dates slice, clamped to the target month's last day); `planningWindow(today: string, horizonWeeks?: number, pastWeeks?: number): DayWindow` and `interface DayWindow { minDate: string; maxDate: string }` from `src/components/ui/dateOptions.ts`
- Produces: `export type DayPickerKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown'`; `export function isDayPickerKey(key: string): key is DayPickerKey`; `export function moveFocusedDay(date: string, key: DayPickerKey, window: DayWindow): string`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The day picker's keyboard movement. The suite runs in `node` with no DOM, so the move is decided
 * from a key NAME rather than from a `KeyboardEvent`, and this is what pins it.
 *
 * The property that matters most is the last one: no key ever answers with a day the window does
 * not offer, because such a cell cannot be clicked either and focus on one is a dead end.
 */

import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../../lib/dates';
import { LAST_WED, MON, NEXT_WED, SUN, THU, TUE, WED } from '../../testing/fixtures';
import { planningWindow, type DayWindow } from './dateOptions';
import { isDayPickerKey, moveFocusedDay, type DayPickerKey } from './dayPickerKeys';

/** The window the wireframe's Wednesday really opens with: 2026-07-13 … 2026-10-04. */
const WINDOW = planningWindow(WED, 8);

/** Wide enough that a page turn is never clamped, so the month arithmetic reads on its own. */
const YEAR: DayWindow = { minDate: '2026-01-01', maxDate: '2026-12-31' };

const BACKWARD: DayPickerKey[] = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Home'];
const FORWARD: DayPickerKey[] = ['ArrowRight', 'ArrowDown', 'PageDown', 'End'];
const EVERY_KEY: DayPickerKey[] = [...BACKWARD, ...FORWARD];

describe('isDayPickerKey', () => {
  it('recognises the eight keys the grid answers, and no more', () => {
    expect(EVERY_KEY).toHaveLength(8);
    for (const key of EVERY_KEY) expect(isDayPickerKey(key)).toBe(true);
  });

  it('leaves every other key to whatever else wants it', () => {
    for (const key of ['Enter', 'Escape', 'Tab', ' ', 'a', 'ArrowLeftRight', 'constructor']) {
      expect(isDayPickerKey(key)).toBe(false);
    }
  });
});

describe('moveFocusedDay', () => {
  it('steps a day with the left and the right arrow', () => {
    expect(moveFocusedDay(WED, 'ArrowLeft', WINDOW)).toBe(TUE);
    expect(moveFocusedDay(WED, 'ArrowRight', WINDOW)).toBe(THU);
  });

  it('steps a week with the up and the down arrow', () => {
    expect(moveFocusedDay(WED, 'ArrowUp', WINDOW)).toBe(LAST_WED);
    expect(moveFocusedDay(WED, 'ArrowDown', WINDOW)).toBe(NEXT_WED);
  });

  it('lands on the Monday and the Sunday of that week', () => {
    expect(moveFocusedDay(WED, 'Home', WINDOW)).toBe(MON);
    expect(moveFocusedDay(WED, 'End', WINDOW)).toBe(SUN);
    expect(moveFocusedDay(MON, 'Home', WINDOW)).toBe(MON);
    expect(moveFocusedDay(SUN, 'End', WINDOW)).toBe(SUN);
  });

  it('keeps the day of the month across a page turn', () => {
    expect(moveFocusedDay(WED, 'PageUp', YEAR)).toBe('2026-07-12');
    expect(moveFocusedDay(WED, 'PageDown', YEAR)).toBe('2026-09-12');
  });

  it('falls back to the last day a shorter month has', () => {
    // 31 January and 31 March both page onto 28 February, which is all 2026 has.
    expect(moveFocusedDay('2026-01-31', 'PageDown', YEAR)).toBe('2026-02-28');
    expect(moveFocusedDay('2026-03-31', 'PageUp', YEAR)).toBe('2026-02-28');
  });

  it('stops on the first day the window offers', () => {
    for (const key of BACKWARD) {
      expect(moveFocusedDay(WINDOW.minDate, key, WINDOW)).toBe(WINDOW.minDate);
    }
  });

  it('stops on the last day the window offers', () => {
    for (const key of FORWARD) {
      expect(moveFocusedDay(WINDOW.maxDate, key, WINDOW)).toBe(WINDOW.maxDate);
    }
  });

  it('clamps a page turn that would land on a drawn but unreachable day', () => {
    // The window opens on Monday 13 July, so the grid draws 12 July without offering it.
    expect(WINDOW.minDate).toBe('2026-07-13');
    expect(moveFocusedDay(WED, 'PageUp', WINDOW)).toBe('2026-07-13');
  });

  it('steps a stored day from outside the window onto the nearest day inside it', () => {
    for (const key of EVERY_KEY) {
      expect(moveFocusedDay('2026-01-09', key, WINDOW)).toBe(WINDOW.minDate);
      expect(moveFocusedDay('2027-03-01', key, WINDOW)).toBe(WINDOW.maxDate);
    }
  });

  it('never answers with a day outside the window', () => {
    for (
      let date = WINDOW.minDate;
      compareDates(date, WINDOW.maxDate) <= 0;
      date = addDays(date, 1)
    ) {
      for (const key of EVERY_KEY) {
        const landed = moveFocusedDay(date, key, WINDOW);
        expect(compareDates(landed, WINDOW.minDate)).toBeGreaterThanOrEqual(0);
        expect(compareDates(landed, WINDOW.maxDate)).toBeLessThanOrEqual(0);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/dayPickerKeys.test.ts -t 'steps a day with the left and the right arrow'`
Expected: FAIL — the suite cannot be imported at all: `Failed to resolve import "./dayPickerKeys"`, because `src/components/ui/dayPickerKeys.ts` does not exist yet.

- [ ] **Step 3: Write the movement table and the clamp**

```ts
/**
 * Where the keyboard moves the focused cell of the day picker's month grid: a key NAME in, a day
 * out. Structural rather than a `KeyboardEvent`, so the movement is testable with no DOM.
 */

import { addDays, addMonths, compareDates, startOfWeek } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

const DAYS_PER_WEEK = 7;

export type DayPickerKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

/** A full `Record`, so a key joining the union without a move of its own stops the build. */
const MOVES: Record<DayPickerKey, (date: string) => string> = {
  ArrowLeft: (date) => addDays(date, -1),
  ArrowRight: (date) => addDays(date, 1),
  ArrowUp: (date) => addDays(date, -DAYS_PER_WEEK),
  ArrowDown: (date) => addDays(date, DAYS_PER_WEEK),
  Home: (date) => startOfWeek(date),
  End: (date) => addDays(startOfWeek(date), DAYS_PER_WEEK - 1),
  PageUp: (date) => addMonths(date, -1),
  PageDown: (date) => addMonths(date, 1),
};

const KEYS: readonly string[] = Object.keys(MOVES);

export function isDayPickerKey(key: string): key is DayPickerKey {
  return KEYS.includes(key);
}

/**
 * The day the focus lands on, always inside `window`: a cell the window does not offer cannot be
 * chosen, so a move that would leave it stops on the edge instead. A stored day from outside the
 * window is a legal starting point, and the first press steps onto the nearest day inside.
 *
 * Caller obligation: a press can therefore answer with the day it was given, and the grid must read
 * the month off the day that came back rather than off the key that was pressed.
 */
export function moveFocusedDay(date: string, key: DayPickerKey, window: DayWindow): string {
  const moved = MOVES[key](date);
  if (compareDates(moved, window.minDate) < 0) return window.minDate;
  if (compareDates(moved, window.maxDate) > 0) return window.maxDate;
  return moved;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/dayPickerKeys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/dayPickerKeys.ts src/components/ui/dayPickerKeys.test.ts
git commit -m "feat(pickers): move the day grid's focus from a key name"
```

### Task 8: The absence range as a two-click state machine

**Files:**
- Create: `src/components/ui/dayRange.ts`
- Test: `src/components/ui/dayRange.test.ts`

**Interfaces:**
- Consumes: `absenceRange(from: string, to: string): { dates: string[]; skipped: string[] }` and `MAX_ABSENCE_DAYS` from `src/lib/absences.ts`; `compareDates(a: string, b: string): number` and `addDays(date: string, days: number): string` from `src/lib/dates.ts`
- Produces: `export interface RangeState { anchor?: string }`; `export interface RangeClickResult { state: RangeState; committed?: { from: string; to: string } }`; `export function rangeClick(state: RangeState, date: string): RangeClickResult`; `export function rangeCells(from: string, to: string): { included: string[]; skipped: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The range picker's state machine, shaped like `paintSession.ts`: state in, state out, and the
 * caller carries out what came back.
 *
 * Nothing leaves the popover until it has both ends. A half-chosen range reaching the form would
 * fire `previewAbsence` — a real write inside a rolled-back transaction — on every click of a walk
 * through the month, announcing displaced work for a range nobody has finished choosing.
 */

import { describe, expect, it } from 'vitest';
import { MAX_ABSENCE_DAYS } from '../../lib/absences';
import { addDays } from '../../lib/dates';
import { FRI, MON, NEXT_MON, SAT, SUN, THU, WED } from '../../testing/fixtures';
import { rangeCells, rangeClick } from './dayRange';

describe('rangeClick', () => {
  it('holds the first click and commits nothing', () => {
    const result = rangeClick({}, WED);
    expect(result.state).toEqual({ anchor: WED });
    expect(result.committed).toBeUndefined();
  });

  it('commits both ends on the second click', () => {
    expect(rangeClick({ anchor: MON }, FRI).committed).toEqual({ from: MON, to: FRI });
  });

  it('orders the ends however they were clicked', () => {
    expect(rangeClick({ anchor: FRI }, MON).committed).toEqual({ from: MON, to: FRI });
    expect(rangeClick({ anchor: MON }, FRI).committed).toEqual({ from: MON, to: FRI });
  });

  it('is a single day when the second click lands back on the anchor', () => {
    expect(rangeClick({ anchor: WED }, WED).committed).toEqual({ from: WED, to: WED });
  });

  it('lets the anchor go once it has committed, so the next click starts a range', () => {
    const committed = rangeClick({ anchor: MON }, FRI);
    expect(committed.state.anchor).toBeUndefined();

    const again = rangeClick(committed.state, SUN);
    expect(again.state).toEqual({ anchor: SUN });
    expect(again.committed).toBeUndefined();
  });
});

describe('rangeCells', () => {
  it('paints the weekend inside a span as excluded', () => {
    expect(rangeCells(THU, NEXT_MON)).toEqual({
      included: [THU, FRI, NEXT_MON],
      skipped: [SAT, SUN],
    });
  });

  it('paints a span that is nothing but a weekend as written in full', () => {
    expect(rangeCells(SAT, SUN)).toEqual({ included: [SAT, SUN], skipped: [] });
  });

  it('crosses a month boundary without a seam', () => {
    // Monday 31 August to Wednesday 2 September 2026.
    expect(rangeCells('2026-08-31', '2026-09-02')).toEqual({
      included: ['2026-08-31', '2026-09-01', '2026-09-02'],
      skipped: [],
    });
  });

  it('paints the longest span the server accepts, whole', () => {
    const last = addDays(MON, MAX_ABSENCE_DAYS - 1);
    const cells = rangeCells(MON, last);
    expect(cells.included.length + cells.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(cells.included[cells.included.length - 1]).toBe(last);
  });

  it('paints no cell past the cap, which is what the server refuses', () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    const cells = rangeCells(MON, past);
    expect(cells.included.length + cells.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(cells.included).not.toContain(past);
    expect(cells.skipped).not.toContain(past);
  });

  it('takes a committed span straight from the click, backwards ones included', () => {
    const { committed } = rangeClick({ anchor: NEXT_MON }, THU);
    expect(committed).toEqual({ from: THU, to: NEXT_MON });
    expect(rangeCells(committed!.from, committed!.to).skipped).toEqual([SAT, SUN]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/dayRange.test.ts -t 'holds the first click and commits nothing'`
Expected: FAIL — the suite cannot be imported at all: `Failed to resolve import "./dayRange"`, because `src/components/ui/dayRange.ts` does not exist yet.

- [ ] **Step 3: Write the state machine, delegating the weekend rule**

`src/lib/absences.ts` is safe to pull into a client component: it imports `addDays`, `compareDates` and `isWeekend` from `src/lib/dates.ts` and nothing else, and `src/lib/dates.ts` has no imports at all — no `better-sqlite3`, no `node:` module, no `server-only`.

```ts
/**
 * Choosing a range of days as a pure state machine. The pending end is kept HERE and only reaches
 * the form once both ends exist: a first click that wrote the form's two dates would fire a preview
 * — a real write inside a rolled-back transaction — on every click of a walk through the month.
 */

import { absenceRange } from '../../lib/absences';
import { compareDates } from '../../lib/dates';

export interface RangeState {
  /** The end clicked first, while the second is still missing. */
  anchor?: string;
}

export interface RangeClickResult {
  state: RangeState;
  /** Set only when both ends exist, always ordered. */
  committed?: { from: string; to: string };
}

/**
 * One click on a cell. The first sets the anchor and commits nothing; the second commits the span
 * in calendar order whichever end was clicked first, and lets the anchor go so a reopened popover
 * starts a range rather than closing the last one.
 */
export function rangeClick(state: RangeState, date: string): RangeClickResult {
  const anchor = state.anchor;
  if (anchor === undefined) return { state: { anchor: date } };

  const backwards = compareDates(date, anchor) < 0;
  return {
    state: {},
    committed: backwards ? { from: date, to: anchor } : { from: anchor, to: date },
  };
}

/**
 * Which cells of a committed span the save will write, and which it drops. Delegated to
 * `absenceRange`, the same call the preview and the save make, so a painted cell cannot promise a
 * day the write skips — and so the whole-range-is-a-weekend exception is not derived twice.
 *
 * Caller obligation: the walk stops at the range cap, so the tail of an over-long span is painted
 * neither included nor skipped. The count under the field comes from the preview, never from here.
 */
export function rangeCells(from: string, to: string): { included: string[]; skipped: string[] } {
  const range = absenceRange(from, to);
  return { included: range.dates, skipped: range.skipped };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/dayRange.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/dayRange.ts src/components/ui/dayRange.test.ts
git commit -m "feat(pickers): choose an absence range in two clicks"
```


### Task 9: The typed time arithmetic — read it, step it, commit it

**Files:**
- Create: `src/components/ui/timeTyping.ts`
- Test: `src/components/ui/timeTyping.test.ts`

**Interfaces:**
- Consumes: `TIME_STEP_MINUTES: number`, `clockMinutes(value: string): number | undefined` from `src/components/ui/timeOptions.ts`; `snapWithinBounds(value: number, bounds: { step: number; min?: number; max?: number }): number` from `src/components/ui/stepper.ts`; `MINUTES_PER_DAY`, `MINUTES_PER_HOUR`, `minutesToHHmm(minutes: number): string` from `src/lib/dates.ts`
- Produces: `export const MAX_TYPED_MINUTES = 1425` (23:45); `export interface TimeBounds { minMinutes?: number; maxMinutes?: number }`; `export type TimeCommit = { ok: true; value: string } | { ok: false; reason: 'invalid-format' } | { ok: false; reason: 'out-of-bounds'; minMinutes: number; maxMinutes: number }`; `export function normalizeTypedTime(value: string): string | undefined`; `export function stepTypedTime(value: string, direction: 1 | -1, options?: { wholeHour?: boolean; bounds?: TimeBounds }): string`; `export function commitTypedTime(valueAtFocus: string, value: string, bounds?: TimeBounds): TimeCommit`

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/timeTyping.test.ts`:

```ts
/**
 * What a time typed into the field means.
 *
 * The commit rule is the one that matters: `changedFields` in src/components/settings/shift.ts
 * compares the STRINGS to decide what to PATCH, so rounding a value nobody touched would put
 * `period1Start` in the patch, and a Settings save recomposes the calendar and empties the undo line.
 */

import { describe, expect, it } from 'vitest';
import { MAX_TYPED_MINUTES, commitTypedTime, normalizeTypedTime, stepTypedTime } from './timeTyping';

/** A 14:10-18:10 afternoon: what `momentBounds` offers, from the shift's start to one step before it closes. */
const AFTERNOON = { minMinutes: 14 * 60 + 10, maxMinutes: 17 * 60 + 55 };

describe('normalizeTypedTime', () => {
  it('reads the short forms of a time', () => {
    expect(normalizeTypedTime('8')).toBe('08:00');
    expect(normalizeTypedTime('18')).toBe('18:00');
    expect(normalizeTypedTime('830')).toBe('08:30');
    expect(normalizeTypedTime('0830')).toBe('08:30');
    expect(normalizeTypedTime('8:30')).toBe('08:30');
    expect(normalizeTypedTime('08:30')).toBe('08:30');
    expect(normalizeTypedTime(' 08:30 ')).toBe('08:30');
    expect(normalizeTypedTime('00:00')).toBe('00:00');
  });

  it('refuses what it cannot read as one time', () => {
    expect(normalizeTypedTime('')).toBeUndefined();
    expect(normalizeTypedTime('8:3')).toBeUndefined();
    expect(normalizeTypedTime('25:00')).toBeUndefined();
    expect(normalizeTypedTime('12:60')).toBeUndefined();
    expect(normalizeTypedTime('ocho')).toBeUndefined();
    expect(normalizeTypedTime('-1:00')).toBeUndefined();
  });

  it('refuses the end of the day, whose last legal moment is 23:45', () => {
    expect(MAX_TYPED_MINUTES).toBe(23 * 60 + 45);
    expect(normalizeTypedTime('23:45')).toBe('23:45');
    expect(normalizeTypedTime('24:00')).toBeUndefined();
    expect(normalizeTypedTime('2400')).toBeUndefined();
    // A legible time above the ceiling still reads back; `commitTypedTime` is what refuses it.
    expect(normalizeTypedTime('23:50')).toBe('23:50');
  });
});

describe('stepTypedTime', () => {
  it('moves a quarter hour from a value on the grid', () => {
    expect(stepTypedTime('08:00', 1)).toBe('08:15');
    expect(stepTypedTime('08:00', -1)).toBe('07:45');
  });

  it('moves a whole hour when one is asked for', () => {
    expect(stepTypedTime('08:00', 1, { wholeHour: true })).toBe('09:00');
    expect(stepTypedTime('08:00', -1, { wholeHour: true })).toBe('07:00');
  });

  it('lands on the next multiple in that direction, not on the nearest', () => {
    // 08:20 is nearer 08:15, so a plain snap would send a press of `+` backwards.
    expect(stepTypedTime('08:20', 1)).toBe('08:30');
    expect(stepTypedTime('08:20', -1)).toBe('08:15');
    expect(stepTypedTime('08:10', 1)).toBe('08:15');
    expect(stepTypedTime('08:10', -1)).toBe('08:00');
    expect(stepTypedTime('08:20', 1, { wholeHour: true })).toBe('09:00');
    expect(stepTypedTime('08:20', -1, { wholeHour: true })).toBe('08:00');
  });

  it('stops at the two ends of the day', () => {
    expect(stepTypedTime('23:45', 1)).toBe('23:45');
    expect(stepTypedTime('23:00', 1, { wholeHour: true })).toBe('23:45');
    expect(stepTypedTime('00:00', -1)).toBe('00:00');
    expect(stepTypedTime('00:30', -1, { wholeHour: true })).toBe('00:00');
  });

  it('stops on a bound that is off the quarter grid', () => {
    expect(stepTypedTime('17:45', 1, { bounds: AFTERNOON })).toBe('17:55');
    expect(stepTypedTime('14:15', -1, { bounds: AFTERNOON })).toBe('14:10');
  });

  it('leaves a value it cannot read alone', () => {
    expect(stepTypedTime('ocho', 1)).toBe('ocho');
    expect(stepTypedTime('', -1)).toBe('');
  });
});

describe('commitTypedTime', () => {
  /**
   * THE LOAD-BEARING ONE. A hand-edited 08:10 has to survive a tab-through: snapping it to 08:15
   * would send `period1Start` in a Settings patch nobody asked for.
   */
  it('returns an untouched value verbatim, unsnapped', () => {
    expect(commitTypedTime('08:10', '08:10')).toEqual({ ok: true, value: '08:10' });
  });

  it('normalises and snaps a value that was actually typed', () => {
    expect(commitTypedTime('09:00', '8')).toEqual({ ok: true, value: '08:00' });
    expect(commitTypedTime('09:00', '830')).toEqual({ ok: true, value: '08:30' });
    expect(commitTypedTime('09:00', '08:10')).toEqual({ ok: true, value: '08:15' });
  });

  it('refuses a value it cannot read, changed or not', () => {
    expect(commitTypedTime('08:00', 'ocho')).toEqual({ ok: false, reason: 'invalid-format' });
    // Leaving the field twice over the same rubbish must not turn it legal on the second pass.
    expect(commitTypedTime('ocho', 'ocho')).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it('refuses past the last quarter of the day instead of sliding the value', () => {
    expect(commitTypedTime('08:00', '23:50')).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 0,
      maxMinutes: MAX_TYPED_MINUTES,
    });
  });

  it('refuses outside the bounds instead of clamping into them', () => {
    expect(commitTypedTime('15:00', '18:00', AFTERNOON)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 850,
      maxMinutes: 1075,
    });
    expect(commitTypedTime('15:00', '14:00', AFTERNOON)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
      minMinutes: 850,
      maxMinutes: 1075,
    });
  });

  it('keeps a bound that is off the quarter grid reachable', () => {
    expect(commitTypedTime('15:00', '17:55', AFTERNOON)).toEqual({ ok: true, value: '17:55' });
    expect(commitTypedTime('15:00', '17:50', AFTERNOON)).toEqual({ ok: true, value: '17:45' });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/timeTyping.test.ts -t 'returns an untouched value verbatim'`
Expected: FAIL — the suite cannot even be collected: `Failed to resolve import "./timeTyping" from "src/components/ui/timeTyping.test.ts"`, because the module does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/components/ui/timeTyping.ts`:

```ts
/**
 * What a typed time means: how a short form is read, where an arrow lands, and what leaving the field
 * stores. Kept out of the component so it can be tested without a DOM.
 */

import { MINUTES_PER_DAY, MINUTES_PER_HOUR, minutesToHHmm } from '../../lib/dates';
import { snapWithinBounds } from './stepper';
import { TIME_STEP_MINUTES, clockMinutes } from './timeOptions';

/** The last quarter of the day: the highest value an arrow or a commit will produce. */
export const MAX_TYPED_MINUTES = MINUTES_PER_DAY - TIME_STEP_MINUTES;

/** Minutes from midnight, both ends inclusive. */
export interface TimeBounds {
  minMinutes?: number;
  maxMinutes?: number;
}

export type TimeCommit =
  | { ok: true; value: string }
  | { ok: false; reason: 'invalid-format' }
  | { ok: false; reason: 'out-of-bounds'; minMinutes: number; maxMinutes: number };

const DIGITS_ONLY = /^\d{1,4}$/;
const HOURS_AND_MINUTES = /^(\d{1,2}):(\d{2})$/;

/** `'8'` -> `'08:00'`, `'830'` -> `'08:30'`, `'0830'` -> `'08:30'`, `'8:30'` -> `'08:30'`. */
export function normalizeTypedTime(value: string): string | undefined {
  const typed = value.trim();
  const spelled = DIGITS_ONLY.test(typed) ? spellDigits(typed) : typed;
  if (!HOURS_AND_MINUTES.test(spelled)) return undefined;

  const minutes = clockMinutes(spelled);
  // `hhmmToMinutes` reads "24:00" as 1440, and a start that big leaves the grid drawing no band at
  // all while the field still looks legal.
  if (minutes === undefined || minutes >= MINUTES_PER_DAY) return undefined;
  return minutesToHHmm(minutes);
}

export function stepTypedTime(
  value: string,
  direction: 1 | -1,
  options: { wholeHour?: boolean; bounds?: TimeBounds } = {},
): string {
  const current = typedMinutes(value);
  if (current === undefined) return value;

  const grid = options.wholeHour === true ? MINUTES_PER_HOUR : TIME_STEP_MINUTES;
  // Off the grid the first press lands on the next multiple in that direction: rounding to the
  // nearest would send a press of `+` on 08:20 backwards to 08:15.
  const aligned =
    direction > 0 ? Math.ceil(current / grid) * grid : Math.floor(current / grid) * grid;
  const next = aligned === current ? current + direction * grid : aligned;

  const { minMinutes, maxMinutes } = effectiveBounds(options.bounds);
  return minutesToHHmm(snapWithinBounds(next, { step: grid, min: minMinutes, max: maxMinutes }));
}

export function commitTypedTime(
  valueAtFocus: string,
  value: string,
  bounds?: TimeBounds,
): TimeCommit {
  const minutes = typedMinutes(value);
  if (minutes === undefined) return { ok: false, reason: 'invalid-format' };

  // Only what was actually retyped is snapped: `changedFields` compares the strings, so rounding a
  // stored 08:10 on the way past would send it in a Settings patch that empties the undo line.
  if (value === valueAtFocus) return { ok: true, value };

  const { minMinutes, maxMinutes } = effectiveBounds(bounds);
  if (minutes < minMinutes || minutes > maxMinutes) {
    return { ok: false, reason: 'out-of-bounds', minMinutes, maxMinutes };
  }
  // Bounds read as typed, then the snap held inside them. A ceiling one step before the shift
  // closes is off the quarter grid (17:55 on a 14:10-18:10 afternoon): snapping first would round
  // that ceiling past itself and the field would refuse the very moment its own error names.
  return {
    ok: true,
    value: minutesToHHmm(
      snapWithinBounds(minutes, { step: TIME_STEP_MINUTES, min: minMinutes, max: maxMinutes }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A bare number as a clock time: one or two digits are the hour, three or four hour and minutes. */
function spellDigits(digits: string): string {
  if (digits.length <= 2) return `${digits}:00`;
  return `${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}`;
}

/** Minutes from midnight for a value as typed, `undefined` when it is not one time. */
function typedMinutes(value: string): number | undefined {
  const normalized = normalizeTypedTime(value);
  return normalized === undefined ? undefined : clockMinutes(normalized);
}

/** The caller's bounds, held inside 00:00-23:45 and in order. */
function effectiveBounds(bounds: TimeBounds = {}): { minMinutes: number; maxMinutes: number } {
  const minMinutes = boundMinutes(bounds.minMinutes, 0);
  const maxMinutes = boundMinutes(bounds.maxMinutes, MAX_TYPED_MINUTES);
  return { minMinutes, maxMinutes: Math.max(minMinutes, maxMinutes) };
}

function boundMinutes(value: number | undefined, fallback: number): number {
  const minutes = value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
  return Math.min(MAX_TYPED_MINUTES, Math.max(0, minutes));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/timeTyping.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/timeTyping.ts src/components/ui/timeTyping.test.ts
git commit -m "feat(time): read, step and commit a typed time"
```


### Task 10: `readDays` and `MAX_DAY_MARK_DAYS`, the two marks only the server knows

**Files:**
- Modify: `src/lib/operations/views.ts:7-22` (the import block), `src/lib/operations/views.ts:156-160` (append after `readWeek`, before `withinWeek`)
- Test: `src/lib/operations.test.ts:8` (add `addDays`), `src/lib/operations.test.ts:24` (add `MAX_DAY_MARK_DAYS`, `readDays`), `src/lib/operations.test.ts:2918` (nine cases inside `describe('the views the screens read')`)

**Interfaces:**
- Consumes: `plannableMinutesOf(snapshot: ScheduleSnapshot, date: string): number` and `readSnapshot(db?: Db, today?: string): ScheduleSnapshot` from `src/lib/scheduler.ts`; `isMovable(block: Block, today: string): boolean` and `horizonEndDate(today: string, planningHorizonWeeks: number): string` from `src/lib/composition.ts`; `freeStretchesFrom(periods: readonly WorkPeriod[], occupied: readonly SpillInterval[], fromMinutes: number): SpillStretch[]` and `type SpillInterval` from `src/lib/dropSpill.ts`; `listDayOverridesBetween(from: string, to: string, db?: Db): DayOverride[]`; `MIN_ROW_MINUTES` from `src/lib/validation.ts`; `badRequest`, `ERROR_MESSAGE_KEYS` from `src/lib/errors.ts`; `addDays`, `compareDates`, `daysBetween`, `todayLocal` from `src/lib/dates.ts`
- Produces: `export const MAX_DAY_MARK_DAYS = 200;`, `export interface DayMarkView { date: string; isClosed: boolean; note?: string; freeMinutes: number; hasRoom: boolean }`, `export interface DaysView { today: string; days: DayMarkView[] }`, `export function readDays(from: string, to: string, options?: { today?: string }, db?: Db): DaysView`

- [ ] **Step 1: Write the failing test**

In `src/lib/operations.test.ts`, change line 8 from `import { minutesToHHmm } from './dates';` to `import { addDays, minutesToHHmm } from './dates';`, change line 24 from `import { readWeek } from './operations/views';` to `import { MAX_DAY_MARK_DAYS, readDays, readWeek } from './operations/views';`, and insert this block at line 2918, immediately before the `});` that closes `describe('the views the screens read')`:

```ts

  it('marks a plain weekday as having room, and says how many minutes are left', () => {
    job('Door', 4);

    const days = marks(MON, TUE, MON);

    expect(days.get(MON)).toEqual({ date: MON, isClosed: false, freeMinutes: 6 * 60, hasRoom: true });
    expect(days.get(TUE)).toEqual({ date: TUE, isClosed: false, freeMinutes: 10 * 60, hasRoom: true });
  });

  it('reports NO room on a day unlocked work has filled, which plannableMinutes calls empty', () => {
    job('Door', 10);

    // The week still answers 600: it reports the engine's budget, not what is left of it.
    expect(readWeek(MON, { today: MON }, db).days[0].plannableMinutes).toBe(10 * 60);
    expect(marks(MON, MON, MON).get(MON)).toEqual({
      date: MON,
      isClosed: false,
      freeMinutes: 0,
      hasRoom: false,
    });
  });

  it('sends a closed day with its stored note, and no room', () => {
    upsertDayOverride({ date: THU, isClosed: true, capacityHours: null, note: 'Fair' }, db);

    expect(marks(THU, THU, MON).get(THU)).toEqual({
      date: THU,
      isClosed: true,
      note: 'Fair',
      freeMinutes: 0,
      hasRoom: false,
    });
  });

  it('gives the weekend no room, because the engine never lays it out', () => {
    const days = marks(SAT, SUN, MON);

    expect([days.get(SAT), days.get(SUN)]).toEqual([
      { date: SAT, isClosed: false, freeMinutes: 0, hasRoom: false },
      { date: SUN, isClosed: false, freeMinutes: 0, hasRoom: false },
    ]);
  });

  it('gives the frozen past no room', () => {
    expect(marks(MON, TUE, WED).get(MON)).toEqual({
      date: MON,
      isClosed: false,
      freeMinutes: 0,
      hasRoom: false,
    });
  });

  it('ships the real free minutes beyond the horizon while refusing it room', () => {
    updateSettings({ planningHorizonWeeks: 1 }, { today: MON }, db);

    const days = marks(THU, NEXT_MON, MON);

    expect(days.get(THU)).toEqual({ date: THU, isClosed: false, freeMinutes: 10 * 60, hasRoom: true });
    // One week's horizon from Monday ends on Sunday: the day after it is fully plannable to the
    // day plan and out of reach to the engine, which is why the horizon is checked separately.
    expect(days.get(NEXT_MON)).toEqual({
      date: NEXT_MON,
      isClosed: false,
      freeMinutes: 10 * 60,
      hasRoom: false,
    });
  });

  it('refuses room to a day whose free minutes are holes too small to hold a row', () => {
    // 08:00-13:50 and 15:30-19:20: twenty minutes left, in two holes of ten.
    createGap({ date: WED, startMinutes: 8 * 60, durationMinutes: 350, reason: 'Breakdown', today: MON }, db);
    createGap({ date: WED, startMinutes: 15 * 60 + 30, durationMinutes: 230, reason: 'Errands', today: MON }, db);

    expect(marks(WED, WED, MON).get(WED)).toEqual({
      date: WED,
      isClosed: false,
      freeMinutes: 20,
      hasRoom: false,
    });
  });

  it('gives a day whose capacity is nought no room, and does not call it closed', () => {
    upsertDayOverride({ date: THU, isClosed: false, capacityHours: 0 }, db);

    expect(marks(THU, THU, MON).get(THU)).toEqual({
      date: THU,
      isClosed: false,
      freeMinutes: 0,
      hasRoom: false,
    });
  });

  it('refuses a span longer than MAX_DAY_MARK_DAYS instead of walking it', () => {
    expect(readDays(MON, addDays(MON, MAX_DAY_MARK_DAYS - 1), { today: MON }, db).days).toHaveLength(
      MAX_DAY_MARK_DAYS,
    );

    const error = refusal(() => readDays(MON, addDays(MON, MAX_DAY_MARK_DAYS), { today: MON }, db));

    expect(error.code).toBe('invalid-range');
    expect(error.status).toBe(400);
    expect(error.field).toBe('to');
    expect(error.details).toMatchObject({ maxDays: MAX_DAY_MARK_DAYS });
  });

  /** The marks by date, so a case names the day it is about instead of counting rows. */
  function marks(from: string, to: string, today: string) {
    return new Map(readDays(from, to, { today }, db).days.map((day) => [day.date, day]));
  }
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/operations.test.ts -t 'the views the screens read'`
Expected: FAIL — `src/lib/operations/views.ts` exports neither `readDays` nor `MAX_DAY_MARK_DAYS`, so the whole file fails to collect with `No "readDays" export is defined on the "./operations/views" mock`/`does not provide an export named 'readDays'`.

- [ ] **Step 3: Add `readDays` next to `readWeek`**

Replace the import block of `src/lib/operations/views.ts` (lines 7-22) with:

```ts
import { getDb, type Db } from '../db';
import {
  addDays,
  compareDates,
  daysBetween,
  isoWeekNumber,
  isoWeekYear,
  isWeekend,
  todayLocal,
  weekDates,
  weekdayOf,
} from '../dates';
import {
  horizonEndDate,
  isMovable,
  summarizeSchedule,
  type DayRole,
  type ScheduleSummary,
} from '../composition';
import { freeStretchesFrom, type SpillInterval } from '../dropSpill';
import { badRequest, ERROR_MESSAGE_KEYS } from '../errors';
import { readHistoryState, type HistoryState } from '../history';
import { plannableMinutesOf, readSnapshot } from '../scheduler';
import { MIN_ROW_MINUTES } from '../validation';
import { listDayOverridesBetween } from '../repositories/dayOverrides';
import { listProjectLabels } from '../repositories/projects';
import type { Block, DayShape, Gap, Settings, WorkPeriod } from '../../types';
```

Then insert this after `readWeek`'s closing brace and before `function withinWeek`:

```ts
/**
 * The widest span one request may ask for. Its own number: the widest window a day picker can
 * navigate is 140 days, plus a stored value's own month.
 */
export const MAX_DAY_MARK_DAYS = 200;

/** One day as a picker draws it, carrying only what the client cannot work out for itself. */
export interface DayMarkView {
  date: string;
  isClosed: boolean;
  note?: string;
  /** Net working minutes the engine would still lay work into. */
  freeMinutes: number;
  /** Whether the engine still places hours here: the horizon, the free minutes and the longest free run all have to allow it. */
  hasRoom: boolean;
}

export interface DaysView {
  /** The shop's LOCAL today. */
  today: string;
  days: DayMarkView[];
}

/**
 * The two marks a day picker cannot deduce — closed, and still has room — for every day of an
 * inclusive span. The weekend and the past are absent on purpose: the client owns them.
 *
 * The room question is NOT `WeekDay.plannableMinutes`, which does not subtract ordinary work and so
 * reports a full Tuesday as empty, and not `bookedMinutes`, which reports a day the next write will
 * clear as full.
 */
export function readDays(
  from: string,
  to: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): DaysView {
  if (daysBetween(from, to) + 1 > MAX_DAY_MARK_DAYS) {
    throw badRequest('invalid-range', ERROR_MESSAGE_KEYS.invalidRange, {
      field: 'to',
      details: { from, to, maxDays: MAX_DAY_MARK_DAYS },
    });
  }

  const today = options.today ?? todayLocal();
  const snapshot = readSnapshot(db, today);
  const notes = new Map(
    listDayOverridesBetween(from, to, db).map((override) => [override.date, override.note]),
  );
  const horizonEnd = horizonEndDate(today, snapshot.settings.planningHorizonWeeks);

  const occupiedByDate = new Map<string, SpillInterval[]>();
  for (const row of [...snapshot.gaps, ...snapshot.blocks]) {
    const rows = occupiedByDate.get(row.date);
    if (rows === undefined) occupiedByDate.set(row.date, [row]);
    else rows.push(row);
  }

  const movableByDate = new Map<string, number>();
  for (const block of snapshot.blocks) {
    if (!isMovable(block, today)) continue;
    movableByDate.set(block.date, (movableByDate.get(block.date) ?? 0) + block.durationMinutes);
  }

  const days: DayMarkView[] = [];
  for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
    const config = snapshot.getDayConfig(date);
    const note = notes.get(date);
    // The engine's own arithmetic: a day opens at its plannable minutes and auto-fill spends them,
    // and the day's movable rows are exactly what the last pass spent that budget on.
    const freeMinutes = Math.max(
      0,
      plannableMinutesOf(snapshot, date) - (movableByDate.get(date) ?? 0),
    );
    // The horizon is asked separately because the day plan does not know it: past it, a day
    // declares all its minutes plannable and would promise room where a save answers 409.
    const withinHorizon = compareDates(date, horizonEnd) <= 0;
    const longestRun = longestFreeRun(config.periods, occupiedByDate.get(date) ?? []);
    days.push({
      date,
      isClosed: config.isClosed,
      freeMinutes,
      hasRoom: withinHorizon && Math.min(freeMinutes, longestRun) >= MIN_ROW_MINUTES,
      ...(note === undefined ? {} : { note }),
    });
  }

  return { today, days };
}
```

And add this private helper next to `withinWeek` at the bottom of the file:

```ts
/**
 * The longest run one row could occupy, so a day whose forty free minutes are four holes of ten
 * reports no room. Measured over the PERIODS, never the manual windows: auto-fill never enters a
 * margin.
 */
function longestFreeRun(
  periods: readonly WorkPeriod[],
  occupied: readonly SpillInterval[],
): number {
  let longest = 0;
  for (const stretch of freeStretchesFrom(periods, occupied, 0)) {
    longest = Math.max(longest, stretch.endMinutes - stretch.startMinutes);
  }
  return longest;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/operations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/views.ts src/lib/operations.test.ts
git commit -m "feat(api): read closed days and free room over a date range"
```

### Task 11: `GET /api/days`

**Files:**
- Create: `app/api/days/route.ts`

**Interfaces:**
- Consumes: `readDays(from: string, to: string, options?: { today?: string }, db?: Db): DaysView` from Task 10; `requireDateParam(url: URL, key: string): string` and `route<T>(work: () => Promise<T> | T): Promise<NextResponse>` from `src/lib/api.ts`
- Produces: `GET /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD` -> `DaysView`

- [ ] **Step 1: Write the route (no test — see below)**

There is no failing test for this step and none is invented: `vitest.config.mts` includes only `src/**/*.test.ts`, no test in the repository imports a route handler, and one that did would reach `getDb()`, which `openDatabase` refuses to point at `data/calendar.db` under vitest. The route is three lines of wiring over `readDays`, which Task 10 pinned; `tsc`, `eslint` and `next build` are its gates.

Create `app/api/days/route.ts`:

```ts
/**
 * GET `?from=YYYY-MM-DD&to=YYYY-MM-DD` -> { today, days: DayMarkView[] }
 *
 * The two marks a day picker cannot deduce: whether the shop is closed that day, with whatever note
 * the owner stored on it, and whether the engine still has room to lay work into it. Both bounds are
 * required — a half-open span has no sensible default — and a span past `MAX_DAY_MARK_DAYS` is a 400.
 */

import type { NextRequest } from 'next/server';
import { requireDateParam, route } from '@/src/lib/api';
import { readDays } from '@/src/lib/operations/views';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return route(() => {
    const url = new URL(request.url);
    return readDays(requireDateParam(url, 'from'), requireDateParam(url, 'to'));
  });
}
```

- [ ] **Step 2: Type-check the new route**

Run: `npx tsc --noEmit`
Expected: PASS — no output

- [ ] **Step 3: Lint the new route**

Run: `npx eslint app/api/days/route.ts`
Expected: PASS — no output

- [ ] **Step 4: Build, which is the only gate that compiles a route**

Run: `npm run build`
Expected: PASS, and `/api/days` listed in the route table

- [ ] **Step 5: Commit**

```bash
git add app/api/days/route.ts
git commit -m "feat(api): serve the day marks at GET /api/days"
```

### Task 12: `getDayMarks` on the client

**Files:**
- Modify: `src/lib/api-client.ts:18` (the type re-export), `src/lib/api-client.ts:38` (the type import), `src/lib/api-client.ts:759` (append after `getWeek`)
- Test: `src/lib/api-client.test.ts:10-31` (the import list), `src/lib/api-client.test.ts:186` (one case at the end of `describe('requests')`)

**Interfaces:**
- Consumes: `DaysView` and `DayMarkView` from `src/lib/operations/views.ts` (Task 10); `get<T>(path: string, options?: RequestOptions): Promise<T>` (private to `api-client.ts`)
- Produces: `export function getDayMarks(from: string, to: string, options?: RequestOptions): Promise<DaysView>`, plus `DaysView` and `DayMarkView` re-exported as types from `src/lib/api-client.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/api-client.test.ts`, add `getDayMarks,` to the import list between `createProject,` (line 16) and `getWeek,` (line 17), then insert this case at line 186, immediately before the `});` that closes `describe('requests')`:

```ts

  it('asks for a span of day marks with both bounds in the query', async () => {
    const { calls } = stubFetch({
      body: { today: '2026-08-12', days: [{ date: '2026-08-12', isClosed: false, freeMinutes: 360, hasRoom: true }] },
    });

    const view = await getDayMarks('2026-07-13', '2026-10-04');

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/api/days?from=2026-07-13&to=2026-10-04');
    expect(view.today).toBe('2026-08-12');
    expect(view.days[0].hasRoom).toBe(true);
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/api-client.test.ts -t 'asks for a span of day marks with both bounds in the query'`
Expected: FAIL — `src/lib/api-client.ts` has no `getDayMarks` export, so the file fails to collect with `does not provide an export named 'getDayMarks'`.

- [ ] **Step 3: Add `getDayMarks` to the Views section**

Change line 18 of `src/lib/api-client.ts` from:

```ts
export type { WeekBlock, WeekDay, WeekView } from './operations/views';
```

to:

```ts
export type { DayMarkView, DaysView, WeekBlock, WeekDay, WeekView } from './operations/views';
```

Change line 38 from:

```ts
import type { WeekView } from './operations/views';
```

to:

```ts
import type { DaysView, WeekView } from './operations/views';
```

Then insert after `getWeek`'s closing brace (line 759), before the `// Undo and redo` banner:

```ts

/**
 * The two marks a day picker cannot deduce for itself, for every day of an inclusive span: closed,
 * with the note stored on the day, and whether the engine still has room there. Both bounds are
 * required, and a span past 200 days is a 400. Refetch it on the same counter as `getWeek` — a
 * recomposition rewrites rows on days this response has already described.
 */
export function getDayMarks(from: string, to: string, options?: RequestOptions): Promise<DaysView> {
  const query = new URLSearchParams({ from, to });
  return get<DaysView>(`/days?${query.toString()}`, options);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/api-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "feat(api): fetch the day marks from the client"
```


### Task 13: The two server marks, and the span the picker asks the route for

**Files:**
- Create: `src/components/ui/pickerDays.ts`
- Test: `src/components/ui/pickerDays.test.ts`

**Interfaces:**
- Consumes: `planningWindow(today: string, horizonWeeks?: number, pastWeeks?: number): DayWindow` and `DayWindow` from `./dateOptions`; `startOfMonth(date: string): string`, `endOfMonth(date: string): string`, `isSameMonth(a: string, b: string): boolean`, `isValidDate(date: string): boolean`, `addDays(date: string, days: number): string`, `daysBetween(from: string, to: string): number` from `../../lib/dates`; `MAX_HORIZON_WEEKS` from `../../lib/settings`; `MAX_DAY_MARK_DAYS` from `../../lib/operations/views` (TEST ONLY — never at runtime); `WED`, `SAT`, `NEXT_MON` from `../../testing/fixtures`
- Produces: `export interface DayMark { isClosed: boolean; note?: string; hasRoom: boolean; freeMinutes: number }`, `export type DayMarks = Readonly<Record<string, DayMark>>`, `export function markOf(date: string, marks: DayMarks | undefined): DayMark | undefined`, `export function markRange(window: DayWindow, current?: string): { from: string; to: string }`

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/pickerDays.test.ts`:

```ts
/**
 * The two marks only the server knows, and the span it is asked for.
 *
 * The span is what can break the picker outright rather than dim it: the route answers nothing at
 * all past `MAX_DAY_MARK_DAYS`, so a stored value months outside the window must not widen the ask.
 */

import { describe, expect, it } from 'vitest';
import { MAX_DAY_MARK_DAYS } from '../../lib/operations/views';
import { MAX_HORIZON_WEEKS } from '../../lib/settings';
import { addDays, daysBetween } from '../../lib/dates';
import { NEXT_MON, SAT, WED } from '../../testing/fixtures';
import { planningWindow } from './dateOptions';
import { markOf, markRange, type DayMarks } from './pickerDays';

const MARKS: DayMarks = {
  [WED]: { isClosed: false, hasRoom: true, freeMinutes: 240 },
  [SAT]: { isClosed: true, note: 'Fair', hasRoom: false, freeMinutes: 0 },
};

describe('markOf', () => {
  it('answers with the day the route sent', () => {
    expect(markOf(WED, MARKS)).toEqual({ isClosed: false, hasRoom: true, freeMinutes: 240 });
    expect(markOf(SAT, MARKS)?.note).toBe('Fair');
  });

  it('answers nothing for a day outside the span that was asked for', () => {
    expect(markOf(NEXT_MON, MARKS)).toBeUndefined();
  });

  it('answers nothing before the marks have arrived', () => {
    expect(markOf(WED, undefined)).toBeUndefined();
  });
});

describe('markRange', () => {
  it('asks for the window when the stored value sits well inside it', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, WED)).toEqual({ from: '2026-07-13', to: '2026-10-04' });
  });

  it('asks for the window when there is no stored value at all', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window)).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it('widens to the whole month at the end the stored value shares', () => {
    const window = planningWindow(WED, 8);
    // The window opens mid-July and closes on 4 October, so both edge months have days it
    // does not offer — and a value stored on one of them opens the popover there.
    expect(markRange(window, '2026-07-06')).toEqual({ from: '2026-07-01', to: '2026-10-04' });
    expect(markRange(window, '2026-10-20')).toEqual({ from: '2026-07-13', to: '2026-10-31' });
  });

  it('leaves a value months away out of the ask rather than one the route refuses', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, '2028-03-05')).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it('does not take July 2027 for the window's own July', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, addDays(window.minDate, 365))).toEqual({
      from: window.minDate,
      to: window.maxDate,
    });
  });

  it('ignores a value that is not a date at all', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, '')).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it('never asks for a span the route refuses, wherever the window falls', () => {
    // A year of "today", the widest window `planningWindow` can produce — four weeks back and the
    // sixteen-week cap — and a stored value at each end of it, the only two that widen the ask.
    for (let offset = 0; offset < 371; offset += 1) {
      const window = planningWindow(addDays(WED, offset), MAX_HORIZON_WEEKS);
      const stored: (string | undefined)[] = [
        undefined,
        window.minDate,
        window.maxDate,
        addDays(window.minDate, -1),
        addDays(window.maxDate, 1),
      ];
      for (const current of stored) {
        const range = markRange(window, current);
        expect(daysBetween(range.from, range.to) + 1).toBeLessThanOrEqual(MAX_DAY_MARK_DAYS);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/pickerDays.test.ts -t 'markRange'`
Expected: FAIL — `Failed to resolve import "./pickerDays"`: the module does not exist yet, so every test in the file errors at collection.

- [ ] **Step 3: Write `pickerDays.ts`**

Create `src/components/ui/pickerDays.ts`:

```ts
/**
 * The two marks a day cell cannot work out on its own — the grey of a closed day and the dot of one
 * the engine still has room in — and the span to ask the route for. Kept out of the component so it
 * can be tested without a DOM.
 */

import { endOfMonth, isSameMonth, isValidDate, startOfMonth } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

/** What the route says about one day. The weekend and the past are derived in the client. */
export interface DayMark {
  isClosed: boolean;
  /** The day's stored note, which the cell says instead of the word "closed". */
  note?: string;
  hasRoom: boolean;
  /** Net working minutes still free. */
  freeMinutes: number;
}

/** The route's answer, by local `YYYY-MM-DD`. */
export type DayMarks = Readonly<Record<string, DayMark>>;

/**
 * A day the route did not send answers `undefined`, which an index lookup at the call site would
 * not: `noUncheckedIndexedAccess` is off, so `marks[date].isClosed` typechecks and then throws on
 * the first day outside the span.
 */
export function markOf(date: string, marks: DayMarks | undefined): DayMark | undefined {
  return marks?.[date];
}

/**
 * ONE request, covering the whole navigable window, widened to a whole month at either end the
 * stored value shares — the month the popover opens in when that value sits just outside.
 *
 * A value FURTHER out is deliberately left out. `window` is always `planningWindow`'s, so twenty
 * weeks at the most, and reaching a month a year away would ask for a span past
 * `MAX_DAY_MARK_DAYS`, which the route refuses whole: no marks anywhere rather than none in one
 * month.
 */
export function markRange(window: DayWindow, current?: string): { from: string; to: string } {
  if (current === undefined || !isValidDate(current)) {
    return { from: window.minDate, to: window.maxDate };
  }
  return {
    from: isSameMonth(current, window.minDate) ? startOfMonth(current) : window.minDate,
    to: isSameMonth(current, window.maxDate) ? endOfMonth(current) : window.maxDate,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/pickerDays.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/pickerDays.ts src/components/ui/pickerDays.test.ts
git commit -m "feat(pickers): bound the day-mark span a picker asks the route for"
```

### Task 14: Where the popover sits, clipped to the window

**Files:**
- Create: `src/components/ui/popoverBox.ts`
- Test: `src/components/ui/popoverBox.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface PopoverAnchor { top: number; left: number; bottom: number; right: number }`, `export interface PopoverSize { width: number; height: number }`, `export interface PopoverViewport { width: number; height: number }`, `export function popoverPosition(anchor: PopoverAnchor, size: PopoverSize, viewport: PopoverViewport, gap: number): { top: number; left: number }`

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/popoverBox.test.ts`:

```ts
/**
 * Where a popover lands. `PaintChooser` clamps the same way against `window.innerWidth` and
 * `innerHeight`, but from ESTIMATED dimensions measured by hand; here the grid is always six rows,
 * so the box is a known size and the clipping is arithmetic with a test.
 */

import { describe, expect, it } from 'vitest';
import { popoverPosition, type PopoverAnchor } from './popoverBox';

/** A six-row month grid: the only box this positions. */
const BOX = { width: 268, height: 320 };
const VIEWPORT = { width: 1280, height: 800 };
const GAP = 6;

/** A trigger in the side panel, which sits at the right of the screen. */
const TRIGGER: PopoverAnchor = { top: 180, left: 940, bottom: 208, right: 1240 };

describe('popoverPosition', () => {
  it('opens below the trigger when the box fits there', () => {
    expect(popoverPosition(TRIGGER, BOX, VIEWPORT, GAP)).toEqual({ top: 214, left: 940 });
  });

  it('opens above the trigger when it does not', () => {
    const low: PopoverAnchor = { top: 520, left: 940, bottom: 548, right: 1240 };
    expect(popoverPosition(low, BOX, VIEWPORT, GAP)).toEqual({ top: 194, left: 940 });
  });

  it('clamps to the right edge rather than hanging off it', () => {
    const nearEdge: PopoverAnchor = { top: 180, left: 1120, bottom: 208, right: 1272 };
    expect(popoverPosition(nearEdge, BOX, VIEWPORT, GAP).left).toBe(1012);
  });

  it('clamps to the left edge, for a trigger already partly off it', () => {
    const offLeft: PopoverAnchor = { top: 180, left: -40, bottom: 208, right: 220 };
    expect(popoverPosition(offLeft, BOX, VIEWPORT, GAP).left).toBe(0);
  });

  it('pins the box to the top left when the viewport is smaller than it is', () => {
    const small: PopoverAnchor = { top: 100, left: 60, bottom: 128, right: 180 };
    expect(popoverPosition(small, BOX, { width: 200, height: 240 }, GAP)).toEqual({
      top: 0,
      left: 0,
    });
  });

  it('sits flush against the trigger with a gap of zero', () => {
    expect(popoverPosition(TRIGGER, BOX, VIEWPORT, 0).top).toBe(208);
    const low: PopoverAnchor = { top: 520, left: 940, bottom: 548, right: 1240 };
    expect(popoverPosition(low, BOX, VIEWPORT, 0).top).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/popoverBox.test.ts -t 'opens below the trigger when the box fits there'`
Expected: FAIL — `Failed to resolve import "./popoverBox"`: the module does not exist yet.

- [ ] **Step 3: Write `popoverBox.ts`**

Create `src/components/ui/popoverBox.ts`:

```ts
/**
 * Where a popover sits: fixed to the viewport and clipped there, like `.paintChooser`. Kept out of
 * the component so it can be tested without a browser — with six fixed rows the box is a known
 * size, so nothing here is measured.
 */

/** The trigger in viewport coordinates, as a `DOMRect` gives it. */
export interface PopoverAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

/**
 * Below the trigger while the box fits, above it when it does not, and never outside the viewport:
 * the box is `position: fixed`, so nothing scrolls a bottom row back into reach.
 */
export function popoverPosition(
  anchor: PopoverAnchor,
  size: PopoverSize,
  viewport: PopoverViewport,
  gap: number,
): { top: number; left: number } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;

  return {
    top: bounded(below + size.height <= viewport.height ? below : above, viewport.height - size.height),
    left: bounded(anchor.left, viewport.width - size.width),
  };
}

/** Inside `[0, limit]`, and pinned to 0 when the box is bigger than the viewport (`limit` < 0). */
function bounded(value: number, limit: number): number {
  return Math.max(0, Math.min(value, Math.max(0, limit)));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/popoverBox.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/popoverBox.ts src/components/ui/popoverBox.test.ts
git commit -m "feat(pickers): place a popover below its anchor and inside the window"
```

### Task 15: The field binding a popover trigger needs, and its layer

**Files:**
- Modify: `src/components/ui/Field.tsx:100-105`
- Modify: `src/components/ui/index.ts:19-34`
- Modify: `app/globals.css:71-75`
- Test: none. `useFieldBinding` is a hook and the token is CSS: neither can be exercised in a suite that runs in Node with no DOM and never renders. Verification is `npx tsc --noEmit` and `npx eslint .`, in Steps 4 and 5.

**Interfaces:**
- Consumes: nothing.
- Produces: `export function useFieldBinding(explicit: { id?: string; describedBy?: string; invalid?: boolean }): { id?: string; describedBy?: string; invalid: boolean }` from `./Field`, re-exported by `src/components/ui/index.ts`; the CSS custom property `--ww-z-popover: 45`.

- [ ] **Step 1: Export the binding from `Field.tsx`**

`src/components/ui/Field.tsx:100-101` reads today:

```tsx
/** What a control inherits from its `Field`, or nothing when it stands alone. */
function useFieldBinding(explicit: {
```

Replace those two lines with:

```tsx
/**
 * What a control inherits from its `Field`, or nothing when it stands alone. Public because a
 * control that does not live in this module — a popover's trigger button — has to inherit the same
 * id, `aria-describedby` and invalid ring as the ones that do.
 */
export function useFieldBinding(explicit: {
```

- [ ] **Step 2: Re-export it from `ui/index.ts`**

In `src/components/ui/index.ts:19-34`, the `./Field` block lists its values before its types. Add `useFieldBinding` as the last value, so the block becomes:

```ts
export {
  Checkbox,
  Field,
  Input,
  NumberStepper,
  Select,
  Textarea,
  useFieldBinding,
  type CheckboxProps,
  type FieldProps,
  type InputProps,
  type NumberStepperProps,
  type SelectOption,
  type SelectOptionGroup,
  type SelectProps,
  type TextareaProps,
} from './Field';
```

- [ ] **Step 3: Add the popover layer to `app/globals.css`**

`app/globals.css:71-77` reads today:

```css
  --ww-panel-width: 360px;
  --ww-z-panel: 40;
  --ww-z-dialog: 50;
  --ww-z-toast: 60;

  --ww-duration-fast: 120ms;
  --ww-duration: 180ms;
```

Replace the four token lines with:

```css
  --ww-panel-width: 360px;
  --ww-z-panel: 40;
  /* Over the panel it opens in, under a confirmation. NOT the panel's own 40: a tie is settled by
     mount order, and a portal mounted between the two would silently invert them. */
  --ww-z-popover: 45;
  --ww-z-dialog: 50;
  --ww-z-toast: 60;
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — no output. An exported hook with no caller yet is not an error.

- [ ] **Step 5: Lint**

Run: `npx eslint .`
Expected: PASS — no output.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Field.tsx src/components/ui/index.ts app/globals.css
git commit -m "refactor(pickers): export the field binding and add a popover layer"
```


### Task 16: The typed time field

**Files:**
- Create: `src/components/ui/TimeField.tsx`
- Modify: `src/components/ui/Field.module.css:209` (a new section between the stepper's last rule and `/* --- checkbox --- */`)
- Modify: `src/components/ui/index.ts:35`
- Modify: `public/locales/es/common.json:21,454`
- Modify: `public/locales/en/common.json:21,454`
- Test: `src/lib/locales.test.ts:98`

**Interfaces:**
- Consumes: `normalizeTypedTime(value: string): string | undefined`, `stepTypedTime(value: string, direction: 1 | -1, options?: { wholeHour?: boolean; bounds?: TimeBounds }): string`, `commitTypedTime(valueAtFocus: string, value: string, bounds?: TimeBounds): TimeCommit`, `interface TimeBounds { minMinutes?: number; maxMinutes?: number }`, `type TimeCommit = { ok: true; value: string } | { ok: false; reason: 'invalid-format' } | { ok: false; reason: 'out-of-bounds'; minMinutes: number; maxMinutes: number }` — all from `src/components/ui/timeTyping.ts`; `Input` from `src/components/ui/Field.tsx`; `useFormat(): Formatter` with `time(minutes: number): string` from `src/lib/useFormat.ts`
- Produces: `export function TimeField(props: TimeFieldProps): React.JSX.Element` and `export interface TimeFieldProps { value: string; onChange: (value: string) => void; minMinutes?: number; maxMinutes?: number; disabled?: boolean; invalid?: boolean; id?: string; className?: string }`, both re-exported from `src/components/ui/index.ts`; locale keys `timeField.earlier`, `timeField.later`, `timeField.hint`, `errors.invalidTimeFormat` (no placeholders), `errors.timeOutOfBounds` (`{{startTime}}`, `{{endTime}}`)

- [ ] **Step 1: Write the failing test**

In `src/lib/locales.test.ts`, add this `it` as the last one inside `describe('locale files')` — after the existing `it('words the wireframe strings exactly', …)` closes on line 98, before the `});` on line 99:

```ts
  it('words the typed time field in both languages', () => {
    expect(resolve(es as Json, 'timeField.earlier')).toBe('Adelantar la hora');
    expect(resolve(es as Json, 'timeField.later')).toBe('Retrasar la hora');
    expect(resolve(es as Json, 'timeField.hint')).toBe(
      'Escríbela, o muévela con ↑ y ↓ de cuarto en cuarto; con Mayús, de hora en hora.',
    );
    expect(resolve(es as Json, 'errors.invalidTimeFormat')).toBe(
      'La hora tiene que tener el formato HH:mm.',
    );
    // The bounds are NAMED, because the field refuses instead of clipping and «entre qué horas»
    // is the only thing that tells the owner what to type instead.
    expect(resolve(es as Json, 'errors.timeOutOfBounds')).toBe(
      'Esa hora tiene que estar entre las {{startTime}} y las {{endTime}}.',
    );
    for (const key of [
      'timeField.earlier',
      'timeField.later',
      'timeField.hint',
      'errors.invalidTimeFormat',
      'errors.timeOutOfBounds',
    ]) {
      expect(enKeys, `missing in en: ${key}`).toContain(key);
    }
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/locales.test.ts -t 'words the typed time field in both languages'`
Expected: FAIL — `Error: Not a string key: timeField.earlier`, thrown by the file's own `resolve` helper because neither bundle has a `timeField` block yet.

- [ ] **Step 3: Add the Spanish `timeField` block**

In `public/locales/es/common.json`, between the close of `common` (line 21) and `"units"` (line 22) — the shared controls' own strings sit with `common`, which is where `common.increase` / `common.decrease` (the `NumberStepper`'s two buttons) already live:

```json
    "optional": "opcional"
  },
  "timeField": {
    "earlier": "Adelantar la hora",
    "later": "Retrasar la hora",
    "hint": "Escríbela, o muévela con ↑ y ↓ de cuarto en cuarto; con Mayús, de hora en hora."
  },
  "units": {
```

- [ ] **Step 4: Add the two Spanish error strings**

In `public/locales/es/common.json`, directly after `"invalidTime"` (line 454), keeping the time family together — `invalidDate`, `invalidTime`, then these two, then `invalidRange`:

```json
    "invalidTime": "Esa hora no cabe en el día.",
    "invalidTimeFormat": "La hora tiene que tener el formato HH:mm.",
    "timeOutOfBounds": "Esa hora tiene que estar entre las {{startTime}} y las {{endTime}}.",
    "invalidRange": "Ese rango de fechas no es válido: «Hasta» tiene que ser igual o posterior a «Desde», y como mucho de {{maxDays}} días.",
```

- [ ] **Step 5: Add the English keys in the same two places**

In `public/locales/en/common.json`, between the close of `common` (line 21) and `"units"` (line 22):

```json
    "optional": "optional"
  },
  "timeField": {
    "earlier": "Move earlier",
    "later": "Move later",
    "hint": "Type it, or move it with ↑ and ↓ a quarter of an hour at a time; with Shift, an hour."
  },
  "units": {
```

and directly after `"invalidTime"` (line 454):

```json
    "invalidTime": "That time does not fit inside the day.",
    "invalidTimeFormat": "The time must be in HH:mm format.",
    "timeOutOfBounds": "That time has to be between {{startTime}} and {{endTime}}.",
    "invalidRange": "That date range is not valid: \"To\" must be the same day as \"From\" or later, and at most {{maxDays}} days long.",
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run src/lib/locales.test.ts`
Expected: PASS — 8 tests, the key-parity and placeholder-parity ones included.

- [ ] **Step 7: Write the component**

Create `src/components/ui/TimeField.tsx`:

```tsx
'use client';

/**
 * A time of day, typed. Not a native `<input type="time">`: that follows the BROWSER's locale, and
 * the Settings screen showed "08:00 AM" beside a calendar reading "08:00–14:00".
 *
 * It draws its OWN string and never `format.time`: passing every keystroke through parse→format
 * rewrites `8:00` to `08:00` under the cursor, and `formatTime` answers `--:--` for anything it
 * cannot read, which is the opposite of leaving an unreadable value on screen. `format.time` is
 * used only where the start is minutes: the bounds named in a refusal.
 *
 * It renders the `Input` from `Field`, so inside a `Field` it picks up the generated id, the
 * `aria-describedby` and the invalid ring like every other control here.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import { useFormat } from '../../lib/useFormat';
import { Input } from './Field';
import { commitTypedTime, normalizeTypedTime, stepTypedTime, type TimeBounds } from './timeTyping';
import styles from './Field.module.css';

export interface TimeFieldProps {
  /** `HH:mm`, drawn verbatim: a stored `08:10` is never pulled onto the quarter-hour grid. */
  value: string;
  /** Fired on a SETTLED value only: Enter, leaving the field, a button or an arrow. */
  onChange: (value: string) => void;
  /** Bounds, in minutes from midnight. Outside them the field refuses; it never clips. */
  minMinutes?: number;
  maxMinutes?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function TimeField({
  value,
  onChange,
  minMinutes,
  maxMinutes,
  disabled = false,
  invalid,
  id,
  className,
}: TimeFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const [text, setText] = useState(value);
  const [rejected, setRejected] = useState<string | undefined>(undefined);
  /** What the field held when focus arrived: an untouched value commits verbatim. */
  const entered = useRef(value);

  // The form's value wins whenever it changes from outside — a panel reopening on another
  // absence, a settings draft reset — and the half-typed string is dropped for it.
  useEffect(() => {
    setText(value);
    setRejected(undefined);
  }, [value]);

  const bounds: TimeBounds = { minMinutes, maxMinutes };

  const settle = (next: string): void => {
    // Set even when it equals `value`: typing `8` over `08:00` leaves nothing for the effect
    // above to put back, and the field would keep showing `8`.
    setText(next);
    setRejected(undefined);
    entered.current = next;
    if (next !== value) onChange(next);
  };

  const commit = (): void => {
    const result = commitTypedTime(entered.current, text, bounds);
    if (result.ok) {
      settle(result.value);
      return;
    }
    // The `Field`'s error line belongs to the caller, so the refusal rides in the same `title` the
    // hint does — the way `Field` swaps its hint for an error.
    setRejected(
      result.reason === 'invalid-format'
        ? t('errors.invalidTimeFormat')
        : t('errors.timeOutOfBounds', {
            startTime: format.time(result.minMinutes),
            endTime: format.time(result.maxMinutes),
          }),
    );
  };

  const step = (direction: 1 | -1, wholeHour: boolean): void => {
    // An unreadable draft has no step of its own, so the arrows move the value the form still holds.
    const from = normalizeTypedTime(text) ?? value;
    settle(stepTypedTime(from, direction, { wholeHour, bounds }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey);
    }
    // Escape is the panel's: there is no buffer of "what was here before" to revert.
  };

  return (
    <span
      className={[styles.stepper, disabled ? styles.stepperDisabled : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className={styles.stepperButton}
        disabled={disabled}
        aria-label={t('timeField.earlier')}
        title={t('timeField.earlier')}
        onClick={(event) => step(-1, event.shiftKey)}
      >
        <IconMinus size={14} stroke={1.75} />
      </button>

      <Input
        className={styles.timeInput}
        value={text}
        id={id}
        disabled={disabled}
        invalid={rejected === undefined ? invalid : true}
        inputMode="numeric"
        maxLength={5}
        title={rejected ?? t('timeField.hint')}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          entered.current = text;
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />

      <button
        type="button"
        className={styles.stepperButton}
        disabled={disabled}
        aria-label={t('timeField.later')}
        title={t('timeField.later')}
        onClick={(event) => step(1, event.shiftKey)}
      >
        <IconPlus size={14} stroke={1.75} />
      </button>
    </span>
  );
}
```

- [ ] **Step 8: Give it the stepper's box**

In `src/components/ui/Field.module.css`, after `.stepperButton:disabled` (lines 206-208) and before `/* --- checkbox --- */` (line 210):

```css
/* --- typed time --- */

/* `TimeField` renders the stepper's own box, so the two stepping controls cannot drift apart.
   The ring goes on the BOX because the state it draws reaches the input from `FieldContext`,
   which the box cannot read. */
.stepper:has(.timeInput[aria-invalid]) {
  border-color: var(--ww-danger);
}

/* Doubled to raise specificity over `.input` above, whose bordered full-width box would
   otherwise sit inside the box already drawing one. */
.timeInput.timeInput {
  width: 4.5em;
  height: 100%;
  border: none;
  border-radius: 0;
  background: none;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 9: Export it**

In `src/components/ui/index.ts`, add the new line above the existing `TimeSelect` export on line 35 (`TimeSelect` still has seven call sites and goes in Task 17):

```ts
export { TimeField, type TimeFieldProps } from './TimeField';
export { TimeSelect, type TimeSelectProps } from './TimeSelect';
```

- [ ] **Step 10: Run the gates**

Run: `npx tsc --noEmit && npx vitest run && npx eslint . && npm run build`
Expected: PASS — no type errors from `TimeField.tsx`, and the locale suite green.

- [ ] **Step 11: Commit**

```bash
git add src/components/ui/TimeField.tsx src/components/ui/Field.module.css src/components/ui/index.ts public/locales/es/common.json public/locales/en/common.json src/lib/locales.test.ts
git commit -m "feat(pickers): add the typed time field and its strings"
```

### Task 17: Every time is typed, and TimeSelect dies

**Files:**
- Modify: `src/components/settings/SettingsScreen.tsx:19,532-546`
- Modify: `src/components/settings/SettingsScreen.module.css:64-70`
- Modify: `src/components/jobs/AbsencePanel.tsx:34,633,665-671`
- Modify: `src/components/jobs/SplitBlockPanel.tsx:19,245-248`
- Modify: `src/components/ui/index.ts:35-41`
- Modify: `src/components/ui/timeOptions.ts:1-8,16-44,63-65`
- Modify: `src/lib/validation.ts:58`
- Modify: `src/components/calendar/geometry.ts:17`
- Delete: `src/components/ui/TimeSelect.tsx`
- Test: `src/components/ui/timeOptions.test.ts:1,13,39-70`

**Interfaces:**
- Consumes: `TimeField`, `TimeFieldProps` from Task 16 (`value`, `onChange`, `minMinutes`, `maxMinutes`, `disabled`, `invalid`, `id`, `className`); `TIME_STEP_MINUTES`, `clockMinutes` from `src/components/ui/timeOptions.ts`
- Produces: `src/components/ui/timeOptions.ts` exporting exactly `TIME_STEP_MINUTES` and `clockMinutes`; `src/components/ui/index.ts` with no `TimeSelect`, `TimeSelectProps`, `timeOptionMinutes` or `TimeOptionsRange`

The seven sites, each read before it is touched: `SettingsScreen.tsx:246`, `:253`, `:269` and `:277` all reach the control through one `TimeRow` (`:537`, the `<TimeSelect>` at `:540`); `AbsencePanel.tsx:633` is an absence's start time; `AbsencePanel.tsx:665` is the moment the day closes, the only site that passes bounds (`closeBounds`, from `momentBounds` at `:929`); `SplitBlockPanel.tsx:247` is the scissors' start time.

- [ ] **Step 1: Write the failing test**

In `src/components/ui/timeOptions.test.ts`, add the namespace import under the existing named one on line 13, and a third `describe` at the end of the file. The `describe('the time step', …)` block that pins `TIME_STEP_MINUTES` to `SNAP_MINUTES` and `MIN_ROW_MINUTES` is left exactly as it is.

```ts
import { describe, expect, it } from 'vitest';
import { MIN_ROW_MINUTES } from '../../lib/validation';
import { SNAP_MINUTES } from '../calendar/geometry';
import { TIME_STEP_MINUTES, clockMinutes } from './timeOptions';
import * as timeOptions from './timeOptions';
```

```ts
describe('the module surface', () => {
  it('no longer offers the list of quarter hours the dropdown was built from', () => {
    // 96 options from 00:00 to 23:45. The step and the parse are what the app needs from here;
    // the list would be a second way to say what a legal time is.
    expect(Object.keys(timeOptions)).not.toContain('timeOptionMinutes');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/timeOptions.test.ts -t 'no longer offers the list of quarter hours the dropdown was built from'`
Expected: FAIL — `expected [ 'TIME_STEP_MINUTES', 'clockMinutes', 'timeOptionMinutes' ] not to contain 'timeOptionMinutes'`.

- [ ] **Step 3: Type the four Settings rows**

In `src/components/settings/SettingsScreen.tsx`, swap the import name on line 19 (`TimeSelect,` → `TimeField,`, keeping the list alphabetical: it sits between `Select,` and `useToast,`), then replace lines 532-546:

```tsx
/**
 * One period boundary, typed rather than `<input type="time">`, which renders in the BROWSER's
 * locale: this form showed "08:00 AM" beside a calendar reading "08:00–14:00".
 */
function TimeRow({ label, value, error, disabled = false, onChange }: TimeRowProps): React.JSX.Element {
  return (
    <Field label={label} inline error={error}>
      <TimeField value={value} disabled={disabled} onChange={onChange} />
    </Field>
  );
}
```

- [ ] **Step 4: Drop the dead width class**

`TimeField` is `inline-flex` around a `4.5em` input, so it sizes itself the way `NumberStepper` already does in these rows. Delete lines 67-70 of `src/components/settings/SettingsScreen.module.css` — the rule only — and leave the comment above it, which `.selectControl` still needs:

```css
/* Controls in an inline `Field` size themselves, so they need an explicit width. The
   doubled class raises specificity over `.input` / `.select` in Field.module.css, whose
   `width: 100%` would otherwise win or lose depending on stylesheet order. */
.selectControl.selectControl {
  width: 11rem;
}
```

- [ ] **Step 5: Type the absence's start time and the closing moment**

In `src/components/jobs/AbsencePanel.tsx`, swap the import name on line 34 (`TimeSelect,` → `TimeField,`), then line 633:

```tsx
                  <TimeField value={startTime} disabled={busy} onChange={setStartTime} />
```

and lines 665-671:

```tsx
              <TimeField
                value={startTime}
                minMinutes={closeBounds?.minMinutes}
                maxMinutes={closeBounds?.maxMinutes}
                disabled={busy}
                onChange={setStartTime}
              />
```

- [ ] **Step 6: Type the scissors' start time**

In `src/components/jobs/SplitBlockPanel.tsx`, swap the import name on line 19 (`TimeSelect,` → `TimeField,`), then replace lines 245-248:

```tsx
        {/* Typed, and moved by quarter hours like the grid's snap. */}
        <Field label={t('gapForm.startTime')} error={errorFor('startTime')}>
          <TimeField value={startTime} disabled={saving} onChange={setStartTime} />
        </Field>
```

- [ ] **Step 7: Delete `TimeSelect` and trim the barrel**

```bash
git rm src/components/ui/TimeSelect.tsx
```

Then in `src/components/ui/index.ts` replace lines 35-41 (the `TimeSelect` export and the four-name `timeOptions` export) with:

```ts
export { TIME_STEP_MINUTES, clockMinutes } from './timeOptions';
```

- [ ] **Step 8: Delete the option list**

Rewrite `src/components/ui/timeOptions.ts` as the two survivors — `timeOptionMinutes`, `TimeOptionsRange`, the private `clamp` and the now-unused `MINUTES_PER_DAY` import all go:

```ts
/**
 * The quarter-hour grid every time in the app lands on, and the one safe parse behind every
 * screen that reads a clock time. A control of the app's own rather than a native `<input
 * type="time">`, measured on the Settings screen, which with Chrome set to English drew
 * "08:00 AM" beside a grid reading "08:00-14:00". Kept out of the component so it can be
 * tested without a DOM.
 */

import { hhmmToMinutes } from '../../lib/dates';

/**
 * Quarter of an hour. Held equal to the drag layer's `SNAP_MINUTES` by
 * `timeOptions.test.ts`, so a typed time and a dragged one land on one grid.
 */
export const TIME_STEP_MINUTES = 15;

/**
 * `"08:00"` to 480, or `undefined` when the value is empty or not a time at all —
 * `hhmmToMinutes` throws, which is wrong for a control still being filled in.
 */
export function clockMinutes(value: string): number | undefined {
  try {
    return hhmmToMinutes(value);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 9: Trim its test to what survives**

In `src/components/ui/timeOptions.test.ts`, drop `timeOptionMinutes` from the named import on line 13 and delete the whole `describe('timeOptionMinutes', …)` block (lines 39-70) — the two properties it held, an off-grid stored value surviving and a range honoured at both ends, are `timeTyping.ts`'s now. Retitle the file's first doc line only:

```ts
/**
 * The time control's granularity, and its one safe parse.
 *
 * The first test is the important one: it pins the form's granularity to the drag
 * layer's snap. If those two ever drift, a start time chosen in the gap form lands
 * between two positions the grid can produce, and dragging that block would silently
 * move it.
 */
```

- [ ] **Step 10: Retarget the two comments that name the dead component**

`src/lib/validation.ts:58`:

```ts
 * `SNAP_MINUTES` and `TIME_STEP_MINUTES` by a test; a shorter row cannot show its own hours
```

`src/components/calendar/geometry.ts:17`:

```ts
 * Held equal to `MIN_ROW_MINUTES` and `TIME_STEP_MINUTES`. A quarter and not a half, though the shop
```

- [ ] **Step 11: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/timeOptions.test.ts && npx tsc --noEmit && npx vitest run && npx eslint . && npm run build`
Expected: PASS — `timeOptions.test.ts` down to 3 tests, `tsc` clean (which is what proves all seven call sites were swapped: a missed one cannot resolve `TimeSelect`), and the full suite at its baseline count minus the five deleted `timeOptionMinutes` cases.

- [ ] **Step 12: Commit**

```bash
git add src/components/settings/SettingsScreen.tsx src/components/settings/SettingsScreen.module.css src/components/jobs/AbsencePanel.tsx src/components/jobs/SplitBlockPanel.tsx src/components/ui/index.ts src/components/ui/TimeSelect.tsx src/components/ui/timeOptions.ts src/components/ui/timeOptions.test.ts src/lib/validation.ts src/components/calendar/geometry.ts
git commit -m "feat(pickers): swap the time dropdowns for the typed field"
```


### Task 18: The day picker itself — trigger, popover, marks

**Files:**
- Create: `src/components/ui/dayPickerTitle.ts`
- Create: `src/components/ui/DayPicker.tsx`
- Create: `src/components/ui/DayPicker.module.css`
- Modify: `src/components/ui/Field.tsx:25-31,51-98,100-112`
- Modify: `src/components/ui/index.ts:19-42`
- Modify: `app/globals.css:70-75`
- Modify: `public/locales/es/common.json:62-77`
- Modify: `public/locales/en/common.json:62-77`
- Modify: `src/lib/locales.test.ts:81-99`
- Test: `src/components/ui/dayPickerTitle.test.ts`

**Interfaces:**
- Consumes: `planningWindow(today: string, horizonWeeks?: number, pastWeeks?: number): DayWindow` and `DayWindow` from `./dateOptions`; `MONTH_GRID_ROWS`, `monthGrid(month, { today, window, current? }): MonthCell[]`, `MonthCell` from `./monthGrid`; `openingMonth(current, { today, window }): string`, `monthReach(month, window): { canPrevious: boolean; canNext: boolean }`, `stepMonth(month, direction: 1 | -1, window): string` from `./monthReach`; `isDayPickerKey(key: string): key is DayPickerKey`, `moveFocusedDay(date, key, window): string` from `./dayPickerKeys`; `markOf(date, marks): DayMark | undefined`, `markRange(window, current?): { from: string; to: string }`, `DayMark`, `DayMarks` from `./pickerDays`; `popoverPosition(anchor, size, viewport, gap): { top: number; left: number }` from `./popoverBox`; `startOfMonth(date: string): string` and `isValidDate` from `../../lib/dates`; `getDayMarks(from, to, options?): Promise<DaysView>`, `isAbortError`, `type DaysView` from `../../lib/api-client`; `useFormat().monthYear/weekdayNarrow/dayOption/dayOfMonth/hourNumber`.
- Produces: `export type DayCellNote = 'today' | 'weekend' | 'closed' | 'note' | 'freeHours' | 'full'`; `export function dayCellNotes(cell: MonthCell, mark: DayMark | undefined): DayCellNote[]`; `export function useFieldBinding(explicit: { id?: string; labelId?: string; describedBy?: string; invalid?: boolean }): { id?: string; labelId?: string; describedBy?: string; invalid: boolean }`; `export interface DayPickerProps { value: string; onChange: (value: string) => void; today: string; horizonWeeks?: number; labelId?: string; revision?: number; disabled?: boolean; invalid?: boolean; id?: string; className?: string }`; `export function DayPicker(props: DayPickerProps): React.JSX.Element`.

**The revision, named:** the marks hang off `WeekController.revision` — the `nonce` inside `useWeek`, bumped by every load and every `mutate`. It reaches the picker as the `revision?: number` prop above. Task 19 exposes it on `WeekController`, puts it on `JobPanelContext`, `NewJobContext` and `AbsenceFormContext` in `CalendarScreen.tsx`, and `app/page.tsx` passes it to `NewJobPanel`, `AbsencePanel` and `SplitBlockPanel`, each of which forwards `revision={revision}` to every `DayPicker` it renders. One request per open, because the range is `markRange(window, value)` — the whole navigable window — and never the month on screen, so the `‹ ›` arrows fetch nothing.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * What a cell of the day calendar says when the mouse rests on it. The grey and the dot are the
 * marks; this is the sentence behind them, and it must never call a day full when that day has no
 * plannable hours to be full OF.
 */

import { describe, expect, it } from 'vitest';
import { FAR_MON, LAST_WED, SAT, WED } from '../../testing/fixtures';
import { dayCellNotes } from './dayPickerTitle';
import type { MonthCell } from './monthGrid';
import type { DayMark } from './pickerDays';

function cellOf(date: string, overrides: Partial<MonthCell> = {}): MonthCell {
  return {
    date,
    inMonth: true,
    selectable: true,
    isToday: false,
    isWeekend: false,
    isPast: false,
    ...overrides,
  };
}

const WORKING: DayMark = { isClosed: false, hasRoom: true, freeMinutes: 240 };
const FULL: DayMark = { isClosed: false, hasRoom: false, freeMinutes: 0 };

describe("a day picker cell's notes", () => {
  it('says nothing about a day the server has not answered for yet', () => {
    expect(dayCellNotes(cellOf(WED), undefined)).toEqual([]);
  });

  it('names today first, then the hours it has left', () => {
    expect(dayCellNotes(cellOf(WED, { isToday: true }), WORKING)).toEqual(['today', 'freeHours']);
  });

  it('names the weekend and never calls it full', () => {
    expect(dayCellNotes(cellOf(SAT, { isWeekend: true }), FULL)).toEqual(['weekend']);
  });

  it('never calls a past day full either', () => {
    expect(dayCellNotes(cellOf(LAST_WED, { isPast: true }), FULL)).toEqual([]);
  });

  it('calls a working day with no minutes left full', () => {
    expect(dayCellNotes(cellOf(WED), FULL)).toEqual(['full']);
  });

  it('prefers the reason a day was closed for over the word closed', () => {
    expect(
      dayCellNotes(cellOf(WED), { isClosed: true, note: 'Fair', hasRoom: false, freeMinutes: 0 }),
    ).toEqual(['note']);
  });

  it('falls back to the word closed when the day carries no reason', () => {
    expect(dayCellNotes(cellOf(WED), { isClosed: true, hasRoom: false, freeMinutes: 0 })).toEqual([
      'closed',
    ]);
  });

  it('reports the free hours of a day beyond the horizon, where the dot is off', () => {
    // Past the horizon `hasRoom` is false while the minutes are genuinely free, and "Día completo"
    // is the one thing that would not be true there.
    expect(
      dayCellNotes(cellOf(FAR_MON), { isClosed: false, hasRoom: false, freeMinutes: 300 }),
    ).toEqual(['freeHours']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/dayPickerTitle.test.ts`
Expected: FAIL — `Failed to resolve import "./dayPickerTitle"`: the module does not exist yet.

- [ ] **Step 3: Write `dayPickerTitle.ts`**

```ts
/**
 * What a cell of the day calendar says on hover. Kept out of the component so it can be decided
 * without a DOM: the component only spells the kinds this returns.
 */

import type { MonthCell } from './monthGrid';
import type { DayMark } from './pickerDays';

/** One line of a cell's tooltip, as a KIND: the switch that words them lives in one place. */
export type DayCellNote = 'today' | 'weekend' | 'closed' | 'note' | 'freeHours' | 'full';

export function dayCellNotes(cell: MonthCell, mark: DayMark | undefined): DayCellNote[] {
  const notes: DayCellNote[] = [];

  if (cell.isToday) notes.push('today');
  if (cell.isWeekend) notes.push('weekend');

  if (mark === undefined) return notes;

  // The owner's own words are the state of a closed day: the grey cell already says "cerrado",
  // and the reason is the only thing it cannot say.
  if (mark.isClosed) notes.push(mark.note === undefined ? 'closed' : 'note');

  if (mark.freeMinutes > 0) notes.push('freeHours');
  // A weekend, a past day and a closed one have no plannable hours to be full of.
  else if (!cell.isPast && !cell.isWeekend && !mark.isClosed) notes.push('full');

  return notes;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/dayPickerTitle.test.ts`
Expected: PASS

- [ ] **Step 5: Assert the new locale strings, and watch that fail**

Add this `it` to `src/lib/locales.test.ts`, immediately after the `words the wireframe strings exactly` block (which ends at line 98) and inside the same `describe`:

```ts
  it('words the day picker in both languages', () => {
    expect(resolve(es as Json, 'day.weekend')).toBe('fin de semana');
    expect(resolve(en as Json, 'day.weekend')).toBe('weekend');
    expect(resolve(es as Json, 'dayPicker.open')).toBe('Elegir el día');
    expect(resolve(es as Json, 'dayPicker.previousMonth')).toBe('Mes anterior');
    expect(resolve(es as Json, 'dayPicker.nextMonth')).toBe('Mes siguiente');
    expect(resolve(es as Json, 'dayPicker.today')).toBe('Hoy');
    expect(resolve(es as Json, 'dayPicker.todayHint')).toBe('Elige hoy');
  });
```

Run: `npx vitest run src/lib/locales.test.ts -t 'words the day picker'`
Expected: FAIL — `Error: Not a string key: day.weekend`, thrown by `resolve`.

- [ ] **Step 6: Add the keys to both locale files**

In `public/locales/es/common.json`, add `"weekend"` after `"closed"` (line 67) and the `dayPicker` block after the `day` block closes (line 77):

```json
    "closed": "cerrado",
    "weekend": "fin de semana",
```

```json
    "note": "Nota: {{note}}"
  },
  "dayPicker": {
    "open": "Elegir el día",
    "previousMonth": "Mes anterior",
    "nextMonth": "Mes siguiente",
    "today": "Hoy",
    "todayHint": "Elige hoy"
  },
  "grid": {
```

In `public/locales/en/common.json`, the same two places:

```json
    "closed": "closed",
    "weekend": "weekend",
```

```json
    "note": "Note: {{note}}"
  },
  "dayPicker": {
    "open": "Choose the day",
    "previousMonth": "Previous month",
    "nextMonth": "Next month",
    "today": "Today",
    "todayHint": "Choose today"
  },
  "grid": {
```

- [ ] **Step 7: Run the locale suite and watch it pass**

Run: `npx vitest run src/lib/locales.test.ts`
Expected: PASS

- [ ] **Step 8: Confirm the popover's stacking level is already there**

**Task 15 owns `--ww-z-popover`; do not add it a second time.** Both slices of the plan were drafted
against it and this step is the reconciliation: verify it, and only add it if Task 15 was skipped.

Run: `grep -n "ww-z-popover" app/globals.css`
Expected: one hit, `--ww-z-popover: 45;`, between `--ww-z-panel: 40;` and `--ww-z-dialog: 50;`.

If the grep is empty, Task 15 did not run: add it there now, with the reason as its comment —

```css
  --ww-z-panel: 40;
  /* Over the panel it belongs to, under a confirmation. Sharing the panel's 40 made the order a
     tie broken by mount order, which inverts the moment anything portals in between. */
  --ww-z-popover: 45;
  --ww-z-dialog: 50;
```

If the grep prints two hits, one of them is this step run twice: delete the duplicate line.

- [ ] **Step 9: Let a control take the `Field`'s label id**

In `src/components/ui/Field.tsx`, four edits.

The context (lines 25-29):

```tsx
interface FieldContextValue {
  id: string;
  /** The `<label>`'s own id, for a control whose accessible name has to point AT it. */
  labelId: string;
  describedBy?: string;
  invalid: boolean;
}
```

Inside `Field`, after `const controlId = ...` (line 64):

```tsx
  const controlId = id ?? `${generated}-control`;
  const labelId = `${generated}-label`;
```

The label element (line 71) and the provider (line 82):

```tsx
      <label className={styles.label} id={labelId} htmlFor={controlId}>
```

```tsx
        <FieldContext.Provider
          value={{ id: controlId, labelId, describedBy, invalid: error !== undefined }}
        >
```

And `useFieldBinding` (lines 100-112):

```tsx
/**
 * What a control inherits from its `Field`, or nothing when it stands alone. Exported for a
 * control that `<label for>` cannot name: a `<button>` takes its accessible name from its own
 * contents, so it has to point `aria-labelledby` at `labelId` itself.
 */
export function useFieldBinding(explicit: {
  id?: string;
  labelId?: string;
  describedBy?: string;
  invalid?: boolean;
}): { id?: string; labelId?: string; describedBy?: string; invalid: boolean } {
  const context = useContext(FieldContext);
  return {
    id: explicit.id ?? context?.id,
    labelId: explicit.labelId ?? context?.labelId,
    describedBy: explicit.describedBy ?? context?.describedBy,
    invalid: explicit.invalid ?? context?.invalid ?? false,
  };
}
```

- [ ] **Step 10: Write the stylesheet**

`src/components/ui/DayPicker.module.css`:

```css
.trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ww-space-2);
  width: 100%;
  min-width: 0;
  height: var(--ww-control-height-lg);
  padding: 0 var(--ww-space-3);
  border: var(--ww-hairline) solid var(--ww-border);
  border-radius: var(--ww-radius);
  background: var(--ww-surface);
  color: var(--ww-text);
  font-size: var(--ww-text-md);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--ww-duration-fast) ease-out;
}

.trigger:hover:not(:disabled) {
  border-color: var(--ww-border-strong);
}

.trigger:disabled {
  background: var(--ww-surface-alt);
  color: var(--ww-text-muted);
  cursor: default;
}

.invalid {
  border-color: var(--ww-danger);
}

.value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  display: flex;
  flex: none;
  color: var(--ww-text-muted);
}

/* Fixed to the viewport like the paint chooser: this opens over the columns the field is moving a
   band on, and a `transform` on the grid would otherwise clip it. The box is a CONSTANT —
   226 wide, six 30px rows plus 100px of chrome — which is what lets popoverPosition clip it by
   arithmetic instead of a measurement. POPOVER_WIDTH and CELL_HEIGHT in DayPicker.tsx are these
   numbers. */
.popover {
  position: fixed;
  z-index: var(--ww-z-popover);
  width: 226px;
  display: flex;
  flex-direction: column;
  gap: var(--ww-space-2);
  padding: var(--ww-space-3);
  border: var(--ww-hairline) solid var(--ww-border);
  border-radius: var(--ww-radius-lg);
  background: var(--ww-surface);
  box-shadow: var(--ww-shadow-popover);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--ww-space-2);
  height: var(--ww-control-height);
}

.month {
  flex: 1;
  text-align: center;
  font-size: var(--ww-text-sm);
  font-weight: var(--ww-weight-medium);
}

.weekdays,
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}

.weekday {
  height: 16px;
  line-height: 16px;
  text-align: center;
  font-size: var(--ww-text-xs);
  color: var(--ww-text-muted);
}

.cell {
  position: relative;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--ww-radius-sm);
  background: none;
  color: var(--ww-text);
  font-size: var(--ww-text-sm);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.cell:hover:not(:disabled) {
  background: var(--ww-hover-fill);
}

.cell:disabled {
  color: var(--ww-text-muted);
  opacity: 0.45;
  cursor: default;
}

/* Two channels, never three: the NUMBER dims where the engine does not work by the calendar, and
   the BACKGROUND goes grey where the shop is closed by the owner's decision. A closed Saturday
   carries both, which is the truth. */
.weekend .number,
.past .number {
  color: var(--ww-text-muted);
}

.outside .number {
  opacity: 0.55;
}

.closed {
  background: var(--ww-surface-alt);
}

.today .number {
  border-radius: var(--ww-radius-pill);
  outline: var(--ww-hairline) solid var(--ww-border-strong);
  outline-offset: 2px;
}

.selected {
  background: var(--ww-accent);
}

.selected .number {
  color: var(--ww-on-accent);
}

.room {
  position: absolute;
  bottom: 3px;
  width: 3px;
  height: 3px;
  border-radius: var(--ww-radius-pill);
  background: var(--ww-text-muted);
}

.selected .room {
  background: var(--ww-on-accent);
}

/* Centred and quiet under a hairline: it is a shortcut, not a third answer. */
.todayButton {
  align-self: stretch;
  border: 0;
  border-top: var(--ww-hairline) solid var(--ww-border);
  background: none;
  color: var(--ww-text-muted);
  cursor: pointer;
  padding: var(--ww-space-2) 0 0;
  font-size: var(--ww-text-sm);
}

.todayButton:hover {
  color: var(--ww-text);
}
```

- [ ] **Step 11: Write the component**

`src/components/ui/DayPicker.tsx`:

```tsx
'use client';

/**
 * A day, chosen from the month it lives in. Which days it offers is `dateOptions.ts`, the 42 cells
 * are `monthGrid.ts`, and the two marks the client cannot deduce — closed, and room left — come
 * from `/api/days`. Not a native `<input type="date">`: in the browser's locale `03/08` is
 * genuinely ambiguous.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { isValidDate, startOfMonth } from '../../lib/dates';
import { getDayMarks, isAbortError, type DaysView } from '../../lib/api-client';
import { useFormat } from '../../lib/useFormat';
import { IconButton } from './IconButton';
import { useFieldBinding } from './Field';
import { planningWindow, type DayWindow } from './dateOptions';
import { MONTH_GRID_ROWS, monthGrid, type MonthCell } from './monthGrid';
import { monthReach, openingMonth, stepMonth } from './monthReach';
import { isDayPickerKey, moveFocusedDay } from './dayPickerKeys';
import { markOf, markRange, type DayMark, type DayMarks } from './pickerDays';
import { popoverPosition } from './popoverBox';
import { dayCellNotes, type DayCellNote } from './dayPickerTitle';
import { useMounted } from './useMounted';
import styles from './DayPicker.module.css';

const DAYS_PER_WEEK = 7;

/** The box drawn by DayPicker.module.css. Pixels, and they must match it. */
const CELL_HEIGHT = 30;
const POPOVER_WIDTH = 226;
/** Everything that is not the six rows: the padding, the month head, the weekday letters, the
    three gaps and the `Hoy` button. */
const POPOVER_CHROME = 100;
const POPOVER_HEIGHT = POPOVER_CHROME + MONTH_GRID_ROWS * CELL_HEIGHT;
/** Clear of the field, so the popover never covers the value it is about to change. */
const POPOVER_GAP = 6;

export interface DayPickerProps {
  /** Local `YYYY-MM-DD`. A stored day outside the window is kept, and its own cell stays pressable. */
  value: string;
  onChange: (value: string) => void;
  /** The shop's today: rings one cell and anchors the window. */
  today: string;
  /** The owner's `planningHorizonWeeks`, which is how far forward the calendar reaches. */
  horizonWeeks?: number;
  /** The `Field`'s own label id. Inherited from the `Field`; pass it only outside one. */
  labelId?: string;
  /** `WeekController.revision`: the marks are refetched whenever the week is. */
  revision?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function DayPicker({
  value,
  onChange,
  today,
  horizonWeeks,
  labelId,
  revision,
  disabled = false,
  invalid,
  id,
  className,
}: DayPickerProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const mounted = useMounted();
  const bound = useFieldBinding({ id, labelId, invalid });

  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const [month, setMonth] = useState(today);
  const [focused, setFocused] = useState(today);
  const [marks, setMarks] = useState<DayMarks | undefined>(undefined);

  // NEVER named `window`: the listeners below are on the global of that name.
  const dayWindow: DayWindow = planningWindow(isValidDate(today) ? today : value, horizonWeeks);
  const { minDate, maxDate } = dayWindow;
  const { from: markFrom, to: markTo } = markRange(
    dayWindow,
    isValidDate(value) ? value : undefined,
  );

  // A save in flight takes the field with it: `disabled` must never leave a calendar open over a
  // form that can no longer be edited.
  const shown = open && !disabled;

  // Read WITHOUT waiting for a render: the capture handler runs before React sees the key.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const dismiss = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const choose = (date: string): void => {
    // Reported on the CLICK, never on the close: the panels set the date optimistically because
    // the band drawn on the grid has to follow the field.
    onChange(date);
    dismiss(true);
  };

  const reveal = (): void => {
    const anchor = trigger.current?.getBoundingClientRect();
    const start = isValidDate(value) ? value : today;
    if (anchor !== undefined) {
      setAt(
        popoverPosition(
          { top: anchor.top, left: anchor.left, bottom: anchor.bottom, right: anchor.right },
          { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
          { width: window.innerWidth, height: window.innerHeight },
          POPOVER_GAP,
        ),
      );
    }
    setMonth(openingMonth(start, { today, window: dayWindow }));
    setFocused(start);
    setOpen(true);
  };

  useEffect(() => {
    if (!shown) {
      // Dropped on close: a stale mark is worse than none, and the next open asks again.
      setMarks(undefined);
      return;
    }

    const controller = new AbortController();
    getDayMarks(markFrom, markTo, { signal: controller.signal })
      .then((view) => setMarks(marksOf(view)))
      .catch((error: unknown) => {
        if (!isAbortError(error)) setMarks(undefined);
      });

    return () => controller.abort();
    // `revision` is the refetch trigger: a write behind the panel can close a day or fill it.
  }, [shown, markFrom, markTo, revision]);

  useEffect(() => {
    if (!shown) return;
    box.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [shown, focused]);

  useEffect(() => {
    if (!shown) return;

    // CAPTURE, and stopped: `SidePanel` listens for Escape on `document` in the bubble phase, and
    // two listeners on the same node in the same phase cannot be ordered. Capturing on `window`
    // runs before the event ever reaches the panel.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss(true);
        return;
      }
      if (!isDayPickerKey(event.key)) return;
      // Swallowed: the trigger is a `<button>`, which `isTypingTarget` does not recognise, so an
      // arrow left alone would page the week under the open calendar.
      event.preventDefault();
      event.stopPropagation();
      const next = moveFocusedDay(focusedRef.current, event.key, { minDate, maxDate });
      setFocused(next);
      setMonth(startOfMonth(next));
    };

    // CAPTURE, and stopped: without it the press that dismisses this lands on the column
    // underneath and starts a band, or opens the panel of the job under it.
    const onPointerDown = (event: PointerEvent): void => {
      if (box.current?.contains(event.target as Node) === true) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [shown, dismiss, minDate, maxDate]);

  const cells = monthGrid(month, {
    today,
    window: dayWindow,
    ...(isValidDate(value) ? { current: value } : {}),
  });
  const reach = monthReach(month, dayWindow);

  const noteText = (note: DayCellNote, mark: DayMark | undefined): string => {
    switch (note) {
      case 'today':
        return t('day.today');
      case 'weekend':
        return t('day.weekend');
      case 'closed':
        return t('day.closed');
      case 'note':
        return mark?.note ?? t('day.closed');
      case 'freeHours':
        return t('day.freeHours', { hours: format.hourNumber(mark?.freeMinutes ?? 0) });
      case 'full':
        return t('day.full');
    }
  };

  const titleOf = (cell: MonthCell, mark: DayMark | undefined): string =>
    [format.dayOption(cell.date), ...dayCellNotes(cell, mark).map((note) => noteText(note, mark))]
      .join(t('units.listSeparator'));

  const labelledBy = [bound.labelId, bound.id]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={bound.id}
        // Explicit, so `SidePanel`'s first-field query — inputs and `[tabindex]`, never a button,
        // because the close button is one — still lands on the date.
        tabIndex={0}
        className={[styles.trigger, bound.invalid ? styles.invalid : '', className]
          .filter(Boolean)
          .join(' ')}
        disabled={disabled}
        // NEVER an `aria-label`: on a button it wins over the contents, and it would replace both
        // the field's name and the day already chosen.
        aria-labelledby={labelledBy === '' ? undefined : labelledBy}
        aria-describedby={bound.describedBy}
        aria-invalid={bound.invalid || undefined}
        aria-haspopup="dialog"
        aria-expanded={shown}
        title={t('dayPicker.open')}
        onClick={() => {
          if (!shown) reveal();
        }}
      >
        <span className={styles.value}>{isValidDate(value) ? format.dayOption(value) : value}</span>
        <span className={styles.chevron} aria-hidden="true">
          <IconChevronDown size={14} stroke={1.75} />
        </span>
      </button>

      {!shown || !mounted
        ? null
        : createPortal(
            <div
              ref={box}
              className={styles.popover}
              role="dialog"
              aria-label={t('dayPicker.open')}
              style={{ top: at.top, left: at.left }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                // Leaving by TAB fires no pointer event. A press on the popover's own padding
                // blurs with no destination at all, which is not leaving.
                if (next === null) return;
                if (box.current?.contains(next) === true) return;
                if (trigger.current?.contains(next) === true) return;
                dismiss(false);
              }}
            >
              <div className={styles.head}>
                <IconButton
                  icon={<IconChevronLeft size={14} stroke={1.75} />}
                  label={t('dayPicker.previousMonth')}
                  size="sm"
                  variant="ghost"
                  disabled={!reach.canPrevious}
                  onClick={() => setMonth(stepMonth(month, -1, dayWindow))}
                />
                <span className={styles.month}>{format.monthYear(month)}</span>
                <IconButton
                  icon={<IconChevronRight size={14} stroke={1.75} />}
                  label={t('dayPicker.nextMonth')}
                  size="sm"
                  variant="ghost"
                  disabled={!reach.canNext}
                  onClick={() => setMonth(stepMonth(month, 1, dayWindow))}
                />
              </div>

              <div className={styles.weekdays} aria-hidden="true">
                {cells.slice(0, DAYS_PER_WEEK).map((cell) => (
                  <span key={cell.date} className={styles.weekday}>
                    {format.weekdayNarrow(cell.date)}
                  </span>
                ))}
              </div>

              <div className={styles.grid}>
                {cells.map((cell) => {
                  const mark = markOf(cell.date, marks);
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      data-date={cell.date}
                      className={[
                        styles.cell,
                        cell.inMonth ? '' : styles.outside,
                        cell.date === value ? styles.selected : '',
                        cell.isToday ? styles.today : '',
                        cell.isWeekend ? styles.weekend : '',
                        cell.isPast ? styles.past : '',
                        mark?.isClosed === true ? styles.closed : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={!cell.selectable}
                      tabIndex={cell.date === focused ? 0 : -1}
                      aria-pressed={cell.date === value}
                      aria-current={cell.isToday ? 'date' : undefined}
                      title={titleOf(cell, mark)}
                      onClick={() => choose(cell.date)}
                    >
                      <span className={styles.number}>{format.dayOfMonth(cell.date)}</span>
                      {mark?.hasRoom === true ? (
                        <span className={styles.room} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                className={styles.todayButton}
                title={t('dayPicker.todayHint')}
                onClick={() => choose(today)}
              >
                {t('dayPicker.today')}
              </button>
            </div>,
            document.body,
          )}
    </>
  );
}

/** The route's rows keyed by day, which is how a cell asks for its own. */
function marksOf(view: DaysView): DayMarks {
  const marks: Record<string, DayMark> = {};
  for (const day of view.days) {
    marks[day.date] = {
      isClosed: day.isClosed,
      hasRoom: day.hasRoom,
      freeMinutes: day.freeMinutes,
      ...(day.note === undefined ? {} : { note: day.note }),
    };
  }
  return marks;
}
```

- [ ] **Step 12: Export it from the barrel**

In `src/components/ui/index.ts`, add `useFieldBinding` to the `./Field` block (line 19-34) and the component after the `DateSelect` line (line 42):

```ts
export {
  Checkbox,
  Field,
  Input,
  NumberStepper,
  Select,
  Textarea,
  useFieldBinding,
  type CheckboxProps,
  type FieldProps,
  type InputProps,
  type NumberStepperProps,
  type SelectOption,
  type SelectOptionGroup,
  type SelectProps,
  type TextareaProps,
} from './Field';
```

```ts
export { DateSelect, type DateSelectProps } from './DateSelect';
export { DayPicker, type DayPickerProps } from './DayPicker';
```

- [ ] **Step 13: Run the four gates**

Run: `npx tsc --noEmit && npm test && npx eslint . && npm run build`
Expected: PASS — 1154 tests plus the nine new ones, no type error, no lint error, a clean build.

- [ ] **Step 14: Commit**

```bash
git add src/components/ui/DayPicker.tsx src/components/ui/DayPicker.module.css src/components/ui/dayPickerTitle.ts src/components/ui/dayPickerTitle.test.ts src/components/ui/Field.tsx src/components/ui/index.ts app/globals.css public/locales/es/common.json public/locales/en/common.json src/lib/locales.test.ts
git commit -m "feat(pickers): add the day picker popover and its marks"
```

### Task 19: The three single-day call sites, and the dropdown's funeral

**Files:**
- Modify: `src/components/calendar/useWeek.ts:15-50,150-180`
- Modify: `src/components/calendar/CalendarScreen.tsx:75-147,1097-1167`
- Modify: `app/page.tsx:22-123`
- Modify: `src/components/jobs/NewJobPanel.tsx:11-21,61-104,385-407`
- Modify: `src/components/jobs/AbsencePanel.tsx:21-36,87-152,561-628`
- Modify: `src/components/jobs/SplitBlockPanel.tsx:11-21,54-85,228-243`
- Modify: `src/components/ui/dateOptions.ts:1-114`
- Modify: `src/components/ui/index.ts:42-52`
- Modify: `src/components/ui/Field.tsx:165`
- Delete: `src/components/ui/DateSelect.tsx`
- Test: `src/components/ui/dateOptions.test.ts`

**Interfaces:**
- Consumes: `DayPicker`, `DayPickerProps` from `../ui`; `useFormat().dayLine(date: string): string`.
- Produces: `WeekController.revision: number`; `revision: number` on `JobPanelContext`, `NewJobContext` and `AbsenceFormContext`; `revision?: number` on `NewJobPanelProps`, `AbsencePanelProps` and `SplitBlockPanelProps`. `dateOptions.ts` keeps exactly `PICKER_PAST_WEEKS`, `PICKER_FUTURE_WEEKS`, `PICKER_MAX_FUTURE_WEEKS`, `planningWindow` and `type DayWindow`.

**Contracts kept — read and confirmed at each site:**
1. **The optimistic set.** `NewJobPanel:398-405` and `AbsencePanel:576-583` set the date inside `onChange`; `DayPicker` fires `onChange` on the CLICK, not on the close, so both bodies move across untouched and the painted band still follows the field.
2. **The `lastVisible` bookkeeping.** `if (visibleDates?.includes(startDate) === true) setLastVisible(startDate)` (job) and the same on `date` (absence) stay the FIRST statement of `onChange`, before the new value lands — `offWeekChoice` needs the last day that WAS on screen, not merely the previous one.
3. **`setForce(false)`.** Still the last statement of `NewJobPanel`'s `onChange`: a new day is a new question and the old answer must not carry over.
4. **`Hasta` pulled forward.** `if (compareDates(endDate, next) < 0) setEndDate(next)` stays in `AbsencePanel`'s `onChange`, so moving the start can never invert the range.
5. **`disabled` while saving** goes on as `disabled={saving}` / `disabled={busy}`; the trigger honours it and `shown` closes the popover if a save starts under it.

`AbsencePanel`'s bulk `Desde`/`Hasta` are NOT restructured here — the two `Field`s stay two. Their controls are swapped for `DayPicker` only because deleting `DateSelect.tsx` would otherwise break the build; merging them into one range calendar is the next slice, which also takes the `hint` of the bulk branch left below.

- [ ] **Step 1: Write the failing test**

Replace the `dayOptionDates` and `groupDaysByWeek` blocks of `src/components/ui/dateOptions.test.ts` (lines 57-125) with one test that pins what survives, and rewrite the file's head:

```ts
/**
 * How far a date control reaches. The window is bounded on purpose: it is the set of days the app
 * can actually honour, so the forward reach is capped and the past reach is a month.
 */

import { describe, expect, it } from 'vitest';
import { MAX_HORIZON_WEEKS } from '../../lib/settings';
import { addDays, startOfWeek, weekdayOf } from '../../lib/dates';
import * as dateOptions from './dateOptions';
import {
  PICKER_FUTURE_WEEKS,
  PICKER_MAX_FUTURE_WEEKS,
  PICKER_PAST_WEEKS,
  planningWindow,
} from './dateOptions';
import { WED } from '../../testing/fixtures';

// A Wednesday, in ISO week 33.
const TODAY = WED;
```

then, after the `planningWindow` describe (which is unchanged, but with its local `TODAY` now coming from the fixtures):

```ts
describe('what a date control still needs', () => {
  it('offers a window and nothing else: the option list died with the dropdown', () => {
    expect(Object.keys(dateOptions).sort()).toEqual([
      'PICKER_FUTURE_WEEKS',
      'PICKER_MAX_FUTURE_WEEKS',
      'PICKER_PAST_WEEKS',
      'planningWindow',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/dateOptions.test.ts -t 'the option list died'`
Expected: FAIL — the export list still holds `dayOptionDates` and `groupDaysByWeek`.

- [ ] **Step 3: Shrink `dateOptions.ts` to the window**

Replace the head comment (lines 1-10) and delete `MAX_OPTION_DAYS`, `dayOptionDates`, `DayOptionWeek` and `groupDaysByWeek` (lines 23-24 and 53-110):

```ts
/**
 * How far a date control reaches around today.
 *
 * The window is a UI affordance, not a rule: a stored value outside it is always kept, and the
 * forward reach is capped so a two-year horizon cannot become a calendar with no end.
 */

import { addDays, startOfWeek } from '../../lib/dates';

const DAYS_PER_WEEK = 7;
```

Everything from `/** How far back a date control reaches` to the end of `planningWindow`, and the `clamp` helper at the foot of the file, stays exactly as it is.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/dateOptions.test.ts`
Expected: PASS

- [ ] **Step 5: Publish the week's revision**

In `src/components/calendar/useWeek.ts`, add to `WeekController` (after `actionError`, line 32):

```ts
  /**
   * Bumped by every load and every mutation. Anything holding data from ANOTHER request — the day
   * picker's marks — hangs off this, because a recomposition rewrites rows the week's own response
   * never mentions.
   */
  revision: number;
```

and to both the returned object and the memo's dependency list (lines 150-180):

```ts
  return useMemo(
    () => ({
      view,
      loading,
      busy,
      mutating,
      loadError,
      actionError,
      revision: nonce,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      showWeekOf,
      mutate,
    }),
    [
      view,
      loading,
      busy,
      loadError,
      actionError,
      nonce,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      showWeekOf,
      mutate,
    ],
  );
```

- [ ] **Step 6: Put it on the three seams**

In `src/components/calendar/CalendarScreen.tsx`, add the same field to `JobPanelContext` (after `horizonWeeks`, line 83), `NewJobContext` (line 95) and `AbsenceFormContext` (line 141):

```ts
  /** `WeekController.revision`: what the day picker's marks are refetched on. */
  revision: number;
```

and pass it in all three render calls — beside `horizonWeeks` at lines 1101, 1117 and 1167:

```ts
                revision: week.revision,
```

- [ ] **Step 7: Wire it through `app/page.tsx`**

Add `revision` to each destructuring and pass it on. `JobPanel` has no date field, so only `SplitBlockPanel` reads it there:

```tsx
      renderJobPanel={({ projectId, close, onChanged, today, horizonWeeks, revision }) =>
```

```tsx
          <SplitBlockPanel
            open
            block={splitting}
            today={today}
            horizonWeeks={horizonWeeks}
            revision={revision}
```

```tsx
      renderNewJob={({
        close,
        onChanged,
        today,
        summary,
        suggestedColor,
        horizonWeeks,
        revision,
        painted,
        defaultHours,
        onDraft,
        visibleDates,
        onShowWeekOf,
      }) => (
        <NewJobPanel
          open
          today={today}
          summary={summary}
          defaultColor={suggestedColor}
          horizonWeeks={horizonWeeks}
          revision={revision}
```

```tsx
        defaultDurationMinutes,
        horizonWeeks,
        revision,
        onDraft,
```

```tsx
          horizonWeeks={horizonWeeks}
          revision={revision}
          onClose={close}
```

- [ ] **Step 8: Swap `NewJobPanel`'s start date**

Three edits in `src/components/jobs/NewJobPanel.tsx`. The import (line 16):

```tsx
  ConfirmDialog,
  DayPicker,
  Field,
```

the prop, after `horizonWeeks` (line 87):

```tsx
  /** `settings.planningHorizonWeeks`: how far ahead the day picker reaches. */
  horizonWeeks?: number;
  /** `WeekController.revision`: what the picker's day marks are refetched on. */
  revision?: number;
```

— adding `revision,` to the parameter list beside `horizonWeeks` — and the field itself (lines 389-407):

```tsx
            <Field
              label={t('jobForm.startDate')}
              hint={isValidDate(startDate) ? format.dayLine(startDate) : undefined}
            >
              <DayPicker
                value={startDate}
                today={reference}
                horizonWeeks={horizonWeeks}
                revision={revision}
                disabled={saving}
                onChange={(next) => {
                  // Set OPTIMISTICALLY: the band on the grid has to follow the field, and a
                  // field frozen behind a question would freeze the band mid-edit.
                  if (visibleDates?.includes(startDate) === true) setLastVisible(startDate);
                  setStartDate(next);
                  // A new day is a new question; the old answer must not carry over.
                  setForce(false);
                }}
              />
            </Field>
```

- [ ] **Step 9: Swap `AbsencePanel`'s two date fields**

In `src/components/jobs/AbsencePanel.tsx`, the import (line 25) becomes `DayPicker,` in the same slot, the prop pair goes in after `horizonWeeks` (line 129) exactly as in Step 8 — `revision,` in the parameter list too — and the two fields (lines 566-627) become:

```tsx
              <Field
                label={t(bulk ? 'absenceForm.from' : 'gapForm.date')}
                error={errorFor('date')}
                hint={
                  !isValidDate(date)
                    ? undefined
                    : bulk
                      ? format.longDate(date)
                      : format.dayLine(date)
                }
              >
                <DayPicker
                  value={date}
                  today={reference}
                  horizonWeeks={horizonWeeks}
                  revision={revision}
                  disabled={busy}
                  onChange={(next) => {
                    // Set OPTIMISTICALLY: a painted band on the grid has to follow the field.
                    if (visibleDates?.includes(date) === true) setLastVisible(date);
                    setDate(next);
                    // "Hasta" follows the day it can no longer precede, so the range is never
                    // inverted by moving its start.
                    if (compareDates(endDate, next) < 0) setEndDate(next);
                  }}
                />
              </Field>
```

and, inside the `{!bulk ? null : (` branch:

```tsx
                  <DayPicker
                    value={endDate}
                    today={reference}
                    horizonWeeks={horizonWeeks}
                    revision={revision}
                    disabled={busy}
                    onChange={setEndDate}
                  />
```

- [ ] **Step 10: Swap `SplitBlockPanel`'s day**

In `src/components/jobs/SplitBlockPanel.tsx`, the import (line 14) becomes `DayPicker,`, the prop pair goes in after `horizonWeeks` (line 71) as above, and the field (lines 231-243) becomes:

```tsx
        <Field
          label={t('gapForm.date')}
          error={errorFor('date')}
          hint={isValidDate(date) ? format.dayLine(date) : undefined}
        >
          <DayPicker
            value={date}
            today={reference}
            horizonWeeks={horizonWeeks}
            revision={revision}
            disabled={saving}
            onChange={setDate}
          />
        </Field>
```

- [ ] **Step 11: Bury the dropdown**

```bash
git rm src/components/ui/DateSelect.tsx
```

In `src/components/ui/index.ts`, delete the `DateSelect` line and the three dead names from the `dateOptions` block (lines 42-52), leaving:

```ts
export { DayPicker, type DayPickerProps } from './DayPicker';
export {
  PICKER_FUTURE_WEEKS,
  PICKER_MAX_FUTURE_WEEKS,
  PICKER_PAST_WEEKS,
  planningWindow,
  type DayWindow,
} from './dateOptions';
```

and in `src/components/ui/Field.tsx:165`, stop the comment naming a module that no longer exists:

```tsx
/** A heading over a run of options. */
```

- [ ] **Step 12: Run the four gates**

Run: `npx tsc --noEmit && npm test && npx eslint . && npm run build`
Expected: PASS — nothing imports `DateSelect`, `dayOptionDates` or `groupDaysByWeek` any more, and the suite is back to green with the option-list tests gone.

- [ ] **Step 13: Commit**

```bash
git add src/components/ui/DateSelect.tsx src/components/ui/dateOptions.ts src/components/ui/dateOptions.test.ts src/components/ui/index.ts src/components/ui/Field.tsx src/components/calendar/useWeek.ts src/components/calendar/CalendarScreen.tsx src/components/jobs/NewJobPanel.tsx src/components/jobs/AbsencePanel.tsx src/components/jobs/SplitBlockPanel.tsx app/page.tsx
git commit -m "feat(pickers): choose the day in a calendar, not a list"
```


### Task 19b: Retire what the dropdown left behind

> **Added after Task 19's review, which found five places of dead code left by one removed control and
> said they should be retired in one deliberate change rather than found again one at a time.** The
> design foresaw two of them — it says `SelectOptionGroup` and the `groups` prop "lose their last
> caller" — but leaving a capability nobody calls is not the same as deciding to keep it, and one of
> the five is a locale key that **no gate can ever catch**: `locales.test.ts` holds the two key sets
> identical, so an unread key present in both bundles passes forever.

**Files:**
- Modify: `src/lib/useFormat.ts` — drop `todayOption` from the `Formatter` interface and its implementation
- Modify: `public/locales/es/common.json:36`, `public/locales/en/common.json:36` — drop `units.dayOptionToday`
- Modify: `src/components/ui/Field.tsx` — drop `SelectOptionGroup`, `Select`'s `groups` prop and its `<optgroup>` branch
- Modify: `src/components/ui/index.ts` — drop the `SelectOptionGroup` type re-export
- Modify: `src/lib/creation.ts:24`, `src/components/ui/dateOptions.ts:18`, `src/components/ui/dateOptions.test.ts:38` — three comments describing a dropdown that no longer exists

**Interfaces:**
- Consumes: nothing new. Everything here is removal.
- Produces: `Formatter` without `todayOption`; `Select` without `groups`; `units` without `dayOptionToday`.
  No later task references any of the three.

- [ ] **Step 1: Prove each one is unread, before deleting anything**

Run each and read it against what is stated. If any prints a caller this task did not expect, **stop and
report it** rather than deleting.

```bash
grep -rn "todayOption" src app
grep -rn "dayOptionToday" src app public
grep -rn "SelectOptionGroup" src app
grep -rn "groups=" src app
grep -rn "\.groups\b" src app
```

Expected, exactly:

- `todayOption` — two hits, both in `src/lib/useFormat.ts` (the interface member and its implementation). No consumer.
- `dayOptionToday` — three hits: `useFormat.ts`'s implementation and the key itself in each bundle. **No test asserts it**; `locales.test.ts`'s verbatim-wording case pins ten other keys and not this one.
- `SelectOptionGroup` — its declaration in `Field.tsx`, the `groups` prop's type, and the type re-export in `index.ts`. No consumer.
- `groups=` — **one hit, `src/components/calendar/WeekGrid.tsx:451`, and it is NOT this one**: that passes `BlockGroup[]` to a different component. Leave it alone.
- `.groups` — the same `WeekGrid` layout usage. Not `Select`.

- [ ] **Step 2: Drop `todayOption` from the formatter**

In `src/lib/useFormat.ts`, delete the interface member and the implementation line. Its neighbour
`dayOption` STAYS — the day picker's trigger renders through it.

- [ ] **Step 3: Drop the key from both bundles**

Delete `"dayOptionToday"` from `units` in `public/locales/es/common.json` and
`public/locales/en/common.json`. Both, at the same key, or the parity test fails — which is the one
thing here a gate does catch.

- [ ] **Step 4: Drop the option group from `Select`**

In `src/components/ui/Field.tsx`, delete the `SelectOptionGroup` interface, the `groups` prop from
`SelectProps`, its default in the destructure, and the `<optgroup>` branch in the returned markup.
`SelectOption` and the ungrouped `options` prop STAY — every surviving `Select` uses them.

In `src/components/ui/index.ts`, delete `SelectOptionGroup` from the type re-export line, leaving the
rest of that line as it is.

- [ ] **Step 5: Reword the three comments**

None of these describes anything that exists. Say what the code now is, in the repo's own comment rule —
a unit, an origin, a caller obligation, a trap, or a measured defect, and nothing else:

- `src/lib/creation.ts:24` — the preview's alternatives are no longer one dropdown click away; they are
  days the owner reaches in the calendar. Name what the constant bounds, not the control.
- `src/components/ui/dateOptions.ts:18` — the cap no longer keeps a list scannable; it bounds how far the
  month arrows may walk.
- `src/components/ui/dateOptions.test.ts:38` — the same, in the test's name.

- [ ] **Step 6: Run the four gates**

Run: `npx tsc --noEmit`
Expected: PASS. This is the gate that proves the deletions: a surviving consumer of `todayOption`,
`SelectOptionGroup` or `groups` cannot compile.

Run: `npm test`
Expected: PASS, at the same file count and the same test count as before this task. **Nothing here adds
or removes a case**, and there is no test to add: a hook cannot be rendered in this suite, and asserting
that a locale key is ABSENT would block a legitimate future re-add. Say so in the report rather than
implying coverage.

Run: `npx eslint .`
Expected: PASS, and specifically no unused-import or unused-variable report from the four edited source
files.

Run: `npm run build`
Expected: compiled successfully.

- [ ] **Step 7: Commit**

```bash
git add src/lib/useFormat.ts public/locales/es/common.json public/locales/en/common.json src/components/ui/Field.tsx src/components/ui/index.ts src/lib/creation.ts src/components/ui/dateOptions.ts src/components/ui/dateOptions.test.ts
git commit -m "refactor(pickers): retire what the day dropdown left behind"
```

### Task 20a: Range mode on the day picker

**Files:**
- Modify: `src/components/ui/dayRange.ts:37-49` (append the paint, the discard and the notice key after `rangeCells`)
- Modify: `src/components/ui/DayPicker.tsx:25-27,34-36,41-71,80-84,102-112,132-137,199,251,304-346`
- Modify: `src/components/ui/DayPicker.module.css:157-175`
- Modify: `public/locales/es/common.json:79-85` (the `dayPicker` block Task 18 added)
- Modify: `public/locales/en/common.json:79-85` (the same block)
- Modify: `src/lib/locales.test.ts:100-108` (the `words the day picker in both languages` block Task 18 added)
- Test: `src/components/ui/dayRange.test.ts`

**Interfaces:**
- Consumes: `rangeClick(state: RangeState, date: string): RangeClickResult`, `rangeCells(from: string, to: string): { included: string[]; skipped: string[] }`, `interface RangeState { anchor?: string }`, `interface RangeClickResult { state: RangeState; committed?: { from: string; to: string } }` from `./dayRange` (Task 8); `absenceRange(from: string, to: string): AbsenceRange` and `MAX_ABSENCE_DAYS` from `src/lib/absences.ts`; `isValidDate(date: string): boolean` from `src/lib/dates.ts`; `isDayPickerKey(key: string): key is DayPickerKey` from `./dayPickerKeys` (Task 7), which answers `false` for `Enter`; `useFieldBinding`, `markOf`, `monthGrid`, `monthReach`, `popoverPosition` and the rest of the `DayPicker` body as Task 18 left it.
- Produces: `export interface RangeSpan { from: string; to: string }`; `export interface RangePaint { included: string[]; skipped: string[]; pending?: string }`; `export function rangePaint(state: RangeState, span: RangeSpan | undefined): RangePaint`; `export function rangeDiscard(state: RangeState): RangeState`; `export function rangeNoticeKey(state: RangeState): 'dayPicker.rangePending' | 'dayPicker.rangeStart'` — all from `src/components/ui/dayRange.ts`. And from `src/components/ui/DayPicker.tsx`, in place of Task 18's single interface: `export interface DayPickerSingleProps { value: string; onChange: (value: string) => void; today: string; horizonWeeks?: number; labelId?: string; revision?: number; disabled?: boolean; invalid?: boolean; id?: string; className?: string; range?: false; endValue?: never; onChangeRange?: never }`; `export interface DayPickerRangeProps { range: true; value: string; endValue: string; onChangeRange: (from: string, to: string) => void; today: string; horizonWeeks?: number; labelId?: string; revision?: number; disabled?: boolean; invalid?: boolean; id?: string; className?: string; onChange?: never }`; `export type DayPickerProps = DayPickerSingleProps | DayPickerRangeProps`. `export { DayPicker, type DayPickerProps } from './DayPicker'` in `src/components/ui/index.ts` needs no edit: a `type` re-export names a union as happily as an interface.

**What is decidable and what is not.** The suites run in `node` with no DOM and nothing in this repository is ever rendered, so everything this task can pin goes into `dayRange.ts`: which cells a committed span paints, which of them the save drops, that a pending end paints no span at all, that discarding a pending end leaves the committed span exactly as it was, and that a second click past the cap commits rather than clamping. **Stated rather than supposed, what stays untested:** that `onChangeRange` fires exactly once and only on the second click; that the popover closes on the commit; the `Escape` and click-outside paths; the trigger's two-end text; the foot swapping its one line; and every rule in the stylesheet. That is the same surface Task 18 left uncovered, for the same reason.

- [ ] **Step 1: Write the failing test**

Extend the `./dayRange` import of `src/components/ui/dayRange.test.ts` (line 14) — the four fixtures and `addDays` it already imports are all these tests need:

```ts
import { rangeCells, rangeClick, rangeDiscard, rangeNoticeKey, rangePaint } from './dayRange';
```

and append these four blocks at the foot of the file, after the `rangeCells` describe:

```ts
describe('rangePaint', () => {
  it('paints the committed span, and the weekend it drops', () => {
    expect(rangePaint({}, { from: THU, to: NEXT_MON })).toEqual({
      included: [THU, FRI, NEXT_MON],
      skipped: [SAT, SUN],
    });
  });

  it('paints a span that is nothing but a weekend as written whole', () => {
    expect(rangePaint({}, { from: SAT, to: SUN })).toEqual({ included: [SAT, SUN], skipped: [] });
  });

  it('paints no span while one end is still missing, only the end already clicked', () => {
    // There is no hover to read: the second click is what decides which way the span runs, and a
    // band drawn from a guess would promise days nobody has asked for.
    expect(rangePaint({ anchor: WED }, { from: MON, to: FRI })).toEqual({
      included: [],
      skipped: [],
      pending: WED,
    });
  });

  it('paints nothing at all in single-day mode, where there is no far end', () => {
    expect(rangePaint({}, undefined)).toEqual({ included: [], skipped: [] });
  });

  it('paints nothing for a stored pair that runs backwards', () => {
    expect(rangePaint({}, { from: FRI, to: MON })).toEqual({ included: [], skipped: [] });
  });
});

describe('closing with one end pending', () => {
  it('drops the pending end', () => {
    expect(rangeDiscard({ anchor: WED })).toEqual({});
  });

  it('leaves the committed span exactly as it was', () => {
    const span = { from: MON, to: FRI };
    const half = rangeClick({}, NEXT_MON);

    expect(rangePaint(half.state, span).included).toEqual([]);
    expect(rangePaint(rangeDiscard(half.state), span)).toEqual(rangePaint({}, span));
    expect(rangePaint(rangeDiscard(half.state), span).included).toEqual(rangeCells(MON, FRI).included);
  });

  it('answers with the state it was given when nothing is pending, so a close is not a render', () => {
    const state = {};
    expect(rangeDiscard(state)).toBe(state);
  });
});

describe('rangeNoticeKey', () => {
  it('asks for the first day, and then for the last', () => {
    expect(rangeNoticeKey({})).toBe('dayPicker.rangeStart');
    expect(rangeNoticeKey({ anchor: WED })).toBe('dayPicker.rangePending');
  });
});

describe('the cap this calendar does not clamp', () => {
  it("commits a second click past the cap, because the refusal is the server's", () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    expect(rangeClick({ anchor: MON }, past).committed).toEqual({ from: MON, to: past });
  });

  it('paints only the cells `absenceRange` walks, and never the day past the cap', () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    const paint = rangePaint({}, { from: MON, to: past });

    expect(paint.included.length + paint.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(paint.included).not.toContain(past);
    expect(paint.skipped).not.toContain(past);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/ui/dayRange.test.ts -t 'paints the committed span'`
Expected: FAIL — the whole file fails to link: `SyntaxError: The requested module './dayRange' does not provide an export named 'rangePaint'`. Task 8's module exports `rangeClick` and `rangeCells` and nothing else.

- [ ] **Step 3: Extend the state machine with the paint, the discard and the notice**

Append to `src/components/ui/dayRange.ts`, after `rangeCells`:

```ts
/** A committed span, both ends stored and already in calendar order. */
export interface RangeSpan {
  from: string;
  to: string;
}

export interface RangePaint {
  /** Cells of the committed span the save will WRITE. */
  included: string[];
  /** Cells inside it the save will DROP. */
  skipped: string[];
  /** The end already clicked, while the second is missing. */
  pending?: string;
}

/**
 * What the month grid paints for a range.
 *
 * A pending end paints NO span, only itself: the second click is what decides which way the span
 * runs, and a popover has no pointer position to guess with — a band drawn from a guess moves under
 * the mouse and promises days that were never asked for.
 */
export function rangePaint(state: RangeState, span: RangeSpan | undefined): RangePaint {
  if (state.anchor !== undefined) return { included: [], skipped: [], pending: state.anchor };
  if (span === undefined) return { included: [], skipped: [] };
  return rangeCells(span.from, span.to);
}

/**
 * Closing the popover with only one end clicked. The pending end dies and the stored span is not
 * touched, because a first click reported nothing there is anything to take back.
 *
 * Answers with the state it was given when nothing is pending, so the close path can hand this
 * straight to a setter without costing a render.
 */
export function rangeDiscard(state: RangeState): RangeState {
  return state.anchor === undefined ? state : {};
}

/** Which line the popover shows about a range, as a locale KEY: the wording lives in the bundles. */
export function rangeNoticeKey(
  state: RangeState,
): 'dayPicker.rangePending' | 'dayPicker.rangeStart' {
  return state.anchor === undefined ? 'dayPicker.rangeStart' : 'dayPicker.rangePending';
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/ui/dayRange.test.ts`
Expected: PASS — the eleven new tests and Task 8's own.

- [ ] **Step 5: Assert the two new locale strings, and watch that fail**

In `src/lib/locales.test.ts`, add four expectations to the end of the `it('words the day picker in both languages')` block Task 18 added, after the `dayPicker.todayHint` line:

```ts
    expect(resolve(es as Json, 'dayPicker.rangeStart')).toBe('Elige el primer día');
    expect(resolve(es as Json, 'dayPicker.rangePending')).toBe('Elige el último día');
    expect(resolve(en as Json, 'dayPicker.rangeStart')).toBe('Choose the first day');
    expect(resolve(en as Json, 'dayPicker.rangePending')).toBe('Choose the last day');
```

Run: `npx vitest run src/lib/locales.test.ts -t 'words the day picker'`
Expected: FAIL — `Error: Not a string key: dayPicker.rangeStart`, thrown by `resolve`.

- [ ] **Step 6: Add the two keys to both bundles**

In `public/locales/es/common.json`, the `dayPicker` block becomes:

```json
  "dayPicker": {
    "open": "Elegir el día",
    "previousMonth": "Mes anterior",
    "nextMonth": "Mes siguiente",
    "today": "Hoy",
    "todayHint": "Elige hoy",
    "rangeStart": "Elige el primer día",
    "rangePending": "Elige el último día"
  },
```

and in `public/locales/en/common.json`:

```json
  "dayPicker": {
    "open": "Choose the day",
    "previousMonth": "Previous month",
    "nextMonth": "Next month",
    "today": "Today",
    "todayHint": "Choose today",
    "rangeStart": "Choose the first day",
    "rangePending": "Choose the last day"
  },
```

- [ ] **Step 7: Run the locale suite and watch it pass**

Run: `npx vitest run src/lib/locales.test.ts`
Expected: PASS — the two bundles still hold identical key sets, and neither new string carries an interpolation the other lacks.

- [ ] **Step 8: Split `DayPickerProps` into a union on `range`**

In `src/components/ui/DayPicker.tsx`, the import block gains one line after `./dayPickerTitle` (line 25):

```tsx
import { dayCellNotes, type DayCellNote } from './dayPickerTitle';
import {
  rangeClick,
  rangeDiscard,
  rangeNoticeKey,
  rangePaint,
  type RangeState,
} from './dayRange';
import { useMounted } from './useMounted';
```

the `POPOVER_CHROME` comment (lines 34-35) stops naming a button that only one mode draws:

```tsx
/** Everything that is not the six rows: the padding, the month head, the weekday letters, the
    three gaps and the foot's one line. */
const POPOVER_CHROME = 100;
```

and `DayPickerProps` (lines 41-58) becomes the two shapes and their union:

```tsx
/** What both modes take. `value` is the day in single-day mode and the NEAR end of the span in range mode. */
interface DayPickerCommonProps {
  /** Local `YYYY-MM-DD`. A stored day outside the window is kept, and its own cell stays pressable. */
  value: string;
  /** The shop's today: rings one cell and anchors the window. */
  today: string;
  /** The owner's `planningHorizonWeeks`, which is how far forward the calendar reaches. */
  horizonWeeks?: number;
  /** The `Field`'s own label id. Inherited from the `Field`; pass it only outside one. */
  labelId?: string;
  /** `WeekController.revision`: the marks are refetched whenever the week is. */
  revision?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export interface DayPickerSingleProps extends DayPickerCommonProps {
  /** Omitted: the discriminant, so a single-day call site needs no change to keep compiling. */
  range?: false;
  onChange: (value: string) => void;
  /** The two `never`s stop a range call site that forgot `range` from silently becoming a
      single-day picker, whose second click would never commit anything. */
  endValue?: never;
  onChangeRange?: never;
}

export interface DayPickerRangeProps extends DayPickerCommonProps {
  range: true;
  /** The stored FAR end. */
  endValue: string;
  /**
   * Fired ONCE, with both ends already in calendar order, on the SECOND click.
   *
   * The first click never leaves this component. A half-chosen range reaching the form would run
   * `previewAbsence` on every click of a walk through the month — a real write inside a transaction
   * that is rolled back — and would drop `Reabrir` out of the footer while `rangeValid` was false.
   */
  onChangeRange: (from: string, to: string) => void;
  onChange?: never;
}

export type DayPickerProps = DayPickerSingleProps | DayPickerRangeProps;
```

- [ ] **Step 9: Take the mode apart at the top of the component**

The signature and destructuring (lines 60-71) become:

```tsx
export function DayPicker(props: DayPickerProps): React.JSX.Element {
  const {
    value,
    today,
    horizonWeeks,
    labelId,
    revision,
    disabled = false,
    invalid,
    id,
    className,
  } = props;
  // Read off BEFORE any closure: a discriminant narrowed on a parameter does not survive into a
  // callback, and `choose` is one. `commitRange` is also what "range mode" is asked with below.
  const commitDay = props.range === true ? undefined : props.onChange;
  const commitRange = props.range === true ? props.onChangeRange : undefined;
  const endValue = props.range === true ? props.endValue : undefined;
```

and the state block gains the pending end (after line 84):

```tsx
  const [marks, setMarks] = useState<DayMarks | undefined>(undefined);
  /** The end clicked first. It never leaves this component: see `onChangeRange`. */
  const [pending, setPending] = useState<RangeState>({});
```

- [ ] **Step 10: Commit the range on the second click, and discard it on the close**

`dismiss` and `choose` (lines 102-112) become:

```tsx
  const dismiss = useCallback((restoreFocus: boolean): void => {
    // The pending end dies with the popover and the stored span is left exactly as it was: a first
    // click reported nothing, so there is nothing to take back. `Escape` and the click outside both
    // arrive here, so both discard.
    setPending(rangeDiscard);
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const choose = (date: string): void => {
    if (commitRange === undefined) {
      // Reported on the CLICK, never on the close: the panels set the date optimistically because
      // the band drawn on the grid has to follow the field.
      commitDay?.(date);
      dismiss(true);
      return;
    }

    const click = rangeClick(pending, date);
    setPending(click.state);
    // NEVER on the first click: it would run `previewAbsence` — a real write inside a transaction
    // that is rolled back — on every click of a walk through the month, and would blink `Reabrir`
    // out of the footer mid-selection.
    if (click.committed === undefined) return;
    // Not clamped to `MAX_ABSENCE_DAYS`: the refusal is the server's 400 `invalid-range`, drawn in
    // the field's own error slot. Clamped here, the owner would never learn why it was refused.
    commitRange(click.committed.from, click.committed.to);
    dismiss(true);
  };
```

and the `!shown` branch of the marks effect (lines 132-137) drops the pending end too:

```tsx
  useEffect(() => {
    if (!shown) {
      // Dropped on close: a stale mark is worse than none, and the next open asks again.
      setMarks(undefined);
      // And the pending end with them. `disabled` hides the popover without `dismiss` ever running,
      // so a save started under an open calendar would otherwise leave an anchor behind for the
      // next click to commit a range nobody started.
      setPending(rangeDiscard);
      return;
    }
```

`Enter` needs no code: a cell is a `<button>`, `isDayPickerKey('Enter')` is `false` so the capture handler lets the key through, and the native activation calls this same `onClick` — which makes the two-click commit work from the keyboard exactly as it does from the mouse.

- [ ] **Step 11: Paint the committed span, and nothing else**

After `const reach = ...` (line 199):

```tsx
  const reach = monthReach(month, dayWindow);

  // Decided by `rangeCells`, which delegates to `absenceRange` — the same call the preview and the
  // save make — and never re-derived here, so a painted cell cannot promise a day the write skips.
  // A span whose every day is a weekend is included whole, which is `absenceRange`'s own exception.
  // Both ends are checked first: `absenceRange` walks with `addDays`, so an unset end would walk
  // 120 junk days.
  const stored =
    endValue !== undefined && isValidDate(value) && isValidDate(endValue)
      ? { from: value, to: endValue }
      : undefined;
  const paint = rangePaint(pending, stored);
  const written = new Set(paint.included);
  const dropped = new Set(paint.skipped);
```

the trigger's value (line 251) shows both ends when it has two:

```tsx
        <span className={styles.value}>{triggerText}</span>
```

with, next to `labelledBy` (line 222):

```tsx
  const dayText = (date: string): string => (isValidDate(date) ? format.dayOption(date) : date);
  // Joined with the separator a day header already composes its own title with. `units.timeRange`
  // is the CLOCK range and would be a lie on two dates.
  const triggerText =
    endValue === undefined
      ? dayText(value)
      : [dayText(value), dayText(endValue)].join(t('units.listSeparator'));
```

and the grid (lines 304-337) gains three marks:

```tsx
              <div className={styles.grid}>
                {cells.map((cell) => {
                  const mark = markOf(cell.date, marks);
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      data-date={cell.date}
                      className={[
                        styles.cell,
                        cell.inMonth ? '' : styles.outside,
                        commitRange === undefined && cell.date === value ? styles.selected : '',
                        written.has(cell.date) ? styles.inSpan : '',
                        dropped.has(cell.date) ? styles.spanDropped : '',
                        cell.date === paint.pending ? styles.pending : '',
                        cell.isToday ? styles.today : '',
                        cell.isWeekend ? styles.weekend : '',
                        cell.isPast ? styles.past : '',
                        mark?.isClosed === true ? styles.closed : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={!cell.selectable}
                      tabIndex={cell.date === focused ? 0 : -1}
                      aria-pressed={
                        commitRange === undefined
                          ? cell.date === value
                          : written.has(cell.date) || cell.date === paint.pending
                      }
                      aria-current={cell.isToday ? 'date' : undefined}
                      title={titleOf(cell, mark)}
                      onClick={() => choose(cell.date)}
                    >
                      <span className={styles.number}>{format.dayOfMonth(cell.date)}</span>
                      {mark?.hasRoom === true ? (
                        <span className={styles.room} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
```

In single-day mode `stored` is `undefined` and `pending` is always `{}`, so all three of the new marks are inert there and the JSX needs no branch.

- [ ] **Step 12: Swap the foot's one line**

The `Hoy` button (lines 339-346) becomes:

```tsx
              {commitRange === undefined ? (
                <button
                  type="button"
                  className={styles.todayButton}
                  title={t('dayPicker.todayHint')}
                  onClick={() => choose(today)}
                >
                  {t('dayPicker.today')}
                </button>
              ) : (
                /* In place of `Hoy`, not under it: `POPOVER_HEIGHT` is the constant
                   `popoverPosition` clips by arithmetic, so a mode may swap the foot's one line and
                   may never add a second. */
                <span className={styles.notice} aria-live="polite">
                  {t(rangeNoticeKey(pending))}
                </span>
              )}
```

- [ ] **Step 13: Style the band, the dropped days and the notice**

In `src/components/ui/DayPicker.module.css`, after `.selected .room` (line 159):

```css
/* The span the save will WRITE. The per-cell radius goes, so a run reads as one band instead of a
   row of separate pills — the grid has no gap, the cells touch. The tint takes the background from
   `.closed` exactly as `.selected` already does: a choice wins that channel, and the cell's own
   title still names the reason the day is closed. */
.inSpan {
  border-radius: 0;
  background: var(--ww-accent-tint);
}

/* Inside the span and dropped by it: the server skips Saturday and Sunday unless the whole span is
   one. A strike and not a tint, so a painted cell never promises a day the write skips — every one
   of these is a weekend cell, so its number is already muted. */
.spanDropped .number {
  text-decoration: line-through;
}

/* The one end already clicked. The second click is what reaches the form, so this is the only sign
   the popover gives that a range is half chosen. */
.pending {
  background: var(--ww-accent);
}

.pending .number {
  color: var(--ww-on-accent);
}
```

and at the foot of the file, after `.todayButton:hover` (line 175):

```css
/* The foot's one line in range mode, in the box `.todayButton` has. */
.notice {
  border-top: var(--ww-hairline) solid var(--ww-border);
  padding-top: var(--ww-space-2);
  color: var(--ww-text-muted);
  font-size: var(--ww-text-sm);
  text-align: center;
}
```

- [ ] **Step 14: Run the four gates**

Run: `npx tsc --noEmit && npm test && npx eslint . && npm run build`
Expected: PASS — the three single-day call sites Task 19 wired compile untouched, because `range` is optional and the shape they pass is unchanged; the suite is green with the eleven new tests; no lint finding; a clean build.

- [ ] **Step 15: Commit**

```bash
git add src/components/ui/dayRange.ts src/components/ui/dayRange.test.ts src/components/ui/DayPicker.tsx src/components/ui/DayPicker.module.css src/lib/locales.test.ts public/locales/es/common.json public/locales/en/common.json
git commit -m "feat(pickers): choose both ends of a range in one calendar"
```

### Task 20: The absence range in one calendar

**Files:**
- Create: `src/components/jobs/absenceFields.ts`
- Test: `src/components/jobs/absenceFields.test.ts`
- Modify: `src/components/jobs/AbsencePanel.tsx:25` (import `DayPicker` instead of `DateSelect`)
- Modify: `src/components/jobs/AbsencePanel.tsx:76` (add the `./absenceFields` import)
- Modify: `src/components/jobs/AbsencePanel.tsx:561-628` (one range `Field` instead of `Desde` + `Hasta`)
- Modify: `src/components/jobs/AbsencePanel.tsx:922,940-950` (delete the local `AbsenceField` and `API_FIELD`)
- Modify: `public/locales/es/common.json:252`
- Modify: `public/locales/en/common.json:252`

**Interfaces:**
- Consumes: `DayPicker` in range mode — `{ range: true; value: string; endValue: string; onChangeRange: (from: string, to: string) => void; today: string; horizonWeeks?: number; disabled?: boolean }`, the callback firing ONCE with both ends and the popover closing on it; `DayPicker` in single mode — `{ value: string; onChange: (value: string) => void; today: string; horizonWeeks?: number; disabled?: boolean }`; `useFormat().dayLine(date: string): string`; `rangeCells(from: string, to: string): { included: string[]; skipped: string[] }` from `src/components/ui/dayRange.ts`; `absenceRange(from: string, to: string): { dates: string[]; skipped: string[] }`; `summarizeAbsence(preview: AbsencePreview): AbsenceSummary`.
- Produces: `type AbsenceField = 'date' | 'endDate' | 'startTime' | 'duration' | 'reason'`; `const API_FIELD: Record<string, AbsenceField | undefined>`; `const RANGE_FIELDS: readonly AbsenceField[]`; `function rangeError(messageFor: (field: AbsenceField) => string | undefined): string | undefined` — all from `src/components/jobs/absenceFields.ts`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Which control of the absences form a refusal lands on, now that the range is ONE calendar. Both
 * refusals a span can earn name the far end, and `localError` is drawn nowhere but a `Field`'s
 * `error`: an end that maps onto no field leaves `Guardar` refusing in silence.
 */

import { describe, expect, it } from 'vitest';
import { API_FIELD, RANGE_FIELDS, rangeError, type AbsenceField } from './absenceFields';
import { summarizeAbsence } from './absence';
import { rangeCells } from '../ui/dayRange';
import { absenceRange } from '../../lib/absences';
import type { AbsencePreview } from '../../lib/api-client';
import { FRI, MON, SAT, SUN, THU, TUE, WED } from '../../testing/fixtures';

function preview(overrides: Partial<AbsencePreview> = {}): AbsencePreview {
  return {
    today: MON,
    kind: 'closed-days',
    dates: [MON],
    skippedDates: [],
    rows: [],
    alreadyClosedDates: [],
    displaced: [],
    lastOccupiedBefore: null,
    lastOccupiedAfter: null,
    ...overrides,
  };
}

const onlyOn =
  (field: AbsenceField, message: string) =>
  (asked: AbsenceField): string | undefined =>
    asked === field ? message : undefined;

describe('the field a refusal of the absences form lands on', () => {
  it('sends both payload keys of a span to the one control that draws it', () => {
    expect(API_FIELD.from).toBe('date');
    expect(API_FIELD.to).toBe('endDate');
    expect(RANGE_FIELDS).toEqual(['date', 'endDate']);
    expect(RANGE_FIELDS).toContain(API_FIELD.from);
    expect(RANGE_FIELDS).toContain(API_FIELD.to);
  });

  it('shows a range refused backwards, which names the far end', () => {
    expect(rangeError(onlyOn('endDate', 'range backwards'))).toBe('range backwards');
  });

  it('shows a range refused for its length, which the server also names on the far end', () => {
    expect(rangeError(onlyOn('endDate', 'invalid range'))).toBe('invalid range');
  });

  it('shows a refusal of the near end too', () => {
    expect(rangeError(onlyOn('date', 'not a date'))).toBe('not a date');
  });

  it('names the near end first when both were refused', () => {
    expect(rangeError((field) => (field === 'date' ? 'near' : 'far'))).toBe('near');
  });

  it('stays quiet about the controls it does not answer for', () => {
    expect(rangeError(onlyOn('startTime', 'not a time'))).toBeUndefined();
    expect(rangeError(() => undefined)).toBeUndefined();
  });
});

describe('what the line under the range field counts', () => {
  it('counts the days the span WRITES, not the cells the calendar paints', () => {
    const span = rangeCells(MON, SUN);
    const server = absenceRange(MON, SUN);

    expect(span.included).toEqual([MON, TUE, WED, THU, FRI]);
    expect(span.skipped).toEqual([SAT, SUN]);
    // The cells drawn excluded are exactly the days the count leaves out: seven painted, five written.
    expect(span.included).toEqual(server.dates);
    expect(span.skipped).toEqual(server.skipped);

    const summary = summarizeAbsence(
      preview({ dates: span.included, skippedDates: span.skipped }),
    );
    expect(summary.dayCount).toBe(5);
    expect(summary.dayCount).toBe(span.included.length);
  });

  it('excludes no cell when the whole span is the weekend the owner named', () => {
    const span = rangeCells(SAT, SUN);

    expect(span.included).toEqual([SAT, SUN]);
    expect(span.skipped).toEqual([]);
    expect(summarizeAbsence(preview({ dates: span.included })).dayCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/components/jobs/absenceFields.test.ts -t 'sends both payload keys of a span to the one control that draws it'`
Expected: FAIL — `Failed to resolve import "./absenceFields" from "src/components/jobs/absenceFields.test.ts"`. The mapping lives inside `AbsencePanel.tsx` as a module-private const, so nothing can read it without a DOM.

- [ ] **Step 3: Create the field mapping as a module of its own**

```ts
/**
 * Which control of the absences form a refusal lands on. Out of the panel so it can be read without a
 * DOM: the range calendar is ONE control over BOTH payload keys of a span, and `localError` is drawn
 * nowhere but a `Field`'s `error`.
 */

/** The controls the form has, whichever of its three shapes is on screen. */
export type AbsenceField = 'date' | 'endDate' | 'startTime' | 'duration' | 'reason';

/** The payload keys the API validates, mapped onto this form's controls. */
export const API_FIELD: Record<string, AbsenceField | undefined> = {
  date: 'date',
  from: 'date',
  to: 'endDate',
  startTime: 'startTime',
  startMinutes: 'startTime',
  durationHours: 'duration',
  durationMinutes: 'duration',
  reason: 'reason',
};

/**
 * The ends the range calendar answers for, in the order it shows them. `errors.rangeBackwards` and the
 * server's 400 `invalid-range` both name the far end, and no other control on the screen draws them.
 */
export const RANGE_FIELDS: readonly AbsenceField[] = ['date', 'endDate'];

/** The message the range calendar shows: whichever of its two ends was refused. */
export function rangeError(
  messageFor: (field: AbsenceField) => string | undefined,
): string | undefined {
  for (const field of RANGE_FIELDS) {
    const message = messageFor(field);
    if (message !== undefined) return message;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/components/jobs/absenceFields.test.ts`
Expected: PASS

- [ ] **Step 5: Name the merged field in both locale files**

`public/locales/es/common.json`, inside `absenceForm`, between `modeClosedHint` and `from`:

```json
    "modeClosedHint": "Vacaciones, feria, festivo: el día entero, sin horas planificables.",
    "range": "Qué días",
    "from": "Desde",
```

`public/locales/en/common.json`, the same place:

```json
    "modeClosedHint": "Holidays, a fair, a public holiday: the whole day, with no plannable hours.",
    "range": "Which days",
    "from": "From",
```

- [ ] **Step 6: Rewire the panel onto one range calendar**

`src/components/jobs/AbsencePanel.tsx:25` — `DateSelect` leaves the `../ui` import list and `DayPicker` takes its place:

```ts
  ConfirmDialog,
  DayPicker,
  Field,
```

`src/components/jobs/AbsencePanel.tsx:77` — the mapping arrives from its own module, after the `./absence` import:

```ts
import { API_FIELD, rangeError, type AbsenceField } from './absenceFields';
```

`src/components/jobs/AbsencePanel.tsx:561-628` — the two bulk pickers become one, and the off-week banner moves into the single-day branch, which is the only one that can raise it:

```tsx
        {closing === undefined ? (
          <>
            {bulk ? (
              /* One control over both ends of the span: its error slot is the only place
                 `errors.rangeBackwards` and the server's `invalid-range` are ever drawn, and the line
                 under it is the days the preview will WRITE — a Monday-to-Sunday span paints seven
                 cells and writes five. */
              <Field
                label={t('absenceForm.range')}
                error={rangeError(errorFor)}
                hint={
                  summary === null ? undefined : t('absenceForm.days', { count: summary.dayCount })
                }
              >
                <DayPicker
                  range
                  value={date}
                  endValue={endDate}
                  today={reference}
                  horizonWeeks={horizonWeeks}
                  disabled={busy}
                  onChangeRange={(from, to) => {
                    // BOTH ends in one update. A half-chosen range would run `previewAbsence`, which
                    // is the real write inside a transaction that is rolled back, and would drop
                    // `Reabrir` out of the footer while `rangeValid` was false.
                    setDate(from);
                    setEndDate(to);
                  }}
                />
              </Field>
            ) : (
              <div>
                {/* Never a native date input. The picker keeps a
                    stored day outside its window, so editing an old gap can never move it. */}
                <Field
                  label={t('gapForm.date')}
                  error={errorFor('date')}
                  hint={isValidDate(date) ? format.dayLine(date) : undefined}
                >
                  <DayPicker
                    value={date}
                    today={reference}
                    horizonWeeks={horizonWeeks}
                    disabled={busy}
                    onChange={(next) => {
                      // Set OPTIMISTICALLY: a painted band on the grid has to follow the field.
                      if (visibleDates?.includes(date) === true) setLastVisible(date);
                      setDate(next);
                      // "Hasta" follows the day it can no longer precede, so the range is never
                      // inverted by moving its start.
                      if (compareDates(endDate, next) < 0) setEndDate(next);
                    }}
                  />
                </Field>

                {offWeek === null ? null : (
                  <InlineBanner tone="info" title={t('jobForm.offWeekTitle')}>
                    {t('jobForm.offWeek', { date: format.longDate(offWeek.goTo) })}
                    <div className={styles.offWeekActions}>
                      <Button size="sm" onClick={() => onShowWeekOf?.(offWeek.goTo)}>
                        {t('jobForm.offWeekGo')}
                      </Button>
                      {offWeek.backTo === null ? null : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDate(offWeek.backTo as string)}
                        >
                          {t('jobForm.offWeekBack', { date: format.dayOption(offWeek.backTo) })}
                        </Button>
                      )}
                    </div>
                  </InlineBanner>
                )}
              </div>
            )}
```

`src/components/jobs/AbsencePanel.tsx:922` and `:940-950` — delete both, they now live in `absenceFields.ts`:

```ts
type AbsenceField = 'date' | 'endDate' | 'startTime' | 'duration' | 'reason';
```

```ts
/** The payload keys the API validates, mapped onto this form's controls. */
const API_FIELD: Record<string, AbsenceField | undefined> = {
  date: 'date',
  from: 'date',
  to: 'endDate',
  startTime: 'startTime',
  startMinutes: 'startTime',
  durationHours: 'duration',
  durationMinutes: 'duration',
  reason: 'reason',
};
```

- [ ] **Step 7: Run the gates**

Run: `npx tsc --noEmit && npm test && npx eslint .`
Expected: PASS — no type error, the whole suite green, no lint finding.

- [ ] **Step 8: Commit**

```bash
git add src/components/jobs/absenceFields.ts src/components/jobs/absenceFields.test.ts src/components/jobs/AbsencePanel.tsx public/locales/es/common.json public/locales/en/common.json
git commit -m "feat(absences): pick the range in one calendar"
```


### Task 21: The SPEC and DECISIONS edits

**Files:**
- Modify: `src/lib/docs.test.ts:74` (insert a new `describe` after the `every pointer resolves` block)
- Modify: `docs/DECISIONS.md:726` (append four entries after the file's closing `---`)
- Modify: `docs/SPEC.md:578-580`, `docs/SPEC.md:1000-1005`, `docs/SPEC.md:1006` (insert two `####` subsections), `docs/SPEC.md:1052` (insert one bullet), `docs/SPEC.md:1415`, `docs/SPEC.md:1429` (insert four bullets), `docs/SPEC.md:1516-1517`, `docs/SPEC.md:1600` (insert one bullet)
- Test: `src/lib/docs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime. The prose names, and must stay true to, `DayPicker`, `TimeField`, `monthGrid`, `monthReach`, `dayRange`, `pickerDays`, `timeField`, `popoverBox`, `readDays(from, to, options?, db?)`, `MAX_DAY_MARK_DAYS = 200`, `getDayMarks(from, to, options?)`, `planningWindow(today, horizonWeeks?, pastWeeks?)`, `MIN_ROW_MINUTES`, `TIME_STEP_MINUTES`, `SNAP_MINUTES`, `absenceRange`, `errorFor`, `API_FIELD`, and the token `--ww-z-popover`.
- Produces: two new SPEC headings other slices may point at — `#### The Day Is Picked From a Month, Never From a List` and `#### The Hour Is Typed` — plus four DECISIONS headings: `## The Hour Is Typed, Not Chosen From 96 Options`, `## The Day Is Picked From a Month, and the Month Reaches Exactly As Far As the List Did`, `## Six Marks in the Month, and the Dot Only Promises Room`, `## A Range Is Chosen In One Calendar, and the Form Hears It Once`. Renaming any of them breaks `every pointer resolves`.

- [ ] **Step 1: Write the failing test**

Insert this new `describe` into `src/lib/docs.test.ts` immediately after the `describe('every pointer resolves', …)` block closes at line 74, before `describe('docs/DECISIONS.md keeps one shape', …)`:

```ts
describe('docs/SPEC.md describes the screen that exists', () => {
  /**
   * The two controls the spec described before the month calendar and the typed hour replaced them.
   * A spec naming a component that is not in the tree sends the next reader to a file that is not
   * there — and it was the pointer this file already caught once, under a different name.
   */
  const RETIRED = ['DateSelect', 'TimeSelect'];

  it('names the day picker and the time field, and neither control they replaced', () => {
    for (const file of [SPEC, DECISIONS]) {
      const text = read(file);
      for (const name of RETIRED) expect(text).not.toContain(name);
    }
    const spec = read(SPEC);
    expect(spec).toContain('DayPicker');
    expect(spec).toContain('TimeField');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/docs.test.ts -t 'names the day picker and the time field'`
Expected: FAIL — `expected 'docs/SPEC.md' text not to contain 'DateSelect'`. `docs/SPEC.md` names `DateSelect` at line 1003 and `TimeSelect` at lines 580 and 1002, and names neither `DayPicker` nor `TimeField`.

- [ ] **Step 3: Append the four DECISIONS entries**

Append to the end of `docs/DECISIONS.md`, after its final `---` line (726). The `**Rule** — ` dash is an EM DASH in all four:

```md

## The Hour Is Typed, Not Chosen From 96 Options

**Rule** — SPEC § *The Hour Is Typed*. Every hour in the app is an `HH:mm` field that is typed. What is
typed takes effect on `Intro` or on leaving the field; `−`/`+` and `↑`/`↓` take effect at once, a quarter
of an hour at a time and an hour with `Mayús`.

**Why** — the owner asked for it in those words: *«Permite escribir para no hacer 2000 clicks para ir de
00:00 a 23:45»*. The list it replaces held all 96 quarter hours of the day in one dropdown, and the shop's
day starts at 08:00, which is the 33rd of them.

**Why it draws its own string instead of `format.time`** — parse-then-format on every keystroke rewrites
`8:00` to `08:00` under the cursor, and `formatTime` fails soft: a value it cannot read comes back as
`--:--`, which is the opposite of leaving what cannot be read on screen.

**Why only a value that CHANGED is snapped to the quarter** — snapping on every blur moves a hand-stored
`08:10` to `08:15` by tabbing over it. `changedFields` compares strings, so that lands in the patch, and a
Settings save recomposes the calendar and empties the undo line. The comparison is against the value the
field held when it took the focus.

**Why bounds refuse instead of clamping** — clamping turns a typed `18:00` into `17:45`, a value moving
under the owner. `errors.timeOutOfBounds` names the two hours it has to be between, so the way out is on
screen instead.

**Why the ceiling is `23:45`** — `hhmmToMinutes` reads `24:00` as 1440, and the band then stops being drawn
with no explanation while the field still looks legal.

**Rejected** — a native `<input type="time">`, which the spec prohibits outright. Measured on the Settings
screen: with Chrome set to English it drew `08:00 AM` beside a grid reading `08:00-14:00`.

---

## The Day Is Picked From a Month, and the Month Reaches Exactly As Far As the List Did

**Rule** — SPEC § *The Day Is Picked From a Month*. A day is chosen on a six-row month grid in a popover,
Monday first, opened from a button carrying the day it already holds. `planningWindow` still decides how
far it reaches — four weeks back, the horizon forward, capped at 16 weeks — the `‹ ›` arrows stop at that
window's edges, and a day the window does not offer is drawn dimmed and cannot be pressed.

**Why** — the list it replaces offered between 84 and 140 consecutive days, and no list answers "which
Thursday" the way a month does. The window is unchanged because it is exactly the set of days a form can
reach today: forward, a day past the horizon is a 409 `horizon-exceeded` on the save; backward, a job's
start date writes padlocked rows in the past, which the owner did not ask for.

**Why six rows always, and never five or six by the month** — the popover's height is then a constant, so
clipping it against the window is arithmetic with a test rather than a measurement of the DOM.

**Why a stored day outside the window is still pressable** — a control that drops the day already on disk
replaces it the moment the form is saved. It was true of the list and it stays true here.

**Why the line under the field says `Semana 33`** — the list grouped its days under the very week label the
grid's header carries, so a form and the grid could not name one day two ways, and that is the only thing
leaving the list would have lost. `units.week` keeps the number; `header.week` carries the date range
inside it, which the long date beside it already says.

**Why the trigger is a `<button>` and the picker swallows its own arrow keys** — `isTypingTarget` recognises
only `INPUT`, `TEXTAREA`, `SELECT` and `contenteditable`. With the old `<select>` the header's week pager
saw the arrows and turned two weeks at once; with a button, nothing but the picker swallowing them stops
the week turning under an open calendar.

---

## Six Marks in the Month, and the Dot Only Promises Room

**Rule** — SPEC § *The Day Is Picked From a Month*, § *Calendar View*. A month cell carries six marks and no
more — the chosen day, today, the weekend, the past, a closed day, room left — and every one of them can
still be chosen. The number dims for what the calendar makes of the day, the background greys for what the
owner decided, and the dot says only that the engine still places hours there.

**Why** — the owner named what they wanted marked and asked for nothing to explain it: the dot gets no
definition on screen, each cell says the rest on hover the way a day header already does, and there is no
legend. Nothing is hatched either — the one hatch this app tried lasted a day, and § *A Gap Is Hatched, the
Lunch-Break Band Is Not* carries the measurement.

**Why the dot is neither `plannableMinutes` nor `bookedMinutes`** — the two answer different questions, as
their own comment in `views.ts` says. `plannableMinutes` does not subtract ordinary movable work, so it
dots a Tuesday the grid draws full; `bookedMinutes` calls a day full that the next write is about to clear,
a state the owner never chose. What the dot reads is the plannable minutes less that day's movable blocks,
which is the engine's own arithmetic: `openDay` starts the day at `plannableMinutes` and `planTake` spends
it, and the movable rows are what the last pass spent it on.

**Why the longest free stretch and the horizon are terms of their own** — a day whose 40 free minutes are
four holes of ten has no room the engine will use, and `buildDayPlan` does not know the horizon, so without
that term the dot would promise room on precisely the days that answer `horizon-exceeded`. One line pays
for the rest: `buildDayPlan` returns zero plannable minutes for a past day, a closed day, a `manual` day
and a zero-minute shift alike, so a weekend, a closed day and a past day lose the dot with no code of
their own and the dot cannot contradict the grey.

**Why no mark ever disables a cell** — § *A Closed Day Chosen As A Start Date Is Honoured*: asked whether to
refuse a closed day, the owner chose *«Dejar elegirlo, pero cumplirlo de verdad»*.

**Why the grey and its reason come from the server** — they are one `day_overrides` row, read through the
same `listDayOverridesBetween` and the same snapshot's `getDayConfig` the week is read through, so the
picker's grey cannot disagree with the column's, and a note written by another writer names the day in both
places at once.

---

## A Range Is Chosen In One Calendar, and the Form Hears It Once

**Rule** — SPEC § *The Absences Screen*. The multiple mode's `Desde` and `Hasta` are one range calendar: the
first click is remembered inside the popover, the second closes it and hands the form both ends at once,
always ordered, and the weekend cells inside the span are drawn excluded by the same `absenceRange` the
server writes with.

**Why the first click never leaves the calendar** — writing `date` on the first click makes every step
across the month fire `previewAbsence`, which is the real write inside a transaction that is rolled back,
announcing displaced work for a range half chosen. Leaving `endDate` unset instead collapses `rangeValid`,
and with it the preview and the `Reabrir` button, in the middle of a selection.

**Why the excluded cells are not re-derived in the screen** — the server skips Saturday and Sunday unless
the whole range is a weekend. A span drawn Monday to Sunday as seven cells promises seven days of a write
that makes five.

**Why one error slot is still needed** — `localError` is drawn nowhere but in a `Field`'s `error=`. Two
fields became one, so the range's `Field` takes `errorFor('date') ?? errorFor('endDate')`; without it
`Guardar` would write nothing and say nothing when the server answers 400 `invalid-range`, which two clicks
reach at `MAX_ABSENCE_DAYS` (120). Ordered ends make `errors.rangeBackwards` unreachable from the calendar.

**Why the week label is not under this field** — that line already carries the day count, and the count is
the days the preview says will be written, not the cells of the span.

---
```

- [ ] **Step 4: Run the suite and watch the pointers fail**

Run: `npx vitest run src/lib/docs.test.ts`
Expected: FAIL — two tests. `every pointer resolves › names a heading that exists` reports
`[ 'docs/DECISIONS.md → The Hour Is Typed', 'docs/DECISIONS.md → The Day Is Picked From a Month', 'docs/DECISIONS.md → The Hour Is Typed', 'docs/DECISIONS.md → The Absences Screen' ]` for the headings SPEC does not have yet, and `docs/SPEC.md describes the screen that exists` still fails on `DateSelect`.

- [ ] **Step 5: Replace the Visual Design bullet in SPEC**

In `docs/SPEC.md`, replace lines 1000-1005 VERBATIM:

```md
- **No native `<input type="time">` or `<input type="date">` anywhere.** Both render in the
  BROWSER's locale, not the page's. Every time and every day goes through `useFormat()`:
  - times from the quarter-hour `TimeSelect`, whose step is held equal to `SNAP_MINUTES` by a test;
  - days from `DateSelect`, which offers the days of the schedule, spelled "Mié 12 ago" and grouped
    under the header's week label. Its window runs a few weeks back to the end of the planning
    horizon, and the day already stored is **always** an option even when it falls outside.
```

with:

```md
- **No native `<input type="time">` or `<input type="date">` anywhere.** Both render in the
  BROWSER's locale, not the page's. Every time and every day goes through `useFormat()`:
  - times are TYPED into `TimeField`, an `HH:mm` field with `−`/`+` beside it, whose quarter-hour step
    is held equal to `SNAP_MINUTES` by a test — see *The Hour Is Typed*;
  - days are chosen on `DayPicker`'s month grid, the day itself spelled "Mié 12 ago" on the button
    that opens it — see *The Day Is Picked From a Month, Never From a List*.
```

- [ ] **Step 6: Add the two new subsections to SPEC**

In `docs/SPEC.md`, insert the following after the blank line that closed the Visual Design list (line 1006) and before `### Calendar View`:

```md
#### The Day Is Picked From a Month, Never From a List
> **A day is chosen on `DayPicker`: a button carrying the day it already holds — `Mié 12 ago` — that
> opens a month grid in a popover. Six rows of seven, ALWAYS six, Monday first, `‹ ›` to change month,
> and a `Hoy` that CHOOSES today and closes like any other cell. The form is told on the click.**

- **One line under the field, never two**: `miércoles 12 de agosto · Semana 33`, joined with
  `units.listSeparator`. The list this replaces grouped its days under the very week label the header
  carries, so a form and the grid could not name one day two ways; `units.week` keeps that number
  without the date range the long date already spells out. `Field` shows the error in its place when
  there is one, so the line goes away exactly when a date is being refused.
- **How far it reaches is `planningWindow`, unchanged**: four weeks back from this week's Monday, the
  planning horizon forward, capped at 16 weeks. `‹ ›` go grey at that window's edges.
- **A month always overhangs the window, and the overhanging days are dimmed and cannot be pressed.**
  The window falls mid-month — for a today of 2026-08-12 on an 8-week horizon it is
  `2026-07-13 … 2026-10-04`, so July shows twelve days it does not offer. Pressed, they would earn a
  409 `horizon-exceeded` forward, and backward a job's start date writing padlocked rows in the past.
- **The day already stored is always pressable, even outside the window**: the popover opens in its
  month, that one cell can be chosen, the rest of that month cannot.
- **Six marks, no more, and every one of them can be chosen.** No mark disables a cell.

  | day | drawn as | known from |
  |---|---|---|
  | the chosen one | the cell filled | the value itself |
  | today | a ring around the number | `today`, which already reaches all three panels |
  | Saturday and Sunday | the number dimmed | the weekday, on the client |
  | past | the number dimmed, the same as the weekend | `compareDates(date, today) < 0`, on the client |
  | closed | the cell's BACKGROUND in `--ww-surface-alt`, the grid's own closed grey | the server |
  | room left | a dot under the number | the server |

  **Two channels and not three**: the NUMBER dims where the calendar itself puts no work — the weekend,
  the past — and the BACKGROUND greys where the owner closed the shop. A closed Saturday carries both,
  which is the truth. No hatch, and no legend.
- **The dot says one thing: the engine still places hours here.** Its absence claims nothing.
  `freeMinutes` is the day's plannable minutes less the movable blocks already on it; `hasRoom` also
  requires the day's longest free stretch to hold `MIN_ROW_MINUTES` and the day to fall inside the
  horizon.
- **Hovering a cell says what that day has to say**, composed with `units.listSeparator` exactly as a
  day header composes its own: the day, then `hoy`, the weekend, the stored reason or *cerrado*, and
  either the hours still free or *Día completo*.
- **The keyboard**: arrows move the focused cell, `Inicio`/`Fin` to the ends of its week,
  `PáginaArriba`/`PáginaAbajo` a month, `Intro` chooses, `Escape` closes and gives the focus back to the
  button. Opening puts the focus on the selected cell, and the picker SWALLOWS the arrow keys it uses,
  so the header's week pager cannot turn the week under an open calendar.
- **The popover is portalled to `document.body`**, fixed to the viewport and clipped there, at
  `--ww-z-popover` (45) — over the panel it belongs to, under a confirmation. The grid clips its own
  overflow and a week change applies a `transform`, which would contain anything `fixed` inside it for
  the 180 ms it lasts.
- **`Escape` and the press that dismisses it are SWALLOWED**, both on `window` in the capture phase.
  Otherwise the same `Escape` closes the panel underneath, and the dismissing press falls through to the
  column and starts painting a band. Leaving by `Tab` fires no pointer event at all, so a `focusout` on
  the box closes it too.

#### The Hour Is Typed
> **An hour is TYPED into `TimeField`, an `HH:mm` field. What is typed takes effect on `Intro` or on
> leaving the field; `−`/`+` and `↑`/`↓` take effect at once, a quarter of an hour at a time and an hour
> with `Mayús`. Typing is tolerant — `8` is `08:00`, `830` and `8:30` are `08:30`.**

- **It draws its own string**, never the result of `format.time`: passing every keystroke through
  parse-then-format rewrites `8:00` to `08:00` under the cursor, and `formatTime` answers a value it
  cannot read with `--:--`. `format.time` is used only where the value starts as minutes — the initial
  value, and what the buttons and the arrows produce.
- **Only a value that actually CHANGED is snapped to the quarter**, compared against what the field held
  when it took the focus, so a hand-stored `08:10` survives being tabbed over.
- **What cannot be read is LEFT ON SCREEN**, with the invalid ring and `errors.invalidTimeFormat`. Never
  replaced, never cleared.
- **The ceiling is `23:45`**, the last quarter of the day: `hhmmToMinutes` reads `24:00` as 1440, and the
  band then stops being drawn while the field still looks legal.
- **Bounds REFUSE in the open and never clamp.** The one field that carries them is the hour a day is
  closed at, bounded by the work periods; out of them it is refused with `errors.timeOutOfBounds`, which
  names the two hours it has to be between.
- **`Escape` inside the field closes the panel**, as it already does inside the name `Input`. There is
  nothing to revert.

```

- [ ] **Step 7: Correct the quarter-hour rule in SPEC**

In `docs/SPEC.md`, replace lines 578-580 VERBATIM:

```md
> **A quarter of an hour is the smallest row the calendar can draw and the smallest amount the owner
> can aim at. `MIN_ROW_MINUTES` (src/lib/validation.ts) is held equal to the drag layer's
> `SNAP_MINUTES` and to the `TimeSelect` step by a test.**
```

with:

```md
> **A quarter of an hour is the smallest row the calendar can draw and the smallest amount the owner
> can aim at. `MIN_ROW_MINUTES` (src/lib/validation.ts), the drag layer's `SNAP_MINUTES` and
> `TIME_STEP_MINUTES` — the step a typed hour moves by — are held equal by a test.**
```

- [ ] **Step 8: Add the Calendar View bullet that pins the shared source**

In `docs/SPEC.md`, insert this bullet after line 1052 (the end of the **Day headers** bullet, `only thing it cannot.`) and before `- **Summary strip** above the grid, amber-tinted:`:

```md
- **The day picker's month is fed from the same rows this week is**: `GET /api/days?from=&to=`, whose
  `readDays` sits beside `readWeek` and reads the same `listDayOverridesBetween` and the same snapshot's
  `getDayConfig`. So a closed cell wears the column's own grey and prints the column's own reason, and
  the two cannot disagree. One request covers the whole navigable window, capped at `MAX_DAY_MARK_DAYS`
  (200), and it reloads on the same counter the week does, because a recomposition rewrites rows in
  weeks no response mentions.
```

- [ ] **Step 9: Rewrite the absences rule and add the range bullets**

In `docs/SPEC.md`, replace line 1415 VERBATIM:

```md
> **Un hueco** / **Cerrar días**. Both modes share `Desde` / `Hasta` and a reason, so there is one
```

with:

```md
> **Un hueco** / **Cerrar días**. Both modes share ONE range calendar and a reason, so there is one
```

Then insert these four bullets after line 1429 (`` `MAX_ABSENCE_DAYS` (120) or running backwards is 400 `invalid-range` on `to`. ``) and before `- **In `gap` mode a range writes the SAME absence on each day**`:

```md
- **The range is chosen in ONE calendar, in two clicks.** The first click is remembered inside the
  popover and tells the form nothing; the second closes it and hands over both ends at once, always
  ordered. A first click that wrote `Desde` on its own would fire the preview — a real write inside a
  rolled-back transaction — on every step across the month, announcing displaced work for a range half
  chosen.
- **The weekend cells INSIDE the span are drawn excluded**, by the same `absenceRange` the write uses
  and never re-derived in the screen: a span drawn Monday to Sunday as seven cells would promise seven
  days of a write that makes five.
- **One error slot, and it is the range's**: the field takes `errorFor('date') ?? errorFor('endDate')`,
  and `API_FIELD` keeps mapping `from → date` and `to → endDate`. Both ends come out ordered, so
  `errors.rangeBackwards` cannot be reached from the calendar; the slot is what shows the 400
  `invalid-range` that two clicks CAN reach.
- **The day count stays under the field** — the days the preview says will be WRITTEN, not the cells of
  the span — so the range is the one day field with no week label. While the second end is missing the
  popover says so itself (`dayPicker.rangePending`), never the form.
```

- [ ] **Step 10: Add the Settings bullet**

In `docs/SPEC.md`, insert this bullet after line 1600 (`Work periods, auto-fill capacity, visual margins, planning horizon, gap colour, language.`) and before `- **A change that narrows the day asks first**`:

```md
- **The four schedule rows are TYPED** `HH:mm` fields — see *The Hour Is Typed* — and the one line
  saying they can be nudged with `↑`/`↓` is the field's `title`, not a line of help under each: the rows
  are inline, and four copies of it would add four rows to this screen.
```

- [ ] **Step 11: Keep the optimistic date true of the new control**

In `docs/SPEC.md`, replace lines 1516-1517 VERBATIM:

```md
- **The date is set OPTIMISTICALLY** and the notice appears after: the band has to follow the field, and
  a field frozen behind a question would freeze the band mid-edit.
```

with:

```md
- **The date is set OPTIMISTICALLY** and the notice appears after: the band has to follow the field, and
  a field frozen behind a question would freeze the band mid-edit. The month grid keeps that true by
  telling the form on the CLICK rather than when the popover closes; the range calendar is outside this
  rule, because painting only ever opens the form for ONE absence.
```

- [ ] **Step 12: Run the test and watch it pass**

Run: `npx vitest run src/lib/docs.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/docs.test.ts docs/SPEC.md docs/DECISIONS.md
git commit -m "docs(pickers): specify the month calendar and the typed hour"
```

---

### Task 22: The version and the changelog

**Files:**
- Modify: `src/lib/docs.test.ts:145` (a new `it` inside `describe('CHANGELOG.md answers for the version that is shipping')`)
- Modify: `package.json:3`, `desktop/package.json:3`
- Modify: `package-lock.json:3,9`, `desktop/package-lock.json:3,9`
- Modify: `CHANGELOG.md:10-11` (insert the new entry above `## 0.21.1`)
- Test: `src/lib/docs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `0.22.0` as the shipping version in `package.json`, `desktop/package.json`, both lockfiles and the top CHANGELOG heading.

- [ ] **Step 1: Write the failing test**

Insert this `it` into `src/lib/docs.test.ts` inside `describe('CHANGELOG.md answers for the version that is shipping', …)`, after the `it('keeps the desktop package on the same version', …)` block and before `it('lists its versions newest first', …)`:

```ts
  it('keeps both lockfiles on that version too', () => {
    // `npm install` writes the manifest's version into the lockfile in two places, and the installer
    // workflow keys its cache on those files. Left behind, the lockfile answers a version the app has
    // not been for three releases.
    for (const [manifest, lock] of [
      ['package.json', 'package-lock.json'],
      ['desktop/package.json', 'desktop/package-lock.json'],
    ]) {
      const { version } = JSON.parse(read(manifest)) as { version: string };
      const locked = JSON.parse(read(lock)) as {
        version: string;
        packages: Record<string, { version?: string }>;
      };
      expect([locked.version, locked.packages[''].version]).toEqual([version, version]);
    }
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/docs.test.ts -t 'keeps both lockfiles on that version too'`
Expected: FAIL — `expected [ '0.20.1', '0.20.1' ] to deeply equal [ '0.21.1', '0.21.1' ]`. `package-lock.json` still says `0.20.1` and `desktop/package-lock.json` says `0.19.1`, while both manifests say `0.21.1`.

- [ ] **Step 3: Bump the two manifests to 0.22.0**

`package.json:3` and `desktop/package.json:3`, both from `"version": "0.21.1",` to:

```json
  "version": "0.22.0",
```

- [ ] **Step 4: Bump both lockfiles to 0.22.0**

`package-lock.json` line 3 (`"version": "0.20.1",`) and line 9 (`      "version": "0.20.1",`), and `desktop/package-lock.json` line 3 (`"version": "0.19.1",`) and line 9 (`      "version": "0.19.1",`), all four to `0.22.0`:

```json
  "version": "0.22.0",
```

- [ ] **Step 5: Run the suite and watch the changelog fail**

Run: `npx vitest run src/lib/docs.test.ts`
Expected: FAIL — one test only. The lockfile assertion now passes; `CHANGELOG.md answers for the version that is shipping › has an entry for the version in package.json` fails with `expected false to be true`, because the newest heading is `0.21.1` and `package.json` says `0.22.0`.

- [ ] **Step 6: Write the CHANGELOG entry**

In `CHANGELOG.md`, insert this entry after the `---` on line 10 and before `## 0.21.1 — the week arrows are easier to hit`:

```md
## 0.22.0 — the day comes from a calendar, the hour is typed

**Choosing a day is a calendar now, not a list.** Every form that asks for one — a new job, the scissors,
an absence — shows the day it holds on a button, and pressing it opens the month: six rows of seven,
Monday first, arrows either side to change month, and a `Hoy` that picks today and closes. The list it
replaces ran to well over a hundred days one after another.

**The month says what it knows about each day.** Today wears a ring; Saturday, Sunday and anything past
are dimmed; a closed day carries the same grey the grid gives its column and, under the mouse, the reason
written on it; and a day the shop can still take work on carries a dot — hover it for the hours still
free. Every one of them can still be chosen, so a closed day picked on purpose is honoured exactly as it
was before.

**The days a form cannot reach now look unreachable.** They are drawn faint and will not take a press,
instead of accepting one and coming back with a refusal after Guardar.

**Under the field the day is spelled out in full**: `miércoles 12 de agosto · Semana 33`. The old list
grouped its days by week, and this is what keeps a form and the calendar calling one day by one name.

**An absence over several days is one calendar.** `Desde` and `Hasta` were two fields; they are one range
picked in two clicks, and the Saturdays and Sundays the save is going to skip are drawn as skipped before
it is pressed. The count of days that will really be written stays under the field.

**Every hour is typed.** `08:00` straight into the field, `Intro` or leaving it to make it count, `−`/`+`
and `↑`/`↓` to move a quarter of an hour and `Mayús` a whole one — the four schedule rows in
Configuración included. Nothing is corrected behind your back: an hour that cannot be read stays on
screen and says so, and an hour outside the working day is refused naming the two hours it has to be
between.

**The placeholders say what to write.** The name of a job, the reason for a gap and the note on a closed
day used to show an example — `Puerta metálica`, `Avería del torno`, `Feria` — which reads like a value
already filled in. They now say what the field is for.

---
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `npx vitest run src/lib/docs.test.ts`
Expected: PASS

- [ ] **Step 8: Run the four gates**

Run: `npx tsc --noEmit && npm test && npx eslint . && npm run build`
Expected: PASS — all four green, `npm test` reporting 0 failures.

- [ ] **Step 9: Commit**

```bash
git add src/lib/docs.test.ts package.json desktop/package.json package-lock.json desktop/package-lock.json CHANGELOG.md
git commit -m "chore: bump the version to 0.22.0 and log the release"
```

### Task 23: A single absence saves one day, whichever way its day moved

> **Found while planning, not asked for.** This is a defect that exists on `dev` today, in the exact
> `onChange` Task 19 rewrites. It is its own task so it can be dropped without touching anything else —
> but if it is dropped, Task 19 must leave the `compareDates` line exactly as it found it.

**The defect.** In the single-absence shape — a painted band, or `Ausencias` opened with no range — `submit`
sends `saveAbsence({ from: date, to: endDate })` (`src/components/jobs/AbsencePanel.tsx:373-375`), and the
day field only ever drags `endDate` **forward**:

```tsx
// "Hasta" follows the day it can no longer precede, so the range is never
// inverted by moving its start.
if (compareDates(endDate, next) < 0) setEndDate(next);
```

Open the panel on Wednesday and move the day back to Monday: `endDate` stays on Wednesday, and Guardar
writes a **three-day** absence (Mon, Tue, Wed) instead of one. The forward guard is right in the
`Desde`/`Hasta` range shape, where inverting the range is the failure it prevents — but after Task 20 that
shape has no day field of its own, so the only remaining reader of this line is the single-day one, where
`endDate` means nothing except "the same day".

**Files:**
- Modify: `src/components/jobs/AbsencePanel.tsx` — the non-bulk `DayPicker`'s `onChange` (the block Task 19
  leaves at what is line 576-583 on `dev` today)

**Interfaces:**
- Consumes: `DayPicker` with `onChange: (value: string) => void` as Task 19 wires it; `setDate`, `setEndDate`
  and `setLastVisible` from the panel's own state
- Produces: no signature. One behaviour: in the single-absence shape `date` and `endDate` are always the
  same day.

- [ ] **Step 1: Reproduce it in the app, before changing anything**

There is no automated route to this: the panel is a client component, tests are `src/**/*.test.ts` in Node
with no DOM, and nothing in this repository is ever rendered in a test. So the red is manual, and it is
worth doing because it is the only proof the fix works.

```bash
WORKWISE_DB_PATH=/tmp/workwise-task23.db npm run dev
```

Paint a band on **Wednesday** of the week on screen, so the absence form opens with that day. Move the day
field back to **Monday**. Press `Guardar`. Expected today: the toast reads `Se han creado 3 huecos` and the
grid draws a gap on Monday, Tuesday **and** Wednesday. That is the defect.

- [ ] **Step 2: Make the two ends move together**

In `src/components/jobs/AbsencePanel.tsx`, the non-bulk day field's `onChange` becomes:

```tsx
                  onChange={(next) => {
                    // Set OPTIMISTICALLY: a painted band on the grid has to follow the field.
                    if (visibleDates?.includes(date) === true) setLastVisible(date);
                    setDate(next);
                    // One absence is ONE day: `submit` sends `to: endDate`, so an end left behind a day
                    // that moved BACKWARDS saved three days for a band drawn on one.
                    setEndDate(next);
                  }}
```

- [ ] **Step 3: Check `compareDates` is still used, or drop the import**

Run: `npx eslint src/components/jobs/AbsencePanel.tsx`
Expected: PASS. `compareDates` is still read by `rangeValid` (`src/components/jobs/AbsencePanel.tsx:252`),
so the import stays. If eslint reports it unused, the range field of Task 20 has been dropped too and the
import goes with it.

- [ ] **Step 4: Confirm the fix in the app**

Repeat Step 1 exactly. Expected now: the toast reads `Se ha creado 1 hueco` and the gap is on Monday alone.
Then repeat it moving the day **forwards** (Wednesday → Friday) and confirm it is still one day, on Friday —
that is the direction the old guard already handled, and it must not have changed.

- [ ] **Step 5: Run the four gates**

Run: `npx tsc --noEmit && npm test && npx eslint . && npm run build`
Expected: all four pass, and `npm test` still reports the count the previous task left.

- [ ] **Step 6: Commit**

```bash
git add src/components/jobs/AbsencePanel.tsx
git commit -m "fix(absences): keep one absence on one day when its day moves back"
```
