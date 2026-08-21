# Workwise Calendar - Project Context

**Workwise** is a simple work scheduling app for a small workshop.

> **This file is the WHAT: the rules an implementer must follow.**
> [DECISIONS.md](DECISIONS.md) is the WHY: how each rule was decided, the owner's own words, what
> was tried and rejected, and what was measured to confirm it. Neither is a summary of the other.
>
> **Any change to a business rule updates this file. The reasoning for the change is appended to
> DECISIONS.md.** Do not put reasoning here; it is what made this file unreadable once already.

## Objective

Help the workshop owner see how long the workshop is booked and what dates are available for new jobs.
Track work blocks sequentially across the week, automatically respecting capacity, locks, and gaps.
Enable quick visual reorganization via drag & drop.

## Architecture
- Web app, self-hosted locally (shop PC).
- **It ships as a Windows application, not as a server the owner starts** (decided 2026-08-21, not
  built). Electron around the Next standalone server: the app is not rewritten and `src/` and `app/`
  are not touched. The plan, the measurements behind it and the one hard constraint — **Electron 36 or
  lower**, because that is where `better-sqlite3`'s prebuilt Windows binaries stop — are in
  `documents/desktop-packaging.md` (gitignored, local only).
- Single user (just the shop owner for now).
- **Desktop only, mouse driven.** No touch support and no narrow/mobile layout (decided 2026-08-11).
- Stack: Next.js 16 + TypeScript + SQLite. Turbopack builds `dev` and `build`; React stays on 18.
- Priority: **simplicity over optimization**.
- Code in English, UI in Spanish (i18n-ready for future languages).

## Internationalization (i18n) Strategy
- **Primary language**: Spanish (es) — initial UI/UX in Spanish.
- **Multi-language support**: The app must support language selection at any time.
  All UI strings externalized to i18n JSON files (`public/locales/{lang}/common.json`).
- **Code convention**: All comments, variable names, functions, internal docs in English.
  Only UI-facing strings in translation files.
- The es and en key sets are held **identical** by a test (`locales.test.ts`).

## Data Model

- **Project** (id, name, description, color, total_hours, created_at, updated_at)
  - A single **job/work order** ("Metal door structure", "Railing", "Staircase").
  - `total_hours`: Estimated duration. Edited when work progresses or the estimate changes.
  - `description`: Optional free text, editable in the job form.
  - `color`: Visual identifier on the calendar.
  - No status, no deadline, no client tracking (out of scope).
  - **No order column.** Queue order is derived from calendar position — see *Queue Order*.

- **Block** (id, project_id, date, start_time, duration, locked, created_at, updated_at)
  - A **time slot on the calendar** where part of a project sits.
  - `date`: YYYY-MM-DD. `start_time`: HH:mm.
  - `duration`: Hours as decimal. Always **net working hours**.
  - `locked`: Boolean. The **only** exemption from auto-move, and the only thing that fixes a row's
    POSITION. If true the engine never moves the block; the user still can, by hand. Set by the
    padlock, and by a gesture that puts the row where the engine would never choose — a visual
    margin, the Friday buffer, the weekend. See *The Padlock Is the Only Pin*. Cleared by the
    padlock, and by nothing else.
  - **One Project can have multiple Blocks** across different days.
  - **A stored block never straddles a non-working interval** (lunch break, end of day). Work
    crossing the lunch break is two blocks of the same job — see *Blocks and the Lunch Break*. This
    holds for a HAND DROP too: the drop is cut at the break when it is saved. The end-of-day half is
    enforced in one place — see *The End of the Day Is a Line No Write May Cross*.
  - **A drop onto Monday-Thursday, inside the working periods, does not pin the block.** It is an
    ordinary block: surrounding unlocked work reflows around it, and placement by hand changes the
    *order*, not the block's mobility.

