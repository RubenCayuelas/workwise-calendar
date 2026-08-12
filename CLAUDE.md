# Workwise Calendar - Project Context

**Workwise** is a simple work scheduling app for a small workshop.

## Objective

Help the workshop owner see how long the workshop is booked and what dates are available for new jobs.
Track work blocks sequentially across the week, automatically respecting capacity, locks, and gaps.
Enable quick visual reorganization via drag & drop.

## Architecture
- Web app, self-hosted locally (shop PC).
- Single user (just the shop owner for now).
- **Desktop only, mouse driven.** No touch support and no narrow/mobile layout (decided 2026-08-11).
- Stack: Next.js 15 + TypeScript + SQLite.
- Priority: **simplicity over optimization**.
- Code in English, UI in Spanish (i18n-ready for future languages).

## Internationalization (i18n) Strategy
- **Primary language**: Spanish (es) — initial UI/UX in Spanish.
- **Multi-language support**: The app must support language selection at any time.
  All UI strings externalized to i18n JSON files (`public/locales/{lang}/common.json`).
- **Code convention**: All comments, variable names, functions, internal docs in English.
  Only UI-facing strings in translation files.

## Data Model

**Simplified model for workshop workflow:**

- **Project** (id, name, description, color, total_hours, created_at, updated_at)
  - Represents a single **job/work order** (e.g., "Metal door structure", "Railing", "Staircase")
  - `total_hours`: Estimated duration. Edited when work progresses or estimate changes.
  - `description`: Optional free text. Editable in the job form alongside name and hours.
  - `color`: Visual identifier on calendar (e.g., #FF5733 for red project)
  - No status, no deadline, no client tracking (out of scope)
  - **No order column.** The queue order is derived from calendar position — see
    *Queue Order* below.

- **Block** (id, project_id, date, start_time, duration, locked, manual_duration, created_at, updated_at)
  - Represents a **time slot on the calendar** where part of a project sits
  - `date`: YYYY-MM-DD (e.g., "2025-01-13" for Monday)
  - `start_time`: HH:mm (e.g., "09:00")
  - `duration`: Hours as decimal (e.g., 2.5 for 2h 30min). Always **net working hours**.
  - `locked`: Boolean. The **only** exemption from auto-move. If true, the engine never moves the
    block; the user still can, by hand.
  - `manual_duration`: Boolean. The **length** was set by hand (the bottom-edge drag), so the engine
    keeps it instead of re-deriving the job's segmentation from its total, and the job's run **ends**
    at that row. It exempts the row's *duration*, never its *position* — a hand-set row is still
    moved by the reflow. See *A Hand-Set Duration*.
    A flag rather than a second copy of the minutes: `duration` stays the single source of truth for
    how long the row is, so the two can never disagree.
  - **One Project can have multiple Blocks** across different days (e.g., Job A = Mon 2h + Tue 2h + Wed 1h)
  - **A stored block never straddles a non-working interval** (lunch break, end of day). Work that
    crosses the lunch break is two blocks of the same job — see *Blocks and the Lunch Break*.
  - **There is no `manually_placed` flag.** A block placed by a human is an ordinary block: the
    surrounding unlocked work reflows around it normally. Placement by hand changes the *order*,
    not the block's mobility.

- **Gap** (id, date, start_time, duration, reason, created_at, updated_at)
  - Represents a **break/hole** in the schedule (admin, maintenance, machine breakdown, etc)
  - `reason`: Optional text (e.g., "Equipment repair"). Can be empty.
  - All gaps have the same visual color (configurable in settings, e.g., gray)
  - **Gaps are time**: they consume the day's plannable hours exactly like locked work does.
  - Treated as fixed occupancy in calendar, no auto-recomposition

**Invariant**: `SUM(blocks.duration) == projects.total_hours` for every project, asserted inside the
transaction of every write. There is nowhere to park hours that are not on the calendar
(`date`/`start_time` are NOT NULL) and no "unscheduled" tray exists.

---

## Work Schedule Configuration (Settings)

**Configurable by the workshop owner:**

The workshop operates with a **split shift (jornada partida)** structure by default:

- **Period 1 (Morning)**: Start "08:00", End "14:00" (mandatory)
- **Period 2 (Afternoon)**: Start "15:30", End "19:30" (optional, toggle via checkbox)
  - The gap between periods (14:00-15:30) is visually implicit (lunch break). No explicit "gap" record is auto-created.
  - If Period 2 is disabled, the workday ends at Period 1 End.
- **defaultDayCapacity**: Default 10 hours (6h morning + 4h afternoon when Period 2 active)
  - It is a **stop-line for auto-fill only**. Its purpose is "fill less than the full shift so the
    shop can leave early", never "work more hours than the shift covers".
  - Range: 1 to the sum of the enabled periods. Re-capped automatically when period times change
    or Period 2 is toggled (so with Period 2 disabled the max becomes 6h in the default setup).
  - **It never blocks manual placement.** When there is a lot of work the user can keep dropping
    blocks by hand up to the end of the periods and into the visual margins.
- **Visual Margins** (for flexibility in exceptional cases):
  - `visualMarginTop`: Default 1 hour before Period 1 Start (e.g., 07:00 if Period 1 starts 08:00)
  - `visualMarginBottom`: Default 1 hour after Period 2 End (e.g., 20:30 if Period 2 ends 19:30)
  - Margins accept **manual drag-drop only**. Auto-fill never enters them.
  - Range: 0-2 hours per margin
- **planningHorizonWeeks**: Default 8. Auto-placement never creates blocks beyond this many weeks
  from today. If the hours do not fit within the horizon the whole operation rolls back in one
  transaction and shows a single message.
- `gapColor`: Color hex for all user-defined gaps (e.g., "#CCCCCC" gray)

All configuration values are user-editable in the Settings screen and apply to Monday-Friday (extendable to weekends if needed).

**Plannable hours for a given day** =
`min(defaultDayCapacity, enabled period minutes − minutes already occupied by gaps and locked blocks)`,
computed as a **union of intervals** so an overlapping gap and block are never counted twice.

**Timezone**: the shop runs on Europe/Madrid. Every `date` is a local YYYY-MM-DD produced by a single
helper in `src/lib/dates.ts`. Never derive a calendar day from a UTC timestamp (SQLite's
`CURRENT_TIMESTAMP` is UTC — anything saved after 22:00 would land on the wrong day).

**Calendar Timeline Display:**
```
07:00 ├─ Visual Margin (manual drag-drop only)
08:00 ├─ Period 1 Start
14:00 ├─ Period 1 End / Lunch Break (implicit gap)
15:30 ├─ Period 2 Start (if enabled)
19:30 ├─ Period 2 End
20:30 └─ Visual Margin (manual drag-drop only)
```

---

## Composition Engine Business Rules

### Queue Order
- The queue order **is the current visual order of the blocks on the calendar**:
  `ORDER BY date, start_time`. There is no `sort_index` column.
- A **newly created job** is appended after the last existing block. Creation order therefore sets
  the initial position (`created_at`, then `id` as tiebreaker, so the ordering is always total and
  the engine deterministic).
- **Dragging a block reorders the queue** — it does not pin the block. After the drop the whole
  calendar reflows in the new order. Example: with `B, A, C, A` on the calendar, creating `D` and
  dragging it after `B` yields `B, D, A, C, A`; the unlocked jobs shift normally to make room.
- Consequence to keep in mind while building the UI: **a dropped block does not stay at the exact
  time it was dropped at.** It keeps that *position in the sequence* and then settles contiguously
  after the preceding block. To nail a block to an exact time, use `locked`.

### The Movable Pool
A block is moved by the engine **iff** all of these hold:
- `locked = 0`, and
- `date >= today` (local), and
- `date` is not Saturday or Sunday.

Everything else is a fixed obstacle that flexible work flows around.

### Weekly Auto-Composition
1. **Monday-Thursday**: auto-fill sequentially with the movable pool, in queue order.
   - Respect the **split shift structure**: Period 1 (08:00-14:00) then lunch then Period 2 (15:30-19:30 if active).
   - Fill up to the day's *plannable hours* (see Settings).
   - Locked blocks are immovable obstacles; flexible work flows **around and past** them — they are
     not a wall.
   - Gaps are occupied time and consume plannable hours.
2. **Friday — the buffer (colchón)**. Friday exists to absorb work that grew beyond its estimate so
   it does not all spill into next week.
   - New job placement **never targets Friday**. A new job fills Mon-Thu; if it does not fit, its
     tail goes to **next week's Monday**, skipping Friday entirely.
   - Friday receives **only overflow generated by the growth of already-placed work** (the job's
     hours were raised, or a block was enlarged).
   - Friday **is** in the movable pool: when space frees up in Mon-Thu the engine pulls those hours
     back, so the buffer self-cleans and stays available for the next surprise. To keep something on
     Friday deliberately, lock it.
   - If Friday's plannable hours run out too, the remainder goes to next week's Monday.
3. **Weekends**: entirely outside the engine.
   - Never auto-placed, and **never auto-recovered**. Work is only ever on Sat/Sun because a human
     put it there, so the engine must not undo that decision — the common "delete one job, add
     another" would otherwise yank it back every time.
   - Moved only by hand. No lock required.

### No Backfilling, No Automatic Splitting
- **Never backfill.** The engine never pulls a later job into an earlier hole. A hole left in front
  of a locked block stays empty unless the job at the head of the queue happens to fit it. The user
  then decides what to do: move or split the locked block, or move or split the new job.
- **Never split a job to make it fit.** If a job does not fit in the space left in the day, the
  *whole* job moves to the next day.
- Splitting only happens when a job is **longer than a full day's plannable hours**. It then fills
  **the hours left in the day the cursor is already on**, then whole days, and the remainder
  continues on the next auto-fill day. No hour is wasted: 12 h reached on a day with 2 h left is
  **2 h today and 10 h tomorrow**, never 10 h tomorrow and 2 h the day after (confirmed with the
  owner, 2026-08-11).
- **Strict order end to end.** Once a job overflows, the rest of the queue follows it. Later jobs
  are never brought forward into the space it left. Example: Thursday has 5h free, the queue is
  Staircase (6h) then Door (2h) → the Staircase moves whole to the next day, the Door follows it,
  and Thursday keeps its 5h free for the user to fill by hand.

### The Past is Frozen
- The engine **never writes to a date earlier than today**. Past days render dimmed and are not a
  drop target. They keep no hover action bar — but they DO keep the bottom-edge resize handle, since
  correcting yesterday's duration is the whole point of *Block Resize*. A past row is one the engine
  will not re-lay out, so the length holds there without any mark being needed.
- Why: recomposition reflows unlocked blocks to close holes. If the past were in scope, a Monday cut
  short by a breakdown would get its hole closed by pulling Tuesday's work back into it — silently
  rewriting the record of what the shop actually did.
- **The user can still edit the past by hand at any time** (correct a duration, add a block). Freezing
  constrains the engine, not the owner. No lock is needed on past days.
- **Today is fully re-plannable.** To protect work already started this morning, lock that block.

### Block Resize (drag the bottom edge)
Resizing a block is a **transfer inside the job**, with the job's **last block** as the counterparty.
`total_hours` does not change unless stated otherwise.

**The gesture works on EVERY row** (decided with the owner, 2026-08-12). It used to be offered only
where it survived the reflow — locked, past and weekend rows — because on an unlocked future weekday
row the engine re-derived that job's segmentation from its total and undid the transfer: the request
answered 200 with the block unchanged. Storing the intent (`manual_duration`) is what fixes it; see
*A Hand-Set Duration* for what the stored intent then means for the rest of the week.

| Action | Effect | `total_hours` |
|---|---|---|
| Enlarge a block that is **not** the last | Subtract those hours from the last block, cascading backwards (LIFO) and deleting any block that reaches 0 | unchanged |
| Shrink a block that is **not** the last | Add those hours to the last block | unchanged |
| Enlarge the **last** block (or the only block) | No farther block to draw from | **increases** |
| Shrink the **last** block (or the only block) | Not allowed — it would leave the blocks summing to less than the total. Reduce the hours in the job form instead | unchanged |

The refusal is a **409 with an i18n code** (`shrink-last-block` / `errors.shrinkLastBlock`) and writes
nothing. A refused resize is never a silent no-op.

This is the normal way to record "yesterday took longer than I noted": enlarge yesterday's block and
the hours come off the job's furthest block, keeping the estimate intact.

### A Hand-Set Duration (decided with the owner, 2026-08-12)
A row whose length was set by the bottom-edge drag carries `manual_duration = 1`, and:

> **A block with a hand-set duration ends its job's run there. The job's remaining hours go to the
> next auto-fill day, and the space it frees that day is filled by the jobs that follow in the queue.**

Worked example. Example_A 14 h sits Wed 08:00-14:00 (6 h) + Wed 15:30-19:30 (4 h) + Thu 08:00-12:00
(4 h), with Example_B 8 h behind it. The owner shrinks the Wednesday morning row to 2 h:
```
Wed 08:00-10:00  Example_A 2 h   <- hand-set
Wed 10:00-14:00  Example_B       <- the next job fills the freed space
Wed 15:30-19:30  Example_B
Thu 08:00-...    Example_A       <- the remainder, on the next day
```
So **a newer job starts before the older job's remainder, and strict order is deliberately broken for
that day**. That is the price of honouring a hand-set duration, and it was chosen over leaving a hole.
If no job follows in the queue, the hours stay free: the shop really is free then.

Mechanically, two rules do it, and both are stated over the **day**, not over "the next item", so they
hold again on the following pass:
- once a hand-set stretch of job X lands on day D, **no more of X is placed on D**;
- the remainder is held back while the jobs behind it fill D, and placed as soon as one of them would
  have to leave D. It may overtake other jobs, never another item of **its own** job — reordering two
  items of one job would leave them adjacent, regroup them on the next pass, and lay the same hours
  out differently.

Everything else still applies unchanged: the Friday buffer (a displaced remainder is not growth, so it
skips the colchón), the weekend, the frozen past, plannable hours, and the lunch-break segmentation —
a hand-set stretch longer than the morning is stored as two rows that both carry the mark, and the
engine reads them back as one stretch.

**Why this is safe for the engine.** Breaking a job's run on a *stored column* is layout-independent,
so `compose` stays a fixed point. Breaking it on anything *derived from the placement* is what caused
an earlier critical defect, where grouping was derived from the layout while the layout was derived
from the grouping and an unrelated save silently resized the owner's blocks. Recomposing twice must
change nothing; the 2000-seed property harness asserts it with hand-set rows in the generated
calendars.

**Setting, keeping and losing the mark.** The mark stands for one specific number the owner drew, so
it lives exactly as long as that number does:
- **set** by a resize, on the row that was resized — including a resize to the length it already had,
  which makes the gesture total (same request, same state);
- **kept** through a move or a drop of that row (position changes, length does not), through any other
  job's edits, and through every recomposition;
- **released** by the explicit *back to automatic* action (`PATCH /api/blocks/:id {action:"release"}`).
  Required, not a nicety: a hand-set length is invisible except that the row stops reflowing, so
  without a one-click release the marks accumulate until the engine manages nothing. It gives back the
  **length**, not the queue position — the row's place in the order is whatever the calendar now says,
  exactly as after any drag;
- **lost** whenever something other than a resize rewrites the row's length: the LIFO transfer from the
  job form, being the counterparty of another row's resize, the scissors, or a drop that cuts the row.
  The row is then back under the engine, which is what the owner just asked for by making the edit.

The two gestures most likely to be asked about, stated outright because "does my 2 h survive this?" is
the question the owner will actually have (both verified over HTTP):

- **The job's total changes** (the job form's stepper). LIFO works on the job's **last unlocked** row,
  so the mark is lost **only if that is the hand-set row itself**. A hand-set row anywhere else keeps
  its mark and its exact length, and the added or removed hours go to the last row as usual — raising a
  14 h job to 17 h leaves the hand-set 2 h at 2 h. When the total is cut so far back that LIFO eats
  backwards into the hand-set row, that row's length is being rewritten by the owner's own edit, so it
  goes back to automatic.
