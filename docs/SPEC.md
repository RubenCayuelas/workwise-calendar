# Workwise — behaviour specification

Every rule the app is held to: the shift it works, how the engine lays work out, how a gesture changes
it, and what the screen says back.

**This file is the WHAT.** `../CLAUDE.md` holds the conventions, the data model and the invariants an
agent must not break, and points here by section name. `DECISIONS.md` holds why each rule is what it is.
A rule changes here; its reasoning is appended there.

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
- `gapColor`: Colour hex for all user-defined gaps. **Stored canonical**: the route trims and the
  validator upper-cases, so `"  #aabbcc  "` is saved `#AABBCC`. The form upper-cases as it is typed,
  so nothing the owner picked is changed behind them.
- **Backups**: `backupsEnabled` (default ON), `backupEveryDays` (default 7, range 1-90, whole days),
  `backupsKept` (default 3, range 1-30). See *Backups* below.

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

**THIS TABLE IS ABOUT A DROP, and one gesture is deliberately not in it.** A band PAINTED on empty
grid space and answered `Un trabajo` padlocks its head on **every** day, Monday to Thursday included —
the only pin inside the working week. It is not an exception to `dropLandsLiterally`, which is
untouched and still says no there: it is a different gesture, whose whole content is a minute the
owner drew. *«Padlock everything the user drags»* was considered and rejected on 2026-08-12 for
freezing the working week, and that reasoning still holds for DRAGS — this pins only what was drawn.
See *Creating a Job With a Start Date*, mode `painted`.

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
it is reachable for a row weeks away. **It is the only way back for the ROW**, and it gives back the
whole of it: its place in the queue and its length. (*Back to automatic*, `{action:"release"}`,
existed while a hand-set LENGTH was a mark of its own; both went on 2026-08-18.)

`Ctrl+Z` is a different thing and does not replace it: the padlock hands one row to the engine, while
the undo line reverts the last WRITE, whatever it was — see *Undo and Redo*. Until 2026-08-21 the
padlock really was the only undo in the app, and this passage said so.

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
  lunch break is one stretch to the arithmetic and TWO rows on the clock. Without the cut an obstacle
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
| the engine would place it EARLIER, or would not place it there at all (a Friday, a weekend, a **closed day**, the past) | `born` | the job's real rows, on that day and the days after, laid out by `compose` itself. |
| a BAND was painted on the grid, so the day carries a chosen MINUTE too (`startMinutes`) | `painted` | the hours start on that exact minute, cut at the lunch break, PADLOCKED; the overflow carries on from the NEXT day the engine lays out. |

**`painted` is the only mode where the chosen day is a POINT rather than a floor**, and it brings the
one thing the other three do not have:

- **The head is padlocked on EVERY day, Monday to Thursday included.** That is the first gesture in
  the app that pins inside the working week, and a deliberate exception: a drop there is a queue rank
  (`dropLandsLiterally` returns false) precisely so the week stays fluid, but without a padlock the
  next reflow moves the row off the minute the band was drawn on and the band has lied. `autoLock`
  and `dayLock` are otherwise UNCHANGED, so **the tail follows the ordinary rule** — locked only where
  the queue would never have reached that day anyway.
- **The overflow is anchored on the day AFTER the painted one** (`engineRows`' `anchorDate`, with the
  synthetic `today` moved with it). `rankedRow` writes a rank at 00:00, so anchoring on the painted day
  laid the overflow in FRONT of the band, padlocked, on hours the owner never aimed at.
- **The head is cut before anything else sees it** (`paintedSegments`). `compose` re-derives nothing on
  a locked row, so an uncut `13:00 +6 h` would be STORED across the lunch break — and `assertRowWithinDayEnd`
  reads `clockEndOf`, so it would not catch it.
- **The refusals are a GAP's, not a drop's.** A gap or a row outside the movable pool under any of the
  head's rows is refused naming it (409 `painted-over-gap`, `painted-over-fixed-block`), asked of every
  ROW rather than of `start + duration`; ordinary work is NOT a refusal — the reflow pushes it. A
  painted band is never SLID and never CUTS another job: it is on its minute or it is refused.
- **`force` is meaningless here** and sending both is a 400: forcing answers a deferral, and a painted
  band is never deferred. `startMinutes` without `startDate` is a 400 too.

**The automatic padlock is mechanical, not a preference.** A job born where the engine would
otherwise fill earlier has every one of its rows padlocked (`autoLock`) — the padlock is the only
thing that holds it, and a half-locked job would come apart on the next reflow. Inside the span
already planned no lock is added, because the work in front of the job is what holds it there.

**Friday, the weekend and a CLOSED DAY are honoured after an explicit confirmation**, and the rows
landing on the chosen day are padlocked (`dayLock`). The job's continuation follows the normal rules
from there, including skipping the buffer, since it is still a new job. A **past** date is allowed:
the rows are created there, locked, as a record of work that was done but never logged.

**A closed day joined that list on 2026-08-20**, and it is a REVERSAL: choosing one used to relocate
the job to the first open day, which contradicted *a closed day behaves like a weekend* — the rule
stated in Settings and relied on by every drop onto a dimmed column. It is honoured the way a chosen
Saturday is, by the same `manualDaySegments` over the day's own periods, for the same reason: the
engine plans nothing there, so only the owner's choice and the padlock hold the rows.

