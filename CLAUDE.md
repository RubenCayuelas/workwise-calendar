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
  - `unit_id`: **which rows are ONE ABSENCE.** The two halves around the comida share one and carry
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

## Work Schedule Configuration (Settings)

The workshop operates with a **split shift (jornada partida)** by default:

- **Period 1 (Morning)**: Start "08:00", End "14:00" (mandatory)
- **Period 2 (Afternoon)**: Start "15:30", End "19:30" (optional, toggle via checkbox)
  - The gap between periods (14:00-15:30) is visually implicit. No explicit gap record is created.
  - If Period 2 is disabled the workday ends at Period 1 End.
- **defaultDayCapacity**: Default 10 hours (6h morning + 4h afternoon when Period 2 is active)
  - A **stop-line for auto-fill only**: "fill less than the full shift so the shop can leave early",
    never "work more hours than the shift covers".
  - Range: 1 to the sum of the enabled periods.
  - **The app never changes it by itself** — see *The Capacity Is Never Touched Alone* below.
  - **It never blocks manual placement.** The user can keep dropping blocks by hand up to the end of
    the periods and into the visual margins.
- **Visual Margins**
  - `visualMarginTop`: Default 1 hour before Period 1 Start. `visualMarginBottom`: Default 1 hour
    after Period 2 End. Range 0-2 hours each.
  - Margins accept **every hand gesture and no automatic one**: a drop, the scissors and the
    bottom-edge resize may all use them; auto-fill never enters them and the capacity stop-line
    never counts them.
  - Because the engine's index space holds no margin minutes, **a hand gesture that takes margin
    time padlocks its row.** Pressing the padlock undoes it.
- **planningHorizonWeeks**: Default 8. Auto-placement never creates blocks beyond this many weeks
  from today. If the hours do not fit within the horizon the whole operation rolls back in one
  transaction and shows a single message.
- `gapColor`: Colour hex for all user-defined gaps.

All values are user-editable in Settings and apply Monday-Friday (extendable to weekends if needed).

### The Capacity Is Never Touched Alone
> **`defaultDayCapacity` changes only when the owner changes it. When a settings change would leave
> it above the hours the shift buys, the app ASKS — naming the old number, the new one and what the
> new one costs per day — and cancelling saves nothing.**

- **The write path refuses.** `validateSettings` throws `SettingsValidationError` on a capacity above
  the sum of the enabled periods, exactly as it does for every other out-of-range value. There is no
  re-cap. A caller shortening the shift must send the capacity it wants **in the same patch**, which
  is what lets the Settings screen ask first and save the answer in one round trip.
- **The read path still repairs.** `readSettings` clamps a stored value above the shift, because a
  hand-edited row must not be able to make `capacityMinutes` claim hours the periods do not have.
  Repairing a READ is not the trap; repairing a WRITE was.
- **The two paths must agree on the whole range, or the repair becomes the trap again.** The write
  refuses a capacity **above the shift, below `min(1, shift)`, or off a whole minute** — the exact
  range the read path would otherwise silently pull it into. Invariant, and it holds for every field:
  *what `writeSettings` returns is what the next `readSettings` gives back.* (It did not: 0.5 h saved
  fine and read back as 1 h.)
- **The form never adjusts it either** — not on a keystroke, not on save. The draft holds the owner's
  number even while it exceeds the draft's shift; the capacity field's own stepper max opens up to
  that value so the control cannot pull it down behind them. In `NumberStepper`, **a bound beats the
  step grid**: it snaps to `step` first and clamps second, or a ceiling that is not a multiple of the
  step (a 9.75 h shift) gets rounded back past itself and a focus-and-blur raises the capacity.
- **A capacity below the shift is stated, not warned about.** Choosing to fill 6 h of a 10 h day is
  legitimate and otherwise invisible — every afternoon simply stays empty — so the Settings field and
  the header strip both say which hours auto-fill is leaving free.
- *(Why, and the reproduction: DECISIONS.md § The Capacity Is Never Touched Alone.)*

**Plannable hours for a day** =
`min(defaultDayCapacity, enabled period minutes − minutes already occupied by gaps and locked blocks)`,
computed as a **union of intervals** so an overlapping gap and block are never counted twice.

**Timezone**: the shop runs on Europe/Madrid. Every `date` is a local YYYY-MM-DD produced by a single
helper in `src/lib/dates.ts`. Never derive a calendar day from a UTC timestamp (SQLite's
`CURRENT_TIMESTAMP` is UTC — anything saved after 22:00 would land on the wrong day).

```
07:00 ├─ Visual Margin (manual gestures only)
08:00 ├─ Period 1 Start
14:00 ├─ Period 1 End / Lunch Break (implicit gap)
15:30 ├─ Period 2 Start (if enabled)
19:30 ├─ Period 2 End
20:30 └─ Visual Margin (manual gestures only)
```

### The Manual Window
> **A day has TWO views, and every rule names the one it is stated over. Auto-fill reads the
> PERIODS. A hand gesture reads the MANUAL WINDOW: the periods plus the visual margins, fused
> wherever they touch.**

On the documented shift the manual window is `07:00-14:00` and `15:30-20:30`, so **the lunch break
stays the only hole in the day** and nothing about segmentation changes — a hand gesture is still cut
there and only there.

| reads the periods | reads the manual window |
|---|---|
| auto-fill placement, plannable hours, the capacity stop-line, `desborde` | the bottom-edge resize, a drop, the scissors, the grid's grouping of a unit and the seam it draws inside one |

Both views are derived in ONE place (`manualWindowsOf` in `src/lib/manualWindow.ts`, called by
`dayShapeFromSettings`) and travel together on `DayConfig` and on the week view's `days[]`.
*(Why: DECISIONS.md § The Manual Window.)*

---

## Composition Engine Business Rules

### The End of the Day Is a Line No Write May Cross
> **A stored row ends inside its day. The line is the end of the day's LAST MANUAL WINDOW —
> `dayEndMinutes` — which is every minute a hand gesture may use, margins included.**

Where it lives, in the order that actually guarantees it:

- **`dayEndMinutes`, `clockEndOf`, `latestStartFor`** (`src/lib/manualWindow.ts`, pure). `duration`
  is NET working minutes, so only `clockEndOf` can say that 6 h at 13:15 reaches 20:45.
- **The drag layer clamps** (`clampDropStart` in `geometry.ts`) — but only as a LAST RESORT now; see
  *Aiming Below What A Day Holds Means The Next Day*. It clamps to the latest legal START rather than
  to an interval end, because a release is measured from the first minute that can hold work (*A
  Minute With No Working Time*) and a row crosses the break for free: 6 h aimed at the break is 6 h
  from 15:30, so it clamps, while 5 h stands.
- **The resize is capped at the day's end and at the row's own end** (`ResizeReach`), never at the
  axis. A row already outside the windows (its margin was set to 0) keeps its hours, can be
  shortened, and can never be grown.
- **The write path refuses** (`assertRowWithinDayEnd`, called by `recompose` over every row it is
  about to write): 409 `row-past-day-end`, nothing saved. It is the backstop, and it is **tolerant
  in exactly one direction**: no write may make an overrun WORSE, so a row a settings change
  stranded outside the windows stays savable, movable and shrinkable.
- **A same-job merge that will not fit the day is refused** (`merge-exceeds-day`).

By construction the clamp only fires where the drop PADLOCKS, so Monday-Thursday RANKING is
untouched. *(Why: DECISIONS.md § The End of the Day Is a Line No Write May Cross.)*

### Queue Order
- Queue order **is the current visual order of the blocks on the calendar**: `ORDER BY date,
  start_time`. There is no `sort_index` column.
- A **newly created job** is appended after the last existing block. Creation order sets the initial
  position (`created_at`, then `id` as tiebreaker, so the ordering is total and the engine
  deterministic).
- **Dragging a block reorders the queue** — it does not pin the block. After the drop the whole
  calendar reflows in the new order. With `B, A, C, A` on the calendar, creating `D` and dragging it
  after `B` yields `B, D, A, C, A`.
- Consequence: **a dropped block does not stay at the exact time it was dropped at.** It keeps that
  *position in the sequence* and settles contiguously after the preceding block. To nail a block to
  an exact time, use `locked`.

### The Movable Pool
A block is moved by the engine **iff** all of these hold:
- `locked = 0`, and
- `date >= today` (local), and
- `date` is not Saturday or Sunday.

Everything else is a fixed obstacle that flexible work flows around. `isMovable` in
`src/lib/composition.ts` is the single line; `dayReflows` is the different question of whether the
engine lays a DAY out at all, and the two must not be confused.

### Weekly Auto-Composition
1. **Monday-Thursday**: auto-fill sequentially with the movable pool, in queue order.
   - Respect the split shift: Period 1, then lunch, then Period 2 (if active).
   - Fill up to the day's *plannable hours*.
   - Locked blocks are immovable obstacles; flexible work flows **around and past** them — they are
     not a wall.
   - Gaps are occupied time and consume plannable hours.
2. **Friday — the buffer.** Friday exists to absorb work that grew beyond its estimate.
   - New job placement **never targets Friday**. A new job fills Mon-Thu; if it does not fit, its
     tail goes to **next week's Monday**, skipping Friday entirely.
   - Friday receives **only overflow generated by the growth of already-placed work**.
   - Friday **is** in the movable pool: when space frees up in Mon-Thu the engine pulls those hours
     back, so the buffer self-cleans.
   - **But only what the engine itself put there.** A block a human DROPPED on Friday is PADLOCKED
     by that drop and is a fixed obstacle. That is how the owner puts work on the buffer
     deliberately, and engine-placed overflow, which carries no padlock, stays reclaimable beside it.
   - If Friday's plannable hours run out too, the remainder goes to next week's Monday.
3. **Weekends**: entirely outside the engine.
   - Never auto-placed, and **never auto-recovered**. Work is only ever on Sat/Sun because a human
     put it there, so the engine must not undo that decision.
   - Moved only by hand. No lock required.

### The Padlock Is the Only Pin
**Padlock = fixed. No padlock = free.** A drop onto a place the engine would never choose on its own
sets `locked = 1`.

**Which places padlock a drop** — `dropLandsLiterally` in `src/lib/dropSlide.ts`, ONE function with
three readers: the write path (`pinsTheRow`), the ghost (`dropPins`) and the landing (`dropLanding`):

| where | padlocks? |
|---|---|
| Friday, the buffer | yes |
| Saturday and Sunday | yes |
| a **closed day** (`day_overrides`) | yes — it is a weekend by another name |
| a row that already carries a padlock, any day | yes — it keeps the minute it was released on |
| a drop that STARTS in manual-only time — a visual margin | yes |
| a footprint that merely RUNS PAST the end of the periods | **no** — those minutes are overflow |
| the lunch break, any day | **no** — it is not a slot: the drop starts at 15:30, inside the periods |
| Monday-Thursday inside the periods | **no** — it re-ranks the queue and the row settles contiguously |