- **The block is dragged.** The mark is **kept**: a drag sets the row's place in the queue and the
  reflow settles it, but nothing rewrites its length. A hand-set 2 h row dragged to Thursday is a
  hand-set 2 h row on Thursday, still closing that job's day there. The one exception is the drop that
  lands *inside* the row and cuts it (above): a cut rewrites the length, so it releases.

### Capping a Day — "we only do 2 h of this today" (decided 2026-08-11, revised 2026-08-12)
Three honest ways, all of which fall out of the rules above:

1. **Put another job after it.** The drop re-ranks the queue, the job splits there, and the day reads
   `A 2 h, B, A 4 h`.
2. **Stop the day with a gap.** Plannable hours are `shift − gaps`, so the day genuinely holds less
   and the work that no longer fits is replanned. This is a **one-click action** on the block's
   hover bar ("Cerrar el día aquí"): it pre-fills a gap from a chosen moment to the end of the day's
   last enabled period, asks only for an optional reason, and states what the day loses and which
   jobs cannot stay inside the closed stretch. It is an ordinary gap — same endpoint, same refusals,
   editable and deletable afterwards.
3. **Shrink the block** (new). It now sticks — see *A Hand-Set Duration* — and the hours it frees go
   to the jobs behind it in the queue, so the day is not left with a hole unless there is genuinely
   nothing else to do. Its cost is the one the owner accepted: a newer job starts before the older
   job's remainder, so strict order is broken for that day.

