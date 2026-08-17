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

- **Block** (id, project_id, date, start_time, duration, locked, manual_duration, created_at, updated_at)
  - A **time slot on the calendar** where part of a project sits.
  - `date`: YYYY-MM-DD. `start_time`: HH:mm.
  - `duration`: Hours as decimal. Always **net working hours**.
  - `locked`: Boolean. The **only** exemption from auto-move, and the only thing that fixes a row's
    POSITION. If true the engine never moves the block; the user still can, by hand. Set by the
    padlock, and by a gesture that puts the row where the engine would never choose — a visual
    margin, the Friday buffer, the weekend. See *The Padlock Is the Only Pin*. Cleared by the
    padlock, and by nothing else.
  - `manual_duration`: Boolean. The **length** was set by hand (the bottom-edge drag), so the engine
    keeps it instead of re-deriving the job's segmentation from its total, and the job's run **ends**
    at that row. It exempts the row's *duration*, never its *position* — a hand-set row is still
    moved by the reflow. See *A Hand-Set Duration*. A flag rather than a second copy of the minutes:
    `duration` stays the single source of truth, so the two can never disagree.
  - **One Project can have multiple Blocks** across different days.
  - **A stored block never straddles a non-working interval** (lunch break, end of day). Work
    crossing the lunch break is two blocks of the same job — see *Blocks and the Lunch Break*. This
    holds for a HAND DROP too: the drop is cut at the break when it is saved. The end-of-day half is
    enforced in one place — see *The End of the Day Is a Line No Write May Cross*.
  - **A drop onto Monday-Thursday, inside the working periods, does not pin the block.** It is an
    ordinary block: surrounding unlocked work reflows around it, and placement by hand changes the
    *order*, not the block's mobility.

- **Gap** (id, date, start_time, duration, reason, created_at, updated_at)
  - A **break/hole** in the schedule (admin, maintenance, machine breakdown).
  - `reason`: Optional text. Can be empty.
  - All gaps share one visual colour (configurable in Settings).
  - **Gaps are time**: they consume the day's plannable hours exactly like locked work does, and are
    fixed occupancy — never auto-recomposed.

**Two marks and no more.** A row can stop reflowing for exactly two reasons, each independently
visible and independently undoable: the **padlock** (`locked`) fixes the POSITION, the **ruler**
(`manual_duration`) fixes the LENGTH. There is no third state. A `hand_placed` column existed until
2026-08-14 and was removed.

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

**Which places padlock a drop** (`pinsTheRow`, `src/lib/operations/blocks.ts`):

| where | padlocks? |
|---|---|
| Friday, the buffer | yes |
| Saturday and Sunday | yes |
| manual-only time on ANY day — a visual margin | yes |
| the lunch break, any day | **no** — it is not a slot: the drop starts at 15:30, inside the periods |
| Monday-Thursday inside the periods | **no** — it re-ranks the queue and the row settles contiguously |