- **Gap** (id, date, start_time, duration, reason, unit_id, created_at, updated_at)
  - A **break/hole** in the schedule (admin, maintenance, machine breakdown).
  - `reason`: Optional text. Can be empty.
  - All gaps share one visual colour (configurable in Settings).
  - **Gaps are time**: they consume the day's plannable hours exactly like locked work does, and are
    fixed occupancy — never auto-recomposed.
  - `duration` is **NET WORKING MINUTES, exactly like a block's** (changed 2026-08-19), and **a stored
    gap row never straddles a non-working interval** either — so the invariant holds for EVERY row in
    the app and `start_time + duration` is any row's clock extent — see *Blocks and the Lunch Break*.
  - `unit_id`: **which rows are ONE ABSENCE.** The two halves around the lunch break share one and carry
    one reason between them, and **ANY ROW OF A UNIT ADDRESSES THE UNIT** — a PATCH and a DELETE both
    mean the whole absence, whichever row they name. It cannot be the reason text: `deleteProject`
    writes the same sentence on every past row, so two absences that merely touch would fuse.
  - **An absence is fully described by (date, start, NET duration)** — the same shape a block's resize
    edits — which is what lets one form and two gestures all mean the same thing. A screen that hands
    any of them ONE ROW'S duration is claiming the absence is that long; see *Gap Management*.
  - **In engine terms a gap was always a padlocked task** — fixed occupancy, consumes plannable hours,
    never recomposed — so it now has the two gestures a padlocked block has: see *Gap Management*.

**ONE MARK AND NO MORE.** A row stops reflowing for exactly one reason, visible on it and undone by
pressing it: the **padlock** (`locked`). It fixes the row ENTIRE — where it sits *and* how long it is,
because the engine neither moves a locked row nor re-derives its length. Two other columns have
existed and both were removed for the same reason, that they were a second way to say what the padlock
already says: `hand_placed` (2026-08-14) and `manual_duration` (2026-08-18).

**Invariant**: `SUM(blocks.duration) == projects.total_hours` for every project, asserted inside the
transaction of every write. There is nowhere to park hours that are not on the calendar
(`date`/`start_time` are NOT NULL) and no "unscheduled" tray exists.

---

## Implementer Defaults

Decided by the implementer because they have an obvious low-risk default. Flagged here so they are
easy to revisit rather than buried in the code.

- **Styling**: plain CSS (CSS Modules) against the brand tokens. Tailwind is not installed.
- **SQLite driver**: `better-sqlite3`. Synchronous, so no `promisify` plumbing, and it removes the
  whole `sqlite3 → node-gyp → tar` vulnerability chain.
- **Growing a job whose last block is outside the movable pool**: the engine appends to the last
  block **it still lays out**. If the job has none, it creates one at the next available slot. "A
  locked block is never grown silently" covers **every row outside the pool**. Taking hours AWAY is
  not symmetrical and still reaches every row, unlocked rows first and a padlocked one only as a last
  resort (reported in `touchedLockedBlockIds`). `lastAutomatic` asks `isMovable`, so every case is
  covered. A SHRINK never hands its freed hours to a row outside the pool at all — it ASKS.
- **Creating a gap on top of existing work**: recompose, pushing unlocked work forward in the same
  transaction. If the space is held by a locked block, refuse the save naming the block.
- **How far the day picker reaches**: 4 weeks back and the planning horizon forward, capped at 16
  weeks. Bounds live in `src/components/ui/dateOptions.ts`, with a test.
- **Whole-day exceptions**: `day_overrides(date, is_closed, capacity_hours, note)` ships in the
  initial migration and the engine reads every day through a single `getDayConfig(date)`. `is_closed`
  and `note` now have their screen — *The Absences Screen*, `Cerrar días` — and are NOT in Settings:
  closing a week is something the owner does to the calendar, not a preference. `capacity_hours` still
  has none, deliberately (*no half-day*).
- **Linting is the ESLint CLI on a flat config** (`eslint.config.mjs`, `npm run lint` = `eslint .`).
  `next lint` does not exist in Next 16 and `next build` no longer lints, so the gate is standalone.
  Two consequences worth knowing before editing that file:
  - **`eslint .` walks the whole tree and reads neither `.gitignore` nor `.git/info/exclude`**, so
    every non-source directory is named in `ignores`. `.claude/worktrees` matters most: it holds a
    checkout of ANOTHER branch and was being linted as if it were this one.
  - **`react-hooks/refs` and `react-hooks/set-state-in-effect` are OFF.** They arrived with
    `eslint-plugin-react-hooks` 7 (the version before had neither) and fire 25 times, every one on a
    deliberate shape that already carries a comment saying why. Turning them on is a refactor of the
    drag layer and the portal mount guard, not a lint fix — see *Open Decisions*.