What none of them may do is leave a hole the engine refuses to fill for no reason: **if nothing
occupies the rest of the day, the shop IS free then, and the app exists to say so.**

What the action must NOT promise is *where* those hours land: only `compose` knows, over the whole
calendar, and *Never split a job to make it fit* means a job that no longer fits the hours left moves
**whole** to the next day with room — leaving the capped morning legitimately free.

### Job Editing: Adding/Removing Hours (LIFO - Last In First Out)
- **Add hours**: Append to the **last block** of that job.
  - If job has blocks: Mon 2h + Wed 1h + Fri 3h, adding 2h makes Fri 5h.
  - Subsequent jobs cascade forward (displaced by the extra 2h).
- **Remove hours**: Decrement from the **last block**.
  - If last block becomes 0, it's deleted, and next block becomes the new "last" (keeps decrementing if needed).

### Job Editing: Name/Description/Color Changes
- No impact on calendar layout or block positions. Just metadata updates.

### Blocks and the Lunch Break
- `duration` always means **net working hours**, so every row is a solid rectangle on the clock and
  can be interpreted without reading Settings.
- Work crossing the lunch break is stored as **two blocks** of the same job (e.g. 13:00-14:00 and
  15:30-17:30 for a 3h stretch). The engine splits at the period boundary when placing.
