# Public holidays close the shop by themselves

**Status**: design, approved in conversation 2026-08-25. Not built.

> **The shop's own municipality is configured in Settings. Every public holiday it has — national,
> Andalusian and the two local ones — becomes a CLOSED DAY, written by the app, named after the
> holiday. A holiday with work on it ASKS before it moves anything.**

When this ships, the behaviour below moves into `docs/SPEC.md` and its reasoning into
`docs/DECISIONS.md`, per the repository's four-document agreement. This file is the working design and
stops being the reference the moment the code exists.

---

## 1. Why a closed day and not a full-day gap

A holiday is the shop being shut, which is what `day_overrides.is_closed` already means: the engine
plans nothing, the column is dimmed, the day header prints the reason (`Mar 8 · Inmaculada
Concepción`), and a hand gesture still lands there and padlocks — the weekend's own behaviour.

The alternative, a 12 h gap per holiday, would be two hatched rows per day, 28 rows a year, drawn as
occupancy the shop never has. Rejected in conversation on 2026-08-25.

---

## 2. Where the dates come from

Both sources were measured on 2026-08-25. The numbers below are from the real responses, not from
their documentation.

### 2.1 The dates: Junta de Andalucía open data (the source of truth)

`https://datos.juntadeandalucia.es/api/v0/work-calendar/all?format=json`

- Consejería de Empleo, Empresa y Trabajo Autónomo. **CC BY 4.0.** No key, no registration.
- **It answers 302** to `https://www.juntadeandalucia.es/ssdigitales/festa/download-pro/dataset-work-calendar.json`.
  The fetch must follow redirects; `curl` without `-L` gets a 145-byte nginx page.
- **1.4 MB, 5,856 rows, years 2023-2027.** `?year=`, `?municipality=` and `?province=` are **ignored**
  — every request returns the whole file. There is no way to ask for one municipality.
- Row shape:
  ```json
  {"id":"20269176","dateformat":"2026-09-03T00:00:00Z","event":"VEVENT","date":20260903,
   "description":"FIESTA LOCAL EN PRIEGO DE CÓRDOBA (CÓRDOBA)",
   "municipality":"PRIEGO DE CÓRDOBA","province":"CÓRDOBA","year":"2026","type":"LOCAL"}
  ```
- `type` is `LABORAL` (12 rows a year, the whole of Andalucía, **named**: `AÑO NUEVO`,
  `DÍA DE ANDALUCÍA`, `JUEVES SANTO`, `FIESTA NACIONAL DE ESPAÑA`…) or `LOCAL` (per municipality,
  **774 of them in 2026**, description always the generic `FIESTA LOCAL EN <municipio> (<provincia>)`).
- `municipality` is upper case with accents and there is **no INE code** on the row.

### 2.2 The name of a local holiday: festivos.io (decoration only)

`https://festivos.io/v1/{year}/municipio/{ine}.json`

- **CC BY 4.0**, no key, 5.3 KB per municipality-year, and its own `source.ref` on the Andalusian
  local rows reads *"Junta de Andalucía — Calendario de fiestas locales (datos abiertos)"*: it is a
  naming layer over the same official data, not a second opinion about the dates.
- It supplies `name.es` at every level, properly cased, which the official dataset does not:
  `2026-09-03` → **"Feria Real de Priego de Córdoba"**.
- **It has no 2027 at all** — `/v1/2027/municipio/14055.json`, `/v1/2027/ccaa/ES-AN.json` and
  `/v1/2027/nacional.json` all answer 404 — while the Junta already carries the 12 Andalusian days of
  2027 (Decreto 84/2026, BOJA of 5 May 2026). This is why it names and does not date.

### 2.3 The horizon is the source's, not ours

Local holidays for year N are published in the **October of N-1** (2026's were the *Resolución de 6 de
octubre de 2025*); each town hall has two months from the regional decree to declare its two days.