- **The confirmation is now the SERVER's answer, not the weekday's.** `confirmKindFor` asks the
  weekday FIRST and lets it win, so a preview that failed or has not arrived can still never let a
  save honour a Friday or a weekend silently. A closed day is invisible to the weekday — only
  `day_overrides` knows — so a **dated save waits for its preview** and Guardar is inert until one
  answers. Without that wait a closed day would be honoured without ever being asked about.
- **`needsDayConfirmation` and `confirmKind` are one question**, held so by a `Record` over the three
  kinds: a confirmation with no sentence in it is a dialog the owner cannot read.

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

**The form CLOSES on the save, and the placement is said in a TOAST**: the rows the hours were born as,
and the sentence for a padlock the date left behind (`announceCreation`).
See § *A Form Closes On The Write That Ends It* in DECISIONS. A refusal is the other way round — the
form stays, its fields stay editable, and the banner says what was refused.

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
- **`Ctrl+Z` reaches here too, and that is not an exception.** An undo is not a gesture: it restores
  rows this calendar already held, so undoing a deletion puts the past rows back where they were.
  Reverting the record is not editing it — see *Undo and Redo*.
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
> **The bottom edge is available on EVERY row but a past one, and it means one thing: make this
> stretch of work longer or shorter. It is a TRANSFER inside the job — the hours come from, or go to,
> the job's other rows — and `total_hours` moves only where there is nothing left to draw from.**

| Action | Effect | `total_hours` |
|---|---|---|
| Enlarge a block that is **not** the last | Subtract those hours from the job's later rows, cascading backwards (LIFO), deleting any that reach 0 | unchanged |
| Enlarge past everything those rows hold | **ASKS**: 409 `grow-needs-choice`, one answer, `add-to-total` | **increases** by the shortfall |
| Enlarge the **last** block (or the only block) | No farther block to draw from — **ASKS**, the same way | **increases** once answered |
| Shrink a block that is **not** the last | Add those hours to the job's last block the engine still lays out | unchanged |
| Shrink with **no block that can take the hours** | **ASKS**: `reduce-total` or `new-block` | depends on the answer |

**THE PADLOCK IS NOT A PRECONDITION.** It decides whether the new geometry SURVIVES, which is a
different question and the owner's to answer by pressing it: on a row the engine lays out, a length
that stays inside the working periods is re-derived on the next pass, so the gesture may come out
looking like nothing happened. That is a consequence the owner accepted knowingly (2026-08-20).

**A LENGTH THAT TAKES MARGIN TIME PADLOCKS ITS ROW.** Auto-fill never enters a visual margin, so
without the padlock the next pass pulls the row back inside the shift and the gesture undoes itself.
The margin is how the owner gets ahead of the work — *«para que pille parte del área de margen y así
adelantar trabajo»* — so it has to hold. Pressing the padlock undoes it. (This rule existed as
`usesManualOnlyTime`, was deleted with `manual_duration` on 2026-08-18 when nothing read it any more,
and was restored with the gesture on 2026-08-20.)

**EVERY DEAD END ASKS, IN BOTH DIRECTIONS, and none writes anything unanswered.** 409 with
`details.freedMinutes` and `details.choices`; the answer comes back on the next request as
`freedHours`, and cancelling is simply never sending it. `ResizeChoiceDialog` builds itself from the
server's list, so the answers offered are always the ones that exist — and it takes the DIRECTION too,
because "what do we do with these hours?" and "shall the job get bigger?" are not the same sentence.

**THE TWO DIRECTIONS ARE SYMMETRICAL, and were not until 2026-08-21.** Growing the job's LAST row
rewrote `total_hours` with nothing asked, while shrinking that same row asked; the owner reported it as
one thing behaving two ways. Worse, the grow that DID ask (`grow-needs-choice`, past everything the
other rows hold) was never caught by the screen, so a question the server had asked arrived as a red
error banner. Both halves are fixed: the last-row grow asks, and the client turns either code into the
dialog.

**A GAP's bottom edge is ABSOLUTE** — it just sets the absence's duration — because there is no job
to transfer hours to. See *Gaps Are Dragged And Resized*.

**The drag is measured in NET WORKING MINUTES over the day's manual window**, crosses the lunch break
for free, may reach into the margins, and stops at the end of the day's last manual window. The
result is stored in segments, and **what the edge sizes is the STRETCH that begins at that row's
start** — this row plus the rows of its own job continuing it *on that day*. It never spans days: what
changes on other days is the counterparty giving up or taking hours, not the gesture reaching there.

> **CORRECTED TWICE, and the second correction undid the first.** Between 2026-08-18 and 2026-08-20
> the edge was withheld on any row the engine lays out (409 `resize-needs-padlock`), recorded here as
> *«decided with the owner»*. **It was not** — the owner decided to delete `manual_duration`, and the
> precondition was the implementer's inference, which silently reversed their v0.3 request. Restoring
> the edge on 2026-08-20 then over-corrected the other way, making a grow ADD to the estimate on any
> automatic row; the owner caught that within the day: *«añade horas totales al trabajo sin que esa
> fuera mi intención ni arrastré el último bloque sino uno intermedio»*. The table above is the
> original rule, which was right all along.
> *(DECISIONS.md § The Edge Never Needed The Padlock.)*

**The past is refused first and for its own reason** (409 `past-block-frozen`): a past row is outside
the pool, so the arithmetic would work, but the past is a record.