- On screen, consecutive segments of the same job are drawn as **one grouped unit** (outer rounded
  corners, label on the first, single drag handle) so the owner still sees and moves "one 3h job".
- **Auto-merge** joins two blocks of the same job only when they touch **inside the same period on
  the same day**. The two halves around lunch deliberately stay two rows.

### Manual Drag-Drop & Merging
- User can move a **portion** of a job (fragment it) or the entire block.
- On DROP: the queue is reordered (see *Queue Order*) and auto-recomposition runs.
- **Auto-merge**: as described above.

### A Drop That Overlaps (decided with the owner, 2026-08-11; extended 2026-08-12)
A drop onto the **weekend or the frozen past** lands where the engine may not reflow, so both the
dropped row and whatever was there are fixed obstacles and the reflow will never separate them. The
overlap is therefore resolved when the drop is saved, in the same transaction, **before**
recomposition — never by a general pass over the calendar, because two rows that were *already*
overlapping are somebody's decision and tidying them on an unrelated save is what rule 6 forbids.

- **Same job → one block, hours SUMMED.** Existing Sat 09:00-11:00 plus a 2 h drop at 10:00 becomes a
  single **09:00-13:00, 4 h** row. Not 09:00-12:00: an interval union would silently eat an hour.
  The earlier row survives (it keeps its id), so the write is an UPDATE plus a DELETE.
- **Different jobs → the cut job is split and its tail pushed after the new block.** A at 09:00-11:00
  with B dropped at 10:00-11:00 becomes A 09:00-10:00, B 10:00-11:00, A 11:00-12:00. A keeps its 2 h.
  "If the user does not want it, they move it again." Neither piece may straddle a non-working
  interval, so a pushed tail may itself become two segments; if it does not fit before the end of the
  day it chains forward like overflow — and a **weekend tail stays on the weekend** (Sat → Sun),
  because the engine never moves weekend work. A tail pushed out of the frozen past skips the
  weekend and the Friday buffer (a displaced row is not growth).
