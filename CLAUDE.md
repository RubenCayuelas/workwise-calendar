# Workwise Calendar

A work scheduling app for a small metalworking workshop. It answers one question: **how long is the
shop booked, and which days are free?** Work sits on a week grid as blocks, the engine lays them out in
queue order respecting capacity, padlocks and gaps, and the owner reorganises by dragging.

## The four documents, and which one you want

| | holds | when to open it |
|---|---|---|
| **CLAUDE.md** (this) | the working agreement: conventions, the data model, the invariants, and where to read | always loaded; start here |
| **[docs/SPEC.md](docs/SPEC.md)** | every rule of behaviour — the engine, the gestures, the screen | **before changing any rule.** A bare `§` below names a section of it |
| **[docs/DECISIONS.md](docs/DECISIONS.md)** | why each rule is what it is, what was tried and rejected, what was measured | before overruling a rule, and before answering an open question |
| **[CHANGELOG.md](CHANGELOG.md)** | what changed in each version | when releasing, or to see what the app does now |

Local-only notes and the wireframes live in `documents/`, which is gitignored on purpose: it holds
whatever the owner does not want in the repository. Do not move it, tidy it or read from it unasked.

## When you write in these documents

**Each file has one shape, and `src/lib/docs.test.ts` enforces it.** Three rounds produced three styles,
a 1,900-line CLAUDE.md and pointers to sections that had been renamed — a written rule was not enough,
so the shape is a test now. Run `npx vitest run src/lib/docs.test.ts` after editing any of them.

| file | shape |
|---|---|
| **CLAUDE.md** | the agreement, under 320 lines. A rule needing more than a line or two belongs in SPEC.md. `## The invariants` stays a numbered list, so a new one joins the list instead of hiding in prose |
| **docs/SPEC.md** | behaviour, present tense, no history. What the app does, not what it used to do |
| **docs/DECISIONS.md** | one entry per decision, all the same shape (below) |
| **CHANGELOG.md** | `## X.Y.Z — title`, newest first, an entry for the version in `package.json`, and `desktop/package.json` on the same number |

A **DECISIONS.md** entry is always these parts in this order:

```
## The Name Of The Rule

**Rule** — SPEC § *Where it is specified*. One or two sentences of the rule as it stands today.

**Why** — what makes it right, and what was measured.

**Rejected** — the alternative that was tried, and what it cost. (Only where one was.)
```

- **A superseded decision is DELETED, not annotated.** An agent reading *"this used to be X"* may restore
  X — that has happened. The rule as it stands today is the only thing the file says.
- **`§ *Name*` must name a real heading** of SPEC.md or DECISIONS.md. The test resolves every one.
- **Never write a `SPEC.md §` or `DECISIONS.md §` pointer in a code comment.** That the rules live there
  is understood; the test refuses it.

## How the owner works

Recorded because two rounds were spent learning it.

They answer product questions well and push back usefully when a question is malformed. Several
questions they were asked should never have been asked — the answer followed from how a calendar works,
and being asked read as the app not knowing what one is. **Ask about genuine forks in intent; decide the
rest and say what was decided.**

Their model of the app is simple and has been stated more than once in the same words: **padlock =
fixed, no padlock = free.** A change that adds a third state, or that makes a mark appear behind their
back, will be reported as a defect.

## Architecture

- Web app, self-hosted on the shop PC. Single user. **Desktop only, mouse driven** — no touch, no
  narrow layout (decided 2026-08-11).
- **Next.js 16 + TypeScript + SQLite** (`better-sqlite3`). Turbopack builds `dev` and `build`; React
  stays on 18.
- **It ships as a Windows application**: an Electron 43 window around the app's own standalone server,
  which runs on a **`node.exe` bundled in the package**. `src/` and `app/` know nothing about it — see
  `desktop/README.md` for the three traps that cost a build each.
- Priority: **simplicity over optimization**. No multi-user, no auth, no subscriptions.
- Code in English, UI in Spanish, i18n-ready.

## Commands

| | |
|---|---|
| `npm run dev` | development server on :3000 |
| `npm run build` / `npm start` | production build and server |
| `npm test` | vitest — the engine, the repositories, the API client, components' pure logic |
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |

**All four gates must pass before a commit**: `tsc`, `vitest`, `eslint`, `next build`. Node **22
exactly** — `scripts/require-node-22.mjs` refuses anything else, because `better-sqlite3` publishes no
prebuilt binary for other ABIs and npm would fall through to a compiler.

## Branches, versions and releases

- **Work on `dev`.** `main` only receives releases, through a pull request from `dev` or a
  `hotfix/*` branch. Neither branch can be deleted, and `main` cannot be force-pushed.
- Versions are `EPIC.FEATURE.FIX`. **You may move the middle number for a feature and the last for a
  fix. Never the first** — that is the owner's call alone.
- **A change that ships bumps the version and adds its CHANGELOG.md entry**, written in terms of what
  is different to use, not how it was built. A change that touches only documentation or tooling still
  earns an entry; keep it to a line.
- **Never create a tag and never publish a release** without the owner asking for it and confirming.
  Pushing a `v*` tag builds the installer and opens a draft release — that is theirs to trigger.

## Before you change a rule

Read the section first. These are the ones most often broken by a plausible-looking change:

| touching | read |
|---|---|
| the engine, placement, overflow | SPEC § *Weekly Auto-Composition*, § *Fill and Overflow, Always*, § *The Movable Pool* |
| anything that pins a row | SPEC § *The Padlock Is the Only Pin* |
| a drag, a drop, the ghost | SPEC § *A Drop Is Stored In Segments*, § *Thirds*, § *A Drop Onto a Day the Engine Reflows Is Never Refused*, § *A Drop Always Answers For Itself* |
| the bottom edge | SPEC § *Block Resize*, and § *Block Resize Is a Transfer, and Both Dead Ends Ask* in DECISIONS |
| gaps, absences, closed days | SPEC § *Gap Management*, § *Blocks and the Lunch Break* |
| the axis, the grid, a gesture's geometry | SPEC § *Calendar View*, § *Block Gestures*, § *One Axis Per Gesture* in DECISIONS |
| Settings | SPEC § *Settings*, § *The Capacity Is Never Touched Alone* |
| undo/redo | SPEC § *A Settings Save Empties the Line*, § *What Ctrl+Z Is Not* |
| backups | SPEC § *Backups* |

**Several rules were decided against an obvious-looking alternative that had already been tried and
failed for a recorded reason.** DECISIONS.md is where that reason is. Overruling a rule without reading
it is how a fixed bug comes back.

## The invariants

Break one of these and the shop's calendar is wrong, not just the feature. They are asserted, not
hoped for.

1. **`SUM(blocks.duration) == projects.total_hours`** for every project, asserted inside the
   transaction of every write. There is nowhere to park hours that are not on the calendar, and no
   "unscheduled" tray.
2. **No stored row straddles a non-working interval** — blocks *and* gaps. Work across the lunch break
   is two rows of one job.
3. **No stored row ends outside its day** (`assertRowWithinDayEnd`).
4. **`duration` is NET working minutes**, never clock minutes, for every row in the app.
5. **Integer minutes everywhere inside the engine.** Decimal hours exist only at the database boundary
   and in what the user reads.
6. **Dates are local `YYYY-MM-DD` from `src/lib/dates.ts`.** Never derive a calendar day from a UTC
   timestamp — SQLite's `CURRENT_TIMESTAMP` is UTC, so anything saved after 22:00 lands on the wrong
   day.
7. **The engine never writes to a date before today**, and no grid gesture reaches it either.
8. **One mark and no more**: `locked` is the only thing that stops a row reflowing. Two other columns
   existed for this and both were deleted as duplicates — `hand_placed` (2026-08-14) and
   `manual_duration` (2026-08-18). Do not add a third.
9. **One transaction per operation.** A refusal writes nothing and leaves the calendar untouched, never
   half-recomposed.
10. **Recomposing twice changes nothing.** The pass is idempotent.
11. **Never open `data/calendar.db` from a test.** Opening MIGRATES it; `openDatabase` refuses it under
    vitest, because the rule was broken once and a data migration ran over the shop's real calendar.

## Data Model