Two details keep the manual-only rule honest: it needs at least a quarter of an hour of manual-only
time (`MIN_MANUAL_ONLY_MINUTES`, held equal to the drag layer's `SNAP_MINUTES` by a test), because a
drop's rank may be nudged by a single minute and one minute of margin is a tie-break rather than a
request; and a **resize** padlocks too, since a length reaching into a margin cannot exist without
the slot.

The test is asked of the rows that will REALLY be stored, which is why the lunch break is not in the
table any more: a drop aimed there is stored from 15:30 (*A Minute With No Working Time*), so it asks
for no manual-only minutes at all. It used to pin, and it had to — the row was stored where it was
released, and the engine's only possible answer to a row in the break is to undo the drop.

**The padlock is only ever ADDED by a gesture, never removed by one.** Dropping a padlocked row back
onto Mon-Thu leaves it padlocked, where it lands on the exact minute it was released at. The way
back is to press the padlock — on the row's hover bar, and on every row in the job panel's list, so
it is reachable for a row weeks away. *Back to automatic* (`{action:"release"}`) gives back the
LENGTH only. Two marks, two undos, and neither is ambiguous about what it hands over.

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

### No Backfilling, No Automatic Splitting
- **Never backfill.** The engine never pulls a later job into an earlier hole. A hole left in front
  of a locked block stays empty unless the job at the head of the queue happens to fit it.
- **Never split a job to make it fit.** If a job does not fit in the space left in the day, the
  *whole* job moves to the next day. This is a rule about **placing a job** — see *A Continuation
  Fills Forward* for the one thing it does not cover.
- Splitting only happens when a job is **longer than a full day's plannable hours**. It then fills
  the hours left in the day the cursor is on, then whole days, and the remainder continues on the
  next auto-fill day. No hour is wasted: 12 h reached on a day with 2 h left is **2 h today and 10 h
  tomorrow**, never 10 h tomorrow and 2 h the day after.
- **Strict order end to end.** Once a job overflows, the rest of the queue follows it. Later jobs are
  never brought forward into the space it left.

### A Continuation Fills Forward
> **A continuation — the tail of a job displaced by a drop, or the remainder left over by a hand-set
> duration — fills forward from where it was cut and MAY split at day boundaries, like any job longer
> than a day. "Never split a job to make it fit" keeps applying to the FIRST placement of a job's
> work.**

**What counts as a continuation**: an item that is **not its job's first item in the queue**.

Everything else is unchanged, and deliberately:
- the continuation is placed **in its queue position**, so strict order holds;
- it is **not growth**, so it skips the Friday buffer like any displaced work;
- it still never straddles a non-working interval, and still stops at the day's plannable hours.

*(Why: DECISIONS.md § A Continuation Fills Forward.)*

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

### The Past is Frozen — And Read-Only To The Block Gestures
> **The past is the RECORD of what the shop did. The engine never writes there, and neither does a
> block gesture: no drag, no resize, no split, no delete, and the padlock stops meaning anything.**

- The engine **never writes to a date earlier than today**. Past days render dimmed, keep no hover
  action bar, and are not a drop target — at either end: a past row cannot be dragged (409
  `past-block-frozen`) and no row can be dropped ONTO a past day (409 `drop-onto-past-day`).
- `setBlockLock` and `deleteBlock` refuse too. A padlock a row carried into the past simply stays.
- **The UI must not offer what the server refuses.** The calendar withholds the whole action bar on
  a frozen day; the job panel draws no scissors and no padlock BUTTON on a past row, rendering the
  padlock as a plain state icon instead.
- **Still allowed, and it is the way out**: editing the job in its FORM, and deleting it. Hours
  added to a job whose last row is past get their own row on a future day (`lastAutomatic`), and
  deleting a job leaves its past rows behind as gaps.
- ***Back to automatic* is also still offered on a past row**: it clears a mark the engine no longer
  consults and moves nothing, so refusing it would only strand the mark with no undo beside it.
- **Today is fully re-plannable.** To protect work already started this morning, lock that block.

*(Why, including the two judgement calls: DECISIONS.md § The Past is Frozen.)*

### Block Resize (drag the bottom edge)
Resizing is a **transfer inside the job**, with the job's **last block** as the counterparty.
`total_hours` does not change unless stated otherwise. **It works on EVERY row THE PAST DOES NOT
HOLD.**

| Action | Effect | `total_hours` |
|---|---|---|
| Enlarge a block that is **not** the last | Subtract those hours from the last block, cascading backwards (LIFO) and deleting any block that reaches 0 | unchanged |
| Shrink a block that is **not** the last | Add those hours to the job's last block **the engine still lays out**, skipping the locked ones and cascading backwards | unchanged |
| Enlarge the **last** block (or the only block) | No farther block to draw from | **increases** |
| Shrink with **no block that can take the hours** | ASK the owner, three ways out | depends on the answer |

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
- **The result is stored in segments.** Both rows carry `manual_duration`, which is what makes the
  engine read them back as one stretch.

**What the edge sizes is the STRETCH that begins at that row's start**, not the rectangle: the row
plus the rows of its own job that continue it on that day and *cannot survive the resize on their
own* — one already hand-set, or one the new segments land on. **An automatic row the stretch does
not reach is left to the engine.**

**The COUNTERPARTY IS ALWAYS A ROW THE ENGINE STILL LAYS OUT.** It is never handed to a row outside
the pool, because there a raw `duration` writes geometry that stays.

**A LOCKED row the stretch rewrites is named** in `touchedLockedBlockIds` and the UI warns; "a locked
block is never grown silently".

**A resize that takes margin time PADLOCKS the row.** It is set alongside `manual_duration`, and the
two have separate undos. `touchedLockedBlockIds` is computed BEFORE the pin is applied, so a resize
never reports the padlock it just added.

*(Why: DECISIONS.md § Block Resize, and Shrinking That Asks.)*

### A Hand-Set Duration
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
that day.** If no job follows in the queue, the hours stay free: the shop really is free then.

Two rules do it, both stated over the **day**, not over "the next item", so they hold again on the
following pass:
- once a hand-set stretch of job X lands on day D, **no more of X is placed on D**;
- the remainder is held back while the jobs behind it fill D, and placed as soon as one of them would
  have to leave D. It may overtake other jobs, never another item of **its own** job.

Everything else applies unchanged: the Friday buffer (a displaced remainder is not growth), the
weekend, the frozen past, plannable hours, and lunch-break segmentation.

**Setting, keeping and losing the mark:**
- **set** by a resize, on the row that was resized — including a resize to the length it already had,
  which makes the gesture total;
- **kept** through a move or a drop of that row, through any other job's edits, and through every
  recomposition;
- **released** by *back to automatic* (`PATCH /api/blocks/:id {action:"release"}`). It gives back the
  **length**, not the queue position;
- **lost** whenever something other than a resize rewrites the row's length: the LIFO transfer from
  the job form, being the counterparty of another row's resize, the scissors, or a drop that cuts it.

The two questions the owner will actually have:
- **The job's total changes.** LIFO works on the job's last unlocked row, so the mark is lost **only
  if that is the hand-set row itself**. Raising a 14 h job to 17 h leaves a hand-set 2 h at 2 h.
- **The block is dragged.** The mark is **kept**: a drag sets the row's place in the queue, but
  nothing rewrites its length. The one exception is a drop that lands *inside* the row and cuts it.

*(Why, including the fixed-point constraint the `QueueItem` doc comment records: DECISIONS.md § A
Hand-Set Duration.)*

### Capping a Day — "we only do 2 h of this today"
Three honest ways, all of which fall out of the rules above:

1. **Put another job after it.** The drop re-ranks the queue, the job splits there, and the day reads
   `A 2 h, B, A 4 h`.
2. **Stop the day with a gap.** A **one-click action** on the block's hover bar ("Cerrar el día
   aquí"): it pre-fills a gap from a chosen moment to the end of the day's last enabled period, asks
   only for an optional reason, and states what the day loses. It is an ordinary gap — same endpoint,
   same refusals, editable and deletable afterwards.
3. **Shrink the block.** It sticks (*A Hand-Set Duration*) and the hours it frees go to the jobs
   behind it in the queue.

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
- **The engine** leaves a full quarter for the tail instead of a sliver (`wantedFrom`).

**It is deliberately NOT a write-path guard**: the one sub-quarter row a gesture can still produce is
an Open Decision, and a floor on the write path would answer it by accident and leave the owner
unable to delete the sliver it refuses to store.

### Blocks and the Lunch Break
- `duration` always means **net working hours**, so every row is a solid rectangle on the clock and
  can be interpreted without reading Settings.
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
- **A hand-set length ENDS the run.** `buildQueue` never joins a hand-set stretch to an automatic
  one, and never joins two of them across days.

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
- **A GAP is untouched.** A gap's `duration` is CLOCK minutes — *stop the day here* makes one across
  the comida on purpose — so a gap is the one row that MAY span a break.

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
- cutting a row rewrites its length, so a **hand-set duration on the row that is cut is released**.

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
| a **visual margin**, any day | yes, once the slide finds nothing | the drop padlocks there, so it lands literally |
| the **lunch break**, any day | it is not a slot: the drop starts at 15:30 and is then judged by the day it is on |
| ANY day, when the row being dragged is already **locked** | yes, once the slide finds nothing | the padlock means the row lands where it was released |

A padlocked row being dragged is **slid** like any other padlocking drop: the padlock keeps the
ENGINE off the row, it does not stop the owner aiming it.

The codes, all 409 and all writing nothing: `overlaps-gap`, `overlaps-locked-block`,
`merge-exceeds-day`, `displaced-hours-unplaceable`. Their sentences name the reason rather than
opening with *«Ahí no cabe»*.

### Aiming Below What A Day Holds Means The Next Day
> **A drop whose footprint would run past the end of its day is not refused and is not clamped: it
> lands on the NEXT DAY the calendar would use, at the top of that day's working periods.**

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
- If a job doesn't fit in the day's plannable hours, the whole job moves to the next day it fits in,
  respecting the Friday and weekend rules.
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
    break, so a block's height is its own minutes exactly; a GAP may span one and covers the seam.
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
- **Day headers** carry their state: `Lun 10 · congelado`, `Mar 11 [hoy]`, `Vie 14 · buffer`.
- **Summary strip** above the grid, amber-tinted:
  `Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre`. This is the stated
  objective of the app. Served from one endpoint so `composition.ts` owns the arithmetic.
- **Header**: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, and `Hoy`, `+ Nuevo trabajo`, language,
  overflow menu.
- **Visual blocks**: tinted fill with a saturated border in the project colour, name + hours. A unit
  cut at the lunch break is marked at both ends. Engine-placed Friday blocks read `desborde 2 h` and
  get a distinct border so an overrun week is visible at a glance.
- **The two marks.** A row can carry either, both or neither:

  | mark | what it fixes | drawn as |
  |---|---|---|
  | padlock (`locked`) | the POSITION | the glyph, plus a solid **whole outline** — the rectangle does not move |
  | ruler (`manualDuration`) | the LENGTH | plus a solid (not hairline) **bottom edge** — the edge that was dragged |

  The tooltip is one line per mark, naming it and the single thing it fixes, so the marks never need
  a legend. The ruler is drawn a shade back from the padlock, the stricter of the two. The padlock's
  solid outline does a second job: on Friday it is the difference between `desborde 2 h` (dashed) and
  a row the owner put there on purpose, so `isOverflow` excludes any unit with a padlocked row in it.
- **Two marks, two undos.** *Back to automatic* appears whenever a unit carries a hand-set LENGTH and
  releases exactly that. It is a `restore` glyph rather than a ruler-off, which would read as a state
  rather than a button. The padlock is undone by pressing the padlock.
- **Past days**: desaturated, not a drop target, and with no gesture on their rows at all.
- **Empty columns**: `libre` / `—` sit in the middle of the day's LONGEST WORKING STRETCH, drawn as a
  small dashed pill (`emptyLabelMinutes` in `geometry.ts`, with a test).
- **Drag-drop**: mouse only, with a ghost during the drag. The ghost states the real outcome before
  the mouse is released — which row will be cut (drawn as a seam), merged into, or refused; whether
  the drop rolls to the next day (`grid.dropNextDay`); whether it slides past something fixed; and
  whether it will padlock. The ghost is drawn **in segments**, one rectangle per row the gesture will
  be stored as, because one rectangle straight through the grey band promises a shape that will never
  exist. **A RESIZE past the break is drawn the same way.**
  - **And the drawn footprint never leaves the day** (`footprintWithinDay`). `segmentDroppedRow` returns
    a stretch UNCUT when its tail would pass midnight, so the server can refuse the drop as it was
    made — and since the drag unit is the whole RUN, that is the ORDINARY case, not a corner: an 18 h
    run drew a single rectangle over the entire column, seam included, on every day the
    pointer crossed. The drawing is capped at the net minutes the day can still hold, so the shape is
    one that can exist; the label beside it already says the rest does not fit today. Storage is
    untouched — only the rectangle is.
- **The week is reachable without putting the block down.** While a move is in the air both ends of
  the grid carry a rail naming the neighbouring week; holding the block on one pages the calendar —
  see *Dragging To The Edge Changes Week*.
- **The ghost never invents a clock time.** A drag's duration is the whole RUN's net working minutes,
  across days, so `start + duration` is an end-of-day reading only while the day can hold every one
  of them (`footprintEnd`, `src/components/calendar/dropEffect.ts`). Where it cannot, the ghost names
  the START and the hours — both true — and says the run is longer than the day holds
  (`grid.dropLongerThanDay`) instead of the clamp's «no pueden empezar después de…», which claims a
  start that would work.

### A Drop Always Answers For Itself
> **Every drop reports what became of it. The only drop that may say nothing is one whose row is
> visible, at the minute it was released, with nothing else changed — because then the calendar is
> already the answer.**

| outcome | when | what it says |
|---|---|---|
| `pinned` | the drop PADLOCKED the row and it did not have one before | it stays there, and names the padlock as the way out. A row that was already padlocked says nothing |
| `settled` | the reflow put it well away from the drop point | a drop is a rank; lock it to pin it |
| `leftWeek` | it landed AFTER the week on screen | names the date its hours carry on from |
| `pulledBack` | it landed BEFORE the week on screen | the queue laid it out where there was room; **padlock first, or drop on a day that keeps the minute** |
| `movedWeek` | it is on the week on screen, and the drag STARTED in another one | names the day and the week, and how to get back to today's |
| `unchanged` | the reflow put it back exactly where it started | admits the drag changed nothing, and **teaches the route in order: padlock first, then move** |
| `absorbed` | its id is gone — a row of the same job took the hours | no hour was lost |

The last two of those are what *Dragging To The Edge Changes Week* made ordinary: a drag that
crosses weeks either keeps the minute (and lands where it was released) or takes a rank (and is laid
out where the queue reaches), and only the row itself can say which happened.

The same order — padlock, then move — is used by `notices.dropSettles` and `grid.dropRankHint`, so
the three agree.

Two rules keep it honest. The outcome is read from **what the server stored**
(`BlockMutation.blocks`), not from the refetched week, so it cannot race the reload. And a **refusal
is not one of these**: nothing was written, the request threw, and the error banner carries the
server's own reason. `describeDrop` in `src/components/calendar/dropOutcome.ts`, pure, with a test
per branch.

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
- **Drag the bottom edge**: resize, as a transfer inside the job. Offered on **every** row — every
  day, and every row OF A UNIT, because each segment is a real rectangle with a real bottom edge. The
  drag is capped at the end of the DAY's last manual window and counted in net working minutes. A
  shrink with nowhere to put the freed hours ASKS.
- **The scissors**: move a PORTION of a job out of its row. Two steps, and the second is not
  optional — the dialog asks how many hours leave the row, then the owner clicks the grid to say
  where they go. A split with an implicit target would park those hours somewhere nobody asked for,
  and a fragment dropped next to its source is auto-merged straight back into it, so it would
  silently do nothing. Both halves are floored at a quarter of an hour. The fragment is a DROP: it
  takes a queue rank and settles, and it padlocks wherever a drop would.
- **None of the above on a PAST day.** Drag, resize, split, delete and the padlock are all refused
  there and are not drawn at all. Only *back to automatic* survives.
- **Click**: open the job panel.
- **Hover**: a small action bar with lock, *back to automatic*, *stop the day here*, split
  (scissors) and delete — never behind a modifier key, since on a shop PC an Alt-drag would never be
  discovered. **The bar drags the block too**: a press on it begins the same move, the press is not
  cancelled (so a press that does not travel is still the BUTTON's click), and a drag that travelled
  eats the one click it would otherwise have delivered to the button it started on.
  The bar **docks outside the block's top edge** when the block is too SHORT or too NARROW to hold it
  (`blockHoldsActions` in `geometry.ts`; `MIN_BLOCK_GRAB_WIDTH`). Do not use a CSS container query
  for this — it would make `.block` a containment context and trap the outside-docked bar behind its
  neighbour. Two buttons are absent where they would do nothing: *stop the day here* on a row that
  already ends the day, on the weekend, on a closed day and in the past; *back to automatic* on a
  unit no part of whose length was set by hand.
- **A gesture that cannot write says so exactly once**, and does not also do something else: a press
  that proves a drag on a gap explains that gaps are not dragged AND swallows the click that would
  otherwise open the gap form.

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
  per-block padlock toggle, the ruler where the row carries it, and *back to automatic* on any row
  whose length was set by hand. It is the only place a row in another week can be released or
  unlocked. **On a PAST row the padlock and the scissors are absent**, and the padlock is drawn as a
  read-only state icon.
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
- **Lock/Unlock**: toggle `locked` per block. Not offered on a past row.
- **Back to automatic**: clear a hand-set LENGTH. It does not touch the padlock.

### Gap Management
- **Create**: Date + Start Time + Duration + Reason (optional). Refused when it would cover a row the
  engine cannot move, naming **the reason that actually binds** — a row is classified `locked`, then
  `weekend`, then `past`, which is exactly the three ways `isMovable` says no. On Saturday the
  weekend is what holds the row, so a padlocked weekend row is refused as `errors.gapOverWeekendBlock`
  while `locked` is reserved for the case where the padlock is the ONLY thing holding it.
- **Create in one click**: *stop the day here* from a block's action bar.
- **Edit**: modify any field. **Delete**: frees up time; recomposition runs if needed.
- **Gaps are not dragged.** Pressing one opens its form; a press that travels says so.

### Settings
Work periods, auto-fill capacity, visual margins, planning horizon, gap colour, language.
- **A change that narrows the day asks first**, in ONE confirmation: it names the blocks the narrower
  periods or margins would strand, and — per *The Capacity Is Never Touched Alone* — the capacity the
  new shift can no longer buy, with both numbers. **Cancel writes nothing** and leaves the rest of the
  unsaved form exactly as it was.

---

## Composition Algorithm Notes

The per-day placement logic is validated in `recompose-poc.js`. Two of its behaviours were checked by
executing it, and only one survives:

- ✅ **Overflows the whole item, never splitting it** — matches the decision above. Keep.
- ✅ **Never backfills a hole left in front of a locked block** — matches the decision above. Keep.
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
  initial migration and the engine reads every day through a single `getDayConfig(date)`, but there
  is **no Settings UI for it**. This keeps holidays and closed weeks a data entry away.
- **Test timeout**: 30 s (`vitest.config.mts`). The suite's property tests run thousands of generated
  calendars each; the seed counts are the guard, so the timeout must not be what decides how many run.

---

## Open Decisions

**Still unanswered. Do not invent an answer — ask first.** Each is a question about what a GESTURE
MEANS, not a broken invariant: hours are conserved, nothing straddles the break, nothing overlaps
that did not already, and recomposing twice changes nothing in every one of them.

The reproductions are in DECISIONS.md § *Reproductions behind the Open Decisions*.

1. **Taking a row out of the movable pool empties the rest of the day and parks the work a week
   later.** Candidates: (a) treat "the job's earlier rows are outside the pool" as a continuation
   too; (b) leave the placement and SAY it; (c) prefer the current day for the remainder even when it
   must split. Fixing it changes what *A Continuation Fills Forward* means.
2. **A 6-pixel drag on a lunch-split unit's bottom edge reshuffles the week while the ghost promises
   nothing.** Candidates: compare like with like (the ROW's own duration); never let a resize be a
   pure mark; or keep committing it and warn in the ghost.
3. **A resize whose result does not fit the day leaves the dragged row untouched and invents a row on
   another day, while the toast says it worked.** Candidates: refuse naming what is in the way; cap
   the drag at what the day can hold; or keep splitting it and report where the hour went.
4. **A resize may grow a row over another job, or over a gap, wherever the reflow cannot separate
   them.** Candidates: refuse naming the row or the gap; cut at the obstacle the way a drop does; or
   keep allowing it and draw the overlap on purpose.
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
   candidates as the sliver — answer both at once.
8. **The scissors never answer for themselves.** Candidates: give them a `describeDrop`-style
   outcome with the same branches; refuse a split whose fragment would settle back inside the source
   row; or leave it.
9. **A hand-set row that has LEFT the pool stops closing its job's day.** Must be answered together
   with decision 1, and the same way, for both marks at once.
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
    that it WILL be placed and carry on. Note the line is midnight and not the end of the day, so a
    13 h run IS accepted and simply reflows back where it came from. Candidates: cut the run across
    days on drop; or refuse it in the PREVIEW (draw the ghost denied) and say so before the mouse is
    released; or leave the behaviour and reword the refusal to name the length. Three things that
    feed on the same over-long number and are deliberately untouched until this is answered — the
    collision test (`dropEffectOf` measures overlaps against the uncut footprint, so a long run can
    announce a cut against rows its real first-day footprint never touches), the pin decision
    (`usesManualOnlyTime` counts minutes past the end of the day as manual-only, scoring 480 for an
    18 h run at 07:00), and the clamp (`latestStartFor` returns a start it knows nothing fits at).
    Only the DRAWN rectangle was fixed, because CLAUDE.md already forbade that shape.
14. **A resize ghost draws its post-break tail on THIS day even when that slot is taken and the
    engine will put the tail on another one.** Measured 2026-08-17: a 6 h Wednesday row grown to 8 h
    with Wednesday afternoon already held by another job previewed `08:00–17:30` as
    `08:00-14:00` + `15:30-17:30`, and stored `Wed 08:00-14:00` + `Thu 08:00-10:00`. The HOURS are
    right and the invariants hold; the rectangle and the end time are not. With the slot free the
    same gesture is exact, so this is only the occupied case. Candidates: draw the tail where the
    reflow will really put it (needs the reflow simulated in the preview); or print no end time for a
    resize whose tail crosses into occupied time, the way the ghost already refuses to invent one for
    a run.

**Decided but NOT BUILT** — do not treat these as done:
- **One-level undo, Ctrl+Z** (decided 2026-08-14). Every mutation already runs in a single
  transaction, so remembering the previous state is enough.
- ***Añadir otra parte*** on the job panel (decided 2026-08-14): creates a second job entry with the
  name and colour pre-filled. See DECISIONS.md § Two Parts of One Job.

**Deferred by direction:**
- **Backups**: an Export button in Settings. The DB is deliberately gitignored and there is no undo.
- **Settings UI for day overrides** (holidays, closed weeks). The table and engine support exist;
  they will **behave like a weekend day**. Only the screen is missing.

---

## Current Project Status

**v0.12 (current).** The engine, the API, the week view, the gestures and the drag layer are built
and green: `tsc --noEmit` clean, `vitest run` 820 passing across 27 files (including four 2000-seed
property harnesses over placement, editing, drops and shrinking), `next lint` clean, `next build`
clean.

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
- **Integer minutes** everywhere inside the engine; `duration` is net working minutes; no stored row
  straddles a break or leaves its day.
- **Database**: auto-created `./data/calendar.db` on first run (the directory must be created too).
  Point `WORKWISE_DB_PATH` at a scratch file when driving the app — never test against `data/`.
- **Complexity**: prioritise simplicity. No multi-user, auth, subscriptions. Keep it lean.