- **A locked block is never overlapped.** A drop onto one is refused (409) with the block named,
  exactly as a gap over a lock is. A merge is refused even when the lock is the drop's own, since it
  would move the lock's start; a *cut* is allowed while the drop is the locked one, because then the
  lock keeps its exact slot and only the other job moves.
- Both cases hold `SUM(blocks.duration) == projects.total_hours` for every touched project.
- This is **not** the auto-merge above. Auto-merge joins rows that *touch* inside one period and
  never runs on the weekend; this resolves an *overlap* a human just created, on any day.

**A drop onto a movable row is cut too** (2026-08-12). The reflow settles both rows, but it settles
them *in queue order*, and queue order is `date, start_time`: without the cut, dropping B at 10:00
into A's 08:00-14:00 row leaves the queue reading `A, B`, so A is laid out whole and B lands after the
entire block — the drop is silently ignored. Cutting A at the drop's start makes the queue read
`A, B, A`, and the engine's forward fill produces `A, B, A` on the clock by itself. Same resolver, far
less machinery, because on this side nothing is *placed*, only *ranked*:
- only a row that **starts before** the drop is cut; one starting at or after it already ranks behind
  the drop and needs no help;
- the tail is one row ranked just after the drop's end — a queue rank, not a position, exactly like the
  provisional row every drop and every new job is written as;
- **fixed rows are ignored** on this side, because flexible work flows around them. A movable drop over
  a locked row is therefore *not* refused, and a locked row is still never cut, grown or absorbed;
- there is no same-job merge on this side: two movable rows of one job are laid out contiguously and
  joined by auto-merge anyway, so folding them here would be tidying rather than repairing;
- cutting a row rewrites its length, so a **hand-set duration on the row that is cut is released** —
  the drop is the newer, more explicit gesture.