- **Project** (id, name, description, color, total_hours, created_at, updated_at)
  - One **job / work order**: "Railing", "Staircase", "Door".
  - `total_hours`: the estimate. Edited as work progresses.
  - No status, no deadline, no client tracking — out of scope.
  - **No order column.** Queue order is derived from calendar position — SPEC § *Queue Order*.

- **Block** (id, project_id, date, start_time, duration, locked, created_at, updated_at)
  - A slice of a project sitting on the calendar. `date` is `YYYY-MM-DD`, `start_time` is `HH:mm`,
    `duration` is decimal net working hours.
  - `locked`: the padlock. The only exemption from auto-move, and the only thing that fixes a row's
    position *and* its length. Set by the padlock and by a gesture that puts a row where the engine
    would never choose — a visual margin, the Friday buffer, the weekend, a closed day. Cleared by the
    padlock and nothing else.
  - One project has many blocks, across days.

- **Gap** (id, date, start_time, duration, reason, unit_id, created_at, updated_at)
  - A hole in the schedule: maintenance, a breakdown, admin. `reason` is optional text.
  - **Gaps are time**: they consume the day's plannable hours exactly as locked work does, and are
    fixed occupancy — never recomposed. In engine terms a gap has always been a padlocked task, which
    is why it has the same two gestures.
  - `unit_id`: **which rows are ONE ABSENCE.** The halves around the lunch break share one and carry
    one reason, and **any row of a unit addresses the unit** — a PATCH or a DELETE means the whole
    absence, whichever row it names. It cannot be the reason text: `deleteProject` writes the same
    sentence on every past row, so two absences that merely touch would fuse.
  - **An absence is fully described by (date, start, NET duration)**, the same shape a resize edits.
    A screen handed ONE ROW's duration is claiming the absence is that long — that destroyed 4 of 10
    hours once.

- **day_overrides** (date, is_closed, capacity_hours, note) — whole-day exceptions, read through a
  single `getDayConfig(date)`. `capacity_hours` deliberately has no screen: a short day is a gap.

- **history** — the undo line, whole calendar states with a cursor. Emptied when the database is
  opened, so a step can never describe a previous day's calendar.

## Implementer Defaults

Decided by the implementer because the low-risk answer was obvious. Here so they are easy to revisit
rather than buried in the code.

- **Styling**: plain CSS Modules against the brand tokens. Tailwind is not installed. Never hardcode a
  colour — always a token, so a dark theme stays cheap.
- **SQLite driver**: `better-sqlite3`, synchronous, so no promise plumbing.
- **Growing a job whose last block is outside the movable pool**: append to the last block the engine
  still lays out; if there is none, create one at the next slot. Taking hours away is not symmetrical —
  it reaches every row, unlocked first, a padlocked one last and reported.
- **Creating a gap over existing work**: recompose and push unlocked work forward in the same
  transaction; refuse naming the block if a padlock holds the space.
- **How far the day picker reaches**: 4 weeks back, the planning horizon forward, capped at 16 weeks
  (`src/components/ui/dateOptions.ts`, with a test).
- **Linting is the ESLint CLI on a flat config.** `next lint` does not exist in Next 16 and `next build`
  no longer lints, so the gate is standalone. Two things to know before editing `eslint.config.mjs`:
  - **`eslint .` reads neither `.gitignore` nor `.git/info/exclude`**, so every non-source directory is
    named in `ignores`. `.claude/worktrees` matters most — it holds a checkout of another branch and
    was being linted as if it were this one — and so do `desktop/build` and `desktop/dist`.
  - **`react-hooks/refs` and `react-hooks/set-state-in-effect` are OFF.** They arrived with
    `eslint-plugin-react-hooks` 7 and fire 25 times, every one on a deliberate shape that carries a
    comment saying why. Turning them on is a refactor of the drag layer, not a lint fix — it is an open
    question in DECISIONS.md.
- **`agentRules: false`** in `next.config.ts`, or `next dev` appends a self-rewriting block to this
  file on every start.
- **`outputFileTracingExcludes`** keeps the file tracer out of `data/`, `desktop/` and `documents/`. It
  resolved `path.join(process.cwd(), 'data', …)` in `getDbPath()` and packaged the shop's own database
  into the installer.