**So the app can never know more than about fifteen months ahead, and usually less.** On 2026-08-25 it
would know: every holiday to 31/12/2026, plus the 12 Andalusian days of 2027, and not Priego's two
local days of 2027. *"How far ahead do we write?"* therefore needs no invented number — **the app
writes every holiday it knows, from today onwards**, and Settings says how far that reaches.

Priego de Córdoba's local days, as the dataset gives them, move every year: 2025 → 19 June and
4 September; 2026 → 4 June and 3 September.

---

## 3. Settings

A new `Festivos` section:

| control | default | notes |
|---|---|---|
| `holidaysEnabled` | ON | Switching it OFF stops future writes. **It removes nothing already written** — those are closed days like any other. |
| `holidaysMunicipality` | `14055` — Priego de Córdoba | An INE code. The picker lists the municipalities of Andalucía only. |

Below them, one line of state and one button: *«Priego de Córdoba · 14 festivos · hasta el 31/12/2026
· consultado el 25/08»* and **Consultar ahora**. With no successful check yet: *«no he podido
consultar los festivos — último intento el …»*.

The attribution both licences require goes here, not in a corner: *Datos: Junta de Andalucía y
festivos.io (CC BY 4.0)*.

**The municipality list ships with the app** (`src/lib/holidays/municipalities.ts`, generated once and
checked in): `{ ine, name, province }` for every Andalusian municipality, so the picker works with no
network. Two consumers, two different keys:

- the **Junta** dataset is matched by `municipality` + `province`, upper-cased and accent-exact;
- **festivos.io** is asked by `ine`.

A municipality whose INE code cannot be resolved simply gets no pretty name — see §5.

Changing the municipality is covered in §7.

---

## 4. What is stored

One new table, and nothing added to an existing one:

```sql
CREATE TABLE IF NOT EXISTS holidays (
  date         TEXT PRIMARY KEY,   -- local YYYY-MM-DD
  name         TEXT NOT NULL,      -- what the day header will print
  level        TEXT NOT NULL,      -- 'national' | 'regional' | 'local'
  municipality TEXT NOT NULL,      -- the INE code it was fetched for
  fetched_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

It is **the cache of the last successful check**, and it is what lets Settings answer *what is loaded
and how far it reaches* without a network call, what lets the app work offline, and what lets a change
of municipality know which closed days were its own (§7).

`name` carries a second job that is easy to lose in a refactor: it is **the app's record of what it
last wrote on that day**, and comparing it against the day's note is the whole of §6.1. Replacing the
cache before that comparison is made destroys the only evidence of who owns the day.

Plus one settings key, `holidaysCheckedAt`, because a **failed** check leaves no row and must still
stop the app retrying on every open.

**No column is added to `day_overrides` and no mark is put on any row of the calendar.** A holiday
that has been written is an ordinary closed day from that moment on.

---

## 5. Composing a holiday

For each year from the current one to the last the Junta dataset carries:

1. Take the `LABORAL` rows (all of Andalucía) and the `LOCAL` rows whose `municipality` + `province`
   match the configured town. This is the list of dates, and it is authoritative.
2. Ask festivos.io for that municipality and year. Where a date matches, take `name.es`.
3. Where it does not — a year festivos.io has not published, a request that failed, an INE code that
   could not be resolved — fall back:
   - `LABORAL` → a fixed table in the repository mapping the dataset's upper-case strings to proper
     Spanish (`AÑO NUEVO` → `Año Nuevo`, `INMACULADA CONCEPCIÓN` → `Inmaculada Concepción`). There are
     about fifteen distinct strings across all years; a written table is reviewable and an
     upper-case-to-title algorithm for Spanish is not.
   - `LOCAL` → **`Fiesta local`**. The owner renames it by pressing the dimmed column, which already
     opens `Cerrar días` on that day with its note pre-filled.
4. Step 2 failing is never a failure of the check. The dates are what matter; the name is decoration.

**A fallback name is provisional, not final.** For a local holiday it is the *expected* first state,
because the date is published months before anyone names it — see §6.1, where a later check replaces
it.

---

## 6. The pass

**When.** Once when the app is opened, and at most **once every 7 days** — the shape
`takeAutomaticBackup` already uses: elapsed time and not a schedule, so a fortnight away owes one
check, not two. Not configurable; holidays move once a year and *Consultar ahora* covers the hurry.
The check is skipped entirely while `holidaysEnabled` is OFF.

**What it writes.** Every holiday in the cache that is **on or after today** and for which
`day_overrides` holds **no row at all** — closed or not, written by the app or by the owner.

**Split by whether anything is in the way**, which is the whole of the owner's answer on 2026-08-25:

- **A holiday with nothing on that day is closed silently.** No question, no notice; it is the boring
  majority of them.
- **A holiday with work on that day opens the panel** in §6.2 and nothing is written for it until the
  panel is answered.

**One transaction.** The silent days and the answered days are written together with one reflow at the
end, so the hours are displaced by one pass and reported once, and any refusal rolls the whole thing
back. It goes through `withHistory` like every other write, so `Ctrl+Z` undoes it.

It reuses `writeAbsence`'s per-day machinery (`kind: 'closed-days'`) but **is handed an explicit list
of dates, never a `from`/`to` range**: `resolveRange` goes through `absenceRange`, which drops
Saturdays and Sundays, and this pass writes them. The one change that buys it is letting the internal
write take the dates it was given instead of deriving them — the public `POST /api/absences` keeps the
range it has.

**Never before today.** Running the pass twice changes nothing.

### 6.1 What it maintains, and what it must never touch

> **The app keeps only what it wrote and nobody has touched since. A future day whose note still reads
> EXACTLY what the app last wrote there is the app's to correct. The moment the owner edits that note,
> closes the day themselves, or reopens it, the day is theirs and the app never writes on it again.**

The test is a string comparison between `day_overrides.note` and the `name` the `holidays` cache holds
for that date — which is why the cache must be read **before** it is replaced. Three cases fall out of
the one rule, and none of them needs a mark on the calendar:

- **The name arrives late, which is the normal case and not an edge one.** A local holiday is
  published by the Junta in the October before its year, and festivos.io — a naming layer over that
  same data — catches up weeks later. So a 2027 local day is first written as `Fiesta local` and
  **renamed to `Feria Real de Priego de Córdoba` by a later check**, silently: no work moves, no hours
  shift, a label simply gets better. Without this the generic name would be permanent, since the
  pretty one never exists on the day the date does.

  **A rename EDITS the day. It never reopens it and writes it again.** One `UPDATE` of
  `day_overrides.note`, no reflow, no preview, nothing else on the row altered — `is_closed` and
  `capacity_hours` included. Reopening and rewriting would land on the same date with the same state
  and look identical afterwards, while in between it releases the day, runs a pass that shuffles the
  queue, and asks again about work whose *displace or keep* answer was already given and paid for. A
  better label must not be able to move a single hour.
- **A date is corrected.** A cached date that is no longer a holiday, is still in the future, and is
  still closed with the app's own note is **reopened**, and the new date is written. A town moving its
  local holiday therefore does not leave a phantom closed day behind.
- **A change of municipality** is the same operation with the whole cache invalidated at once (§7).

**Everything else is left exactly as it stands**: a day the owner closed by hand, a day whose note they
rewrote, a `capacity_hours` they entered, and any date before today.

### 6.2 The panel: displace, or keep it here

One panel at app open, listing every holiday that has work on it, one line each:

```
3 sep · Feria Real de Priego de Córdoba
   6 h de Barandilla                        ( • ) Desplazar    (   ) Mantener aquí
8 dic · Inmaculada Concepción
   4 h de Escalera (fijada)                 el día se cierra con el trabajo donde está