Two details keep the manual-only rule honest: it needs at least a quarter of an hour of manual-only
time (`MIN_MANUAL_ONLY_MINUTES`, held equal to the drag layer's `SNAP_MINUTES` by a test), because a
drop's rank may be nudged by a single minute and one minute of margin is a tie-break rather than a
request; and a **resize** padlocks over its WHOLE footprint (`usesManualOnlyTime`), since a length
reaching into a margin really is stored there and cannot exist without the slot.

**A drop asks for manual-only time by STARTING in it** (narrowed 2026-08-17). A drop writes a queue
rank, and since *Fill and Overflow, Always* the minutes past the end of the working periods are not
a request for the margin below them — they are hours the reflow carries to the next day. Reading the
whole footprint instead made the owner's own case impossible: 6 h released at Monday 15:30 reaches
21:30, scored 120 manual-only minutes, and came back PADLOCKED at a slot that then had to be refused
or rolled onto another day. They had aimed at a four-hour hole.

**A CLOSED DAY WAS MISSING FROM THIS TABLE UNTIL 2026-08-19, and it was a real defect** (measured):
its `role` is still `auto` on a weekday, so a 2 h row released on a closed Thursday at 09:00 was read
as a queue RANK, stored unlocked, and — the engine may not lay a closed day out — carried to the next
open Monday at 08:00, with no refusal and nothing said. `DropPin.closed` is now asked alongside
`role`, which is what makes *a closed day accepts work dropped by hand and never auto-recovers it*
true rather than merely intended.

The lunch break is not in the table for the same reason it never pins: a drop aimed there is stored
from 15:30 (*A Minute With No Working Time*), so it asks for no manual-only minutes at all.

**The padlock is only ever ADDED by a gesture, never removed by one.** Dropping a padlocked row back
onto Mon-Thu leaves it padlocked, where it lands on the exact minute it was released at. The way
back is to press the padlock — on the row's hover bar, and on every row in the job panel's list, so
it is reachable for a row weeks away. **It is the only undo there is**, and it gives back the whole
row: its place in the queue and its length. (*Back to automatic*, `{action:"release"}`, existed while
a hand-set LENGTH was a mark of its own; both went on 2026-08-18.)

On a day the engine reflows, a padlocking drop's slot is its **intent, not the last word**: if the
slot it asks for is held by a gap or a locked row, the drop slides forward to the nearest slot it
can have on the day the owner named. If the day has none, the drop is **refused naming what is in
the way** — it may not give up the pin, because that would mean taking a padlock off a row behind
the owner's back.

Consequences, all of them wanted:
- a padlocked row **costs its day the hours it holds** (it is an obstacle, like a gap);
- a gap that would cover one is **refused** naming it (`errors.gapOverLockedBlock`);
- a drop that overlaps one is resolved by the FIXED half of *A Drop That Overlaps*;
- **the same job still merges**, padlocks and all, and the merged row keeps the padlock. Refusing
  there would make a Saturday the owner had already used unusable for the job already on it.

*(Why, including the removal of `hand_placed` and the migration: DECISIONS.md § The Padlock Is the
Only Pin.)*

### Fill and Overflow, Always
> **Work fills what is left of the day and the remainder overflows to the next day it can use.
> Always, and whoever placed it. A job may therefore end up in four or five pieces — the owner
> accepted that consequence in as many words.**

This **replaces "never split a job to make it fit"** (removed 2026-08-17), and with it two things
that rule had produced:

- a job that did not fit in the space left no longer moves WHOLE to the next day leaving that day's
  tail empty — it takes the tail and continues tomorrow;
- the hole in front of a locked block is no longer left for the owner to decide about — work fills
  up to the lock and continues after it.

It also removes the **continuation**, a distinction that existed only to exempt a displaced tail
from the rule now deleted (`QueueItem.continuation`, gone). Every item is placed by one path.

**What did NOT change:**
- **Never backfill.** The cursor walks forward and never goes back, so free minutes the queue has
  already walked past — what a day's stop line left, a stretch too short to hold a row, a day
  `acceptsItem` refused — are never reclaimed by later work.
- **Strict order end to end.** Once a job spills onto a later day, the rest of the queue follows it.
- The Friday buffer, the weekend, the frozen past, plannable hours, lunch-break segmentation and
  the hours invariant.

**Where each of those is pinned**, because the difference matters when one of them breaks: the
2000-seed harness asserts the hours invariant, the frozen past, the weekend, the buffer, the stop
line, "every row inside a working period", "nothing overlaps", the sliver floor, strict order and
idempotence — on every seed. **Never-backfill is pinned by its own three cases** (*rule 7 — no
backfilling*), not by the harness: the cursor is not visible in the output, so the property would
have to restate the algorithm to see it.

**EVERY PIECE IS STILL A LEGAL ROW**, and that is the sharp edge of the change: filling a
ten-minute hole may not produce a ten-minute row. One function decides it (`takeableFrom`), and it
is *The Calendar Sits On The Quarter Hour* applied at the one place splitting now happens:

| the stretch and the hours left | what happens |
|---|---|
| the whole remainder fits here | it is taken; nothing is left over |
| the remainder is under a quarter of an hour | it is DRAWN — it could not be a row anywhere |
| the remainder is one quarter but not two | it goes on WHOLE; this stretch keeps its minutes |
| the stretch cannot hold a quarter of an hour | it is **stepped over like an obstacle** and stays free |
| otherwise | a full quarter of an hour is left for the hours that carry on |

Two details make it hold rather than nearly hold:
- **A free stretch is cut at every real break between two periods**, because a stretch spanning the
  comida is one stretch to the arithmetic and TWO rows on the clock. Without the cut an obstacle
  ending at 13:50 stored a ten-minute `13:50-14:00` row plus the rest of the afternoon.
- **The floor is never a refusal.** `compose` walks the horizon once with it on and, only if the
  hours still have nowhere to go, once more with it off: an item the cursor keeps stepping over ends
  in `horizon-exceeded`, which rolls the whole save back, and a short row beats that.

**The drag says it before the release.** A drop's ghost draws the rows this rule will produce, on
every column they reach, and names them — see *The Ghost of a Rank Is the Division*. `takeableFrom`
lives in `src/lib/dropSpill.ts` so the engine and the preview cannot answer differently.

*(Why, and what it supersedes: DECISIONS.md § Fill and Overflow, Always.)*

### Creating a Job With a Start Date
The create form takes an **optional start date**. Left empty the job is appended to the end of the
queue, Mon-Thu, never Friday.

> **The date means "not before this day". It is a FLOOR, not a deadline** — deadlines are excluded
> deliberately and this must not grow into one — **and it is NOT STORED.**

**The three modes** (`src/lib/creation.ts`; one function, `planCreation`, serves both the save and
the form's preview, so the form cannot promise a placement the save will not perform):

| the chosen day | mode | what is written |
|---|---|---|
| the queue reaches it: appending the job lands on or after that day | `queue` | one provisional row after the last block. When the queue's own answer is LATER than the day chosen, the form says so before saving. |
| the same, but the owner disagreed (`force`) | `forced` | one provisional row ranked at 00:00 of that day. The same outcome as creating the job and dragging it there, including that a **locked** row is not moved. |
| the engine would place it EARLIER, or would not place it there at all (a Friday, a weekend, the past) | `born` | the job's real rows, on that day and the days after, laid out by `compose` itself. |

**The automatic padlock is mechanical, not a preference.** A job born where the engine would
otherwise fill earlier has every one of its rows padlocked (`autoLock`) — the padlock is the only
thing that holds it, and a half-locked job would come apart on the next reflow. Inside the span
already planned no lock is added, because the work in front of the job is what holds it there.

**Friday and the weekend are honoured after an explicit confirmation**, and the rows landing on the
chosen day are padlocked (`dayLock`). The job's continuation follows the normal rules from there,
including skipping the buffer, since it is still a new job. A **past** date is allowed: the rows are
created there, locked, as a record of work that was done but never logged.

**`newProjectIds` still applies in every mode**, so the continuation of a dated job skips the Friday
buffer like any new job's tail. The chosen day itself is the one exception, opened up explicitly:
the synthetic pass reports the chosen day's role as `auto` when it is a Friday, because choosing the
buffer by hand is the owner's intent and they have just confirmed it. The weekend is never opened up
— it is outside the pool BY DATE — so hours on a chosen Saturday or Sunday are laid out by
`manualDaySegments`, free working time forward, a run that holds the job whole preferred, never
straddling the lunch break; the remainder goes back to `compose` from the following Monday.

**The form previews the placement BEFORE saving** (`POST /api/projects/preview`, which writes
nothing): where the hours really start, the rows they would occupy, what is already sitting across
the whole span, whether every row would come back locked, and which days are free instead.

### The Past is Frozen — And Read-Only To The GRID Gestures
> **The past is the RECORD of what the shop did. The engine never writes there, and neither does a
> grid gesture: no drag, no resize, no split, no delete, and the padlock stops meaning anything. A
> FORM still reaches it — that is how a mis-recorded day is corrected.**

- The engine **never writes to a date earlier than today**. Past days render dimmed, keep no hover
  action bar, and are not a drop target — at either end: a past row cannot be dragged (409
  `past-block-frozen`) and no row can be dropped ONTO a past day (409 `drop-onto-past-day`).
- `setBlockLock` and `deleteBlock` refuse too. A padlock a row carried into the past simply stays.
- **The UI must not offer what the server refuses.** The calendar withholds the whole action bar on
  a frozen day **and the bottom-edge strip with it**; the job panel draws no scissors and no padlock
  BUTTON on a past row, rendering the padlock as a plain state icon instead.
  *(On a FUTURE row the engine lays out, the strip is not withheld — it is drawn inert and explains
  itself, because withholding it there let the press fall through to the body and start a MOVE. Not
  offering and not being there are different things: see* Block Resize.*)*
- **Still allowed, and it is the way out**: editing the job in its FORM, and deleting it. Hours
  added to a job whose last row is past get their own row on a future day (`lastAutomatic`), and
  deleting a job leaves its past rows behind as gaps.
- **A padlock a row carried into the past simply stays**, and toggling it is refused: it changes
  nothing the engine reads, since `isMovable` asks the date before it asks the flag. Nothing is
  stranded by that — there is no second mark left to hand back.
- **A GAP is frozen there the same way** (2026-08-19), at both ends: a past absence is not dragged and
  not resized (409 `past-gap-frozen`) and none is dragged ONTO a past day (409 `drop-onto-past-day`).
  The grid draws no bottom-edge handle on one, and the press that proves a drag names the way out —
  **its own FORM**, not the job panel (`notices.pressOnPastGap`). Editing it there is allowed, exactly
  as editing a job in its form is, which is what `action` on the PATCH exists to distinguish.
- **Today is fully re-plannable.** To protect work already started this morning, lock that block.

*(Why, including the two judgement calls: DECISIONS.md § The Past is Frozen.)*

### Block Resize (drag the bottom edge)
> **The bottom edge is available on EVERY row but a past one, and it means one thing said two ways:
> make this stretch of work longer or shorter. Where the hours come from is what differs.**

| the row | what the edge changes | `total_hours` |
|---|---|---|
| the engine **lays it out** (no padlock, not a weekend) | the JOB'S HOURS — there is no drawing to fix, so the gesture changes how much work there is and the engine places it, flowing past whatever is padlocked | grows; shrinking **asks** first |
| it carries a **padlock**, or sits on a **weekend** | a TRANSFER inside the job, with the job's last block as the counterparty | unchanged unless stated below |

**Why an automatic row changes the ESTIMATE rather than its own length.** A hand-set number cannot
survive there: shrinking Wednesday grows Thursday, frees exactly those minutes on Wednesday, and the
job flows straight back into them — *«quedando exactamente igual»* (the owner, 2026-08-18, deciding
that `manual_duration` had to go). But that argument is about a stored GEOMETRY, and it does not reach
the gesture: changing how many HOURS the job has survives every reflow, because the engine is what
places them. So the edge stays, and on such a row it does what the owner described — *«esas horas de
más se colocan después de la tarea con candado»*.

- **Growing is applied straight.** The job gets those hours and `compose` lays them out.
- **Shrinking ASKS**, because it destroys hours: 409 `shrink-needs-choice` with the single answer
  `reduce-total`, and nothing written until it comes back. `new-block` is deliberately absent — a row
  of its own, of this same job and unpinned, is placed straight back where those hours already were.
- **The padlock is still what holds a LENGTH**: the engine hands a locked row's geometry back
  untouched, never merges it and never re-derives it. That is why the same gesture is a transfer there.
- **To end a day earlier, make a GAP** — *Cerrar el día aquí*. **THE APP NEVER CREATES THAT GAP.** The
  owner was explicit: *«no se creará el hueco automáticamente, sino que si el usuario lo quiere lo
  deberá de crear él»*.
- **A GAP's bottom edge is ABSOLUTE** — it just sets the absence's duration — because there is no job
  to transfer hours to. See *Gaps Are Dragged And Resized*.

> **CORRECTED 2026-08-20, and the correction is the point.** Between 2026-08-18 and this date the edge
> was **withheld** on any row the engine lays out (409 `resize-needs-padlock`), and this file recorded
> that precondition as *«decided with the owner»*. **It was not.** The owner decided to delete
> `manual_duration`, and gave the reasoning above. The precondition was the implementer's inference
> from it, and it silently reversed the owner's own v0.3 request that the edge *«debería de estar
> siempre disponible»*. They caught it: *«mis palabras literales no tienen nada que ver con este
> problema… nadie dijo en ningún momento que eso debía desaparecer para los bloques sin candado»*.
> Do not re-derive the precondition from the quote; the quote is about a stored length, not about a
> gesture. *(DECISIONS.md § The Edge Never Needed The Padlock.)*

**The past is refused first and for its own reason** (409 `past-block-frozen`): a past row is outside
the pool, so the arithmetic would work, but the past is a record.

| Action | Effect | `total_hours` |
|---|---|---|
| Enlarge a block that is **not** the last | Subtract those hours from the last block, cascading backwards (LIFO) and deleting any block that reaches 0 | unchanged |
| Shrink a block that is **not** the last | Add those hours to the job's last block **the engine still lays out**, skipping the locked ones and cascading backwards | unchanged |
| Enlarge the **last** block (or the only block) | No farther block to draw from | **increases** |
| Shrink with **no block that can take the hours** | ASK the owner, three ways out | depends on the answer |

The counterparty rule is the mirror of the precondition: **what is sized is never in the pool and the
counterparty always is.** A raw `duration` written onto a fixed row is geometry nothing settles.

**SHRINKING ASKS, IT DOES NOT REFUSE.** The dead end is a QUESTION, asked once and answered in the
same request shape:

| the answer | what happens | `total_hours` |
|---|---|---|
| **Cancelar** | nothing is written; the client simply does not ask again | unchanged |
| **Quitar las horas del total** (`freedHours: "reduce-total"`) | the job becomes smaller by those hours | **decreases** |
| **Dividir** (`freedHours: "new-block"`) | the hours become a block of their own, ranked after the job's last row | unchanged |

Unanswered, the request is **409 `shrink-needs-choice` / `errors.shrinkNeedsChoice`** that writes
nothing and carries `freedMinutes` and `choices` — the answers that really exist, so the dialog is
built from the server's list in ONE round trip. `new-block` is absent when the freed hours are under
a quarter of an hour. A `freedHours` value the refusal did not offer is a 400, never a silent
re-ask. `ResizeChoiceDialog` renders it; `details` carries MINUTES only, and the dialog formats them.

**The dead end is exactly two cases**: the stretch being sized contains the job's LAST row, or every
counterparty is outside the movable pool (locked, weekend, frozen past).

**The drag is measured in NET WORKING MINUTES over the day's manual window.**
- **It crosses the lunch break, which costs nothing.** A row starting at 10:00 dragged to 17:30 is
  **6 h** — `10:00-14:00` plus `15:30-17:30` — never 7.5 h. Releasing anywhere inside 14:00-15:30
  gives the same 4 h as releasing at 14:00.
- **It may reach into the visual margins**, and stops at the end of the day's last manual window.
- **The result is stored in segments**, and **the whole stretch comes out as fixed as the row that
  was dragged**: every row it writes or absorbs inherits the target's padlock. Half a stretch left to
  the engine came apart on the very next pass — a padlocked `10:00-14:00` beside an automatic
  `15:30-17:30` was reflowed to `15:30-19:30`, so the drag stored a length nobody asked for. Same rule
  as `autoLock`: what holds a hand-made shape has to hold all of it.

**What the edge sizes is the STRETCH that begins at that row's start**, not the rectangle: the row
plus the rows of its own job that continue it on that day and *cannot survive the resize on their
own* — one the engine does not lay out either (the other fixed half of the same unit), or one the new
segments land on. **An automatic row the stretch does not reach is left to the engine.**

**The COUNTERPARTY IS ALWAYS A ROW THE ENGINE STILL LAYS OUT.** It is never handed to a row outside
the pool, because there a raw `duration` writes geometry that stays.

**A LOCKED row the stretch rewrites is named** in `touchedLockedBlockIds` and the UI warns; "a locked
block is never grown silently".

**Margin time needs no extra padlock.** A resize reaching into a visual margin used to pin its row,
because the engine's index space has no margin minutes; every row this gesture can touch already
carries the padlock that let it be sized. `touchedLockedBlockIds` is still computed BEFORE the
stretch's padlock is spread, so a resize never reports a padlock it has just applied.

*(Why: DECISIONS.md § Block Resize, and Shrinking That Asks, and § The Padlock Holds the Length.)*

### A Hand-Set Duration — REMOVED 2026-08-18
> **A block is exactly as big as the room it has. There is no stored exception, and the padlock is
> what fixes a length.**

`manual_duration` said "the owner drew this length, keep it" and made a job's run END at that row. The
owner worked out why it could not be a rule of its own: *«la duración de un bloque nunca es fija. Es
fija cuando se aplica entre bloques de otras tareas porque eso es lo que dura… si lo reduce de
miércoles crece en jueves y sitio se libera en miércoles y pasa allí quedando exactamente igual. Si el
usuario quisiera hacer eso, significa que quiere acabar la jornada antes… tendrá que añadir un gap.»*

**What went with the column**, each of which existed only to hold it up:
- a hand-set length **ending its job's run** in `buildQueue`, `unitOf` and the grid's `buildRuns`;
- **"no more of that job lands on that day"** (`closedDays`) and the **deferral** that let the jobs
  behind take the hours it freed — the ONE documented break in strict order, which is now unbroken;
- the stretch **absorbing rows already hand-set** (now: rows the engine does not lay out either);
- a **cut releasing the mark**, and every other "lost when something else rewrites the length" rule;
- ***back to automatic*** — `PATCH /api/blocks/:id {action:"release"}`, `releaseBlock`,
  `notices.released`, the ruler glyph and its two buttons. There is no mark left to hand back;
- `usesManualOnlyTime`, whose only reader was the resize's padlock-the-margin rule.

**Where the intent lives now:** *Block Resize* (the padlock holds the length) and *Capping a Day* (a
gap ends a day early, and only the owner makes one).

*(Why, and what the migration does with the shop's `manual_duration = 1` rows: DECISIONS.md § The
Padlock Holds the Length.)*

### Capping a Day — "we only do 2 h of this today"
Three honest ways, all of which fall out of the rules above:

1. **Put another job after it.** The drop re-ranks the queue, the job splits there, and the day reads
   `A 2 h, B, A 4 h`.
2. **Stop the day with a gap.** A **one-click action** on the block's hover bar ("Cerrar el día
   aquí"): it pre-fills a gap from a chosen moment to the end of the day's last enabled period, asks
   only for an optional reason, and states what the day loses and whose hours the engine will move.
   **Across the comida that is TWO rows** and the plan says so (`CloseDayPlan.rows`), while the hours
   it asks for are the day's NET working minutes — closing at 13:00 is 5 h, not 6.5 h. One request
   still: the form posts the stretch and the save cuts it, so there is one refusal and one undo.
   It is an ordinary gap — same endpoint, same refusals, editable and deletable afterwards.
   **It is also what the refused resize offers**, so a reach for the bottom edge of an automatic row
   ends one tap from the thing that really works. **THE APP NEVER CREATES THE GAP ITSELF**, from
   either entry point: it fills the form in and the owner presses Guardar. Both entry points read the
   same `closeDayOffer.ts`, so they can never propose different gaps.
3. **Padlock the block and then shrink it.** The padlock is what holds the shorter length (*Block
   Resize*); the hours it frees go to the job's last block the engine still places, and the room it
   leaves goes to whatever the queue has next. On its own a shrink of an automatic row is refused,
   because there the length is the room the row has.

What none of them may do is leave a hole the engine refuses to fill for no reason: **if nothing
occupies the rest of the day, the shop IS free then, and the app exists to say so.** What the action
must NOT promise is *where* those hours land: only `compose` knows.

### Job Editing: Adding/Removing Hours (LIFO)
- **Add hours**: append to the job's last block **that the engine can still place** — its last block
  in the movable pool. Mon 2h + Wed 1h + Fri 3h, adding 2h makes Fri 5h. Subsequent jobs cascade
  forward. If the job's last block is **outside** the pool, the new hours get their **own new block**.
  The growth target must agree exactly with the movable pool.
- **Remove hours**: decrement from the **last block**, reaching every block including those outside
  the pool — shrinking frees space rather than claiming it, so it cannot produce an illegal row.
  Unlocked rows first; a padlocked one only as a last resort, and then reported in
  `touchedLockedBlockIds`. If a block reaches 0 it is deleted and the next becomes the new "last".

### Job Editing: Name/Description/Color Changes
No impact on calendar layout or block positions. Metadata only.

### The Calendar Sits On The Quarter Hour
> **A quarter of an hour is the smallest row the calendar can draw and the smallest amount the owner
> can aim at. `MIN_ROW_MINUTES` (src/lib/validation.ts) is held equal to the drag layer's
> `SNAP_MINUTES` and to the `TimeSelect` step by a test.**

- **The scissors** floor both halves (409 `split-below-minimum`).
- **The engine** never stores a row under it and never fills a hole too small to hold one — see the
  table in *Fill and Overflow, Always* (`takeableFrom`), which is where the whole of this rule now
  lives for auto-fill.

**It is deliberately NOT a write-path guard**: the one sub-quarter row a gesture can still produce is
an Open Decision, and a floor on the write path would answer it by accident and leave the owner
unable to delete the sliver it refuses to store.

> **KNOWN DEFECT — the one-minute rank nudge crosses the lunch break and the day comes back off the
> quarter hour.** Measured 2026-08-18, and it is a broken invariant rather than an open question, so
> it is written here beside the rule it breaks rather than in *Open Decisions*.
>
> A drop aimed at the upper third of a row that starts at 08:00 goes in BEFORE it, and `rankFor`
> writes the rank one minute earlier — `startMinutes: 479`, inside the top visual margin, which is
> below `MIN_MANUAL_ONLY_MINUTES` and so correctly does NOT padlock. But the provisional row is then
> cut at the lunch break FROM THAT MINUTE (`resolveDrop` step 2, `segmentDroppedRow`): a 7 h run
> becomes `07:59 +361` and `15:30 +59`, and because the next job's row ranks between them
> `buildQueue` cannot join them again. One run arrives at the engine as **two items of 361 and 59
> minutes** — quantities no gesture asked for — and `takeableFrom` then cuts the 361 into 346 + 15.
>
> Reproduced over HTTP with no browser (`PATCH {action:"move", date, startMinutes}`), on a Wednesday
> whose only obstacle is a padlocked Tuesday:
>
> | rank | stored |
> |---|---|
> | `480` (08:00) | `Wed 08:00-14:00 6 h` + `Wed 15:30-16:30 1 h`, then the next job. Clean |
> | `479` (07:59) | `Wed 08:00-13:46 5,77 h` + `Wed 15:30-15:45 0,25 h`, the next job, then `Thu 10:15-11:14 0,98 h` of the FIRST job again |
>
> With a 6 h 15 m run the same rank stores **`Thu 10:15-10:29`, a 14-minute row** — the thing this
> rule says the engine never stores. The nudge and the segmentation are both older than *Fill and
> Overflow, Always*; what is new is that an off-quarter queue item now propagates into the stored
> layout instead of being moved whole, and that the ghost promises a division the save contradicts
> (measured: the ghost said *«6 h el Mié 19 · 1 h el Jue 20»*, the save stored 5,77 h and 1,23 h).
> Hours are still conserved and nothing straddles a break.
>
> The fix is a decision, not a patch: either the rank is clamped to the first minute of the periods
> when the margin it asks for is below `MIN_MANUAL_ONLY_MINUTES` (the same reading
> *A Minute With No Working Time* already gives the lunch band), or a rank drop is not segmented at
> all — the reflow re-cuts it anyway. **Same cause as Open Decisions 6 and 7; answer the three at
> once.**

### Blocks and the Lunch Break — And Gaps, the Same Way
- `duration` always means **net working hours**, so every row is a solid rectangle on the clock and
  can be interpreted without reading Settings. **A GAP IS ONE OF THOSE ROWS** (since 2026-08-19), so
  everything in this section is stated of gaps too, over the *manual window*: a gap of 8 h from 10:00
  is `10:00-14:00` plus `15:30-19:30`, drawn as ONE unit with the seam and the `sigue…` marks, its
  reason on the first row and one lane between the two.
- Work crossing the lunch break is stored as **two blocks** of the same job (13:00-14:00 and
  15:30-17:30 for a 3 h stretch).
- On screen, consecutive segments of the same job are drawn as **one grouped unit** (outer rounded
  corners, label on the first, single drag handle). Two rows are one unit when nothing **workable**
  separates them, read over the *manual window*.
- **The unit is marked at BOTH ends**: `4 h · sigue…` above the break and `…sigue · 4 h` below it,
  the ellipsis on the side the work carries on, each with the dashed edge on that side and its own
  tooltip line.
- **What the mark names is the BREAK BETWEEN TWO WINDOWS, not the join between two rows.** The hole
  must START where one window ends and FINISH where the next begins (`seamAbove` / `seamBelow` on
  `BlockSegment`). The *rounded corners* stay with the row's position in the unit, which is a
  different question.
- **Auto-merge** joins two blocks of the same job only when they touch **inside the same period on
  the same day**. The two halves around lunch deliberately stay two rows.
- **TWO GAPS THAT MERELY TOUCH ARE NEVER MERGED**, in storage or on screen: each carries its own
  reason and merging would destroy one. A gap unit is grouped by `adjacentInWindows` **and the reason**
  — the reason is all a gap has to be identified by, standing where a block's `projectId` stands
  (`groupGaps` / `gapSegmentsOf`, next to the block pair in `grouping.ts`).

### The Unit of a Drag Is the RUN
> **Dragging any block moves its whole RUN: the consecutive blocks of that job with no other movable
> job between them. The lunch break does not break a run. A NIGHT does not break one. Another job
> does — that separation is the owner's own decision, so the drag respects it and stops there.**

That is exactly the engine's `QueueItem`, and it is read the same way on purpose: the engine will lay
the run out as one item however it is dragged, so a drag that moved anything else would be arguing
with the reflow. Two consequences fall straight out of `buildQueue`:

- **A unit the engine never moves is SKIPPED, not treated as a separator.** Fixed work (padlocked,
  weekend, past) is an obstacle the reflow flows around, so it does not end the run — and it is its
  own drag unit, because dragging it is a literal placement.
- **NOTHING ELSE DIVIDES A RUN.** A hand-set length did until 2026-08-18; with `manual_duration`
  gone there is no stored flag either side reads, and a run is a job's consecutive movable groups.

**One request, one transaction.** The client names the run it drew (`unitBlockIds`, from
`buildRuns` in `grouping.ts`) and sends the run's total minutes; the server folds those rows into the
one the request names and moves them as ONE row, stored in segments at the destination. Ids that are
not really part of the run are **ignored, not refused**: the list describes what the owner saw, and
the server is the authority on what it means. An HTTP caller that names one row still moves one row.

**The server's `unitOf` (src/lib/composition.ts) must give the same answer the grid drew**, and is
written as a transcription of the grid's two steps in the grid's order: `groupBlocks` (one job's rows
on ONE day joined by `adjacentInWindows`) then `buildRuns` (consecutive groups of one job). It must
**not** filter to the target's own date — that was a real defect, and it made every cross-day run
move only its first day's part.

*(Why: DECISIONS.md § The Unit of a Drag Is the RUN.)*

### A Drop Is Stored In Segments
> **A dropped block is cut at the break between two MANUAL WINDOWS, exactly like everything the
> engine places is cut at the break between two periods.** 6 h dropped at 10:00 is stored as
> `10:00-14:00` plus `15:30-17:30`, two rows of one job, on every kind of day.

It applies to the merge below too. One thing it deliberately leaves alone, because it is latitude a
hand drop already has and it is not a straddle: anything whose tail would land past midnight. A row
that starts in a **margin** is not one of them — the margin is inside the manual window.

`segmentDroppedRow` in `src/lib/dropSegments.ts` is imported by both the engine and the preview
rather than restated in each.

#### A Minute With No Working Time Means The Next Minute That Has Some
> **A gesture aimed at a minute no window covers — the lunch break — starts at the first minute that
> can hold work. On the documented shift 14:00, 15:00 and 15:29 all mean 15:30.**

The break is not a slot. Aiming at it asks for work in time the shop cannot work, and the whole band
is already an arithmetic dead zone for a **resize** (`durationTo` counts net working minutes, so all
three of those minutes commit the same duration), so the drop reads it the same way.

- **It is NOT the visual margins' latitude.** A margin is workable time the owner chose and a row may
  sit in one; the break is not workable at all. The margins are inside the manual window, so nothing
  about them changes.
- **Where there is no later working minute the release is left exactly as it came**: past the end of
  the day, and on a day whose afternoon is switched off, where the hole runs to midnight. There is
  nothing to offer, so *Aiming Below What A Day Holds Means The Next Day* and the end-of-day guard
  answer instead.
- **A Monday-Thursday drop aimed at the break therefore does NOT padlock**: read as 15:30 it is an
  ordinary request inside the periods, so it is a queue rank like any other. The **day** still pins
  (Friday, the weekend), and so does a margin.
- **A GAP reads it too** (changed 2026-08-19). A gap's duration is net working minutes, so a gap aimed
  at the comida is stored from 15:30 and a gap can no longer be recorded inside the break. Nothing
  happens during it by definition.

`firstWorkingMinute` (`src/lib/manualWindow.ts`) is the rule, and it is read in exactly two places
so a preview and a write cannot disagree: `dropLanding` settles the gesture's start (the padlock, the
queue rank and the ghost's rectangle are all decided from it) and `segmentDroppedRow` lays the stored
rows out from it — **so its returned start may differ from the one asked for and every caller reads it
back**. `reachableRuns`, and therefore `clockEndOf`, read a non-working start the same way, because the
end-of-day guard and the drag's clamp decide from that number what the write path will do.

*(Why: DECISIONS.md § A Minute With No Working Time.)*

### A Drop That Overlaps
A drop onto the **weekend, the frozen past or a padlocked row** lands where the engine may not
reflow, so the overlap is resolved when the drop is saved, in the same transaction, **before**
recomposition — never by a general pass over the calendar.

- **Same job → one block, hours SUMMED.** Existing Sat 09:00-11:00 plus a 2 h drop at 10:00 becomes a
  single **09:00-13:00, 4 h** row. Not 09:00-12:00: an interval union would silently eat an hour.
  The earlier row survives (keeps its id). If the sum crosses the lunch break it is stored as two
  rows, the absorbed row's id reused for the second.
- **Different jobs → the cut job is split and its tail pushed after the new block.** A at 09:00-11:00
  with B dropped at 10:00-11:00 becomes A 09:00-10:00, B 10:00-11:00, A 11:00-12:00. A keeps its 2 h.
  Neither piece may straddle a non-working interval; a **weekend tail stays on the weekend** (Sat →
  Sun). A tail pushed out of the frozen past skips the weekend and the Friday buffer.
- **A GAP is never overlapped either.** Gaps and blocks are ONE occupancy set. Only on the fixed
  side: on Mon-Thu the reflow keeps auto work off a gap by itself.
- **A locked block of ANOTHER job is never overlapped.** A *cut* is allowed while the drop is the
  locked one, because then the lock keeps its exact slot and only the other job moves.
- **Two rows of the SAME job merge whatever their padlocks**, and the merged row keeps the padlock.
- Both cases hold the hours invariant for every touched project.
- This is **not** auto-merge. Auto-merge joins rows that *touch* inside one period and never runs on
  the weekend; this resolves an *overlap* a human just created, on any day.

**A drop onto a movable row is cut too.** Queue order is `date, start_time`: without the cut,
dropping B at 10:00 into A's 08:00-14:00 row leaves the queue reading `A, B`, so A is laid out whole
and B lands after the entire block — the drop is silently ignored. Cutting A at the drop's start
makes the queue read `A, B, A`.
- only a row that **starts before** the drop is cut;
- the tail is one row ranked just after the drop's end — a queue rank, not a position;
- **fixed rows are ignored** on this side, because flexible work flows around them;
- there is no same-job merge on this side;
- cutting a row rewrites its length, and nothing on the row claims otherwise: there is no stored
  length to release.

### A Drop Onto Another Row's Start Goes BEFORE It
> **Releasing exactly on a row's start means "put me before this one". The row underneath stays whole
> and follows. To cut a row, release BELOW its start.**

**The SERVER settles the tie.** On a day the engine reflows, `resolveManualPlacement` re-ranks every
movable row of another job that starts on the drop's exact minute to just behind it: nothing is cut,
no hours move. On the fixed side the same answer falls out by construction — a drop covering a row
from its very start leaves no head, so that row is pushed whole.

**A PINNED placement is never nudged at all.** Where the row keeps the minute it was released on —
the weekend, the colchón, a visual margin, a locked unit — that minute is not an ordering, it is the
clock, and it is what gets stored. `rankFor(…, pinned)` in
`src/components/calendar/geometry.ts` is the one place both rules live.

### Thirds Decide Where a Drop Lands Relative to the Row Under It
> **Over another row the aim collapses to one of three answers. Over free time it is left exactly as
> it came — the owner is pointing at the clock and there is nothing to be relative to.**

| the aim falls in the row's… | it becomes | and the drop… |
|---|---|---|
| upper third | its START | goes in BEFORE it; the row stays whole |
| middle third | its MIDDLE | CUTS it, the tail carries on after |
| lower third | its END | goes in AFTER it |

- **A row too short to cut has TWO targets, not three.** Under half an hour neither half of a cut
  could be a legal row, so such a row is split down the middle into "before" and "after".
- **The cut is the row's own MIDPOINT, snapped, and never within a snap step of either end**: the
  owner is choosing a ROW to cut, not a minute to cut it at.

`aimAtThirds` in `src/components/calendar/dropAim.ts`, applied in `previewMove` **before** the day
question. It replaces exact-minute aiming, which asked for a precision a mouse on a shop PC does not
have. *(Why, and why the cut has to stay reachable by drag: DECISIONS.md § Thirds.)*

### A Drop Onto a Day the Engine Reflows Is Never Refused
> **On a day the engine lays out — Monday to Thursday, and the Friday buffer, from today on — a drop
> is not a placement: it is a re-ranking of the queue, and the reflow is what finds the room. So it
> may NEVER be refused because its footprint collides with work or with a gap.**

**A drop the engine still owns — unlocked, inside the periods of a reflowing day — is never refused
at all.** The reflowed side of the resolver has no failure mode.

**A drop that PADLOCKS gets one latitude, and then the refusal stands.**
1. **SLIDE** — the drop moves forward, on the day the owner named, to the first start where its
   footprint touches neither a **gap** nor a **locked row** (the only two things nothing will ever
   move out of the way). Forward only, never out of a manual window, never past the end of the day.
   It keeps the padlock.
2. **AND THEN THE REFUSAL STANDS** — a day with no clear slot is refused, naming the gap or the row
   in the way. It may not give up the pin.

| the drop is on… | refuses for a collision? | why |
|---|---|---|
| Monday-Thursday (`auto`), today onwards | **never** | the reflow lays the day out; the drop is a rank |
| Friday (`buffer`), today onwards | **never** | in the movable pool too — it slides instead |
| Saturday, Sunday (`manual`) | yes | the engine lays out nothing there: the exact minute IS the promise |
| a closed day (`day_overrides`) | yes | same as a weekend |
| a past day (frozen) | **refused outright** | not a collision rule: 409 `drop-onto-past-day` |
| a drop that STARTS in a **visual margin**, any day | yes, once the slide finds nothing | the drop padlocks there, so it lands literally |
| a footprint that merely RUNS PAST the end of the periods | **never** on Mon-Thu | it is a rank; the reflow carries the overflow to the next day |
| the **lunch break**, any day | it is not a slot: the drop starts at 15:30 and is then judged by the day it is on |
| ANY day, when the row being dragged is already **locked** | yes, once the slide finds nothing | the padlock means the row lands where it was released |

A padlocked row being dragged is **slid** like any other padlocking drop: the padlock keeps the
ENGINE off the row, it does not stop the owner aiming it.

The codes, all 409 and all writing nothing: `overlaps-gap`, `overlaps-locked-block`,
`merge-exceeds-day`, `displaced-hours-unplaceable`. Their sentences name the reason rather than
opening with *«Ahí no cabe»*.

### Aiming Below What A Day Holds Means The Next Day
> **A drop that LANDS LITERALLY and whose footprint would run past the end of its day is not refused
> and is not clamped: it lands on the NEXT DAY the calendar would use, at the top of that day's
> working periods.**

**A DROP THAT IS ONLY A QUEUE RANK IS NEITHER ROLLED NOR CLAMPED** (2026-08-17) — an unlocked row
released inside the working periods of Monday to Thursday. It has no footprint to fit: the engine
takes what the day has left and carries the rest to the next day it can use (*Fill and Overflow,
Always*), so 6 h released into a 4 h afternoon is 4 h there and 2 h the day after. Rolling it was
the owner's own defect — the row moved to a day it was already on and the request answered 200 with
nothing changed — and clamping it said «6 h no pueden empezar después de las …» about a release that
works perfectly well. Both sides ask `dropLandsLiterally`, so the ghost and the write agree, and what
the ghost draws in their place is the division itself — see *The Ghost of a Rank Is the Division*.

**Where it still applies — a drop whose minute IS the promise:** the buffer, the weekend, a closed
day, the frozen past, a visual margin, and a padlocked row anywhere.

**It only ever leaves a day the engine LAYS OUT, and only lands on one** (`dayReflows`):
- from Monday to Thursday, and from the Friday colchón, it rolls forward to the next such day. The
  buffer is one of them — and a run that lands there padlocks like any other Friday drop;
- from the WEEKEND, a closed day or the past it does not roll at all. There the drop is a literal
  placement on a day the owner named on purpose, so moving it to another DATE would be a bigger
  surprise than the end-of-day refusal it gets instead.

**Measured over the PERIODS on the day it rolls to, over the MANUAL WINDOWS where it was released.**
A run no day can hold on those terms is left exactly where it was released and the end-of-day guard
answers for it.

**ONE IMPLEMENTATION.** `dropLanding` (`src/lib/dropSlide.ts`) is the rule. `moveBlock` and
`splitBlock` apply it BEFORE the padlock is decided, so a drop that rolls onto Friday is padlocked
for being on the buffer. The ghost's `resolveDropDay` (`src/components/calendar/dropAim.ts`)
**imports it** and adds only what the server has no opinion about: the clamp, which is a fact about
the drag axis, and the two flags the ghost speaks with (`rolled`, `clamped`). The client's walk stops
at the week on screen and clamps rather than rolling onto a column the owner cannot see.

**THE GHOST ASKS THE SAME TWO QUESTIONS THE SERVER DOES**, and they are different questions:

| the question | the server | the preview |
|---|---|---|
| does the row keep the minute (and get a padlock)? | `pinsTheRow` | `dropPins` |
| may the drop be slid rather than refused? | `dayReflows` | `dayReflowsOn` |

`resolveDropPreview` applies the SLIDE and the RE-RANK itself, and the ghost is drawn where the row
will really be. The slide is **not implemented twice**: `firstClearStart` lives in
`src/lib/dropSlide.ts` and both sides import it.

### Locked Blocks Don't Act as Walls
- `locked = true` means "don't auto-move this block during recomposition".
- Flexible blocks **flow around** locked blocks (they don't stop at them).
- The user CAN manually move locked blocks, change their duration, or place other jobs around them,
  and CAN toggle `locked` at any time (except on a past row).
- Because overflow always chains forward, a locked block can **never** make placement fail. There is
  no "Can't fit job due to blocked slot" error.

### Overflow Behavior
- A job takes what the day's plannable hours can hold and the remainder goes to the next day it can
  use, respecting the Friday and weekend rules — see *Fill and Overflow, Always*.
- Beyond Friday, overflow continues into the following week, up to `planningHorizonWeeks`.
- If it still does not fit, roll the whole recomposition back in one transaction and show one clear
  message. The calendar is never left half-recomposed.

### Deleting a Job Leaves Its Past Intact
> **Deleting a job removes its FUTURE rows and recomposes. Its PAST rows become GAPS, so nothing on
> those days moves, and each gap says what it replaced: `Trabajo «Barandilla» eliminado`.**

A gap holds the time exactly where the work was — same date, same start, same duration, the same
fixed occupancy — so the day keeps its shape and nothing later is pulled backwards into the hole.

**The name is composed AT DELETION TIME and stored in the gap's `reason`.** The sentence is frozen in
whatever language the app was in when the job was deleted; a gap's `reason` is user data and stays
editable afterwards. The server composes it out of the locale files themselves
(`gapForm.deletedJobReason`, `src/lib/text.ts`), with the language the owner is reading passed on the
request (`DELETE /api/projects/:id?lang=`). **Callers must pass `i18n.language`.** It is the only
prose the data layer ever produces; every other message is an i18n KEY the UI resolves.

`preservedGapIds` in the response says how many rows were kept, so the owner can be told
(`notices.deletedJobPast`) rather than left to notice.

### Edge Cases Handled
1. **Delete job**: confirmation required. Future blocks deleted in cascade, past blocks kept as gaps.
   Calendar recomposes if space frees up.
2. **Edit total_hours to exceed remaining week**: distributes across multiple future days, then
   following weeks, bounded by `planningHorizonWeeks`.

---

## UI/UX Behavior

**Reference wireframes** (gitignored, local only): `documents/workwise_wireframe_vista_semana.png`
and `documents/workwise_wireframe_bloque_y_panel.html`. They are the authority on layout.

### Visual Design
- **Light theme only.** `public/brand/workwise-tokens.css` already ships dark values behind
  `prefers-color-scheme`, so `<html>` carries `data-theme="light"` to keep them dormant. Never
  hardcode a colour in a component; always go through a token so dark stays cheap.
- Import `public/brand/workwise-tokens.css` before `app/globals.css`.
- **Project colours** are a fixed swatch picker built from `--ww-project-1..8`. No free hex input —
  amber is reserved for the app itself.
- Hairline borders (`0.5px`), `--radius` rounded corners, generous whitespace.
- **Icons**: Tabler (`@tabler/icons-react`), bundled locally — no CDN.
- **No native `<input type="time">` or `<input type="date">` anywhere.** Both render in the
  BROWSER's locale, not the page's. Every time and every day goes through `useFormat()`:
  - times from the quarter-hour `TimeSelect`, whose step is held equal to `SNAP_MINUTES` by a test;
  - days from `DateSelect`, which offers the days of the schedule, spelled "Mié 12 ago" and grouped
    under the header's week label. Its window runs a few weeks back to the end of the planning
    horizon, and the day already stored is **always** an option even when it falls outside.

### Calendar View
- **Horizontal week layout**: all seven columns always rendered. Mon-Fri at full width; Sat/Sun
  narrow and de-emphasised, so dragging to the weekend works with no extra state and no setting.
- **Time axis**: vertical, from the top visual margin to the bottom visual margin. Grey bands mark
  the margins and the lunch break, labelled "solo arrastre manual".
- **The axis is PIECEWISE, and only the break between two periods is compressed.** Working time and
  the visual margins share one scale; the break is drawn as a fixed **28 px seam**
  (`BREAK_BAND_HEIGHT` in `geometry.ts`) however tall an hour is — "hay un hueco pero es
  despreciable". A margin is never compressed: the owner puts real work in one by hand.
  - **The seam is DISCREET: the margins' own grey fill between two hairlines in the ordinary
    border colour.** No hatch, no heavy rules. Three things already say "nothing lives here" —
    it is the same grey as the top and bottom margins (a margin and the comida are the same kind
    of nothing), it spans the week edge to edge and square (nothing else on the grid has that
    shape, so it cannot be misread as a very short block), and 28 px where an hour is 50-plus is
    itself the statement.
  - The fitted scale is spread over WORKING minutes only, each seam costing its flat height first.
  - **Both directions stay exact everywhere, seam and margins included** — see *One Axis Per Gesture*.
    A pixel inside the seam is worth ~3 minutes instead of ~1; **what a pointer in there MEANS is
    unchanged**: a resize counts net working minutes, so the seam is the same dead zone it always was
    (14:00, 15:00 and 15:29 commit the same duration), and a DROP is now read the same way — every
    minute of the seam means 15:30 (*A Minute With No Working Time*). Nobody works there, so a target
    that redirects to the first minute they do is the answer, not a harder aim.
  - **A rectangle is the clock interval it occupies** (`Timeline.heightBetween`). No row straddles a
    break — gaps included since 2026-08-19 — so every rectangle's height is its own minutes exactly and
    **nothing on the grid is drawn over the seam**.
- **Every hour is labelled**, plus both edges of every period. A label is dropped only where it would
  print over one already placed — 15:00 inside the seam, 20:00 under a cramped 20:30. It replaces "an
  interior tick every three hours", which labelled 08:00 and then 11:00.
  - **What gives way is decided by a precedence, most meaningful first** (`axisTicks`): every PERIOD
    EDGE, then the two ENDS OF THE AXIS, then the HOURS. An hour can be counted from its neighbours;
    an edge cannot. An axis end is only the outer lip of a grey margin, so an edge outranks it.
  - **Both demotions are real configurations, not hypotheticals.** Settings accepts a 10-minute break
    (`08:00-14:00` then `14:10-18:10`), which the seam deliberately draws at its own 9 px rather than
    stretching to 28 — and two 18 px labels do not fit in 9 px, so `14:00` and `14:10` printed one
    through the other. The margins step in half hours, so at `MIN_PIXELS_PER_HOUR` a 0.5 h margin puts
    the axis end 21 px from `08:00`. **The earlier of two edges survives** (it is when work stops), and
    the boundary is not lost with its label: the seam draws a rule on both of its own edges.
  - **Nothing left on the axis ever overlaps anything else** — asserted as a property over every shift
    Settings can produce at every scale the window can ask for, not just the cases above.
  - The two hanging classes (`.tickFirst` / `.tickLast`) are keyed on the MINUTE, never on the tick's
    index: either end can now be dropped, and by index the label that inherited position 0 would be
    hung below its rule while the collision arithmetic had measured it as centred.
- **Day headers** carry their state: `Lun 10 · congelado`, `Mar 11 [hoy]`, `Vie 14 · buffer`. On a
  CLOSED day the state is the owner's own words — `Mar 1 · Feria`, from `day_overrides.note`, falling
  back to *cerrado* when there are none: the dimmed column already says "closed", and the reason is the
  only thing it cannot.
- **Summary strip** above the grid, amber-tinted:
  `Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre`. This is the stated
  objective of the app. Served from one endpoint so `composition.ts` owns the arithmetic.
- **Header**: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, and `Hoy`, `+ Nuevo trabajo`, language,
  overflow menu.
- **Visual blocks**: tinted fill with a saturated border in the project colour, name + hours. A unit
  cut at the lunch break is marked at both ends. Engine-placed Friday blocks read `desborde 2 h` and
  get a distinct border so an overrun week is visible at a glance.
- **The mark.** One, and a row either carries it or does not:

  | mark | what it fixes | drawn as |
  |---|---|---|
  | padlock (`locked`) | the ROW — its place AND its length | the glyph, plus a solid **whole outline** — the rectangle does not move and the engine does not re-derive it |

  The tooltip is one line naming it and what it fixes, so it never needs a legend. The solid outline
  does a second job: on Friday it is the difference between `desborde 2 h` (dashed) and a row the
  owner put there on purpose, so `isOverflow` excludes any unit with a padlocked row in it.
- **One mark, one undo**: pressing the padlock. It hands the row back whole, length included. (A
  second mark for a hand-set LENGTH, drawn as a ruler with *back to automatic* beside it, existed
  until 2026-08-18.)
- **The bottom-edge strip is drawn on every row but a PAST one, and says which of the two it is.**
  Live (`ns-resize`, the job-coloured pill) exactly where the server will size it — a padlocked row,
  or one on a weekend. Inert (`.resizeInert`, `cursor: help`, a grey hairline pill) everywhere else,
  where it names the padlock, the gap, another job behind this one and the job's own form, and its
  refusal carries the *Cerrar el día aquí* action. **On a past row there is no edge at all** — the
  body answers the press with `notices.pressOnPastDay`. Withholding the strip on an automatic row was
  tried and reverted: the press fell through to the body and started a MOVE.
- **Past days**: desaturated, not a drop target, and with no gesture on their rows at all.
- **Empty columns**: `libre` / `—` sit in the middle of the day's LONGEST WORKING STRETCH, drawn as a
  small dashed pill (`emptyLabelMinutes` in `geometry.ts`, with a test).
- **Painting on empty space**: a drag on a column's background draws a band in the gap colour, dashed
  because nothing is written yet, in one rectangle per row the absence will be stored as. It opens the
  absences form on release — see *Painting an Absence on Empty Grid Space*.
- **Drag-drop**: mouse only, with a ghost during the drag. The ghost states the real outcome before
  the mouse is released — which row will be cut (drawn as a seam), merged into, or refused; whether
  the drop rolls to the next day (`grid.dropNextDay`); whether it slides past something fixed; and
  whether it will padlock. The ghost is drawn **in segments**, one rectangle per row the gesture will
  be stored as, because one rectangle straight through the grey band promises a shape that will never
  exist. **A RESIZE past the break is drawn the same way.**
  - **A GAP's two gestures get the same ghost, in its own two sentences** (`gapDropEffect`): the rows
    the absence will be stored as, and either the job it will push forward (`grid.gapDisplaces`) or
    the fixed row that will make the save write nothing (`grid.gapBlocked`, drawn denied). A gap is
    never slid, never merged and never cut, so none of a block's other sentences can be true of one —
    which is why it has a vocabulary of its own rather than borrowing that table.
  - **And the drawn footprint never leaves the day** (`footprintWithinDay`). `segmentDroppedRow` returns
    a stretch UNCUT when its tail would pass midnight, so the server can refuse the drop as it was
    made — and since the drag unit is the whole RUN, that is the ORDINARY case, not a corner: an 18 h
    run drew a single rectangle over the entire column, seam included, on every day the
    pointer crossed. The drawing is capped at the net minutes the day can still hold, so the shape is
    one that can exist; the label beside it already says the rest does not fit today. Storage is
    untouched — only the rectangle is.

#### The Ghost of a Rank Is the Division, Across Columns
> **A drop that is only a queue RANK is drawn as the ROWS the reflow will store: what this day has
> left, and the remainder on the day it carries to. The label names the days —
> «4 h el Mié 19 · 2 h el Jue 20» — and the hours line is replaced by it, because the total is the
> sum of the parts.**

Since *Fill and Overflow, Always* a drop on a day the engine lays out is never "it fits" or "it does
not", so one rectangle at the pointer could only ever be half the answer. `planDropSpill`
(`src/lib/dropSpill.ts`, shared with the engine, which imports `takeableFrom` from it) walks the
release day and the days after it exactly as `compose` does, and the grid draws a rectangle per piece
— on **every column they reach**. One ghost, one insertion rule, several rectangles:

- **The hours begin where the work in FRONT of them ends** (`fillStartFor`), not at the released
  minute: the engine places the item at its cursor, so 6 h released at 16:00 into an afternoon free
  from 15:30 is stored from 15:30 — and drawn from there, or the label's two numbers would be the
  two the save contradicts. The rank sent is still the raw minute; only the drawing moves.
- **The room is what nothing will move out of the way** — the gaps and the padlocked rows — because
  everything else is ranked behind the drop and the reflow lays it out after these hours. So the
  hole in front of a lock is drawn filled and the work continues after it.
- **Every rectangle is a legal row**: inside one period, never in a margin (auto-fill does not enter
  one), never under a quarter of an hour (`takeableFrom`, the engine's own floor). A hole too short
  to hold a row is drawn as what it is — nothing here — and the whole gesture appears on the next
  column, label and all.
- **The heavy rule is drawn once**, on the drop's own first row: there is one insertion point however
  many rectangles the hours land in. The continuation carries `…sigue aquí · 2 h`.
- **The clamp, the roll and «no caben en un solo día» are drawn only for a drop that lands
  LITERALLY** — the buffer, the weekend, a margin, a padlocked row — where they are true.
- **The scissors' second click reads the same plan** (`placingGhost`), for the same reason: a
  fragment is a drop. Its own row does not leave the calendar, so it stays in front of the fragment
  in the queue.

**What it still cannot promise is the POSITION**, and that is unchanged: only a whole pass knows where
the queue's cursor reaches, so a drop whose rank is the one it already had is laid out where it
already was and the ghost will have drawn it from the release day. That is what *A Drop Always
Answers For Itself* is for — `unchanged` and `settled` now always fire.
- **The week is reachable without putting the block down.** While a move is in the air both ends of
  the grid carry a rail naming the neighbouring week; holding the block on one pages the calendar —
  see *Dragging To The Edge Changes Week*.
- **The ghost never invents a clock time.** A drag's duration is the whole RUN's net working minutes,
  across days, so `start + duration` is an end-of-day reading only while the day can hold every one
  of them (`footprintEnd`, `src/components/calendar/dropEffect.ts`). Where it cannot, the ghost names
  the START and the hours — both true — and says the run is longer than the day holds
  (`grid.dropLongerThanDay`) instead of the clamp's «no pueden empezar después de…», which claims a
  start that would work. **Both sentences are for a drop that lands LITERALLY only** (2026-08-17): on
  a day the engine reflows, "these hours do not fit in one day" is the deleted rule speaking, and what
  is said instead is the division — see *The Ghost of a Rank Is the Division*. A RESIZE keeps them,
  since its length really is stored on one day.

### A Drop Always Answers For Itself
> **Every drop reports what became of it. The only drop that may say nothing is one whose row is
> visible, at the minute it was released, with nothing else changed — because then the calendar is
> already the answer.**

| outcome | when | what it says |
|---|---|---|
| `unchanged` | the server wrote **nothing** (`changed === false`) | admits the drag changed nothing, and **teaches the route in order: padlock first, then move**. Decided from the field, never from geometry, and asked before every other branch — a vanished id is the only thing that cannot co-occur with it |
| `pinned` | the drop PADLOCKED the row and it did not have one before | it stays there, and names the padlock as the way out. A row that was already padlocked says nothing |
| `filled` | the hours ended up on **more than one day** (`placedBlockIds`, grouped by day) | «llena lo que quedaba del día y sigue en el siguiente: 4 h el Mié 19 · 2 h el Jue 20» — the same words the ghost used. It outranks every sentence about where the ROW went, because those describe one row and this describes all of them |
| `settled` | the reflow put it well away from the drop point | a drop is a rank; lock it to pin it |
| `leftWeek` | it landed AFTER the week on screen | names the date its hours carry on from |
| `pulledBack` | it landed BEFORE the week on screen | the queue laid it out where there was room; **padlock first, or drop on a day that keeps the minute** |
| `movedWeek` | it is on the week on screen, and the drag STARTED in another one | names the day and the week, and how to get back to today's |
| `absorbed` | its id is gone — a row of the same job took the hours | no hour was lost |

`unchanged` also covers the narrower case of a pass that DID change the calendar while leaving this
row on its own slot. `leftWeek` and `movedWeek` are what *Dragging To The Edge Changes Week* made
ordinary: a drag that crosses weeks either keeps the minute (and lands where it was released) or
takes a rank (and is laid out where the queue reaches), and only the row itself can say which
happened.

**A DIVISION INSIDE ONE DAY IS SILENT, and that is what the table above actually does** (measured
2026-08-18, said out loud here because the spec has to describe the code): `filled` counts DAYS, so a
6 h drop cut into `Mié 08:00-10:00` + `Mié 15:30-19:30` around a padlocked row answers `changed:
true`, `placedBlockIds` two long — and no branch fires, because the row is visible at the minute it
was released. Four of the six hours are five and a half hours below the pointer and nothing is said.
It is defensible (the ghost drew both rectangles before the release, and `block` genuinely is at the
released minute) and it is the one shape *Fill and Overflow, Always* introduced that gets no sentence.
**Open Decision 15** — do not answer it by widening `filled` to count PIECES without asking.

The same order — padlock, then move — is used by `notices.dropSettles` and `grid.dropRankHint`, so
the three agree.

Two rules keep it honest. The outcome is read from **what the server stored**
(`BlockMutation.blocks`), not from the refetched week, so it cannot race the reload. And a **refusal
is not one of these**: nothing was written, the request threw, and the error banner carries the
server's own reason. `describeDrop` in `src/components/calendar/dropOutcome.ts`, pure, with a test
per branch.

**THE SERVER SAYS IT, THE CLIENT DOES NOT INFER IT** (2026-08-17). Two fields on every block
mutation, added because neither is derivable from geometry:

- **`changed`** — false when the request wrote nothing the owner can see. A drop is a rank, so the
  reflow may answer it with the calendar they already had, and that is indistinguishable from a drop
  that worked. It is asked of the ROWS and not of the ids: moving a run folds it into one row and
  lets the reflow lay it out again, so ids churn on a pass that moved nothing. `unchanged` must be
  decided from this, never from comparing rectangles.
- **`placedBlockIds`** — the rows the gesture's hours really ended up on, in calendar order, and
  routinely more than one now that work fills a day and overflows: 6 h dropped into a 4 h afternoon
  comes back as `[Monday 4 h, Tuesday 2 h]`. `block` is only the FIRST of them, so a notice built
  from `block` alone tells the owner half of what happened. Empty when a merge absorbed the row.

### Dragging To The Edge Changes Week
> **Holding a dragged block at either end of the grid pages the calendar, with the block still in
> hand. The block is never put down and nothing is written: paging is a GET.**

- **Where.** The strip at each end of the visible grid FRAME, not of the columns — on a narrow
  window the columns scroll inside it. On the left it is the whole **time-axis gutter** (58 px),
  which belongs to no day; on the right, where there is no gutter, the last **40 px of Sunday**
  (`EDGE_ZONE_PX`). Past the frame counts as inside the strip.
- **How long.** **500 ms** for the first turn, then a **constant 800 ms** for every repeat
  (`edgeDelayFor`, `EDGE_REPEAT_DELAY_MS`). The repeat is a metronome, not an acceleration: a hold
  has to be **stoppable** on the week it was aimed at, and the rail names its destination by dates,
  which a pace that outruns its own label makes pointless. A repeat is only scheduled once the week
  the last one asked for has ARRIVED, so the gesture can never outrun the calendar, and a week that
  fails to load stops the hold instead of hammering the endpoint.
- **What it looks like.** Both rails are drawn for as long as a MOVE is in the air and never
  otherwise — that is how the gesture is discovered rather than fallen into. Each names the week it
  leads to by its dates. The one the pointer is in fills over exactly the wait that is running, so
  holding still reads as progress; while it waits for the week it pulses instead.
- **It must be gone to.** A hold that BEGINS inside a strip does not arm until the pointer has left
  it once (`DragSession.edgeArmed`) — otherwise a block grabbed at Sunday's right edge would page the
  week out from under itself.
- **The arrow keys do the same thing without the wait**, handled by the drag itself in the capture
  phase so the screen's own pager never sees the key. A RESIZE ignores them: its edge belongs to one
  row on one day.
- **The axis is untouched.** Paging changes the COLUMNS; *One Axis Per Gesture* is about the vertical
  mapping, which the screen holds still for as long as a block is in the air.
- **The drop is resolved against the week it is released in**, because the day, the rows and the
  taken starts are all read at the release. **Three** consequences are wired for it: the preview
  falls back to the NEAREST column when the date it remembers has left the screen; the ghost is
  re-resolved from the last pointer position the moment the columns change, without waiting for the
  hand to move, in a LAYOUT effect so no paint and no event can fall between the two; and the
  RELEASE itself re-resolves rather than committing the preview it happens to be holding. The
  re-resolve is pure, so with nothing changed underneath it returns the ghost the owner was looking
  at, to the minute.
- **Released before the new week has arrived**, the drop belongs to the week that was on screen and
  the pending page turn is cancelled (`showWeekOf`), so the owner is never left looking at a week
  their block is not in.
- **Escape still cancels the drag**; the week paged to stays, since nothing was written.

### A Week Change Says Which Way It Went
> **A new week slides in from the side it came from: forward it enters from the right, back from the
> left. 180 ms, `ease-out`, 26 px, opacity 0.2 to 1. The FIRST week never slides — opening the app is
> not a page turn — and a refetch of the SAME week never slides, because a save must not look like
> one.**

- **The direction is DERIVED, not passed in** (`useWeekSlide`, by comparing this week's Monday with
  the last one), so the header buttons, the arrow keys, `Hoy` and the edge hold all get it for free
  and none of them can get it wrong.
- **What moves is what belongs to the WEEK**: each column's blocks, gaps and `libre` pill, inside a
  `.columnBody` wrapper, and each day header's WORDS. Moving the header's BOX instead puts its border
  26 px from the column border under it, which reads as misalignment rather than motion.
- **What does NOT move**: the axis, the grey bands, the hour rules and the time-axis header cell —
  the shape of a day is the same in every week, and a horizontal rule sliding sideways reads as
  breakage. Neither does the **GHOST**, which is a sibling of `.columnBody` and not a child of it:
  the one rectangle that promises where the block in the owner's hand will land may never slide out
  from under the pointer.
- **And it may not move the CALENDAR.** `translateX` past the last column's right edge is scrollable
  overflow, and a scrollbar appearing for 180 ms narrowed the whole grid by 15 px and jumped the
  ghost 14 px sideways under a still hand. A column therefore clips sideways **while, and only
  while, its contents are travelling** (`.columnSliding`) — permanently would hide most of the
  settle, which crosses a whole column.

### Block Gestures
- **Drag the body**: move the whole RUN — this reorders the queue and triggers a reflow.
- **Drag the bottom edge**: make this stretch of work longer or shorter, on **every row but a past
  one**. On a row the engine lays out it changes the JOB'S HOURS and the engine places them; on a
  padlocked or weekend row it is a TRANSFER inside the job. Either way it works on every row OF A
  UNIT, because each segment is a real rectangle with a real bottom edge; the drag is capped at the
  end of the DAY's last manual window and counted in net working minutes; and a shrink that has
  nowhere to put the freed hours ASKS. **On a past row no strip is drawn at all.**
- **The scissors**: move a PORTION of a job out of its row. Two steps, and the second is not
  optional — the dialog asks how many hours leave the row, then the owner clicks the grid to say
  where they go. A split with an implicit target would park those hours somewhere nobody asked for,
  and a fragment dropped next to its source is auto-merged straight back into it, so it would
  silently do nothing. Both halves are floored at a quarter of an hour. The fragment is a DROP: it
  takes a queue rank and settles, and it padlocks wherever a drop would.
- **None of the above on a PAST day.** Drag, resize, split, delete and the padlock are all refused
  there, and none of them is drawn. Nothing is left stranded by that: the padlock a past row carries
  is drawn as a read-only state, and there is no other mark to hand back.
- **Click**: open the job panel.
- **Hover**: a small action bar with lock, *stop the day here*, split (scissors) and delete — never
  behind a modifier key, since on a shop PC an Alt-drag would never be discovered. **The bar drags the block too**: a press on it begins the same move, the press is not
  cancelled (so a press that does not travel is still the BUTTON's click), and a drag that travelled
  eats the one click it would otherwise have delivered to the button it started on.
  The bar **docks outside the block's top edge** when the block is too SHORT or too NARROW to hold it
  (`blockHoldsActions` in `geometry.ts`; `MIN_BLOCK_GRAB_WIDTH`). Do not use a CSS container query
  for this — it would make `.block` a containment context and trap the outside-docked bar behind its
  neighbour. *Stop the day here* is absent where it would do nothing: on a row that already ends the
  day, on the weekend, on a closed day and in the past.
- **A gesture that cannot write says so exactly once**, and does not also do something else. **A GAP
  now has both gestures** (*Gaps Are Dragged And Resized*), so what is left to say is why one of them
  cannot run right now — a save in flight, a frozen day — and the CLICK still happens, the form being
  a read. It is a `div role="button"`, not a `<button>`: `preventDefault` on a pointer-down does not
  stop a button firing its own click, so a press that did not travel would open the form twice.

#### One Axis Per Gesture
> **A gesture is resolved against the axis as it was WHEN THE POINTER WENT DOWN. Only the grid's
> ORIGIN is re-measured while the pointer is down.**

An origin that moves means the grid moved under a still hand, and the minute under the pointer really
did change. A SCALE that changes means the same pixel now means a different minute, and the gesture
ends somewhere the owner never chose.

Three things hold it: `useBlockDrag` fixes the axis in the session at press; the screen HOLDS the
painted axis for as long as a block is in the air; and the legend reserves its two lines, which
removes the trigger at the source. The invariant underneath is `minutesAt(yOf(m)) === m` for every
minute of the axis, margins and lunch band included. **Since the axis became piecewise (the
compressed break) that is a stronger claim, not a formality**: the two directions have to agree
segment by segment and on every seam between two segments, so it is asserted over the whole axis,
minute by minute, at several fitted scales — never at sample points.

### Job Panel (side panel)
- Colour dot + job name + close.
- Fields: `Nombre`, `Descripción`, `Horas totales` (stepper), `Color` (swatches).
- `Bloques · 11 h en 4 tramos`: the job's blocks listed as `Mié 12 · 08:00–14:00 · 6 h` with a
  per-block padlock toggle. It is the only place a row in another week can be unlocked. **On a PAST
  row the padlock and the scissors are absent**, and the padlock is drawn as a read-only state icon.
- The two halves around lunch are listed as two separate rows — that is the segment model, confirmed
  by the wireframe.
- Actions: `Guardar`, `Eliminar`.

### Job Management
- **Create**: Name + Description + Color + Hours, appended to the end of the queue (Mon-Thu, never
  Friday); or an optional **start date**. The form previews the placement before saving.
- **Edit**: name, description, colour, total hours (LIFO). This is the way to change a job whose work
  is already behind it.
- **Delete**: requires confirmation. FUTURE blocks deleted and the calendar recomposes; PAST blocks
  become gaps.
- **Lock/Unlock**: toggle `locked` per block. Not offered on a past row. It is the app's ONE undo for
  a row the owner has settled by hand — position and length together.

### Gap Management
*(Absences over a RANGE of days, closing days, and painting a band are the four sub-sections at the end
of this one.)*
- **Create**: Date + Start Time + Duration + Reason (optional). The hours are **net working minutes**,
  and the save **cuts them at the comida** into one row per manual window they reach, sharing the
  reason (`createGap` → `segmentDroppedRow` over `manualWindows`). Consequences the form has to live
  with:
  - **the stored start may differ from the one asked for** — a gap aimed at 14:00 is stored from 15:30
    (*A Minute With No Working Time*), and the response carries every row it wrote (`gaps`);
  - **a gap may sit in a visual margin**, so "all day" is 12 h on the documented shift, not 10;
  - **the line is the end of the day's last manual window**, not midnight: past it the save is refused
    409 `row-past-day-end`, writing nothing. The duration field's ceiling is the window's own minutes.
- **Refused when it would cover a row the engine cannot move**, naming **the reason that actually
  binds** — a row is classified `locked`, then `weekend`, then `past`, which is exactly the three ways
  `isMovable` says no. On Saturday the weekend is what holds the row, so a padlocked weekend row is
  refused as `errors.gapOverWeekendBlock` while `locked` is reserved for the case where the padlock is
  the ONLY thing holding it. **The refusal is asked of every ROW the gap will be stored as**: measured
  over `start + duration` instead, 8 h from 10:00 tests `10:00-18:00`, names rows in the comida where
  nothing can be, and MISSES the padlocked `18:00-19:30` its real second half lands on.
- **Create in one click**: *stop the day here* from a block's action bar.
- **Edit**: modify any field; the result is tested and cut exactly as a create is. **A PATCH ADDRESSES
  THE WHOLE UNIT**, whichever of its rows it names: the duration defaults to the SUM of the unit's
  rows and the rows the edit becomes are reconciled against the rows it has — updated, inserted or
  DELETED. **Delete**: takes the whole unit too; it frees up time and recomposition runs if needed.
- **The FORM edits the absence, never one of its rows.** It is handed (date, start, NET total) for the
  unit. Handed one half instead, opening the `08:00 +6 h` morning of a 10 h absence and pressing
  Guardar sent `durationMinutes: 360` for the whole unit and the reconcile deleted the afternoon —
  4 h destroyed by a save that changed nothing (measured 2026-08-19). `gapUnitOf` in `grouping.ts` is
  the one place the absence is derived from what is on screen.
- **The form is the only gesture that reaches a PAST day**, which is how a mis-recorded absence is
  corrected. The two below are frozen there.

#### Gaps Are Dragged And Resized
> **REVERSES *«Gaps are not dragged. Pressing one opens its form; a press that travels says so»*
> (2026-08-19). A gap already WAS a padlocked task to the engine; what it lacked was the two gestures
> a padlocked block has. A plain CLICK still opens the form — only a press that TRAVELS drags.**

- **The drag is a LITERAL placement**, like a padlocked row: the absence lands on the minute it was
  released and is cut at the comida. **Never a queue rank — a gap is not in the queue**, so there is
  no rank for it to take and `dropLandsLiterally` answers `fixed` for it on every day.
- **The WHOLE UNIT moves.** Both halves travel; the far one is created or deleted by the same
  transaction, since the absence is (day, start, net duration) and nothing else.
- **A release aimed at a minute no window covers starts at the first minute that can hold work** —
  the same rule a block's drop follows (*A Minute With No Working Time*), so a gap aimed anywhere in
  the comida is stored from 15:30 and the drop SAYS so (`notices.gapMovedTo`).
- **Its DAY is as literal as its minute, so it is never carried to another one.** A footprint the day
  cannot hold is CLAMPED to the latest start that fits (`resolveDropDay`'s `rolls: false`), exactly
  like a weekend drop: the owner named the day the machine broke, and moving an absence to Thursday
  would be a bigger surprise than the clamp.
- **The resize (bottom edge) is ABSOLUTE, not a transfer**: it just sets the duration. There is no job
  to hand hours to, so **`shrink-needs-choice` can never appear on a gap**. It is counted in net
  working minutes, it CROSSES THE COMIDA — absorbing or creating the far half — and it clamps at the
  end of the day's last manual window. **This is not an exception to *the padlock holds the length***:
  that rule is about rows the ENGINE lays out, and a gap never is one.
- **The handle is on the LAST row of the unit only.** An absence has ONE duration, measured from its
  own start, so that row's bottom edge is the only edge that is its END.
- **The refusals are the ones a gap already had**, now reachable from two more gestures: a footprint
  over a row the engine cannot move is refused naming it (`gapOverLockedBlock` /
  `gapOverWeekendBlock` / `gapOverPastBlock`), and on Mon-Thu unlocked work is pushed forward. A gap
  is never SLID and never MERGED — two gaps that touch keep their reasons and stay two.
- **NEITHER GESTURE CONFIRMS.** A drag and a resize are direct manipulation: the ghost drew the rows
  and what they would displace, and the result is on screen. Only bulk creation warns.
- **The past is read-only to both** — see *The Past is Frozen*.
- **`action` is what tells the server which gesture is asking** (`edit` | `move` | `resize`, absent =
  `edit`), because a drag and a form save send the same three fields. Without it the past could not be
  frozen to the gestures while staying open to the form.

#### The Absences Screen — One Place, Two Modes
> **`Ausencias`, reached from the calendar's overflow menu and from the grid itself, with a selector:
> **Un hueco** / **Cerrar días**. Both modes share `Desde` / `Hasta` and a reason, so there is one
> screen to learn and the decision is made INSIDE it.**

The evidence it was built on, from the shop's own database: `2026-09-01` … `09-04`, four gaps of
`08:00 +11,5 h` reason "Feria", typed one per day — because a whole-week absence had no other way to be
said and `day_overrides` had **0 rows**. Judge a change here by whether that week still takes one
gesture.

- **`POST /api/absences` `{ kind: "gap" | "closed-days", from, to?, reason?, startMinutes?,
  durationMinutes? }`** — one request, ONE transaction over the whole range. `to` absent is a range of
  one day.
- **A range SKIPS Saturday and Sunday**, unless it lies entirely inside one weekend, which is the owner
  naming those days on purpose (`absenceRange` in `src/lib/absences.ts`, with a test). The response and
  the preview both NAME the days they skipped, so the skip is never silent. A range longer than
  `MAX_ABSENCE_DAYS` (120) or running backwards is 400 `invalid-range` on `to`.
- **In `gap` mode a range writes the SAME absence on each day**: same start, same net duration, one
  unit id per day, each cut at the comida by the very function a single gap uses (`insertAbsence`).
- **The rows are written first and the reflow runs ONCE**, at the end, so the hours are displaced by one
  pass and reported once. A refusal on ANY day of the range rolls the whole thing back.
- **The two OLD shapes of the form are untouched**: editing one absence and *cerrar el día aquí* still
  write through `/api/gaps`, still reach the past, and keep every refusal they had.

#### Closing Days — the mechanism that was wired engine-deep and had no way in
> **A closed day is one `day_overrides` row: `plannableMinutes` 0, `dayReflows` false, the column
> dimmed, and the DAY HEADER carries the reason from `note` — `Mar 1 · Feria`. No colour band: five in
> a row would drown the week.**

- **It behaves like a weekend**, and that is the whole of its definition: the engine plans nothing
  there, a drop by hand LANDS LITERALLY and padlocks (*The Padlock Is the Only Pin*), and nothing is
  ever auto-recovered from it.
- **Closing a day the engine cannot empty is REFUSED, naming what is in the way** — 409
  `closed-day-over-fixed-block`, with its own three sentences (`closedDayOverLockedBlock` /
  `…PastBlock` / `…WeekendBlock`) because "that gap steps on…" is not what a closed day does. Same
  question a gap asks over its footprint, asked over the whole day (`findGapConflicts`). The
  alternative is a day that says *cerrado* while work nothing will move sits on it, reporting no
  capacity at all.
- **Reopening is `DELETE /api/absences/closed-days?from=&to=`** — a range too, so undoing a Feria week
  is also one gesture — and the queue fills those days again on the same pass. The ROW is dropped, note
  and all, **except** where it carries a hand-entered `capacity_hours`: that column has no screen and
  nothing could put it back, so there only `is_closed` is cleared.
- **The way IN to a closed day is its own column.** Pressing a dimmed column opens this screen in
  `Cerrar días` mode on that day, with its note pre-filled — otherwise a mistyped reason would be
  unreachable, since a closed day is not an object on the grid.
- **NO HALF-DAY.** `capacity_hours` stays without a screen: the owner was asked and said no, because a
  short day is a GAP. Do not offer it.

#### Painting an Absence on Empty Grid Space
> **A drag on empty grid space paints a band and, ON RELEASE, OPENS THE FORM PRE-FILLED with the day,
> the start and the net duration. IT WRITES NOTHING — the owner presses Guardar.** That is the rule
> they set on 2026-08-18 about *cerrar el día aquí* and it holds for every absence: the app never
> creates a gap by itself.

- **ONE COLUMN per paint** (`usePaintAbsence`). Several days go through the form's range; cross-column
  painting does not exist.
- **GAPS ONLY.** There is therefore no gap-versus-closed-day threshold to compute — a question that
  was asked and then dissolved by this answer. Painting the whole column gives a **12 h gap in two
  rows**, which LOOKS like a closed day and is not one. Do not add a threshold.
- **The band draws the rows the absence will really be stored as**, cut at the comida
  (`segmentDroppedRow`), like every other ghost on this grid, and it is measured in NET working
  minutes: 13:00 to 16:30 is 2 h. It paints upwards as readily as downwards, reaches the visual
  margins, and a press aimed inside the comida starts at the first minute that can hold work.
- **Under a quarter of an hour there is no band and no form**: a press that wandered is not a gesture.
- **Disabled while a scissors fragment waits for its target**, where a grid click already means "put it
  here". **No modifier key, ever.**
- **A past day and a closed day take no paint**, and each says so once, on the first travel: the past
  gets the frozen-day notice, a closed day opens the absences screen for itself.

#### The Warning Before Work Is Pushed
> **Bulk creation PREVIEWS: `POST /api/absences/preview` takes the same body and WRITES NOTHING. It
> names the days, the rows one day will hold, the hours it pushes, the jobs they belong to and the
> date they land on. Cancelling is not pressing Guardar.**

- **It runs the real write and rolls it back** (`previewAbsence` → `dryRun`), so it cannot promise a
  placement the save will not perform and it REFUSES whatever the save would refuse — a padlocked row
  in the way, a horizon the hours no longer fit in. The screen shows the refusal and does not offer
  Guardar at all. The alternative, a model of the reflow, is the thing *one function serves both* exists
  to prevent: only a whole pass knows where the queue's cursor reaches.
- **Only bulk creation warns** — a range of closed days, a range of gaps, a painted gap — because those
  displace hours into weeks that are not on screen. A DRAG or a RESIZE of one absence does not: the
  result is on screen and the ghost drew it.
- **The hours are read from what the write DID**, not predicted: the rows before and after, per job,
  with the job's furthest day afterwards as "where they land" (`displacedWork`). `summarizeAbsence`
  turns that into the sentences, and it is where the wording is decided and tested.
- **`horizon-exceeded` rolls the whole range back**, upserts included, because they sit in the same
  transaction as the reflow. They did not once: the overrides survived the failed pass and **every
  later write answered the same 409**, including the deletion of the job that would not fit.

### Settings
Work periods, auto-fill capacity, visual margins, planning horizon, gap colour, language.
- **A change that narrows the day asks first**, in ONE confirmation: it names the blocks the narrower
  periods or margins would strand, and — per *The Capacity Is Never Touched Alone* — the capacity the
  new shift can no longer buy, with both numbers. **Cancel writes nothing** and leaves the rest of the
  unsaved form exactly as it was.

---

## Composition Algorithm Notes

The per-day placement logic was validated in `recompose-poc.js`. Three of its behaviours were checked
by executing it, and only one survives:

- ❌ **Overflows the whole item, never splitting it** — replaced by *Fill and Overflow, Always*
  (2026-08-17). The item takes what the day has left and the remainder goes on.
- ❌ **Never backfills a hole left in front of a locked block** — half replaced. Nothing is ever
  pulled BACK into an earlier hole, but the head of the queue now fills the hole in front of a lock
  instead of hopping it.
- ❌ **Keeps filling the day with later jobs after one overflows** (verified: `X 3h, Y 6h, Z 2h` at
  8h capacity places X and Z, overflowing Y). This violates strict order and must not be ported.

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
- **Test timeout**: 30 s (`vitest.config.mts`). The suite's property tests run thousands of generated
  calendars each; the seed counts are the guard, so the timeout must not be what decides how many run.

---

## Open Decisions

**Still unanswered. Do not invent an answer — ask first.** Each is a question about what a GESTURE
MEANS, not a broken invariant: hours are conserved, nothing straddles the break, nothing overlaps
that did not already, and recomposing twice changes nothing in every one of them.

The reproductions are in DECISIONS.md § *Reproductions behind the Open Decisions*.

1. ~~**Taking a row out of the movable pool empties the rest of the day and parks the work a week
   later.**~~ **ANSWERED 2026-08-17 — by the owner removing the rule underneath it.** The cause was
   "the remainder is treated as a FIRST placement, so *Never split a job to make it fit* applies and
   it moves whole". That rule is gone (*Fill and Overflow, Always*), so the answer is candidate (c) —
   prefer the current day for the remainder even when it must split — and it arrives for all three
   gestures the defect came from at once: growing a row into the margin, padlocking a row, and growing
   a row up against a gap. Re-measured; see DECISIONS.md.
2. **A 6-pixel drag on a lunch-split unit's bottom edge asks a question the owner did not.** STILL
   OPEN, and re-measured 2026-08-18 on the new gesture: the edge sits at 14:00 while the value the
   client edits is the STRETCH's 600 minutes, so `useBlockDrag`'s no-op guard can never suppress a
   micro-drag on a multi-row unit and `resize 360` is still sent. What arrives back is no longer a
   silent mark — that was `manual_duration` — it is **409 `shrink-needs-choice` with `freedMinutes:
   240`**, a dialog for a drag that went nowhere. Candidates: compare like with like (the ROW's own
   duration); suppress a request whose stretch total is unchanged; or keep it and warn in the ghost.
   **Reproduced in a real browser, 2026-08-18**, on a padlocked `Mié 26 08:00 6 h` + `15:30 4 h` unit:
   a 6 px drag on the 14:00 edge sent `{"action":"resize","durationMinutes":360}` — the row's own
   current length, byte for byte — and opened *«¿Qué hacemos con esas 4 h?»*. 409, nothing written.
3. ~~**A resize whose result does not fit the day leaves the dragged row untouched and invents a row
   on another day, while the toast says it worked.**~~ **CLOSED 2026-08-18 BY REMOVAL.** The shape
   needed a MOVABLE target: the transfer was applied, the reflow re-derived the row it had grown, and
   the hour surfaced somewhere else. The edge no longer sizes such a row. Re-measured on the original
   reproduction — gap Thu 18:30-19:30, `Barandilla 13 h`, the padlocked `15:30-18:30` row dragged to
   19:30 — the row really becomes `15:30-19:30`, the hour comes off the job's Monday row (4 h → 3 h),
   the total stays 780 min and no row is invented. What it leaves behind is decision 4, and only that.
4. **A resize may grow a row over another job, or over a gap.** STILL OPEN, and **BROADER since
   2026-08-18**: the edge now sizes only rows the engine does not lay out, so *every* resize is on the
   side where nothing will separate an overlap afterwards — this is the one real hole the round leaves.
   `resizeBlock` never looks at another project's rows and never at gaps; only the drop path resolves
   overlaps. **Both halves re-measured over HTTP 2026-08-18, no margins needed any more**, each a 200
   with the overlap stored: `Barandilla Lun 24 08:00 4 h [locked]` grown to 6 h is stored `08:00-14:00`
   straight over `Porton Lun 24 12:00 2 h [locked]`; and `Reja Mar 25 15:30 3 h [locked]` grown to 4 h is
   stored `15:30-19:30` straight over `gap Mar 25 18:30 1 h`. Candidates unchanged: refuse naming
   the row or the gap; cut at the obstacle the way a drop does; or keep allowing it and draw the
   overlap on purpose. **`findGapConflicts` and `otherJobOverlaps` already exist** — the drop path's
   two halves — so whichever answer the owner picks is a call, not a new mechanism.
5. ~~**A drop released in the lunch band stores one solid row straight through the break.**~~
   **ANSWERED 2026-08-17 — and it was not a question about what a gesture means after all.** It was
   listed here because the STORED shape looked like latitude *A Drop Is Stored In Segments* granted
   on purpose. It is not: the data model states as an INVARIANT that no stored row straddles a
   non-working interval, "and this holds for a HAND DROP too", so the two rules contradicted each
   other and the invariant is the one that is load-bearing — rendering, the overlap maths and
   auto-merge all rest on it. The rule now is *A Minute With No Working Time Means The Next Minute
   That Has Some*: a release anywhere in the break starts at 15:30 and is cut like any other drop.
   **One consequence is a real change and wants the owner's eye**: a Monday-Thursday drop aimed at
   the break no longer padlocks, because at 15:30 there is nothing left for a padlock to protect.
6. **A drop whose grab offset pushes the unit above the axis lands hours away from the pointer and
   padlocks it on a Monday-Thursday day.** Candidates: do not count clamp-forced minutes as a
   request; clamp to the first minute inside the PERIODS on an auto-fill day; or measure the grab
   offset in NET minutes.
7. **On a day that padlocks, the one-minute rank nudge becomes the stored time.** Same three
   candidates as the sliver — answer both at once. **And on a day that does NOT padlock the same
   nudge is now a broken invariant, not a question**: it puts the rank one minute inside the top
   margin, the provisional row is cut at the lunch break from there, and the day comes back off the
   quarter hour — see the KNOWN DEFECT box in *The Calendar Sits On The Quarter Hour*. Whichever
   candidate answers 6 and 7 has to answer that too.
8. **The scissors never answer for themselves.** Candidates: give them a `describeDrop`-style
   outcome with the same branches; refuse a split whose fragment would settle back inside the source
   row; or leave it. (Its GHOST does answer now — the fragment's second click previews the same
   division a drag does, `placingGhost` — but nothing is said after the save.)
9. ~~**A hand-set row that has LEFT the pool stops closing its job's day** — should padlocking a
   hand-set row re-open the day its ruler had closed?~~ **CLOSED 2026-08-18 BY REMOVAL, not by an
   answer.** Both halves of the question were properties of `manual_duration`: the mark, the day it
   closed (`closedDays`) and the deferral behind it are all deleted, so there is no day for a padlock
   to re-open and no asymmetry between the stored flag and the queue. Confirmed rather than assumed —
   `closedDays`, `dayKey` and `handSetDate` do not exist in `compose` any more, and the 2000-seed
   harness now asserts strict order on **every** seed instead of skipping the calendars that had a
   hand-set item. If the owner ever wants a day closed to a job, that is a GAP.
10. **A sub-quarter row deleted leaves `total_hours` off the quarter hour for ever.** Answer the
    sliver and this goes away with it.
11. **Does `buffer` belong on a padlocked Friday row?** `BlockRows.tagOf` labels every Friday row
    `buffer`, including one the owner dropped there. The tag names the DAY's role, not the row's
    provenance. Left as-is pending a second opinion.
12. **The hover action bar still covers a tall block's NAME on a narrow column.** Fixed for short and
    narrow blocks (the bar docks outside), but on a ~150 px weekday column a tall block still has its
    top ~28 px covered. The drag is safe there; a CLICK still lands on a button. Moving the bar
    outside on narrow columns too puts it over the neighbouring day.

13. **A RUN LONGER THAN A DAY CANNOT BE DRAGGED ANYWHERE, and the refusal reads as a technical
    error.** The drag unit is the whole run, so an 18 h run arrives at the server as ONE row of
    1080 minutes; `assertFitsInDay` measures it against MIDNIGHT and answers 400 `out-of-range`,
    which the owner sees as *«Esa hora no cabe en el día»* — a sentence about an hour, for a gesture
    about a length. The ghost meanwhile says *«este tramo no termina hoy»*, which reads as a promise
    that it WILL be placed and carry on.
    **MOSTLY ANSWERED 2026-08-17, and by the candidate "cut the run across days on drop".** A drop
    that is only a queue RANK has no footprint to fit, so `assertFitsInDay` is not asked of it and the
    engine lays the run out across days (*Fill and Overflow, Always*). Measured: an 18 h run dragged
    onto Monday-Thursday answers 200 and re-ranks — dropped behind a 2 h job it came out
    `Corto 08:00-09:00`, `Nave 09:00-14:00 + 15:30-19:30 + …`. Two of the three things feeding on the
    over-long number went with it: the PIN now reads the drop's start rather than its footprint, and
    the CLAMP does not run on a rank at all.
    **The GHOST's half is answered too (2026-08-17).** On a day the engine lays out it no longer says
    *«este tramo no termina hoy»* at all: it draws the run's real division and names it — measured, an
    18 h run dropped in front of a 10 h Tuesday previewed `10 h el Mar 18 · 8 h el Mié 19` over four
    rectangles and stored exactly that. See *The Ghost of a Rank Is the Division*.
    **What is left of the question**: the same drag onto a day that keeps the minute — the weekend, a
    closed day, the past, a margin, or with the row padlocked — is still 400 `out-of-range`, and there
    the row really would be stored in one day, so the refusal is right and only its SENTENCE is wrong
    (it names an hour for a gesture about a length). And `dropEffectOf` still measures overlaps
    against the uncut footprint, so a long run can announce a cut against rows its real first-day
    footprint never touches.
14. **A resize ghost draws its post-break tail on THIS day even when that slot is taken and the
    engine will put the tail on another one.** Measured 2026-08-17: a 6 h Wednesday row grown to 8 h
    with Wednesday afternoon already held by another job previewed `08:00–17:30` as
    `08:00-14:00` + `15:30-17:30`, and stored `Wed 08:00-14:00` + `Thu 08:00-10:00`. The HOURS are
    right and the invariants hold; the rectangle and the end time are not. With the slot free the
    same gesture is exact, so this is only the occupied case. Candidates: draw the tail where the
    reflow will really put it (needs the reflow simulated in the preview); or print no end time for a
    resize whose tail crosses into occupied time, the way the ghost already refuses to invent one for
    a run.
    **Half of it is answered: the DROP side is built** (2026-08-17). A drop's ghost now draws the rows
    the reflow will really store, on the columns they land on (`planDropSpill`, *The Ghost of a Rank Is
    the Division*), which is the first candidate applied to the one gesture whose arithmetic the
    preview could reach without simulating a whole pass. **The RESIZE still previews its tail on this
    day**, and it is a different question — a resize's counterparty is the job's own last row, so what
    the preview would have to simulate is the LIFO transfer and not just the fill.
15. **A drop cut into pieces INSIDE ONE DAY says nothing.** Measured 2026-08-18: 6 h released at
    Wednesday 08:00 in front of a padlocked `10:00-14:00` stored `08:00-10:00` + `15:30-19:30`,
    `changed: true`, `placedBlockIds` two long — and no `describeDrop` branch fires, because `filled`
    counts DAYS and the row is at the minute it was released. Candidates: count PIECES rather than
    days and reuse `notices.dropFilled`'s sentence; give the same-day case its own wording («se parte
    en dos: 2 h y 4 h»); or leave it, on the grounds that the ghost drew both rectangles before the
    release and the row really is where it was put. This is the ONE shape *Fill and Overflow, Always*
    made ordinary that the notice table does not cover, so it is a question about what the gesture
    means, not a bug.

**Decided but NOT BUILT** — do not treat these as done:
- **One-level undo, Ctrl+Z** (decided 2026-08-14). Every mutation already runs in a single
  transaction, so remembering the previous state is enough.
- ***Añadir otra parte*** on the job panel (decided 2026-08-14): creates a second job entry with the
  name and colour pre-filled. See DECISIONS.md § Two Parts of One Job.

**Deferred by direction:**
- **Backups**: an Export button in Settings. The DB is deliberately gitignored and there is no undo.
- ~~**Settings UI for day overrides**~~ **BUILT 2026-08-19**, and not in Settings: closing a week is
  something the owner does to the CALENDAR, so it lives on *The Absences Screen* (`Cerrar días`). Only
  `capacity_hours` still has no screen, and that is now a decision rather than a gap — a short day is a
  gap.
- **Whether a closed day belongs in the summary strip's sentence**, and whether a gap unit should be
  reachable from the job panel's list. Both left open by the owner on 2026-08-19.

---

## Current Project Status

**v0.17 (current).** The engine, the API, the week view, the gestures and the drag layer are built
and green: `tsc --noEmit` clean, `vitest run` **977 passing across 33 files** (including five
2000-seed property harnesses over placement, manual placement, drops, editing and shrinking — the
placement one generating off-grid quantities on a quarter of its calendars, which is where the
quarter-hour floor is really at risk, and asserting strict order on EVERY seed since the hand-set
duration was deleted), `next lint` clean, `next build` clean.

**A LONG ABSENCE IS ONE GESTURE, AND A CLOSED DAY HAS A SCREEN** (2026-08-19). `Ausencias` has two
modes — *un hueco* and *cerrar días* — sharing `Desde` / `Hasta`, so the shop's four hand-typed `Feria`
rows are now one request in one transaction; `day_overrides` had 0 rows for want of a screen. Bulk
creation PREVIEWS by running the real write and rolling it back, so the warning names the hours, the
jobs and the day they land on, and cancelling writes nothing. A drag on empty grid space PAINTS a band
that only ever opens the form pre-filled. **A defect the round found and fixed**: a drop onto a closed
weekday was read as a queue rank — `role` is still `auto` there — so the hours left for the next open
Monday, unlocked and unannounced; `DropPin.closed` makes a closed day pin like the weekend it behaves
like. **And one that would have bricked the shop**: the overrides were written outside the reflow's
transaction, so a close the horizon could not absorb stayed on disk and every later write answered the
same 409, deletions included.

**A GAP IS DRAGGED AND RESIZED** (2026-08-19). It was already a padlocked task to the engine; now it has
the two gestures one has. The drag is a literal placement of the whole UNIT, cut at the comida, never
rolled to another day; the bottom edge of the unit's last row sets the absence's duration ABSOLUTELY and
crosses the comida; a plain click still opens the form; and the past is read-only to both while the form
still reaches it. `DragTarget` is a union (`kind: 'block' | 'gap'`) over one drag controller, so *One
Axis Per Gesture* has one implementation. **A defect the round fixed before building on it**: the form
was being handed one ROW of a comida-crossing absence, so opening its morning half and pressing Guardar
destroyed 4 of its 10 hours.

**NO STORED ROW STRADDLES THE COMIDA — gaps included.** A gap's `duration` became NET working
minutes on 2026-08-19, so a gap is cut at the break like everything else, its two halves are ONE unit on
screen, and the one row in the app that could span a break is gone. The four `08:00 +11,5 h` Feria rows
in the shop's file are split by a one-shot data migration (`data_migrations`, the first of its kind:
`PRAGMA table_info` cannot see a change of MEANING).

**A row carries ONE mark, the padlock.** `manual_duration` was deleted on 2026-08-18 with every rule
that held it up, and the bottom edge now sizes only a row the engine does not lay out. That is the
SECOND mark removed by the same argument — `hand_placed` went on 2026-08-14 — and the argument is the
same both times: a second column that says what the padlock already says costs a rule for every
consequence and buys nothing the padlock cannot state. What is left open by this round is Open
Decision 4, and it got broader — read it before touching the resize.

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
- **Review `recompose-poc.js` first** for the per-day placement logic, but see the one behaviour
  above that must not be ported.
- **Any change to a business rule updates this file**, and appends its reasoning to DECISIONS.md.
- **All code, comments, variable names**: English. **UI strings**: only in
  `public/locales/{lang}/common.json`, with the es and en key sets identical.
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
- **Complexity**: prioritise simplicity. No multi-user, auth, subscriptions. Keep it lean.