**SHRINKING ASKS, IT DOES NOT REFUSE**, and so does growing past what the job can pay for. Each dead
end is a QUESTION, asked once and answered in the same request shape:

| the answer | what happens | `total_hours` |
|---|---|---|
| **Cancelar** | nothing is written; the client simply does not ask again | unchanged |
| **Quitar las horas del total** (`freedHours: "reduce-total"`) | the job becomes smaller by those hours | **decreases** |
| **Dividir** (`freedHours: "new-block"`) | the hours become a block of their own, ranked after the job's last row | unchanged |
| **Añadir las horas al total** (`freedHours: "add-to-total"`) | answers a GROW: the job becomes bigger by the shortfall | **increases** |

Unanswered, the request is **409 `shrink-needs-choice`** or **409 `grow-needs-choice`**, writing
nothing and carrying `freedMinutes` and `choices` — the answers that really exist, so the dialog is
built from the server's list in ONE round trip. `new-block` is absent when the freed hours are under a
quarter of an hour, and absent from a grow entirely. A `freedHours` value the refusal did not offer is
a 400, never a silent re-ask. `ResizeChoiceDialog` renders it; `details` carries MINUTES only, and the
dialog formats them. **`freedHours` is the answer channel for BOTH directions** — the name predates the
grow and is kept because it is the documented wire field.

**The dead ends are three, and each of them asks whichever way the edge was dragged**: the stretch
being sized contains the job's LAST row; every counterparty is outside the movable pool (locked,
weekend, frozen past); or the growth is larger than everything the counterparties hold. **A transfer
that the job's other rows can pay for is NOT one of them** and must stay silent — a dialog on every
ordinary drag would be the gesture asking permission to do its job.

- **The drag crosses the lunch break, which costs nothing.** A row starting at 10:00 dragged to 17:30
  is **6 h** — `10:00-14:00` plus `15:30-17:30` — never 7.5 h. Releasing anywhere inside 14:00-15:30
  gives the same 4 h as releasing at 14:00.
- **It may reach into the visual margins**, and stops at the end of the day's last manual window.
- **The result is stored in segments**, and **the whole stretch comes out as fixed as the row that was
  dragged**: every row it writes or absorbs inherits the target's padlock. Half a stretch left to the
  engine came apart on the very next pass — a padlocked `10:00-14:00` beside an automatic
  `15:30-17:30` was reflowed to `15:30-19:30`, so the drag stored a length nobody asked for. Same rule
  as `autoLock`: what holds a hand-made shape has to hold all of it.

**What the edge sizes is the STRETCH that begins at that row's start**, not the rectangle: the row plus
the rows of its own job that continue it *on that day* and cannot survive the resize on their own — one
the engine does not lay out either (the other fixed half of the same unit), or one the new segments land
on. **An automatic row the stretch does not reach is left to the engine**, and the stretch NEVER spans
days: what changes elsewhere is a counterparty giving up or taking hours.

**The COUNTERPARTY IS ALWAYS A ROW THE ENGINE STILL LAYS OUT** (`lastAutomatic`). Hours handed to a row
outside the pool are written straight onto the clock, where nothing settles them.

**A LOCKED row the stretch rewrites is named** in `touchedLockedBlockIds` and the UI warns; "a locked
block is never grown silently".

**Margin time PADLOCKS the row** — stated in full above. `touchedLockedBlockIds` is computed BEFORE the
stretch's padlock is spread, so a resize never reports a padlock it has just applied.


*(Why: DECISIONS.md § Block Resize, and Shrinking That Asks, and § The Padlock Holds the Length.)*

### Capping a Day — "we only do 2 h of this today"
Three honest ways, all of which fall out of the rules above:

1. **Put another job after it.** The drop re-ranks the queue, the job splits there, and the day reads
   `A 2 h, B, A 4 h`.
2. **Stop the day with a gap.** A **one-click action** on the block's hover bar ("Cerrar el día
   aquí"): it pre-fills a gap from a chosen moment to the end of the day's last enabled period, asks
   only for an optional reason, and states what the day loses and whose hours the engine will move.
   **Across the lunch break that is TWO rows** and the plan says so (`CloseDayPlan.rows`), while the hours
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

> **The one-minute rank nudge can put a day off the quarter hour**, and it is SET ASIDE — the owner
> could not reproduce it and asked for it to be left (2026-08-20). Do not open a round on it
> unsolicited; if anything similar surfaces, say that this was set aside. The measurements and the
> two candidate fixes are in DECISIONS.md § The One-Minute Rank Nudge Crosses the Break.

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
  at the lunch break is stored from 15:30 and a gap can no longer be recorded inside the break. Nothing
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
the weekend, the buffer, a visual margin, a locked unit — that minute is not an ordering, it is the
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
- from Monday to Thursday, and from the Friday buffer, it rolls forward to the next such day. The
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

## Undo and Redo

> **`Ctrl+Z` walks the calendar back one write, `Ctrl+Y` walks it forward again, up to 50 steps. A
> step is a whole STATE of the calendar, never the inverse of a gesture — the reflow rewrites,
> deletes and recreates rows on every pass, so what a move DID is not derivable from the move. The
> line lasts ONE RUN OF THE APP.**

A step holds `projects`, `blocks`, `gaps` and `day_overrides`, ids and timestamps verbatim.
**`settings` is not in it** — see *A Settings Save Empties the Line*.