- **`agentRules: false`** in `next.config.ts`. Without it `next dev` appends a self-rewriting block to
  **CLAUDE.md** on every start: a dirty tree on every run, and framework prose inside the file that
  states its own contract in its header. The useful half of that block is kept below, in
  *Notes for Development*.
- **The calendar every suite is written against lives in `src/testing/fixtures.ts`** — the
  wireframe's week, Monday 10 to Sunday 16 August 2026, plus the days either side the horizon tests
  need. Nine test files had been declaring it themselves, and two had drifted: one called
  `2026-08-20` THURSDAY while the rest call `2026-08-13` THU, so one word meant two days depending
  on the file. Add a date here rather than locally.
- **Test timeout**: 30 s (`vitest.config.mts`). The suite's property tests run thousands of generated
  calendars each; the seed counts are the guard, so the timeout must not be what decides how many run.

---

## Open Decisions

**Three lists, and the difference between them is the whole point.** *ANSWERED, NOT BUILT* has the
owner's decision already in it — build it, do not re-ask. *STILL OPEN* has no answer — ask before
inventing one. *SET ASIDE* was looked at and deliberately dropped.

None of these is a broken invariant: hours are conserved, no stored row straddles a break, nothing
overlaps that did not already, and recomposing twice changes nothing. Reproductions live in
DECISIONS.md § *Reproductions behind the Open Decisions*.

### ANSWERED, NOT BUILT — build these; the decision exists

- **A resize may grow a row over another job, or over a gap.** *(Decision 4, answered 2026-08-20.)*
  `resizeBlock` looks at neither, so the growth is simply written over whatever is there; only the
  drop path resolves overlaps. **The owner's answer: CUT AT THE OBSTACLE, the way a drop does** — grow
  up to what is in the way, store what fits, and say what stopped it. With their refinement, which is
  three cases and not one:
  - both rows **padlocked** → cut at the obstacle;
  - the row being grown is padlocked and the one below is **not** → **push the one below**;
  - the row being grown is **not** padlocked and the one below is → the extra hours go **after** the
    padlocked row, which is what the reflow already does with hours the job cannot fit here.

  `findGapConflicts` and `otherJobOverlaps` already exist — the drop path's two halves — so this is
  wiring, not a new mechanism.
- ***Añadir otra parte*** on the job panel *(decided 2026-08-14)*: a second job entry with the name and
  colour pre-filled. DECISIONS.md § Two Parts of One Job.

### STILL OPEN — ask before inventing an answer

- **25 `react-hooks` 7 findings, silenced rather than fixed** *(2026-08-20, with the Next 16 upgrade)*.
  `react-hooks/refs` (13) and `react-hooks/set-state-in-effect` (12). Every one is a shape chosen on
  purpose: `useMounted`'s `setMounted(true)` in an effect, which exists so a portal is not created
  during hydration; `useWeekSlide` deriving the slide direction from two refs DURING render, so the
  week animation costs one render and not two; and `live.current = options` in `useBlockDrag`, which
  exists because without it the window listeners captured stale callbacks and dropped onto a stale
  week. The rules are right in general and wrong about these three, and the fix is a refactor of the
  drag layer — the most measured code in the app. **Ask before starting it.**

- **The scissors never answer for themselves.** Their GHOST does (`placingGhost` previews the same
  division a drag does), but nothing is said after the save. Candidates: a `describeDrop`-style
  outcome; refuse a split whose fragment would settle back inside the source row; or leave it.
- **A drop cut into pieces INSIDE ONE DAY says nothing.** `filled` counts DAYS, so 6 h released in
  front of a padlocked row stores two rows on one day and no branch fires. Candidates: count PIECES;
  give the same-day case its own wording; or leave it, since the ghost drew both rectangles first.
  **Do not widen `filled` to count pieces without asking.**
- **A resize ghost draws its post-break tail on THIS day even when the slot is taken.** The hours are
  right, the rectangle is not. Only the occupied case; with the slot free the preview is exact. A
  resize's counterparty is the job's own last row, so the preview would have to simulate the LIFO
  transfer, not just the fill.