### Locked Blocks Don't Act as Walls
- `locked = true` means: "Don't auto-move this block during recomposition"
- Flexible blocks **flow around** locked blocks normally (don't stop at them)
- User CAN manually move locked blocks, change duration, or place other jobs around them
- User CAN toggle `locked` on/off at any time
- Because overflow always chains forward (into following days and weeks up to the horizon), a locked
  block can **never** make placement fail. There is no "Can't fit job due to blocked slot" error.

### Overflow Behavior (Default)
- If a job doesn't fit in the day's plannable hours, the whole job moves to the next day it fits in,
  respecting the Friday and weekend rules above.
- Beyond Friday, overflow continues into the following week, up to `planningHorizonWeeks`.
- If it still does not fit, roll the whole recomposition back in one transaction and show one clear
  message. The calendar is never left half-recomposed.

### Edge Cases Handled
1. **Delete job**: Confirmation required. Blocks deleted in cascade. Calendar recomposes if space frees up.
2. **Edit total_hours to exceed remaining week**: Distributes across multiple future days, then
   following weeks, bounded by `planningHorizonWeeks`.

---

## UI/UX Behavior

**Reference wireframes** (gitignored, local only): `documents/workwise_wireframe_vista_semana.png`
and `documents/workwise_wireframe_bloque_y_panel.html`. They are the authority on layout and are
where the decisions in this section come from.

### Visual Design
- **Light theme only.** Dark is deferred to a distant future. `public/brand/workwise-tokens.css`
  already ships dark values behind `prefers-color-scheme`, so `<html>` carries
  `data-theme="light"` to keep them dormant — the token file already honours that. Never hardcode a
  colour in a component; always go through a token so dark stays cheap.
- Import `public/brand/workwise-tokens.css` before `app/globals.css`.
- **Project colours** are a fixed swatch picker built from `--ww-project-1..8`. No free hex input —
  amber is reserved for the app itself and a free picker would let a job blend into the interface.
- Hairline borders (`0.5px`), `--radius` rounded corners, generous whitespace.
- **Icons**: Tabler (`@tabler/icons-react`), bundled locally — no CDN.
- **No native `<input type="time">` or `<input type="date">` anywhere.** Both render in the
  BROWSER's locale, not the page's: on a shop PC with Chrome in English the first draws "08:00 AM"
  beside a grid reading "08:00–14:00", and the second writes `08/12/2026` for the 12th of August,
  which makes a day like `03/08` genuinely ambiguous. Every time and every day the app shows goes
  through `useFormat()`, so the ones the owner *chooses* come from the same helpers:
  - times from the quarter-hour `TimeSelect` (`src/components/ui/`), whose step is held equal to the
    drag layer's `SNAP_MINUTES` by a test;
  - days from `DateSelect`, which offers the days of the schedule — spelled "Mié 12 ago" and grouped
    under the same week label the header shows ("Semana 33 · 10–16 ago 2026") — with the long date
    echoed underneath in prose. Its window runs a few weeks back (the past stays hand-editable) to
    the end of the planning horizon, and the day already stored is **always** an option even when it
    falls outside, so opening a form can never move what it is showing.

### Calendar View
- **Horizontal week layout**: all seven columns always rendered. Mon-Fri at full width; Sat/Sun
  narrow and de-emphasised, so dragging to the weekend works with no extra state and no setting.
- **Time axis**: vertical, from the top visual margin to the bottom visual margin. Grey bands mark
  the visual margins and the lunch break, labelled "solo arrastre manual".
- **Day headers** carry their state: `Lun 10 · congelado`, `Mar 11 [hoy]`, `Vie 14 · colchón`.
- **Summary strip** above the grid, amber-tinted:
  `Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre`.
  This is the stated objective of the app, so it ships in v0.2. Served from one endpoint so
  `composition.ts` owns the arithmetic: last occupied date across all weeks, hours queued, and
  whether Friday is still clear.
- **Header**: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, and the actions `Hoy`, `+ Nuevo trabajo`,
  language, overflow menu.
- **Visual blocks**: tinted fill with a saturated border in the project colour, name + hours. A
  padlock icon marks locked blocks, and a **hand-set length is marked too** — the row has stopped
  reflowing and the owner must be able to see why, and to undo it (*back to automatic*). The two
  marks are deliberately unalike, because they are independent and mean different things: the padlock
  fixes the row's POSITION, a ruler icon plus a solid (rather than hairline) bottom edge — the very
  edge that was dragged — fixes its LENGTH. A row can carry either, both or neither. Continuation
  segments read `2 h · sigue`. Engine-placed Friday blocks read `desborde 2 h` and get a distinct
  border so an overrun week is visible at a glance.
- **Past days**: desaturated and not a drop target; still editable by hand.
- **Drag-drop**: click and drag job blocks to a new position. Ghost/preview during drag. Mouse only.
  Since an overlapping drop CUTS the row underneath on any day (*A Drop That Overlaps*), the ghost
  also says what the drop will do to that row before the mouse is released — cut it here (drawn as a
  seam across it), merge into it (hours summed), or be refused because it is locked. Announcing it
  afterwards in a toast would be telling the owner about somebody else's block only once it had
  already been split.

### Block Gestures
- **Drag the body**: move the block — this reorders the queue and triggers a reflow
- **Drag the bottom edge**: resize, as a transfer inside the job (see *Block Resize*). Offered on
  **every** row — every day, and every row OF A UNIT. A unit has one handle for the move, because it
  is one thing to drag, but its segments are separate rectangles with the lunch band between them and
  each has a real bottom edge; without an edge on the first one, *A Hand-Set Duration*'s own worked
  example ("shrink the Wednesday morning row to 2 h") would be unreachable from the calendar. The
  drag is capped at the end of that row's own period, so it can never produce a row straddling the
  break. On a row the engine reflows, the new length sticks and marks the row hand-set, which
  is a visible, releasable state — see *A Hand-Set Duration*. The consequence is never local, so the
  save reports it: the hours went to the job's last block, the remainder starts on the next day, and
  the jobs behind it took the space the day gained. The refusal (409 `shrink-last-block`) is said the
  same way, since it is the one failure with a concrete next step.
- **Click**: open the job panel
- **Hover**: a small action bar appears with lock, *back to automatic*, *stop the day here*, split
  (scissors) and delete — never behind a modifier key, since on a shop PC an Alt-drag would never be
  discovered. Two of them are absent where they would do nothing: *stop the day here* on a row that
  already ends the day, on the weekend, on a closed day and in the past; *back to automatic* on a
  unit no part of whose length was set by hand. It releases the WHOLE unit — a hand-set stretch cut
  at the lunch break is two marked rows, and giving back only half of it would leave the other half
  still closing the day.

### Job Panel (side panel)
- Colour dot + job name + close
- Fields: `Nombre`, `Descripción`, `Horas totales` (stepper), `Color` (swatches)
- `Bloques · 11 h en 4 tramos`: the job's blocks listed as `Mié 12 · 08:00–14:00 · 6 h` with a
  per-block lock toggle, and a *back to automatic* action on any row whose length is hand-set. Note
  how the wireframe lists the two halves around lunch as two separate rows (`Mar 11 · 13:00–14:00 · 1 h`
  and `Mar 11 · 15:30–17:30 · 2 h`) — that is the segment model above, confirmed by the design.
- Actions: `Guardar`, `Eliminar`

### Job Management
- **Create**: Name + Description + Color + Hours (e.g., "Door frame" + Red + 8h)
  - Appended to the end of the queue (Mon-Thu, never Friday)
  - Or user specifies a start day
- **Edit**: Change name, description, color, total hours (affects last block per LIFO rules)
- **Delete**: Requires confirmation. Blocks deleted; calendar recomposes.
- **Lock/Unlock**: Toggle `locked` flag per block
- **Back to automatic**: clear a hand-set length so the engine owns the row again
  (`PATCH /api/blocks/:id {action:"release"}`)

### Gap Management
- **Create**: Date + Start Time + Duration + Reason (optional)
- **Create in one click**: *stop the day here* from a block's action bar — the same form with the day,
  the moment and the span already filled in, asking only for the reason. See *Capping a Day*.
- **Edit**: Modify any field
- **Delete**: Frees up time; auto-recomposition runs if needed

### Settings
- Work periods, auto-fill capacity, visual margins, planning horizon, gap color, language

---

## Composition Algorithm Notes

The per-day placement logic is validated in `recompose-poc.js`. Two of its behaviours were checked by
executing it, and only one of them survives:

- ✅ **Overflows the whole item, never splitting it** — matches the decision above. Keep.
- ✅ **Never backfills a hole left in front of a locked block** — matches the decision above. Keep.
- ❌ **Keeps filling the day with later jobs after one overflows** (verified: `X 3h, Y 6h, Z 2h` at
  8h capacity places X and Z, overflowing Y — so Z jumps ahead of Y). This violates strict order and
  must change in the port. It needs an explicit regression test rather than a straight port.

The production implementation should:
1. Extend it to **weekly chaining** (Mon-Thu, then the Friday buffer rule, then following weeks)
2. Support **gaps** as fixed occupancy (treated like locked blocks) and as consumers of plannable hours
3. Handle **LIFO editing** and **block resize as a transfer**
4. Derive queue order from calendar position, and **exclude the past and weekends from the pool**
5. Support **auto-merge** for contiguous blocks within the same period

---

## Implementer Defaults

Decided by the implementer for v0.2 because they have an obvious low-risk default. Flagged here so
they are easy to revisit rather than buried in the code.

- **Styling**: plain CSS (CSS Modules) against the brand tokens. Tailwind is not installed — the
  calendar grid is custom geometry, so Tailwind would earn little and the token file already exists.
- **SQLite driver**: `better-sqlite3`. Synchronous, so no `promisify` plumbing; it is what the README
  already claimed; and it removes the whole `sqlite3 → node-gyp → tar` vulnerability chain
  (1 critical + 7 high in `npm audit`).
- **Growing a job whose last block is locked**: the engine appends to the last **unlocked** block,
  ordered by date then start time. If the job has no unlocked block, it creates one at the next
  available slot after the job's last existing block. A locked block is never grown or shrunk
  silently.
- **Creating a gap on top of existing work**: recompose, pushing unlocked work forward in the same
  transaction. If the space is held by a locked block, refuse the save with a message naming the
  block rather than creating an overlap. Gaps and blocks are one occupancy set (union of intervals).
- **How far the day picker reaches**: 4 weeks back and the planning horizon forward, capped at 16
  weeks. The horizon may legally be set to 104 weeks, which would be 700+ options in one dropdown;
  a day further out than that is chosen by dragging on the calendar, which is where it is being
  looked at anyway. Bounds live in `src/components/ui/dateOptions.ts`, with a test.
- **Whole-day exceptions**: the `day_overrides(date, is_closed, capacity_hours, note)` table ships
  in the initial migration and the engine reads every day through a single `getDayConfig(date)`
  (global settings → weekday rule → override), but there is **no Settings UI for it in v0.2**. This
  keeps holidays and closed weeks a data entry away instead of a migration away.

## Open Decisions

Still unanswered; do not invent an answer, ask first.

- **A resize that overlaps another job in the frozen past.** *Block Resize* is offered on past rows
  precisely so yesterday can be corrected, and a *drop* that overlaps is now resolved (see *A Drop
  That Overlaps*) — but a resize is not a drop. Enlarging yesterday's row can still run over another
  job's row on that same past day, and nothing cuts it: the past is a RECORD of what the shop did,
  and silently splitting somebody's record to make room is not obviously the right answer. The three
  candidates are refuse the resize naming the row, cut the other job exactly as a drop does, or keep
  allowing the overlap because two jobs really were on the bench at once. The same applies to the
  LIFO counterparty growing into a past row.
- **Backups**: daily local copy, manual export/import, or both? The DB is deliberately gitignored,
  a recomposition rewrites many rows at once, and there is no undo. Deferred out of v0.2, but every
  mutating operation already runs in a single transaction, which makes a future undo much cheaper.
- **Settings UI for day overrides** (holidays, closed weeks, a one-off day with different hours).
  The table and engine support exist; only the screen is missing.

---

## Current Project Status

**v0.1 — closed.** Data model, business rules resolved with the owner (2026-08-11), the PoC's
per-day placement, and the project skeleton. Its whole fix-first list is done: the
`migrations.ts` type error, `initializeDb()` on a clean checkout, the lazy idempotent accessor,
the typed settings repository, `updated_at`, the `locked` mapper, the i18n wiring, the brand
tokens, the README, the dead config and the tracked `tsbuildinfo`.

**v0.2 — built.**
- [x] `src/lib/composition.ts`: the queue from calendar position, the movable pool, weekly
      chaining, the Friday buffer, gaps as occupancy, LIFO editing, resize-as-transfer,
      auto-merge inside a period, and manual-placement overlap resolution
- [x] `src/lib/scheduler.ts`: the one seam to SQLite, one transaction per operation, the
      hours invariant asserted before every commit
- [x] API routes for Project, Block, Gap, Settings, week and summary
- [x] Week view, job panel, job form, gap form, split form, Settings screen
- [x] Drag-drop (mouse only), the hover action bar, *stop the day here*, the resize edge
      (then restricted to rows the engine will not re-lay out — see v0.3)
- [x] Every time and every day chosen from `TimeSelect` / `DateSelect`, never a native input

Verified on 2026-08-12: `tsc --noEmit` clean, `vitest run` 381 passing across 16 files,
`next lint` clean, `next build` succeeds. Exercised over real HTTP against a **clean** database
and in a real browser: the same-job overlap merge (durations summed, total unchanged), the
different-job cut (`A, B, A`), *stop the day here* dropping the day's plannable minutes and
pushing the work that no longer fits to the next day with room, the 409 naming the locked block
that a gap or a drop would have overlapped, and the Friday rule both ways (a new job skips the
colchón for next Monday; the growth of an existing job lands on it).

**Not in v0.2**, and both already listed above: the Settings UI for `day_overrides`, and backups.

**v0.3 — the two defects found on v0.2, engine and persistence done (2026-08-12).**
Both were reproduced over real HTTP against a clean database, and both are fixed and re-verified the
same way:
- **A resize was a silent no-op** on any row the engine re-lays out — 200 with the block unchanged.
  Fixed by storing the intent in `blocks.manual_duration` and giving it the meaning in *A Hand-Set
  Duration*, with the explicit *back to automatic* release. The refusal path is a 409 with an i18n
  code, never a no-op.
- **An overlapping drop did not cut a movable row**, so `A, B, A` was unreachable on a weekday: the
  drop landed after the whole block instead. Fixed by extending `resolveManualPlacement` to cut
  movable rows — see *A Drop That Overlaps*. The fixed-row paths are unchanged.

**v0.3 — the interface, done.** The bottom edge is offered on every row (the two strings that used to
explain why it was inert are deleted, not just unused); a hand-set row carries the ruler mark and the
solid bottom edge; *back to automatic* is on the block's hover bar and on every hand-set row of the
job panel's list; a resize reports where the hours went and a refused one says so where the gesture
happened; and the drag ghost names what the drop will do to the row underneath, which matters far
more now that an ordinary weekday drop cuts.

Verified: `tsc --noEmit` clean, `vitest run` 423 passing across 18 files, `next lint` clean,
`next build` succeeds, and the property harness runs 2000 seeds with hand-set rows in the generated
calendars asserting hours conservation, no overlap and the fixed point. The drop preview mirrors
`resolveManualPlacement` branch for branch and has its own test file, because a preview that promises
a cut the server will not perform is worse than no preview at all.

**v0.3 — closed, verified end to end (2026-08-12).** `tsc --noEmit` exit 0, `vitest run` 423 passing
across 18 files, `next lint` clean, `next build` succeeds. Re-checked over real HTTP against clean
databases (`WORKWISE_DB_PATH` on a scratch path, `next start`), with today = Wed 2026-08-12:

- **Defect A.** `PATCH {action:"resize", durationMinutes:120}` on the unlocked 6 h Wednesday morning
  row answers 200 with the block **at 120 min and `manualDuration: true`** — it used to answer 200
  with the row unchanged at 360. The calendar that comes back is *A Hand-Set Duration*'s worked
  example row for row: `Wed 08:00-10:00 Barandilla 2 h [hand-set] / Wed 10:00-14:00 + 15:30-19:30
  Porton / Thu 08:00-14:00 + 15:30-19:30 Barandilla / Mon 08:00-10:00 Barandilla`. Both totals
  unchanged (14 h and 8 h), every job's blocks still summing to its total.
- **It is a fixed point.** Creating an unrelated job leaves the hand-set 2 h at 2 h; deleting it again
  leaves the whole calendar byte-identical to before.
- **Back to automatic** clears the mark, and once the job that had taken the freed hours is gone the
  engine re-derives the job from its total (`Wed 6 h + 4 h, Thu 4 h`) — confirming the release gives
  the **length** back, while the queue position stays where the calendar now puts it.
- **The refusal.** Shrinking a job's last block answers **409** `shrink-last-block` /
  `errors.shrinkLastBlock` and writes nothing.
- **Defect B.** Dropping Porton at Wed 10:00 inside Barandilla's 08:00-14:00 movable row now cuts it:
  `Barandilla 08:00-10:00, Porton 10:00-12:00, Barandilla 12:00-14:00`, both totals intact, with the
  cut job named in `displacedProjectIds`. A movable drop onto a **locked** row is still accepted, and
  the locked row is neither cut, grown nor absorbed.
- **The mark's lifecycle**, as documented above: a hand-set row keeps its length through a drag (only
  its position moves) and through a job-total edit that lands on another row; it is released by the
  cut, and by LIFO reaching the row itself.