```

- **`Desplazar` is the default** and is what happens today: the day closes, the reflow carries the
  work forward, and the panel names where it lands — `previewAbsence` already computes exactly that
  (`displaced`, `lastOccupiedAfter`).
- **`Mantener aquí` padlocks the work on that day** and then closes the day around it. The padlock is
  the only thing that can hold a row on a day the engine plans nothing on, so keeping it and padlocking
  it are one act, not two.
- **Work that is ALREADY padlocked is not asked about.** `Desplazar` would have to clear a padlock,
  and *the padlock is cleared by the padlock and nothing else*. The line states what will happen
  instead of offering a choice. **This resolves an ambiguity in the owner's answer and is the first
  thing to check in review.**
- **Closing the panel without answering writes nothing for those days.** They are asked about again on
  the next check. The silent days of the same pass are still written.
- The panel needs one thing the preview does not return yet: **which rows sit on each day of the
  range**, per day, so a line can name them. `AbsencePreview` gains that.

---

## 7. Changing the municipality

The owner's answer, 2026-08-25: the old town's holidays go.

It is §6.1's rule with the whole cache invalidated at once, not a mechanism of its own. On a save that
changes `holidaysMunicipality`, in one transaction: every **future** cached date **still carrying the
app's own note** is reopened through the existing `reopenDays` path, the cache is emptied, and a check
for the new town runs immediately.

So a day the owner closed by hand survives, because it was never in the cache, and so does one whose
note they rewrote — they claimed it, and a change of town does not unclaim it.

A holiday of the old town that is also a holiday of the new one is reopened and written again with the
new town's name for it, in the same transaction, so nothing flickers on the calendar.

---

## 8. The rule this changes, and it is not a small one

> **Closing a day no longer refuses because work sits on it. It asks.**

Today `assertDayCanClose` throws 409 `closed-day-over-fixed-block` whenever `findGapConflicts` finds a
row the engine cannot move — `locked`, `weekend` or `past` — and the range rolls back. The owner chose
option (a) on 2026-08-25: **the refusal goes from both places**, the automatic pass and the manual
`Cerrar días` screen, so that one situation does not have two answers depending on which door you came
through.

What replaces it:

| what is on the day | before | after |
|---|---|---|
| nothing | closes | closes |
| work the engine can move | closes, work displaced silently | **asks**: displace, or keep it here and padlock it |
| work with a padlock | **409, whole range rolled back** | closes around it; the panel says so |
| work on a weekend day | **409** | closes around it; the panel says so |
| work in the PAST | 409 | **409, unchanged** — the past is frozen and stays frozen |

The justification, which belongs in DECISIONS.md when this ships: a closed day *is* a weekend to the
engine, and a weekend has always held padlocked work without complaint. The refusal existed because
nothing could be asked at the moment of closing, not because the state was wrong. Now something can.

`Cerrar días` gains the same panel, fed by the same preview.

---

## 9. When it cannot do it

None of these may take the app down or block the rest of the pass.

| | what happens |
|---|---|
| No internet, or the source is down | Nothing is written. `holidaysCheckedAt` moves anyway, so it retries in 7 days rather than on every open. Settings says when the last attempt was. The cache stays and is still what Settings reports. |
| festivos.io down or missing the year | The dates are written with the fallback names of §5. Not an error. |
| The reflow of one day would bust the planning horizon | That day is skipped and named; the rest of the pass is written. `horizon-exceeded` must not cost the other thirteen holidays. |
| A malformed or truncated response | Discarded whole. A partial holiday list is worse than none: it would close some days and leave others open with no way to tell which. |

---

## 10. The known defect, recorded on purpose

**Reopen a holiday and the next check will write it again.** The owner chose the simplest behaviour
available on 2026-08-25, knowing this: *"posible bug donde el usuario sí que quiere mantenerlo
eliminado, dejarlo reflejado como decisión pendiente"*.

It goes into `DECISIONS.md` → *Open Decisions* → **STILL OPEN**, worded as the failure and not as a
feature request: *the owner reopens an automatic holiday because the shop is working that day, and the
next check closes it again; the app has no way to tell that reopening from a day that was never
written.* The `holidays` table is where the answer will live when it is wanted — a column saying the
day was dismissed — so the fix stays cheap.

**The asymmetry with §6.1 is deliberate and worth stating**, because it looks like an oversight and is
not: an edited note is evidence that survives — the row is still there and it no longer matches — so
the app can see the day was claimed and back off. A reopened day leaves no evidence at all; the row is
gone, and *never written* and *written and undone* are the same picture. Respecting one and not the
other is the difference between what can be known and what cannot.

---

## 11. Out of scope

- **Anywhere outside Andalucía.** Spain has seventeen regional calendars and 8,132 municipalities, and
  the official Andalusian dataset covers none of the rest. A move would be a new source and a new
  decision.
- **Recurring closures of the owner's own** — the Feria week, holidays, *asado con los pibes*. Those
  are absences and already have a screen.
- **Half days.** A holiday is a whole day. `capacity_hours` still has no screen.
- **Holidays before today.** The engine never writes behind today and neither does this.
- A holiday falling on a Saturday or a Sunday **is** written, on the owner's instruction. It changes
  nothing for the engine — the header simply names the day.

---

## 12. Testing

- `absenceRange` **is not the right tool here** and must not be reached for: it drops weekends, and
  this writes them. The pass walks the cache, not a range.
- Parsing: a Junta row into a holiday; the `LOCAL`/`LABORAL` split; the municipality match with
  accents; a truncated body discarded whole.
- Composition: festivos.io present, absent, and returning a year it does not have; the upper-case name
  table.
- The pass: idempotent over two runs; skips the past; writes a weekend holiday; one transaction with
  one reflow; a horizon failure on one day sparing the others.
- **What it maintains (§6.1), which is where a careless change will do damage.** A `Fiesta local`
  written by an earlier check is renamed when the name arrives; a note the owner rewrote is NOT; a day
  the owner closed by hand is NOT; a cached date that stops being a holiday is reopened, but only
  while it still carries the app's own note; nothing before today moves in any of those cases. The
  comparison must read the cache **before** it is replaced — a test that replaces first will pass
  while renaming everything the owner ever typed.
- **A rename moves no hours.** Assert it over a day carrying padlocked work and a day carrying work
  that was displaced: after the rename the blocks are byte-for-byte where they were, `is_closed` is
  untouched, and no history step is recorded beyond the note. A rename implemented as reopen-and-
  rewrite passes a naive *"the day is closed and named right"* assertion and fails this one.
- The panel: displace, keep-and-padlock, unanswered, and a day whose work is already padlocked.
- `assertDayCanClose`: the past still refuses, the other three no longer do.
- Municipality change: the old town's future days reopen, hand-closed days survive, a shared date does
  not flicker.
- The fixtures week in `src/testing/fixtures.ts` gains whatever dates these need — **there and not
  locally**.
- **No test may open `data/calendar.db`**, and no test may reach the network: both sources are stubbed.

## 13. Files this touches

New: `src/lib/holidays/` (source, composition, the municipality list, the name table),
`src/lib/operations/holidays.ts`, `app/api/holidays/route.ts`, a Settings section.
Changed: `src/lib/migrations.ts` (the table), `src/lib/settings.ts` (two keys and a third for the
timestamp), `src/lib/operations/absences.ts` (`assertDayCanClose`, the per-day rows on the preview,
the keep-and-padlock answer), the absences screen, `src/lib/api-client.ts`, both locale files.

## 14. Shipping it

`0.21.1` → **`0.22.0`** in `package.json` and `desktop/package.json`, with its CHANGELOG entry written
as what is different to use. The four gates — `tsc`, `vitest`, `eslint`, `next build` — plus
`npx vitest run src/lib/docs.test.ts` after the SPEC and DECISIONS edits.