- **The calendar every suite is written against is `src/testing/fixtures.ts`** — the wireframe's week,
  Monday 10 to Sunday 16 August 2026, plus the days either side the horizon tests need. Add a date
  there, not locally: nine files had been declaring it and two had drifted, so one word meant two
  different days depending on the file.
- **Test timeout**: 30 s (`vitest.config.mts`). The property suites run thousands of generated
  calendars; the seed counts are the guard, so the timeout must not decide how many run.

## Conventions

- **Commits: Conventional Commits, SUBJECT ONLY** (decided by the owner, 2026-08-20).
  `type(scope): subject`, imperative, ~72 characters, **no body** — the reasoning goes to DECISIONS.md.
  Scope is the area, not the file: `resize`, `gaps`, `absences`, `engine`, `grid`, `desktop`, `backups`.
  Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
  **No self-attribution** in a commit or a pull request: no trailer, no mention of the tool.
- **WHO DECIDED WHAT MATTERS.** Never write *"decided with the owner"* about something inferred from
  what they said. That exact overstatement stood for two days about the resize precondition and cost a
  round to undo. If it was an inference, say so, and name what they actually decided.
- **All code, comments and identifiers in English. UI strings only in
  `public/locales/{es,en}/common.json`**, with the two key sets held identical by a test. That includes
  **test data**: jobs are `Railing`, `Staircase`, `Door`, `Shutter`, `Grille`, `Shed`, `Casing`,
  `Capping`; gap reasons are `Fair`, `Breakdown`, `Errands` and the rest.
  **Four kinds of Spanish are correct and must survive a sweep**, all four found by one that did not
  spare them:
  1. an assertion of an `es` locale VALUE (`locales.test.ts`, `summary.test.ts`, the
     `apiErrorMessage(…, 'es')` cases);
  2. a UI label the spec NAMES, so the document describes the screen that exists — `Ausencias`,
     `Cerrar días`, `Un hueco`, `desborde 2 h`;
  3. the owner's own words, quoted;
  4. a reason STORED in the shop's database, where `Feria` is the datum and `Fair` would be a lie.

  A fifth trap has no Spanish in it: **`taller` is the English comparative**, and a map that translates
  it turns *"made the grid taller than its box"* into nonsense.
- **A comment carries what the code cannot, and nothing else.** The path names the module, the
  identifier names the thing, the type says its shape, SPEC.md holds the rules and DECISIONS.md the why.
  A comment restating any of those is a copy that will drift.
  - **Delete**: a doc recoverable from the name or the type; a file header describing what the filename
    says; an essay justifying a constant; an obituary for deleted code; owner quotes; boilerplate true
    of half the repo.
  - **Never write a `SPEC.md §` or `DECISIONS.md §` pointer in code.** That the rules and the reasoning
    live in those files is understood; repeating it on every symbol is the noise this rule exists to
    stop.
  - **What earns a comment**: a unit or origin the type cannot state (*"minutes from midnight"*, *"net
    working minutes"*); a caller obligation; a trap the next reader would otherwise walk into; a
    measured defect or a tried-and-failed alternative not written down elsewhere.
  - If it needs a paragraph it is reasoning, and it belongs in DECISIONS.md.
- **Database**: `./data/calendar.db`, created on first run. Point `WORKWISE_DB_PATH` at a scratch file
  when driving the app — **never test against `data/`**.
- **A change of MEANING in a stored column needs a one-shot data migration**, not a schema one:
  `PRAGMA table_info` cannot see that a column's units changed. `runMigrations` applies them once each
  and records the name in `data_migrations`; add to that list rather than inventing a mechanism. It
  reads the CURRENT settings, so it must never re-cut rows the owner has since moved by hand.
- **Next 16 is newer than the training data of whatever is reading this.** The version-matched docs ship
  inside the install at `node_modules/next/dist/docs/`. `next lint`, `serverRuntimeConfig`,
  `publicRuntimeConfig`, AMP and `experimental.ppr` are gone; `middleware` is now `proxy`; `params`,
  `searchParams`, `cookies()` and `headers()` are async only.