- **Does `buffer` belong on a padlocked Friday row?** `BlockRows.tagOf` labels every Friday row
  `buffer`, including one the owner dropped there. The tag names the DAY's role, not the row's
  provenance. Left as-is pending a second opinion.
- **The hover action bar still covers a tall block's NAME on a narrow column.** Fixed for short and
  narrow blocks (the bar docks outside); on a ~150 px weekday column a tall block still has its top
  ~28 px covered. The drag is safe there and a click still lands on a button.
- **Two gaps may overlap each OTHER on the fixed side** — refused on create and on edit since
  2026-08-19 (`gap-over-gap`), but a BLOCK resize can still be grown over a gap, which is Decision 4
  above.

### SET ASIDE — looked at, deliberately dropped

- **The one-minute rank nudge, and the sub-quarter row it can produce.** A drop that goes in BEFORE a
  row writes its rank one minute earlier; that minute was then treated as a time and the run cut at
  the lunch break from it, so a day could come back off the quarter hour (`5,77 h`, and once a 14-minute
  row). **The owner could not reproduce it and set it aside on 2026-08-20**: *«parece ser solo problema
  teórico en código, ignorar por ahora pero si ocurre un problema similar mencionar este detalle»*.
  So: do not spend a round on it unsolicited — but **if anything similar surfaces, say that this was
  set aside**. The two candidate fixes and the measurements are in DECISIONS.md § The One-Minute Rank
  Nudge Crosses the Break.
- **A micro-drag on a bottom edge sends a request that changes nothing.** Measured in a browser
  2026-08-20 on a padlocked lunch-split unit: from the 4 px drag threshold every small drag sends
  `resize` with the row's EXISTING duration and gets 200 with the calendar unchanged. **No dialog ever
  appeared** — the older note claiming one was wrong, and the owner was right that the 15-minute snap
  keeps every value legal. What is left is a wasted round trip and a recompose; a one-line no-op guard
  would close it.

### Deferred by direction

- **The Windows executable**, above. Wanted, planned, and behind a few features the owner wants first.
  The milestone to build before anything cosmetic is the one that can only be tested on Windows:
  `ELECTRON_RUN_AS_NODE` plus the standalone server plus an Electron-ABI `better-sqlite3`.
- **Whether a closed day belongs in the summary strip's sentence**, and whether a gap unit should be
  reachable from the job panel's list. Both left open by the owner, 2026-08-19.
- **`day_overrides.capacity_hours` has no screen**, and that is a decision rather than a gap: a short
  day is a gap.

---

## Current Project Status

**v0.19.** `tsc --noEmit` clean, `vitest run` **1127 passing across 41 files**, `eslint .` clean,
`next build` clean.

**UNDO AND REDO, MANY STEPS DEEP** (2026-08-21). `Ctrl+Z` and `Ctrl+Y` walk the calendar back and
forward up to 50 writes, and two discreet icons in the header say what the next step is. A step is a
whole STATE of the calendar rather than the inverse of a gesture — the reflow recreates rows on every
pass, so what a move did is not derivable from the move — written inside the same transaction as the
rows it describes, which is what makes a refusal discard it for free. **The line lasts one run of the
app** and is emptied when the database is OPENED, because a close can be skipped and rows outliving
their run would describe yesterday's calendar. **Two decisions are the owner's**: the scope is the
calendar, so a settings save EMPTIES the line instead of joining it, and with a panel open the shortcut
is inert and says so rather than risking a half-written form. **A write that changed nothing the owner
can see earns no step**, which also stops the `SET ASIDE` micro-resize costing one.

Everything in *Composition Engine Business Rules* and *UI/UX Behavior* above is implemented and was
verified by driving the running app, except the items marked **Decided but NOT BUILT** in
*Open Decisions*.

**The full release history — what each round built, what it measured, and what the measuring found —
is in [DECISIONS.md](DECISIONS.md) § Release history.**

---

## Notes for Development

- **Read [DECISIONS.md](DECISIONS.md) before changing a rule.** Several of these rules were decided
  against an obvious-looking alternative that had already been tried and had failed for a recorded
  reason.