- **Nothing regressed**: a new job skips the Friday colchón for next Monday while the growth of placed
  work lands on Friday and is pulled back off it when room reappears; weekend work survives the
  "delete one job, create another" churn with no lock; the engine never writes to a past day the owner
  moved work onto; a gap over a locked block is a 409 naming the block, and a gap on movable time is
  accepted.
- **In a real browser** (Chromium, the same clean database): every block carries its own bottom-edge
  handle including the first row of a lunch-split unit; dragging that edge from 6 h to 2 h reproduces
  the worked example on screen; the row draws the ruler mark and a 2 px solid bottom edge; the toast
  reads *«Barandilla» se queda en 2 h aquí y esa duración queda fija…*; *Volver a automático* on the
  hover bar clears it, and appears only on the hand-set row. Zero console errors.

---

## Notes for Development

- **Review `recompose-poc.js` first**: It contains validated per-day placement logic.
  Production code should derive from this, not reinvent — but see the one behaviour that must change.
- **Any change to business rules above must update CLAUDE.md** to keep specs in sync.
- **All code, comments, variable names**: English.
- **UI strings**: Only in `public/locales/{lang}/common.json`.
- **Database**: Auto-created `./data/calendar.db` on first run (the directory must be created too).
- **Complexity**: Prioritize simplicity. No multi-user, auth, subscriptions, etc. Keep it lean.