**The line is a row of STATES with a cursor** (`history`, `src/lib/history.ts`). The lowest `seq` is
the FLOOR: restorable, not undoable. Every later row is the calendar AFTER the write its `kind`
names. `undone = 1` marks the redo tail, so the cursor is the highest `seq` with `undone = 0`.

- **A new write drops the tail** — the standard rule, and the only way a redo is ever lost.
- **50 steps**, then the oldest is forgotten: 51 rows are 50 undoable steps and a floor.
- **Emptied when the database is OPENED, not when it is closed.** A close can be skipped — a power
  cut, a kill, a crash — and rows outliving their run would describe a calendar from a previous day:
  at best the drift guard throws the line away, at worst an undo silently reverts yesterday's work.
  No run can BEGIN without opening the file, and that is the only way to a handle, so nothing can
  read a stale line before it is gone. Once the app ships as a Windows application (*Architecture*),
  "a run" is one launch of it, which is what the owner asked the line to last.

**A RESTORE DOES NOT RECOMPOSE.** It puts the stored rows back exactly — same ids, same
`created_at`, same `updated_at` — because anything else would mean undo did not give back what was
there. Two details make that hold rather than nearly hold: the queue's tiebreak is `(date,
start_time, created_at, id)`, so a re-insert through the repositories (which leave `created_at` to
SQLite) reorders the calendar; and it is a DELETE and an INSERT rather than an UPDATE, because the
`updated_at` triggers fire `WHEN OLD.updated_at = NEW.updated_at` and would rewrite a row restored
to its own timestamp. `assertProjectHours` runs afterwards as a net.

**A WRITE THAT CHANGED NOTHING THE OWNER CAN SEE EARNS NO STEP**, so `Ctrl+Z` can never appear to do
nothing. The comparison is the one `RecomposeReport.changed` already uses — over the rows the owner
sees, ignoring timestamps and a BLOCK's id, since the reflow recreates rows on a pass that moved
nothing. Two consequences, both wanted: the micro-resize in *SET ASIDE* stops costing a step, and so
does a Monday-to-Thursday drop the reflow answers with the row's own slot.

**EVERY WRITE PASSES ONE PLACE.** `withHistory` wraps `runTransaction` (`src/lib/scheduler.ts`) at
its 13 mutating call sites, so the step is written inside the same transaction as the rows it
describes, and a refusal or a `horizon-exceeded` rollback discards it for free. That is why the line
is a TABLE and not an array in memory. (`previewAbsence` needs none of it today — it reaches
`writeAbsence` directly, below the hook — but it is the standing proof that this codebase writes for
real and rolls back, and an array would have to be told about every such path by hand.)

**THE ROW CARRIES ITS OWN FINGERPRINT** — the state as the owner sees it, `canonical`. Both questions
the line ever asks are then a string comparison and never a parse of the blob: *did this write change
anything?* and *has the calendar moved outside the line?* Safe to store only because the table is
emptied on open, so a change to how the fingerprint is computed can never meet a row written under
the old one.

**`POST /api/history/undo` and `/redo`**, both answering `{changed, step, focusDate, drifted,
summary}`. What the line HOLDS rides on `GET /api/week`, which the grid already refetches after every
mutation, so the controls cannot fall out of step with the calendar they act on.

### A Settings Save Empties the Line
> **Saving Settings is the one write that is not undoable: it empties the line instead of joining
> it. The owner decided this on 2026-08-21, naming the cost — no undo right after narrowing the
> shift, which is when it would be most welcome.**

A settings save recomposes in the same transaction, so it moves the very rows the earlier steps
describe: the shift they were laid out against is gone. It is asked of the REFLOW as well as of the
fields, or a save that changed no setting but moved rows a restore had put back would leave the line
describing a calendar that is no longer there. **The undo control then says WHY it is off**, instead
of sitting grey and mute.

### What Ctrl+Z Is Not
- **It is not the padlock.** The padlock hands one ROW back to the engine; `Ctrl+Z` reverts the last
  WRITE, whatever it was — padlock presses included.
- **It is not a grid gesture, so *The Past is Frozen* does not refuse it.** Undoing a job's deletion
  puts its past rows back where they were: reverting the record is not editing it.
- **It is not offered on the Settings screen**, which shares no component with the calendar and holds
  a draft form of its own.

### The Two Controls and the Two Keys
- **`Ctrl+Z` undoes; `Ctrl+Y` and `Ctrl+Shift+Z` both redo.** On `window` in the BUBBLE phase: the
  grid's two capture-phase listeners — the drag and the paint — match only Escape and the arrows, so
  there is nothing to fight over and Escape stays theirs.
- **Two discreet ghost icon buttons** before `Hoy`, whose tooltip names the step: *«Deshacer: mover
  «Barandilla»»*. The keyboard is the normal route; the buttons are how the gesture is discovered.
- **ONE predicate decides the buttons AND the keys.** Inert while any panel, form or dialog is open,
  while a gesture is in the air, and while a save is in flight. That is what keeps a restore from
  leaving an open panel, a pending scissors fragment or a held band pointing at a row it has just
  deleted: with everything shut, there is no client state left to go stale.
- **Inside a text field the press is the BROWSER's** and is not touched — no `preventDefault`, no
  notice. With a panel open and the focus on a BUTTON it is inert AND SAYS SO, because there the
  press would otherwise look ignored.
- **A restore shows the week it touched** (`focusDate`, the earliest day the two states disagree
  about) and a toast names what was undone. **Nothing to undo is silent and is not an error**:
  `changed: false`, never a 409 — a control that raced a keystroke must not raise a red banner.
- **A calendar that moved outside the line is never clobbered, and that is checked TWICE.** Before a
  restore, what is on disk must be what the cursor says is there; where it is not — a hand-edited
  file, a maintenance script — the line is emptied, the request says so, and nothing is restored.
  **And before a step is RECORDED**, the cursor must still describe what the write found: checking
  only at restore time protected the foreign write for exactly one gesture, because the next
  ordinary write folded it into its own `after` and the undo below then deleted it reporting
  `drifted: false`. A write that finds a calendar the line does not recognise floors a new line on
  it.

*(Why, and what was rejected: DECISIONS.md § Undo and Redo Are a Line of States.)*

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
  amber is reserved for the app itself. Every swatch holds at least 3:1 against both the light and the
  dark surface — the yellow excepted, which the owner asked to be a true yellow and which therefore
  runs fainter on white — and clears both amber and the gap fill, so no job reads as the app's own
  accent or as a hole in the day. Replacing a swatch repaints the jobs already wearing the retired
  one.
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
    it is the same grey as the top and bottom margins (a margin and the lunch break are the same kind
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
  **`GET /api/summary` is API surface, not dead code**, even though the week view reads the same
  object out of `GET /api/week`: it is the one place the strip's arithmetic is reachable on its own.
  An audit called it unused on 2026-08-20; it is unused BY THIS APP, which is a different thing.
- **Header**: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, and two discreet undo/redo icons, `Hoy`,
  `+ Nuevo trabajo`, language, overflow menu. The icons are ghost-styled and their tooltip names the
  step — see *The Two Controls and the Two Keys*.
- **Visual blocks**: tinted fill with a saturated border in the project colour, name + hours. A unit
  cut at the lunch break is marked at both ends. Engine-placed Friday blocks read `desborde 2 h` and
  get a distinct border so an overrun week is visible at a glance.
- **A gap is HATCHED, and that is what separates it from a job at a glance.** Its fill is `gapColor`
  under `/`-leaning diagonal stripes mixed from that same fill toward the surface, so the stripes
  follow the colour wherever the owner takes it and there is no second setting. The band a paint
  draws carries the same hatch, so the preview looks like what it will store. Purely visual: no
  gesture, rule or engine decision reads it.
- **The mark.** One, and a row either carries it or does not:

  | mark | what it fixes | drawn as |
  |---|---|---|
  | padlock (`locked`) | the ROW — its place AND its length | the glyph, plus a solid **whole outline** — the rectangle does not move and the engine does not re-derive it |

  The tooltip is one line naming it and what it fixes, so it never needs a legend. The solid outline
  does a second job: on Friday it is the difference between `desborde 2 h` (dashed) and a row the
  owner put there on purpose, so `isOverflow` excludes any unit with a padlocked row in it.
- **One mark, one way back**: pressing the padlock. It hands the row back whole, length included —
  which is not what `Ctrl+Z` does, that being the last WRITE rather than one row. (A second mark for a
  hand-set LENGTH, drawn as a ruler with *back to automatic* beside it, existed until 2026-08-18.)
- **The bottom-edge strip is LIVE on every row but a PAST one** (`ns-resize`, the job-coloured pill):
  the server sizes them all. **On a past row there is no edge at all** — the body answers the press
  with `notices.pressOnPastDay`. Withholding the strip anywhere was tried twice and reverted twice:
  the press fell through to the body and started a MOVE.
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
**Still open** — do not answer it by widening `filled` to count PIECES without asking.

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
  one**, as a TRANSFER inside the job. It works on every row OF A UNIT, because each segment is a real
  rectangle with a real bottom edge; the drag is capped at the end of the DAY's last manual window and
  counted in net working minutes; taking margin time padlocks the row; and BOTH dead ends ASK — a
  shrink with nowhere to put the freed hours, and a grow past everything the job's other rows hold.
  **On a past row no strip is drawn at all.**
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
  Friday); or an optional **start date**. The form previews the placement before saving, and closes
  on the save, which names where the hours landed in a toast.
- **Edit**: name, description, colour, total hours (LIFO). This is the way to change a job whose work
  is already behind it.
- **Delete**: requires confirmation. FUTURE blocks deleted and the calendar recomposes; PAST blocks
  become gaps.
- **Lock/Unlock**: toggle `locked` per block. Not offered on a past row. It is the way back for a row
  the owner has settled by hand — position and length together — which is a narrower thing than
  `Ctrl+Z`, and the only one that reaches a row weeks away without walking the line.

### Gap Management
*(Absences over a RANGE of days, closing days, and painting a band are the four sub-sections at the end
of this one.)*
- **Create**: Date + Start Time + Duration + Reason (optional). The hours are **net working minutes**,
  and the save **cuts them at the lunch break** into one row per manual window they reach, sharing the
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
  over `start + duration` instead, 8 h from 10:00 tests `10:00-18:00`, names rows in the lunch break where
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
  released and is cut at the lunch break. **Never a queue rank — a gap is not in the queue**, so there is
  no rank for it to take and `dropLandsLiterally` answers `fixed` for it on every day.
- **The WHOLE UNIT moves.** Both halves travel; the far one is created or deleted by the same
  transaction, since the absence is (day, start, net duration) and nothing else.
- **A release aimed at a minute no window covers starts at the first minute that can hold work** —
  the same rule a block's drop follows (*A Minute With No Working Time*), so a gap aimed anywhere in
  the lunch break is stored from 15:30 and the drop SAYS so (`notices.gapMovedTo`).
- **Its DAY is as literal as its minute, so it is never carried to another one.** A footprint the day
  cannot hold is CLAMPED to the latest start that fits (`resolveDropDay`'s `rolls: false`), exactly
  like a weekend drop: the owner named the day the machine broke, and moving an absence to Thursday
  would be a bigger surprise than the clamp.
- **The resize (bottom edge) is ABSOLUTE, not a transfer**: it just sets the duration. There is no job
  to hand hours to, so **`shrink-needs-choice` can never appear on a gap**. It is counted in net
  working minutes, it CROSSES THE LUNCH BREAK — absorbing or creating the far half — and it clamps at the
  end of the day's last manual window. **This is not an exception to *the padlock holds the length***:
  that rule is about rows the ENGINE lays out, and a gap never is one.
- **The handle is on the LAST row of the unit only.** An absence has ONE duration, measured from its
  own start, so that row's bottom edge is the only edge that is its END.
- **The refusals are the ones a gap already had**, now reachable from two more gestures: a footprint
  over a row the engine cannot move is refused 409 `gap-over-fixed-block`, naming it
  (`gapOverLockedBlock` / `gapOverWeekendBlock` / `gapOverPastBlock`), and on Mon-Thu unlocked work is
  pushed forward. A gap is never SLID and never MERGED — two gaps that touch keep their reasons and
  stay two.
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
  unit id per day, each cut at the lunch break by the very function a single gap uses (`insertAbsence`).
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
- **Closing a day with work on it ASKS; it does not refuse.** Work the engine can move is moved,
  unless the caller names that date in `keepWork`, which PADLOCKS the day's movable rows and closes
  the day around them. Work the engine cannot move — a padlock, a weekend — simply stays, and the day
  closes around it: a closed day is a weekend to the engine, and a weekend has always held padlocked
  work. **Only the PAST still refuses**, 409 `closed-day-over-fixed-block` with
  `closedDayOverPastBlock`, because nothing may be written there at all. The question is asked of the
  DATE and never of `findGapConflicts`'s `reason`: a padlocked past row is classified `locked`, so a
  filter on `past` would let the one case that matters through.
- **Reopening is `DELETE /api/absences/closed-days?from=&to=`** — a range too, so undoing a Feria week
  is also one gesture — and the queue fills those days again on the same pass. The ROW is dropped, note
  and all, **except** where it carries a hand-entered `capacity_hours`: that column has no screen and
  nothing could put it back, so there only `is_closed` is cleared.
- **The way IN to a closed day is its own column.** Pressing a dimmed column opens this screen in
  `Cerrar días` mode on that day, with its note pre-filled — otherwise a mistyped reason would be
  unreachable, since a closed day is not an object on the grid.
- **NO HALF-DAY.** `capacity_hours` stays without a screen: the owner was asked and said no, because a
  short day is a GAP. Do not offer it.

#### Public Holidays Close The Shop By Themselves
> **The shop's municipality is set in Settings. Every public holiday it has — national, Andalusian and
> the two local ones — becomes a CLOSED DAY named after the holiday, written by the app. A holiday
> with work on it ASKS before it moves anything.**

- **The dates are the Junta de Andalucía's open data** (`datos.juntadeandalucia.es`, CC BY 4.0, no
  key), which answers a 302 the fetch must follow and ignores every query parameter — the whole 1.4 MB
  file, every time. **The names come from festivos.io** (CC BY 4.0), a naming layer over that same
  official data. A name that cannot be had is not a failure: a regional day falls back to a written
  table of proper Spanish, and a local one to `Fiesta local`.
- **The horizon is the source's, not a number of ours.** Local holidays for a year are published in
  the October before it, so the app never knows more than about fifteen months ahead and Settings says
  how far it reaches. It writes **every holiday it knows, from today onwards**, the past excluded.
- **A holiday on a Saturday or a Sunday IS written.** It changes nothing for the engine; the header
  naming the day is the point.
- **The check runs once when the app is opened and at most once every 7 days** — elapsed time and not
  a schedule, the shape the automatic backup already uses — plus `Consultar ahora` in Settings.
  Changing the municipality checks straight away. `holidaysEnabled` OFF stops future writes and
  removes nothing already written.
- **A holiday with nothing on that day is closed silently. One with work on it opens the panel** and
  nothing is written for it until the panel is answered: `Desplazar` (the default) or `Mantener aquí`,
  which padlocks the work and closes the day around it. A day whose work already carries a padlock is
  STATED and not asked about — displacing it would have to clear a padlock. Closing the panel writes
  nothing and the next check asks again.
- **THE OWNERSHIP RULE.** A future day whose note is EXACTLY what the last check wrote there is the
  app's to correct: **renamed in place** when a better name arrives — one write of the note, no reflow,
  nothing else on the row touched — and **reopened** when the date stops being a holiday. The moment
  the owner edits that note, closes the day themselves or reopens it, the day is theirs and the app
  never writes on it again. Changing the municipality is the same rule with the whole cache
  invalidated at once.
- **Offline, nothing is written and nothing is lost**: the cache stays, the failed attempt is recorded
  so the next open does not retry, and Settings says when it was. A malformed or truncated body is
  discarded WHOLE — a partial list would close some days and leave others open with no way to tell
  which. A day the write refuses is skipped and named; the rest of the pass still runs.
- **Andalucía only**, 785 municipalities, the list bundled so the picker works with no network.

#### Painting on Empty Grid Space — a Gap or a Job
> **A drag on empty grid space paints a band. ON RELEASE the band STAYS DRAWN and two buttons appear
> at the pointer — `Un trabajo` / `Un hueco` — and whichever is pressed OPENS A FORM PRE-FILLED with
> the day, the start and the net duration. IT WRITES NOTHING either way — the owner presses Guardar.**
> That is the rule they set on 2026-08-18 about *cerrar el día aquí* and it holds for both: the app
> never creates work or an absence by itself.

- **ONE COLUMN per paint** (`usePaintAbsence` over the `paintSession` reducer). Several days go through
  the form's range; cross-column painting does not exist.
- **THE BAND NO LONGER MEANS ONE THING, so it is ASKED rather than guessed.** *«GAPS ONLY»* was
  deleted on 2026-08-21 — but the half of it that forbade a THRESHOLD is now stronger, not weaker: the
  kind is never inferred from the band's size, its day or anything else. `Un trabajo` is focused, so
  Enter is the common answer; there is no memory of the last choice, and **no modifier key, ever**.
- **A `Trabajo` is a job created at the painted MINUTE, padlocked** — see *Creating a Job With a Start
  Date*, mode `painted`. **A `Hueco` is the absence it always was**, and it opens ONE absence rather
  than the `Desde`/`Hasta` range screen, which a one-column gesture had no use for.
- **The band draws the rows the gesture will really be stored as**, cut at the lunch break
  (`segmentDroppedRow`), like every other ghost on this grid, and it is measured in NET working
  minutes: 13:00 to 16:30 is 2 h. It paints upwards as readily as downwards, reaches the visual
  margins, and a press aimed inside the lunch break starts at the first minute that can hold work.
- **Under a quarter of an hour there is no band and no question**: a press that wandered is not a
  gesture. A **pointercancel** commits nothing.
- **Disabled while a scissors fragment waits for its target**, where a grid click already means "put it
  here", and **while a painted form is open** — otherwise a second band replaced a form the owner had
  already typed a name and hours into.
- **A past day and a closed day take no paint**, and each says so once, on the first travel: the past
  gets the frozen-day notice, a closed day opens the absences screen for itself. That the FORM reaches
  a closed day while the brush does not is deliberate: the form asks a confirmation, and pressing a
  dimmed column already means "reopen this day".

#### The Band Stays Drawn While Its Form Is Open
> **Choosing an answer does not erase the band. It stays on the grid and FOLLOWS THE FORM — the day,
> the start and the hours — until Guardar replaces it with the real rows, or Cancelar takes it away.
> For a gap and for a job alike.**

- **Client-side only, and AGNOSTIC to what is underneath it** (`planDraftRows`, `draftBand.ts`): it
  reads no block and no gap, is drawn OVER whatever is there, and never tries to show who gets pushed.
  That is the form's warning to make, and only a whole pass knows the answer.
- **The painted day is EXACT**: its rectangles come from the same `paintedSegments` the save writes, so
  the two cannot drift. A **continuation** day is a shape and is drawn fainter for it.
- **A job's hours span days; a gap's never do.** The band walks the days after the painted one exactly
  as the engine would — skipping the weekend, closed days and the Friday buffer, and measured over
  their PERIODS, because auto-fill never enters a margin. A gap is one column and what the day cannot
  hold is simply not drawn.
- **It never slides on a week change**: it is drawn in the paint band's own slot, outside
  `.columnBody`, so *A Week Change Says Which Way It Went* leaves it alone by construction.
- **The axis is frozen only while the pointer is DOWN** (`PaintController.pressed`). The band and the
  form are held in minutes, so they redraw correctly at any scale; freezing on the band instead would
  hold a stale scale across a window resize.

#### A Date That Leaves the Week On Screen
> **While a band is being held, moving the form's day off the visible week OFFERS THE TRIP: *Ir a esa
> semana*, or *Volver al …* — the last day chosen that WAS on screen. Declining puts the band back
> where it can be seen; it never leaves the owner looking at a week their band is not in.**

- **The date is set OPTIMISTICALLY** and the notice appears after: the band has to follow the field, and
  a field frozen behind a question would freeze the band mid-edit.
- **The way back is the last VISIBLE day, not the previous value** (`offWeekChoice`). Sep 1 → Sep 8
  would otherwise offer Sep 1, which is off screen too, leaving nothing left to press.
- **Triggered by the FIELD changing, never by visibility.** Paging the week with the header arrows
  while a form is open must not ask "shall we go back?" the instant the owner deliberately left it.

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
- **A painted JOB warns through the creation preview it already had** (`POST /api/projects/preview`
  + `PlacementNotice`), not through this one: `planCreation` computes the whole placement, so the form
  states what the day will hold and what the hours cost before Guardar. `startMinutes` is sent to the
  preview only while the date is STILL the painted one — moving the day gives the point up and makes it
  an ordinary floor again, and previewing a minute on another column would promise a placement nobody
  asked for.
- **The hours are read from what the write DID**, not predicted: the rows before and after, per job,
  with the job's furthest day afterwards as "where they land" (`displacedWork`). `summarizeAbsence`
  turns that into the sentences, and it is where the wording is decided and tested.
- **`horizon-exceeded` rolls the whole range back**, upserts included, because they sit in the same
  transaction as the reflow. They did not once: the overrides survived the failed pass and **every
  later write answered the same 409**, including the deletion of the job that would not fit.

### Backups
> **A copy of the database is a file SQLite writes, never a file copy. The automatic ones live beside
> the database and rotate; a copy the owner saves goes wherever they point it and is never touched.**

- **`VACUUM INTO`, not `copyFile`.** WAL holds recent pages outside the main file — measured on the
  shop's own calendar, a 688 KB sidecar against 73 KB of database — so a file copy loses most of the
  recent work, and on a young database it loses the SCHEMA too. One consistent, compacted file with
  no sidecars to carry around.
- **`backups/` sits beside the database**, `path.dirname(getDbPath())`, so it is `data/backups/` today
  and `%APPDATA%\Workwise\backups\` once packaged. NOT the program folder: on Windows that needs
  elevation and an update replaces it.
- **`workwise-YYYY-MM-DD-HHmm.db`**, local time. The name sorts chronologically, which is what the
  rotation and "which is newest" both read — never a modification time, which any copy would falsify.
- **The automatic copy is ELAPSED TIME, not a schedule.** Nothing runs while the app is closed, so the
  check happens when it is opened: newer than `backupEveryDays` means nothing, older means one copy.
  Three weeks away owes ONE. **"When was the last one" is derived from the FOLDER, never stored** —
  in the database it would be restored along with an old copy, and the app would believe it had just
  run one.
- **A copy is taken even when nothing changed.** The owner was shown the consequence — the rotation
  can retire the last copy from before a mistake — and chose it (2026-08-21).
- **The rotation only ever deletes names it could have written itself.** A copy saved by hand into the
  same folder survives a limit of three, and so does `workwise-before-restore.db`. Lowering the limit
  deletes nothing until the next copy is taken: saving a preference must not delete data.
- **The refusals, all of which write nothing**: 400 `backup-not-a-database` when the file is not SQLite,
  400 `backup-not-workwise` when it is a database but not this app's, and 404 `backup-not-found` for a
  name that is not one of the automatic copies in the folder — which is also what a name reaching
  outside it gets.
- **Restoring is ONE implementation** for both ways in, a name from the folder and a file from
  anywhere, so neither can be the less tested one. In order: recognise the file (SQLite header, then
  the tables), **migrate it** so a copy from an older version of the app is what a backup is for,
  keep the calendar being replaced as `workwise-before-restore.db`, then close, swap, delete the
  orphaned sidecars and reopen. Nothing is destroyed before the last step, and reopening clears
  `history` — an undo may not reach back into a calendar that no longer exists.
- **A name is `basename`d and must match the automatic pattern**, so the folder cannot be used to read
  an arbitrary file off the disk.
- **The buttons.** *Guardar copia* opens the browser's native save dialog (`showSaveFilePicker`,
  falling back to a download where it does not exist) — the server streams bytes and never learns
  where they went. The list of automatic copies is the primary way to restore; *Cargar copia desde mi
  PC* is a secondary button for a file the owner saved themselves.
- **Silent when it works, loud when it does not.** The automatic copy says nothing on success or when
  it was not due; a failure raises the error banner, because a backup that quietly never happens is
  worse than none.
- **A HAND action says what really happened, in place and until dismissed.** Not a toast: a 4-second
  corner message is the wrong feedback for the action that protects the data, and after a restore the
  page reload destroys it outright (which is why the confirmation crosses the reload in
  `sessionStorage`). Saving distinguishes its two outcomes, because they are different facts — the
  native dialog put the file where the owner chose, while the fallback put it in the browser's
  downloads folder. `showSaveFilePicker` exists only in a SECURE CONTEXT, so reaching the app by IP
  rather than by `localhost` always takes the fallback, and the message says so.

### Settings
Work periods, auto-fill capacity, visual margins, planning horizon, gap colour, language.
- **A change that narrows the day asks first**, in ONE confirmation: it names the blocks the narrower
  periods or margins would strand, and — per *The Capacity Is Never Touched Alone* — the capacity the
  new shift can no longer buy, with both numbers. **Cancel writes nothing** and leaves the rest of the
  unsaved form exactly as it was.
- **A save EMPTIES the undo line**, and the undo control then says so rather than sitting grey — see
  *A Settings Save Empties the Line*. There is no `Ctrl+Z` on this screen.

---

## Composition Algorithm Notes

The per-day placement logic was first validated in a throwaway prototype (`recompose-poc.js`, deleted
2026-08-20 — every one of its scenarios is a real test now). Three of its behaviours were checked by
executing it, and **none of the three survives**, which is why the file went:

- ❌ **Overflows the whole item, never splitting it** — replaced by *Fill and Overflow, Always*
  (2026-08-17). The item takes what the day has left and the remainder goes on.
- ❌ **Never backfills a hole left in front of a locked block** — half replaced. Nothing is ever
  pulled BACK into an earlier hole, but the head of the queue now fills the hole in front of a lock
  instead of hopping it.
- ❌ **Keeps filling the day with later jobs after one overflows** (verified: `X 3h, Y 6h, Z 2h` at
  8h capacity places X and Z, overflowing Y). This violates strict order and must not be ported.

---