- **Any change to a business rule updates this file**, and appends its reasoning to DECISIONS.md.
- **Commits: Conventional Commits, SUBJECT ONLY** (decided by the owner, 2026-08-20).
  `type(scope): subject`, imperative, ~72 characters, no body. The reasoning goes to DECISIONS.md,
  which is what the body used to carry — and the owner's instruction was explicit: *«commits
  descriptivos simples y con una convención usada de forma estandarizada»*, not the long messages
  before it. Scope is the area, not the file: `resize`, `gaps`, `absences`, `engine`, `grid`,
  `decisions`. Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
  No self-attribution in a commit or a PR: no trailer, no mention of the tool.
- **WHO DECIDED WHAT MATTERS.** Never write *«decided with the owner»* about something inferred from
  what they said — that exact overstatement stood for two days about the resize precondition and cost
  a round to undo. If it was an inference, say so, and name what they actually decided.
- **All code, comments, variable names**: English. **UI strings**: only in
  `public/locales/{lang}/common.json`, with the es and en key sets identical. That includes TEST
  DATA: jobs are `Railing`, `Staircase`, `Door`, `Shutter`, `Grille`, `Shed`, `Casing`, `Capping`,
  and gap reasons are `Fair`, `Breakdown`, `Errands` and the rest — the English word for the thing,
  because the test COMMENTS were already using it while the code said `escalera`.
  **Four kinds of Spanish are correct and must survive a sweep**, all of them found by one that did
  not spare them: an assertion of an `es` locale VALUE (`locales.test.ts`, `summary.test.ts`, the
  `apiErrorMessage(..., 'es')` cases); a UI label the spec NAMES, so the doc describes the screen
  that exists (`Ausencias`, `Cerrar días`, `Un hueco`, `desborde 2 h`); the owner's own words, quoted;
  and a reason STORED in the shop's database, where `Feria` is the datum and `Fair` would be a lie.
  A fifth trap has no Spanish in it at all: `taller` is the English comparative, and a map that
  translates it turns *"made the grid taller than its box"* into nonsense.
- **A comment carries what the code cannot, and nothing else.** The path names the module, the
  identifier names the thing, the type says its shape, this file holds the rules and DECISIONS.md
  holds the why. A comment restating any of those is a copy that will drift out of step with them.
  - **Delete**: a doc recoverable from the name or the type (*"the job's name"* over `name`); a file
    header describing what the filename says; an essay justifying a constant; an obituary for deleted
    code (git has it); owner quotes; boilerplate true of half the repo (*"pure, so it is testable"*).
  - **Never write a `CLAUDE.md §` or `DECISIONS.md §` pointer.** That the rules and the reasoning live
    in those two files is understood, and saying it on every symbol is the noise this rule exists to
    stop. The owner asked for the pointers to go, twice.
  - **What earns a comment**: a unit or origin the type cannot state (*"minutes from midnight"*, *"net
    working minutes"*); a caller obligation; a trap or invariant the next reader would otherwise
    break; a measured defect or a tried-and-failed alternative not already written down elsewhere.
  - If it needs a paragraph it is reasoning, and it belongs in DECISIONS.md instead.
  *(Applied 2026-08-18: 11,027 comment lines over 24,525 of code, then a second pass on the
  survivors.)*
- **Integer minutes** everywhere inside the engine; `duration` is net working minutes; no stored row
  straddles a break or leaves its day.
- **Database**: auto-created `./data/calendar.db` on first run (the directory must be created too).
  Point `WORKWISE_DB_PATH` at a scratch file when driving the app — never test against `data/`. **Under
  `vitest` that file is refused outright** (`openDatabase`), because opening it MIGRATES it: the rule was
  broken once, on 2026-08-19, by a mistyped argument that let a trailing `db` parameter fall back to its
  default, and a data migration ran over the shop's real calendar.
- **Next 16 is newer than the training data of whatever is reading this.** The version-matched docs
  ship inside the install, at `node_modules/next/dist/docs/` — read them rather than recalling Next 15
  behaviour. `next lint`, `serverRuntimeConfig`, `publicRuntimeConfig`, AMP and `experimental.ppr` are
  all gone; `middleware` is now `proxy`; `params`, `searchParams`, `cookies()` and `headers()` are
  async only.
- **Complexity**: prioritise simplicity. No multi-user, auth, subscriptions. Keep it lean.
