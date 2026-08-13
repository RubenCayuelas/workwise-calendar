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

- **Block** (id, project_id, date, start_time, duration, locked, manual_duration, hand_placed, created_at, updated_at)
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
  - `hand_placed`: Boolean. A **human put this row on this day**, on a day the engine would otherwise
    have taken it back — the Friday buffer or the weekend. The engine then treats it as a fixed
    obstacle and never moves it. It is what tells "the engine parked overflow on Friday" (recovered
    the moment Mon-Thu frees up, which is the whole point of the buffer) apart from "the owner said
    do this on Friday". See *A Hand-Placed Row*.
  - **One Project can have multiple Blocks** across different days (e.g., Job A = Mon 2h + Tue 2h + Wed 1h)
  - **A stored block never straddles a non-working interval** (lunch break, end of day). Work that
    crosses the lunch break is two blocks of the same job — see *Blocks and the Lunch Break*. This
    holds for a HAND DROP too: the drop is cut at the break when it is saved. The **end of day**
    half of that sentence is enforced in one place — see *The End of the Day Is a Line No Write May
    Cross*; four gestures used to reach past it.
  - **A drop onto Monday-Thursday does not pin the block.** It is an ordinary block: the surrounding
    unlocked work reflows around it normally, and placement by hand changes the *order*, not the
    block's mobility. Only the buffer and the weekend pin, via `hand_placed` above, because there a
    rank means nothing — the reflow's only possible answer would be to undo the drop.

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
  - Margins accept **every hand gesture and no automatic one**: a drop, the scissors, and the
    bottom-edge resize may all use them; auto-fill never enters them and the capacity stop-line
    never counts them. See *The Manual Window*, which is how that difference is expressed once
    instead of being re-decided at each call site.
  - Because the engine's index space holds no margin minutes, **a hand gesture that takes margin
    time pins its row** (`hand_placed`) — otherwise the very same save would pull it back inside the
    periods, which is what made the margins configurable and unusable. *Back to automatic* undoes it.
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

### The Manual Window (decided 2026-08-13)
> **A day has TWO views, and every rule names the one it is stated over. Auto-fill reads the
> PERIODS. A hand gesture reads the MANUAL WINDOW: the periods plus the visual margins, fused
> wherever they touch.**

On the documented shift the manual window is `07:00-14:00` and `15:30-20:30`, so **the lunch break
stays the only hole in the day** and nothing about segmentation changes — a hand gesture is still cut
there and only there.

It exists because three defects the owner reported were one defect: a resize stopped at the end of its
own period, a drop into a margin was pulled straight back out, and margin time was unreachable by
hand. Each was a place where the only view available was the engine's. So both views are derived in
ONE place (`manualWindowsOf` in `src/lib/manualWindow.ts`, called by `dayShapeFromSettings`), travel
together on `DayConfig` and on the week view's `days[]`, and each rule says which one it means:

| reads the periods | reads the manual window |
|---|---|
| auto-fill placement, plannable hours, the capacity stop-line, `desborde` | the bottom-edge resize, a drop, the scissors, the grid's grouping of a unit and the seam it draws inside one |

The alternative — an `if (isMargin)` in the drag layer, another in the engine, a third in the
scheduler — is what this replaces, and the reason is that a future reader must not be able to add a
rule to one view and forget the other.

---

## Composition Engine Business Rules

### The End of the Day Is a Line No Write May Cross (2026-08-13)
> **A stored row ends inside its day. The line is the end of the day's LAST MANUAL WINDOW —
> `dayEndMinutes` — which is every minute a hand gesture may use, margins included.**

CLAUDE.md already said this twice (the data model above; *Block Resize*'s "it stops at the end of
the day's last manual window") and nothing enforced it. Four gestures reached past it, all answering
200, all storing a row hanging below the grid's own last rule:

| gesture | what it stored |
|---|---|
| a drop released at 13:15 with 6 h | `13:15-14:00` + `15:30-20:45` |
| a bottom-edge resize (over HTTP, and by mouse on a row already outside the windows) | `15:30-21:30`; `19:30-21:00` |
| the scissors' second click | `19:45-20:45`, and `19:30-23:00` |
| a same-job merge | one `13:00-23:00` row, straight through the lunch band |

One line was drawn at MIDNIGHT (`assertRowInsideDay`, which is about a row being *renderable*) and
three were not drawn at all. The axis was worse than no limit: `cover` widens it to keep a row left
over from a longer working day visible, so the drag read its cap off the very space the previous
overrun had opened, and each drop could land lower than the last (verified: three drags compounded
into a 10 h row `13:00-23:00`).

Where it now lives, in the order that actually guarantees it:

- **`dayEndMinutes`, `clockEndOf`, `latestStartFor`** (`src/lib/manualWindow.ts`, pure). The second
  is the conversion everything else was missing: `duration` is NET working minutes, so only it can
  say that 6 h at 13:15 reaches 20:45.
- **The drag layer clamps** (`clampDropStart` in `geometry.ts`): a release that would not fit is
  pulled DOWN to the latest start that does. It replaces `axisEnd − durationMinutes`, which mixed
  net minutes with clock minutes. The set of legal starts is not an interval — a release inside the
  lunch band is legal whenever the row, stored uncut, still ends inside the day — so it clamps to the
  latest legal start rather than to an interval end. The scissors' placement and the rank nudge go
  through the same function.
- **The resize is capped at the day's end and at the row's own end** (`ResizeReach`), never at the
  axis. A row that already sits outside the windows (the margin under it was set to 0) keeps its
  hours, can be shortened, and can never be grown — which is the sub-case CLAUDE.md already decided.
- **The write path refuses** (`assertRowWithinDayEnd`, called by `recompose` over every row it is
  about to write): 409 `row-past-day-end`, nothing saved. It is the backstop, so a future path that
  gets the arithmetic wrong cannot store the shape — and it is **tolerant in exactly one direction**:
  no write may make an overrun WORSE, so a row a settings change stranded outside the windows stays
  savable, movable and shrinkable. Without that clause the guard would refuse every unrelated save on
  a calendar that has one.
- **A same-job merge that will not fit the day is refused** (`merge-exceeds-day`), instead of storing
  the sum uncut.

By construction the clamp only ever fires where the drop PINS: a row whose end passes the last
window holds manual-only minutes, and that is the same test `handPlaced` is set by. So Monday-Thursday
RANKING is untouched — a 2 h drop released at 17:00 on today still ranks at 17:00 and still reflows.

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
- `hand_placed = 0`, and
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
2. **Friday — the buffer**. Friday exists to absorb work that grew beyond its estimate so
   it does not all spill into next week.
   - New job placement **never targets Friday**. A new job fills Mon-Thu; if it does not fit, its
     tail goes to **next week's Monday**, skipping Friday entirely.
   - Friday receives **only overflow generated by the growth of already-placed work** (the job's
     hours were raised, or a block was enlarged).
   - Friday **is** in the movable pool: when space frees up in Mon-Thu the engine pulls those hours
     back, so the buffer self-cleans and stays available for the next surprise.
   - **But only what the engine itself put there.** A block a human DROPPED on Friday carries
     `hand_placed` and is a fixed obstacle — see *A Hand-Placed Row*. That is how the owner puts work
     on the buffer deliberately; a lock is not required (though it still works, and means something
     stricter: it survives a drag back into Mon-Thu).
   - If Friday's plannable hours run out too, the remainder goes to next week's Monday.
3. **Weekends**: entirely outside the engine.
   - Never auto-placed, and **never auto-recovered**. Work is only ever on Sat/Sun because a human
     put it there, so the engine must not undo that decision — the common "delete one job, add
     another" would otherwise yank it back every time.
   - Moved only by hand. No lock required.

### A Hand-Placed Row (decided with the owner, 2026-08-12)
A block a human dropped on a day the engine would otherwise have recovered it from carries
`hand_placed = 1`, and:

> **The engine only ever recovers from Friday what it placed there itself.** A hand-placed row is
> outside the movable pool: it keeps the exact slot it was dropped in, and the reflow flows around it.

The defect it fixes was silent and total: `PATCH /api/blocks/:id {action:"move", date:<a Friday>}`
answered **200 and changed nothing**. Friday is in the pool so the buffer can self-clean, so the
reflow pulled the hand-dropped row straight back to Monday — and nothing on the row distinguished
"the engine parked overflow here" from "the owner said Friday". There was **no way at all** to put
work on a Friday by hand.

**Which days pin.** The ones whose whole point is that the engine does not decide what sits there:
- **Friday, the buffer** — a drop pins;
- **Saturday and Sunday** — a drop pins (and those days were already outside the engine, so the mark
  is a record there rather than a constraint, and the *same* record the UI reads);
- **Monday-Thursday** — a drop does NOT pin. It re-ranks the queue and the row settles contiguously,
  exactly as before. That is a decision the owner made deliberately and likes, and it is unchanged.

**And one SLOT pins, on every day** (2026-08-13): manual-only time — a visual margin, or the lunch
band — because the engine cannot represent those minutes at all, so its only possible answer to such a
gesture is to undo it. Same mark, same reason, same undo. Two details keep it honest: it needs at
least a quarter of an hour of manual-only time (a drop's rank is nudged by a single minute to break a
tie, and one minute of margin is a tie-break rather than a request — `MIN_MANUAL_ONLY_MINUTES`, held
equal to the drag layer's `SNAP_MINUTES` by a test); and a **resize** sets it too, since a length that
reaches into a margin cannot exist without the slot.

**Setting, keeping and losing the mark.** It stands for one specific day the owner chose, so it lives
exactly as long as that choice does:
- **set** by a drop (a move or the scissors) onto the buffer or the weekend;
- **kept** through every recomposition, through any other job's edits, and through a resize of its own
  row — a length is not a day;
- **released** by the explicit *back to automatic* action (`PATCH /api/blocks/:id {action:"release"}`),
  which gives back the hand-set LENGTH and the hand-placed DAY together. One action for both, because
  neither is visible in the calendar's geometry — the row simply stops obeying the engine — and an
  owner who pressed the wrong one of two buttons would still have a row that would not move.
  Releasing hands the day to the ENGINE; it does not promise Monday. A released Friday row keeps its
  queue position, and the forward-only cursor may have passed the earlier hole already — *Never
  backfill* then leaves it on Friday, moved up to the first free minute there, which is the engine
  deciding rather than the owner. It comes off the buffer as soon as the reflow reaches a Mon-Thu day
  with room at its rank (verified in the browser: releasing the hand-set length ahead of it in the
  queue reopened Wednesday and pulled the Friday row back to Thursday in the same pass);
- **lost** by a drop back onto Monday-Thursday. The same gesture that set it takes it away.

It is **independent of `locked`**: a row can carry either, both or neither. The padlock says "never
auto-move this, wherever it is" and survives a drag anywhere; `hand_placed` says "a human chose this
day" and is dropped the moment they choose an auto-fill day instead.

Consequences that fall out of it, all of them wanted:
- a hand-placed row **costs its day the hours it holds** (it is an obstacle, like a lock or a gap);
- a gap that would cover one is **refused** naming it (`errors.gapOverHandPlacedBlock`), the same
  answer a gap over a lock gets, and the message says how to undo it;
- a drop that overlaps one is resolved by the FIXED half of *A Drop That Overlaps* — merged if it is
  the same job, cut if it is another — because nothing will ever separate the two otherwise.

### No Backfilling, No Automatic Splitting
- **Never backfill.** The engine never pulls a later job into an earlier hole. A hole left in front
  of a locked block stays empty unless the job at the head of the queue happens to fit it. The user
  then decides what to do: move or split the locked block, or move or split the new job.
- **Never split a job to make it fit.** If a job does not fit in the space left in the day, the
  *whole* job moves to the next day. This is a rule about **placing a job** — see *A Continuation
  Fills Forward* for the one thing it does not cover.
- Splitting only happens when a job is **longer than a full day's plannable hours**. It then fills
  **the hours left in the day the cursor is already on**, then whole days, and the remainder
  continues on the next auto-fill day. No hour is wasted: 12 h reached on a day with 2 h left is
  **2 h today and 10 h tomorrow**, never 10 h tomorrow and 2 h the day after (confirmed with the
  owner, 2026-08-11).
- **Strict order end to end.** Once a job overflows, the rest of the queue follows it. Later jobs
  are never brought forward into the space it left. Example: Thursday has 5h free, the queue is
  Staircase (6h) then Door (2h) → the Staircase moves whole to the next day, the Door follows it,
  and Thursday keeps its 5h free for the user to fill by hand.

### A Continuation Fills Forward (decided with the owner, 2026-08-12)
> **A continuation — the tail of a job displaced by a drop, or the remainder left over by a hand-set
> duration — fills forward from where it was cut and MAY split at day boundaries, like any job longer
> than a day. "Never split a job to make it fit" keeps applying to the FIRST placement of a job's
> work.**

The defect, in the owner's words: *«al mover un bloque a otro, en vez de adaptarse, desplazó el bloque
al día siguiente sin partirlo ni nada, dejando el día vacío después de la tarea que he movido».*
Reproduced: Barandilla 12 h filling Thursday, a 2 h job dropped at Thursday 10:00. The cut was right
(`Barandilla 2 h, Marquesina 2 h`) and then Barandilla's remaining 10 h went **whole to the following
Monday**, leaving Thursday 12:00-19:30 completely empty.

The cause was "never split a job to make it fit" being applied to a tail that is **already a
continuation of work under way**. The owner chose that rule for *placing a job*; applied to the
remainder of a job that has just been cut or shortened it produces exactly a hole for the rest of the
day and the work thrown a week forward.

**What counts as a continuation**: an item that is **not its job's first item in the queue**. That is
the same population by construction — a job only ever gets a second item because a drop cut it, the
scissors fragmented it, or a hand-set length pushed the rest of it out of a day. A brand-new job has
one item, so it still moves whole or not at all.

Everything else is unchanged, and deliberately:
- the continuation is placed **in its queue position**, so strict order holds and nothing is brought
  forward into the space it left;
- it is **not growth**, so it skips the Friday buffer like any displaced work;
- it still never straddles a non-working interval, and still stops at the day's plannable hours.

This also fixes the owner's second complaint (*«redimensiona mal empujando de forma errónea otros
bloques»*): after a resize the remainder used to leap past a day it could partly fill, instead of
continuing into it.

### Creating a Job With a Start Date (decided with the owner, 2026-08-12)
The create form takes an **optional start date**, chosen from the same `DateSelect` the gap and split
forms use. Left empty it means exactly what it always did: the job is appended to the end of the
queue, Mon-Thu, never Friday.

> **The date means "not before this day". It is a FLOOR, not a deadline** — CLAUDE.md excludes
> deadlines deliberately and this must not grow into one — **and it is NOT STORED.** It decides where
> the rows are born and nothing else: no `not_before` column, no new check inside `compose`. Where a
> date genuinely has to survive, the automatic lock below is what survives.

**The three modes**, all of them answers to one question — *would the engine put this job on or after
that day by itself?* `src/lib/creation.ts` owns them, and one function (`planCreation`) serves both
the save and the form's preview, so the form cannot promise a placement the save will not perform.

| the chosen day | mode | what is written |
|---|---|---|
| the queue reaches it: appending the job lands on or after that day | `queue` | today's behaviour, unchanged: one provisional row after the last block. The job joins the end of the queue, and when that is LATER than the day chosen the form says so before saving. |
| the same, but the owner disagreed (`force`) | `forced` | one provisional row ranked at 00:00 of that day. The job takes that place in the queue and the work behind it moves — the same outcome as creating the job and dragging it there, including that a **locked** row is not moved: it stands, and the new job flows around it and continues after. |
| the engine would place it EARLIER (the day is beyond the work planned), or would not place it there at all (a Friday, a weekend, the past) | `born` | the job's real rows, on that day and the days after it, laid out by `compose` itself. |

**The automatic lock, and why it is mechanical rather than a preference.** Queue order IS calendar
position and the engine fills forward from today, so a rank on a later day is not a reservation: a job
with nothing in front of it is placed at the cursor, which is today. **A job born where the engine
would otherwise fill earlier has every one of its rows locked** — the padlock is the only thing that
holds it, and a half-locked job would come apart on the next reflow. Inside the span already planned
no lock is added, because the work in front of the job is what holds it there. It is the ordinary
padlock: visible, and removable.

The owner stated the rule as "later than the last currently occupied day", and on the dense calendar
they were describing that is the same test. The code measures the reason directly instead — it asks
the engine where an appended job would land and compares — because on a sparse calendar a single
locked row far out makes "the last occupied day" say nothing about where the engine would fill.
Worked examples, both unchanged by the refinement: work planned through 30 Sep, job placed 15 Sep →
no lock, it flows; job placed 20 Oct → locked, or the engine pulls it back to today. **The boundary
where the chosen day IS the last occupied day gives no lock**, and has its own test.

**Friday and the weekend are honoured after an explicit confirmation** ("the Friday is the buffer" /
"the weekend is not planned"), and the rows that land on the chosen day carry `hand_placed`, so the
engine never reclaims them. The job's continuation follows the normal rules from there — including
skipping the buffer, since it is still a new job. A **past** date is allowed: the rows are created
there, locked, as a record of work that was done but never logged.

**`newProjectIds` still applies in every mode**, so the continuation of a dated job skips the Friday
buffer exactly like any new job's tail. The chosen day itself is the one exception, and it is opened
up explicitly rather than by weakening the rule: the synthetic pass that decides where a born job's
rows go reports the chosen day's role as `auto` when it is a Friday, because choosing the buffer by
hand is the owner's intent and they have just confirmed it. The weekend is never opened up — it is
outside the movable pool BY DATE — so the hours sitting on a chosen Saturday or Sunday are laid out by
`manualDaySegments`, free working time forward, a run that holds the job whole preferred, never
straddling the lunch break; the remainder goes back to `compose` from the following Monday.

**The form previews the placement BEFORE saving** (`POST /api/projects/preview`, which writes
nothing): where the hours really start, the rows they would occupy, **what is already sitting across
the whole span they would occupy** — not only the first day — naming the job and the day, whether
every row would come back locked, and which days are free instead. Then the owner picks another day,
forces it, or accepts it.

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

**The drag is measured in NET WORKING MINUTES over the day's manual window** (decided with the owner,
2026-08-13), which is three things at once and all three are the owner's report:

> «al aumentar de tamaño o empequeñecer un bloque este no pasa de las horas de comer y las de margen,
> debería dejarme hacerlo más grande, y que ignore la hora de comer, ejemplo arrastro hasta las 17:30
> una tarea que empezaba a las 10, en vez de la hora del medio sumarla, ignorarla y sería de 10 a 14 y
> de 15:30 a 17:30.»

- **It crosses the lunch break, which costs nothing.** A row starting at 10:00 dragged to 17:30 is
  **6 h** — `10:00-14:00` plus `15:30-17:30` — never 7.5 h. Releasing anywhere inside 14:00-15:30
  gives the same 4 h as releasing at 14:00: the grey band is a dead zone, not a jump.
- **It may reach into the visual margins**, and stops at the end of the day's last manual window.
  It used to stop at the end of the row's own period, so a 4 h morning row could not be made longer by
  any gesture at all and the configurable margins were unreachable.
- **The result is stored in segments**, by the same splitter a drop uses, so no drag can produce a row
  that straddles the break. Both rows carry `manual_duration`, which is what makes the engine read
  them back as one stretch.

**What the edge sizes is the STRETCH that begins at that row's start**, not the rectangle: the row plus
the rows of its own job that continue it on that day and *cannot survive the resize on their own* —
one that is already hand-set (the queue would regroup it with the target, so sizing the target alone
would hand the freed hours to the row right below it and the next pass would read the pair back
unchanged: a 200 that changed nothing), or one the new segments land on (reused rather than stacked
under a second row). **An automatic row the stretch does not reach is left to the engine**, which is
what keeps *A Hand-Set Duration*'s own worked example working: shrinking the Wednesday morning row of
an automatic 10 h unit still leaves the job's remaining hours to be moved by the reflow.

**The COUNTERPARTY is laid out too, or the resize is refused** (2026-08-13). Shrinking a row hands the
freed hours to the job's last row *in the movable pool*, and the reflow settles it. When the job has
none — every other row locked, hand-placed, on a weekend or in the frozen past — the hours land on a
row nothing will ever re-lay out, so writing a raw `duration` onto it writes geometry that stays:
verified in six configurations, a 1 h Saturday row handed 4 h became `12:00-17:00` (minutes on both
sides of the lunch break) and a 15:30 one became `15:30-21:30` (an hour past the end of the day). The
new length now goes through `segmentDroppedRow` — the same splitter the target's own segments use — so
it comes back as two rows around the break; and when the receiver's day cannot hold it at all the
whole resize is refused (409 `receiver-cannot-hold-hours`), because an immovable row has nowhere else
to put them and nothing later will tidy them.

**A LOCKED row the stretch rewrites is named** (2026-08-13). What the bottom edge sizes is the stretch
that begins at the row, and a continuation is part of it whatever its marks — so growing the morning
half of a unit lengthens a locked afternoon half. That is allowed; doing it silently is not, against
both "a locked block is never grown silently" and `BlockMutation.touchedLockedBlockIds` ("Never
silent"), and the response used to carry an empty list. It now names the row and the UI warns.
Whether a locked continuation should be excluded from the stretch altogether is the owner's call, not
a mechanical fix, and is left in *Open Decisions*.

**A resize that takes margin time pins the row** (`hand_placed`), and only where the engine would
otherwise have undone it. The engine's index space has no margin minutes, so an unpinned row would be
pulled back inside the periods or thrown onto the next day, and the drag would visibly do nothing.
This is the one gesture other than a drop that sets the mark, it is set together with
`manual_duration`, and one *back to automatic* releases both.

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
skips the buffer), the weekend, the frozen past, plannable hours, and the lunch-break segmentation —
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
- **Add hours**: Append to the job's last block **that the engine can still place** — its last block
  in the movable pool (not locked, not hand-placed, not in the past, not on a weekend).
  - If job has blocks: Mon 2h + Wed 1h + Fri 3h, adding 2h makes Fri 5h.
  - Subsequent jobs cascade forward (displaced by the extra 2h).
  - If the job's last block is **outside** the pool, the new hours get their **own new block**, which
    the engine then places normally. The growth target must agree exactly with the movable pool, and
    this is not a nicety: while it only tested `locked` and `hand_placed`, adding hours to a job whose
    last row sat in the **past** wrote them straight onto that untouchable row, which then ran through
    the lunch break, and past midnight took the whole week view down with
    `RangeError: Invalid minutes "1500"`. No gesture was needed to reach it — a row on *today* is a
    past row tomorrow. Fixed 2026-08-12, with a write-path guard so no transaction can store a row
    running past the end of its day even if some future path gets the target wrong again.
- **Remove hours**: Decrement from the **last block**, reaching every block including those outside
  the pool — shrinking frees space rather than claiming it, so it cannot produce an illegal row.
  - If last block becomes 0, it's deleted, and next block becomes the new "last" (keeps decrementing if needed).

### Job Editing: Name/Description/Color Changes
- No impact on calendar layout or block positions. Just metadata updates.

### The Calendar Sits On The Quarter Hour (2026-08-13)
> **A quarter of an hour is the smallest row the calendar can draw and the smallest amount the owner
> can aim at. `MIN_ROW_MINUTES` (src/lib/validation.ts) is held equal to the drag layer's
> `SNAP_MINUTES` and to the `TimeSelect` step by a test.**

A row shorter than that cannot show its own hours (`MIN_LABEL_HEIGHT`): on screen it is a nameless
two-pixel stripe. Two paths could produce one:

- **the scissors**, the one gesture that names a duration outright, checked only that the fragment was
  smaller than the row: `durationMinutes: 5` stored a 5-minute fragment and a 10-minute remainder.
  Both halves are now floored (409 `split-below-minimum`), which also keeps the calendar's own
  quantities on the quarter hour — the UI's two constants were the only thing holding it.
- **the engine**, when a quantity in the calendar is already off the grid. A 19 h 59 min job on days
  holding 600 and 590 plannable minutes placed `360 + 230` and then a NINE-MINUTE row on a day no
  gesture had touched. `wantedFrom` now leaves a full quarter for the tail instead of a sliver. The
  honest boundary, tested: with fewer than two quarters left there is no split that avoids a short
  row, and drawing it is far better than refusing to place it (an item the cursor keeps stepping over
  ends in `horizon-exceeded`, which rolls the whole save back).

**It is deliberately NOT a write-path guard**, and that is the interesting part: the one sub-quarter
row a gesture can still produce is the head a drop released a hair below another row's start leaves
behind, which is an Open Decision below. A floor on the write path would answer that decision by
accident, and would leave the owner unable to delete the sliver it refuses to store.

### Blocks and the Lunch Break
- `duration` always means **net working hours**, so every row is a solid rectangle on the clock and
  can be interpreted without reading Settings.
- Work crossing the lunch break is stored as **two blocks** of the same job (e.g. 13:00-14:00 and
  15:30-17:30 for a 3h stretch). The engine splits at the period boundary when placing.
- On screen, consecutive segments of the same job are drawn as **one grouped unit** (outer rounded
  corners, label on the first, single drag handle) so the owner still sees and moves "one 3h job".
  Two rows are one unit when nothing **workable** separates them, read over the *manual window*, so
  half an hour of margin between two rows keeps them apart while the whole lunch break does not.
- **The unit is marked at BOTH ends** (decided with the owner, 2026-08-13). The row above the break
  reads `4 h · sigue…` and the row below `…sigue · 4 h` — the ellipsis on the side the work carries
  on — and each has the dashed edge on that same side plus its own tooltip line ("Sigue después de la
  comida" / "Viene de antes de la comida"). Only the continuation used to say anything, so looking at
  the morning row alone there was nothing to tell the owner the job went on after lunch.
- **What the mark names is the BREAK BETWEEN TWO WINDOWS, not the join between two rows** (corrected
  2026-08-13 after dragging it). Being one unit is not enough, because a unit joins any two rows with
  nothing *workable* between them and that covers two more shapes than "cut at lunch":
  - **rows that TOUCH**, with no hole at all — reachable whenever auto-merge may not fold them, which
    is exactly the margins: the scissors moving an hour to 07:00 leaves `07:00-08:00` hand-placed
    against `08:00-11:00`, and auto-merge never folds a hand-placed row;
  - **a hole left by a margin the owner has since set to 0**, real but not the comida.

  Read off the row's position in the unit (`!isFirst` / `!isLast`), the marks drew a dashed seam down
  the middle of one unbroken rectangle and the tooltip announced a lunch break three hours away. So
  the seam is asked of the day's manual windows — the hole must START where one window ends and FINISH
  where the next begins — and the *rounded corners* stay with the position, which is a different
  question. `seamAbove` / `seamBelow` on `BlockSegment`, with tests for all three shapes.
- **Auto-merge** joins two blocks of the same job only when they touch **inside the same period on
  the same day**. The two halves around lunch deliberately stay two rows.

### Manual Drag-Drop & Merging
- User can move a **portion** of a job (fragment it) or the entire block.
- On DROP: the queue is reordered (see *Queue Order*) and auto-recomposition runs.
- **Auto-merge**: as described above.

### A Drop Moves Its Whole Unit, In ONE Transaction (2026-08-13)
> **A unit is one thing to drag, so it is one request. The rows of the unit are folded into the row
> the request names, moved as one row, and stored in segments at the destination.**

It used to be one `PATCH` per row of the unit, a minute apart, each its own transaction with a full
reflow between them — and that is not a smaller version of the same thing. The reflow re-laid the
job's remaining hours onto DIFFERENT ids in between, so the second request moved whatever row now
carried the id the drag had captured: a 3 h unit dragged onto Saturday moved 2 h and left an hour on
Thursday, while the message said no hour had been lost (true, and beside the point). The same race
raised «Ese bloque ya no existe» on drops that had in fact succeeded.

The client names the unit it drew (`unitBlockIds`, the grid's own grouping) and the server checks the
list against what is stored (`unitOf`, over `adjacentInWindows` — the same predicate the grid groups
with and the resize sizes a stretch with). An id that is not really part of the unit — another job,
another day, a row a previous gesture absorbed — is **ignored, not refused**: the list describes what
the owner saw, and the server is the authority on what it means. An HTTP caller that names one row
still moves one row, which is what aiming at a row means.

### A Drop Is Stored In Segments (decided 2026-08-12; the window named 2026-08-13)
> **A dropped block is cut at the break between two MANUAL WINDOWS, exactly like everything the
> engine places is cut at the break between two periods.** 6 h dropped at 10:00 is stored as
> `10:00-14:00` plus `15:30-17:30`, two rows of one job, on every kind of day.

A hand drop was the one placement that did not go through the engine's own segmentation, and therefore
the one way to get a stored row holding minutes on both sides of the lunch break — reproduced: a
360 min drop onto a past Monday at 10:00 was saved as a single `10:00 + 360 min` row running straight
through 14:00-15:30. `duration` is **net working time**, so that row was a lie about the day, and the
grid, the overlap arithmetic and auto-merge all read a row as one solid rectangle.

It applies to the merge below too: a same-job merge whose summed hours cross the break comes back as
two rows rather than one long one. Two things it deliberately leaves alone, because each is latitude a
hand drop already has and neither is a straddle: a row that **starts** outside every window (the lunch
band itself), and anything whose tail would land past midnight. A row that starts in a **margin** is
no longer one of them: the margin is inside the manual window, so such a row runs on into the period
below it with no boundary between them and is cut at the lunch break like any other.

### A Drop That Overlaps (decided with the owner, 2026-08-11; extended 2026-08-12)
A drop onto the **weekend, the frozen past or a hand-placed row** lands where the engine may not reflow, so both the
dropped row and whatever was there are fixed obstacles and the reflow will never separate them. The
overlap is therefore resolved when the drop is saved, in the same transaction, **before**
recomposition — never by a general pass over the calendar, because two rows that were *already*
overlapping are somebody's decision and tidying them on an unrelated save is what rule 6 forbids.

- **Same job → one block, hours SUMMED.** Existing Sat 09:00-11:00 plus a 2 h drop at 10:00 becomes a
  single **09:00-13:00, 4 h** row. Not 09:00-12:00: an interval union would silently eat an hour.
  The earlier row survives (it keeps its id), so the write is an UPDATE plus a DELETE. If the sum
  crosses the lunch break it is stored as two rows (above), and the absorbed row's id is reused for
  the second, so the write is two UPDATEs instead.
- **Different jobs → the cut job is split and its tail pushed after the new block.** A at 09:00-11:00
  with B dropped at 10:00-11:00 becomes A 09:00-10:00, B 10:00-11:00, A 11:00-12:00. A keeps its 2 h.
  "If the user does not want it, they move it again." Neither piece may straddle a non-working
  interval, so a pushed tail may itself become two segments; if it does not fit before the end of the
  day it chains forward like overflow — and a **weekend tail stays on the weekend** (Sat → Sun),
  because the engine never moves weekend work. A tail pushed out of the frozen past skips the
  weekend and the Friday buffer (a displaced row is not growth).
- **A GAP is never overlapped either** (2026-08-13). Gaps and blocks are ONE occupancy set, and the
  mirror gesture — a gap over a hand-placed row — is already refused naming the row, so the precedent
  fixed the answer: a drop that lands on a gap is refused (409 `overlaps-gap` / `errors.dropOverGap`)
  naming the day and the hours, and the ghost says so before the mouse is released. Only on the fixed
  side: on Monday-Thursday the reflow keeps auto work off a gap by itself, so nothing is said. That is
  why this only ever bit where the drop PINS — the buffer, the weekend, a margin, the lunch band,
  which is exactly where the owner parks work by hand. It was stored silently on top of the gap:
  no cut, no toast, two things holding the same minutes.
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
- **Day headers** carry their state: `Lun 10 · congelado`, `Mar 11 [hoy]`, `Vie 14 · buffer`.
- **Summary strip** above the grid, amber-tinted:
  `Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre`.
  This is the stated objective of the app, so it ships in v0.2. Served from one endpoint so
  `composition.ts` owns the arithmetic: last occupied date across all weeks, hours queued, and
  whether Friday is still clear.
- **Header**: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, and the actions `Hoy`, `+ Nuevo trabajo`,
  language, overflow menu.
- **Visual blocks**: tinted fill with a saturated border in the project colour, name + hours.
  A unit cut at the lunch break is marked at BOTH ends: `4 h · sigue…` above the break and
  `…sigue · 4 h` below it, each with the dashed edge on the side the work continues (see *Blocks and
  the Lunch Break*). Engine-placed Friday blocks read `desborde 2 h` and get a
  distinct border so an overrun week is visible at a glance.
- **The three marks** (settled 2026-08-12). A row can stop reflowing for three independent reasons,
  and each has to be visible and undoable, so each gets its own glyph and its own edge treatment.
  They are deliberately unalike, and a row can carry any combination of them:

  | mark                    | what it fixes | drawn as                                            |
  |-------------------------|---------------|-----------------------------------------------------|
  | padlock (`locked`)      | the POSITION  | the glyph alone — it survives a drag anywhere        |
  | ruler (`manualDuration`)| the LENGTH    | plus a solid (not hairline) **bottom edge** — the edge that was dragged |
  | hand (`handPlaced`)     | the DAY       | plus a solid **whole outline** — the rectangle the owner placed |

  The tooltip is one line per mark, naming it and the single thing it fixes
  (`block.markLocked` / `block.markManualDuration` / `block.markHandPlaced`), so three marks on one
  small rectangle never need a legend. The two hand marks are drawn a shade back from the padlock,
  which is the strictest of the three.

  The hand's solid outline does a second job: on Friday it is the difference between `desborde 2 h`
  (dashed — the week overran and the engine parked hours on the buffer) and a row the owner put
  there on purpose. `isOverflow` therefore excludes any unit with a hand-placed row in it, so the
  two treatments never appear on the same block.
- **One undo for both hand marks.** *Back to automatic* appears whenever a unit carries EITHER a
  hand-set length or a hand-placed day, and releases both — matching the server, where one `release`
  clears both. It is a `restore` glyph rather than the ruler-off it used to be: a ruler would name
  half of what the action does, and would be plainly wrong on a Friday row of automatic length.
- **Past days**: desaturated and not a drop target; still editable by hand.
- **Empty columns.** `libre` / `—` sit in the middle of the day's LONGEST WORKING STRETCH, drawn as a
  small dashed pill. Centred on the column instead — which is what they were — the documented shift
  puts them at 13:45, a quarter of an hour above the 14:00 rule and on the lip of the grey lunch
  band, where the word reads as debris left over from something else rather than as a label for the
  day. `emptyLabelMinutes` in `geometry.ts`, with a test.
- **Drag-drop**: click and drag job blocks to a new position. Ghost/preview during drag. Mouse only.
  Since an overlapping drop CUTS the row underneath on any day (*A Drop That Overlaps*), the ghost
  also says what the drop will do to that row before the mouse is released — cut it here (drawn as a
  seam across it), merge into it (hours summed), or be refused because it is locked. Announcing it
  afterwards in a toast would be telling the owner about somebody else's block only once it had
  already been split.
  The ghost is drawn **in segments**, one rectangle per row the gesture will be stored as, because a
  drop crossing lunch is stored as two rows (*A Drop Is Stored In Segments*) and one rectangle
  straight through the grey band promises a shape that will never exist. **A RESIZE past the break is
  drawn the same way** — two rectangles with the lunch band left clear — since it is stored in segments
  too. The first rectangle carries the span, the net hours and the effect line; the continuation is
  bare, exactly as a stored unit labels only its first row. That segmentation is `segmentDroppedRow` in
  `src/lib/dropSegments.ts` — **imported by both the engine and the preview rather than restated in
  each**, since a preview that promises a cut the server will not perform is worse than no preview at
  all.

### A Drop Always Answers For Itself (decided 2026-08-12)
> **Every drop reports what became of it. The only drop that may say nothing is one whose row is
> visible, at the minute it was released, with nothing else changed — because then the calendar is
> already the answer.**

This is the owner's Friday defect generalised. A drop writes a queue RANK, so the row lands where the
reflow puts it, and *four different things* look identical on screen to a drag the app ignored:

| outcome      | when                                                       | what it says |
|--------------|------------------------------------------------------------|--------------|
| `pinned`     | the row landed on the buffer or the weekend and carries `handPlaced` | it stays there, and names *back to automatic* as the way out |
| `settled`    | the reflow put it well away from the drop point             | a drop is a rank; lock it to pin it |
| `leftWeek`   | it no longer fits this week                                 | names the date its hours carry on from |
| `unchanged`  | the reflow put it back exactly where it started             | admits the drag changed nothing, and why |
| `absorbed`   | its id is gone — a row of the same job took the hours       | no hour was lost (silent when the overlap merge already reported it) |

Two rules keep it honest. The outcome is read from **what the server stored** (`BlockMutation.blocks`)
rather than from the refetched week, so it cannot race the reload. And a **refusal is not one of
these**: nothing was written, the request threw, and the error banner carries the server's own reason.
A drag released where nothing can be written at all — the frozen past — is refused by the drag layer
and says so too, instead of the ghost simply vanishing.

`describeDrop` in `src/components/calendar/dropOutcome.ts`, pure, with a test per branch.

### Block Gestures
- **Drag the body**: move the block — this reorders the queue and triggers a reflow
- **Drag the bottom edge**: resize, as a transfer inside the job (see *Block Resize*). Offered on
  **every** row — every day, and every row OF A UNIT. A unit has one handle for the move, because it
  is one thing to drag, but its segments are separate rectangles with the lunch band between them and
  each has a real bottom edge; without an edge on the first one, *A Hand-Set Duration*'s own worked
  example ("shrink the Wednesday morning row to 2 h") would be unreachable from the calendar. The
  drag is capped at the end of the DAY's last manual window rather than at the end of that row's own
  period, and it is counted in net working minutes, so it crosses the lunch break and may reach into
  the margins while never producing a row that straddles the break — the result is stored in segments.
  On a row the engine reflows, the new length sticks and marks the row hand-set, which
  is a visible, releasable state — see *A Hand-Set Duration*. The consequence is never local, so the
  save reports it: the hours went to the job's last block, the remainder starts on the next day, and
  the jobs behind it took the space the day gained. The refusal (409 `shrink-last-block`) is said the
  same way, since it is the one failure with a concrete next step.
- **Click**: open the job panel
- **Hover**: a small action bar appears with lock, *back to automatic*, *stop the day here*, split
  (scissors) and delete — never behind a modifier key, since on a shop PC an Alt-drag would never be
  discovered. **The bar drags the block too** (2026-08-13). It is a fixed 102 px anchored at the
  block's right edge and it appears UNDER the cursor on the first mouse move, so it covers the block's
  own NAME on every weekend column (129 px wide at the widest viewport) and on every weekday block
  from about 210 px down — the owner's most natural grab point. Swallowing the press there, which is
  what it used to do, made the drag do NOTHING: no ghost, no request, no toast, no console error,
  which is precisely what «la app me ignora» looks like. So a press on the bar begins the same move,
  and two things keep the buttons working: the press is not cancelled (a press that does not travel is
  still the BUTTON's click, and is NOT read as a click on the block), and a drag that travelled eats
  the one click it would otherwise have delivered to the button it started on. Two of them are absent where they would do nothing: *stop the day here* on a row that
  already ends the day, on the weekend, on a closed day and in the past; *back to automatic* on a
  unit no part of whose length was set by hand. It releases the WHOLE unit — a hand-set stretch cut
  at the lunch break is two marked rows, and giving back only half of it would leave the other half
  still closing the day.

#### One Axis Per Gesture (decided 2026-08-13)
> **A gesture is resolved against the axis as it was WHEN THE POINTER WENT DOWN. Only the grid's
> ORIGIN is re-measured while the pointer is down.**

The two are different in kind. An origin that moves means the grid moved under a still hand — a
scroll, a banner opening above it — and the minute under the pointer really did change, so the drag
must follow it. A SCALE that changes means the same pixel now means a different minute, and the
gesture ends somewhere the owner never chose.

This is the answer to «a veces no se coloca exactamente donde quiero». The axis is fitted to the
height the grid is measured at, and the drag hint under the grid is ONE line where the resting legend
is TWO — so publishing the drag's own preview shrank the legend, `.gridArea` took the 9 px, and the
axis re-fitted by 1.2% about 50 ms into the drag. A resize released on 17:30 was read as 17:22 and
stored 5,75 h. "A veces" because it depended on how fast the drag was and on how many lines the hint
wrapped to at that window width. A move looked safe only by accident: subtracting the grab offset
cancels an ORIGIN error, and this was a SCALE error, which it merely re-anchors to the press depth —
visible wherever the exact minute is KEPT rather than re-flowed (Friday and the weekend, both
`hand_placed`).

Three things hold it, in order of what actually guarantees it: `useBlockDrag` fixes the axis in the
session at press; the screen HOLDS the painted axis for as long as a block is in the air, so no late
re-fit (a window resize, a banner, a refetch that widens `cover`) repaints the week mid-gesture; and
the legend reserves its two lines, which removes the trigger at the source. The invariant underneath
is `minutesAt(yOf(m)) === m` for every minute of the axis, margins and lunch band included — asserted
in `geometry.test.ts`, with the gesture itself pinned release-point by release-point in
`useBlockDrag.test.ts`.

### Job Panel (side panel)
- Colour dot + job name + close
- Fields: `Nombre`, `Descripción`, `Horas totales` (stepper), `Color` (swatches)
- `Bloques · 11 h en 4 tramos`: the job's blocks listed as `Mié 12 · 08:00–14:00 · 6 h` with a
  per-block lock toggle, the ruler and hand marks where the row carries them, and a *back to
  automatic* action on any row carrying either of them (it is the only place a row in another week
  can be released). Note
  how the wireframe lists the two halves around lunch as two separate rows (`Mar 11 · 13:00–14:00 · 1 h`
  and `Mar 11 · 15:30–17:30 · 2 h`) — that is the segment model above, confirmed by the design.
- Actions: `Guardar`, `Eliminar`

### Job Management
- **Create**: Name + Description + Color + Hours (e.g., "Door frame" + Red + 8h)
  - Appended to the end of the queue (Mon-Thu, never Friday)
  - Or an optional **start date**, which means "not before this day" — see *Creating a Job With a
    Start Date*. The form previews the placement before saving: where the hours land, what is in the
    way across the whole span, which days are free, and whether the rows come back locked.
- **Edit**: Change name, description, color, total hours (affects last block per LIFO rules)
- **Delete**: Requires confirmation. Blocks deleted; calendar recomposes.
- **Lock/Unlock**: Toggle `locked` flag per block
- **Back to automatic**: clear a hand-set length AND a hand-placed day, so the engine owns the row
  again (`PATCH /api/blocks/:id {action:"release"}`)

### Gap Management
- **Create**: Date + Start Time + Duration + Reason (optional). Refused when it would cover a row the
  engine cannot move, naming **the reason that actually binds** — because the sentence tells the owner
  what to do about it, and advising a release that would not free the row is worse than saying
  nothing. A row is classified `locked`, then `weekend`, then `past`, then `hand-placed`: on Saturday
  the weekend is what holds the row (clearing `hand_placed` would not move it), so a hand-placed
  weekend row is refused as `errors.gapOverWeekendBlock`, and `errors.gapOverHandPlacedBlock` is
  reserved for the case where the mark is the ONLY thing holding it — a Friday or a Mon-Thu row.
  Among rows that are all equally actionable the headline prefers `locked`, then `hand-placed`.
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
- **Growing a job whose last block is outside the movable pool**: the engine appends to the last
  block **it still lays out**, ordered by date then start time. If the job has none, it creates one
  at the next available slot after the job's last existing block. Hours added to a row the reflow
  cannot touch would be written straight onto the clock, where they can run over the day's other
  work or through the lunch break with nothing to settle them — so "a locked block is never grown
  silently" covers **every row outside the pool**: locked, hand-placed, on a weekend, and in the
  frozen past. Taking hours AWAY is not symmetrical and still reaches every row: shrinking one frees
  space rather than claiming it.
  `lastAutomatic` in `src/lib/composition.ts` asks `isMovable`, so all four cases are covered — the
  frozen past included, which is the one that shipped broken and took the week view down with it.
  The mirror of this default is in *Block Resize*: when a SHRINK has to hand its freed hours to a row
  outside the pool, they are laid out in segments on that row's day, or the resize is refused. Only
  the pool gets a raw number written onto it.
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

**The eight below came out of the 2026-08-13 defect hunt** (the one that fixed *The End of the Day*,
the unit drop, the gap refusal and the quarter-hour floor). Every one of them was reproduced, none of
them breaks an invariant of the battery — hours are conserved, nothing straddles the break, nothing
overlaps that did not already, recomposing twice changes nothing — and every one of them is a question
about what a GESTURE MEANS. That is why they were deliberately left alone: guessing would waste the
answer. Each carries its reproduction and its candidates.

1. **Taking a row out of the movable pool empties the rest of the day and parks the work a week
   later.** The owner's «redimensiona mal empujando de forma errónea otros bloques» in its purest
   form, and it arrives three ways at once: growing a row into the bottom margin, padlocking a row,
   and growing a row up against a gap. Reproduction: `Barandilla 14 h` then `Porton 6 h`, today Thu;
   drag the bottom edge of Barandilla's `Thu 15:30-19:30` row down to 20:30 → Thursday MORNING (6 h of
   today) is emptied and stays empty, Friday stays clear, and Porton slides Monday → Tuesday. The
   gesture added one hour and moved nine. Cause: an item is treated as its job's FIRST placement
   whenever the reason it heads the queue is that its earlier rows LEFT the pool, so `continuation` is
   false, *Never split a job to make it fit* applies, and the remainder moves whole. Candidates:
   (a) treat "the job's earlier rows are outside the pool" as a continuation too, so the remainder
   fills the hours left on the day it was cut on; (b) leave the placement and SAY it ("esto deja hoy
   6 h libres y mueve X al lunes"); (c) prefer the current day for the remainder even when it must
   split. Fixing it changes what *A Continuation Fills Forward* means, which is the rule it was
   written to settle.
2. **A 6-pixel drag on the bottom edge of a lunch-split unit's first row reshuffles the week while
   the ghost promises nothing.** The ghost reads `08:00–14:00 · 6 h` — no change — and the request
   `resize 360` is still sent, because `useBlockDrag`'s no-op guard compares the released NET minutes
   from the row's start (360) with `target.durationMinutes`, which for a resize is the STRETCH (600).
   The two can never be equal on a multi-row unit, so no micro-drag is ever suppressed. The resize is
   then a zero-delta one whose only effect is to set `manual_duration`, and *A Hand-Set Duration* does
   the rest: Barandilla's run ends on Thursday, its 4 h go to Monday, Porton fills the freed
   afternoon. The mechanical half (a guard comparing two different quantities) could be fixed
   tomorrow; the semantic half cannot, because the edge the owner can grab sits at 14:00 while the
   value the client is editing ends at 19:30, so a correct guard still has to be told what "release
   where you grabbed" means for a unit. Candidates: compare like with like (the ROW's own duration);
   never let a resize be a pure mark; or keep committing it and warn in the ghost.
3. **A resize whose result does not fit the day leaves the dragged row untouched, invents a row on
   another day, and the toast says it worked.** Gap Thu 18:30-19:30, then `Barandilla 13 h`; drag the
   `15:30-18:30` row's edge to 19:30 → ghost `15:30–19:30 · 4 h`, request `resize 240`, and the
   Thursday row is still 3 h while a NEW 1 h row appears on Monday. The toast says «pasa a 4 h aquí».
   Candidates: refuse it naming what is in the way; cap the drag at what the day can hold; or keep
   splitting it across days and report where the hour went.
4. **A resize may grow a row over another job, or over a gap, wherever the reflow cannot separate
   them.** Both rows are hand-placed, so both are outside the pool and the reflow flows around both:
   `Barandilla` grown to 20:30 sits on top of a hand-placed `Porton 19:30-20:30` on TODAY, and a
   Friday row grown from 12:00 to 13:00 sits on a gap at 12:00-14:00. `resizeBlock` never looks at
   other projects' rows and never at gaps; only the drop path resolves overlaps. The existing decision
   below covers only "a resize that overlaps another job in the frozen past", and both of these are
   today or on the buffer. Candidates: refuse naming the row or the gap (the answer a drop and a gap
   already give — and for the gap half the mirror gesture is already a 409); cut at the obstacle the
   way a drop does; or keep allowing it and draw the overlap on purpose.
5. **A drop released in the lunch band stores one solid row straight through the break.** 6 h released
   at Thu 14:00 is stored as ONE `14:00-20:00` row, of which only 15:30-19:30 is inside a period, and
   `/api/week` then reports the day 360/360 booked while 08:00-14:00 is empty. `segmentDroppedRow`
   skips the cut whenever the row STARTS outside every window, which is latitude *A Drop Is Stored In
   Segments* grants on purpose — written for a row that stays inside the hole, not one six hours long.
   The end of the day is now enforced for it (a 6 h drop at 14:00 fits; 8 h does not and is clamped),
   so what is left is the meaning. Candidates: cut it at 15:30 like every other drop; refuse a release
   inside the band for anything that would not fit inside the band; or clamp the ghost to 15:30 while
   the pointer is in the band.
6. **A drop whose grab offset pushes the unit above the axis lands hours away from the pointer and
   pins it on a Monday-Thursday day.** `grabOffsetMinutes` is measured on the CLOCK, so grabbing
   inside the afternoon row of a lunch-split unit includes the 90-minute hole and the unit's head
   tracks 4.5 h above the pointer; the clamp then floors it at the top of the axis, and
   `usesManualOnlyTime` reads the resulting hour of top margin as the owner ASKING for margin time and
   sets `hand_placed` — on a day CLAUDE.md says a drop never pins. Candidates: do not count
   clamp-forced minutes as a request; clamp to the first minute inside the PERIODS on an auto-fill
   day; or measure the grab offset in NET minutes so the head tracks the pointer through the hole.
7. **On a day that pins, the one-minute rank nudge becomes the stored time.** `Alfa 4 h` by hand on
   Saturday 10:00, `Beta 2 h` dropped 3 px above the 10:00 rule → `Sáb 09:59-11:59 Beta`,
   `11:59-14:00 Alfa` (121 min) and `15:30-17:29 Alfa` (119 min). On Mon-Thu the rank is only an
   ordering and the reflow rewrites it, which is why this stayed hidden; on the weekend, the buffer, a
   margin or the lunch band the rank IS the stored time. Its three candidates are the same three as
   the sliver below, so answer both at once.
8. **The scissors never answer for themselves.** A fragment that reflows back inside the row it came
   from is a 200 that changes nothing, and the UI says nothing — the shape that made the owner report
   Friday drops as "the app ignored me". *A Drop Always Answers For Itself* closed exactly this for
   drops. Candidates: give the scissors a `describeDrop`-style outcome with the same five branches;
   refuse a split whose fragment would settle back inside the source row; or leave it.

**Two more, from the same pass, that are decisions rather than defects:**

- **A hand-set row that has LEFT the pool stops closing its job's day.** `closedDays` is seeded from
  the QUEUE, and a locked, hand-placed, weekend or past row is not a queue item — so padlocking a
  hand-set row re-opens the day the ruler had closed and pulls the same job back onto it, byte for
  byte what *back to automatic* would have produced. Reproduced: `Barandilla 14 h` + `Porton 6 h`,
  shrink Barandilla's Thu 08:00 row to 2 h, then padlock it → 2 h of Barandilla come back to Thursday
  17:30-19:30 and the Tuesday row disappears. Hours conserved, no overlap, idempotent, and the marks
  are documented as independent — so this is not an invariant break, and the mechanical "fix" (seed
  `closedDays` from the stored flag) makes the padlock leave the day EMPTY instead, which is decision
  1 above arriving from a third direction. It has to be answered together with decision 1, and the
  same way, for all three marks at once.
- **A sub-quarter row deleted leaves `total_hours` off the quarter hour for ever.** `DELETE
  /api/blocks/:id` does `total -= row.duration` with no floor, so deleting the 1-minute head the
  sliver decision below leaves behind makes a 20 h job 19.98333 h. Nothing downstream now produces a
  short row from it (*The Calendar Sits On The Quarter Hour*), and no invariant is broken — but the
  number is not one the owner ever typed. It cannot be fixed here without answering the sliver: the
  minutes are real, `SUM(blocks.duration) == total_hours` must hold, and refusing the delete would
  leave the owner unable to remove the very row the app should not have created. Answer the sliver
  and this goes away with it.

- **Does `buffer` belong on a hand-placed Friday row?** `BlockRows.tagOf` labels every Friday row
  `buffer`, including one the owner dropped there. The tag names the DAY's role, not the row's
  provenance, and the hand glyph beside it says who chose the day — but the owner may read `buffer`
  as "the engine overran onto Friday". Raised by the interface pass; left as-is pending a second
  opinion, since changing it means the tag stops meaning one thing.
- **A resize that overlaps another job in the frozen past.** *Block Resize* is offered on past rows
  precisely so yesterday can be corrected, and a *drop* that overlaps is now resolved (see *A Drop
  That Overlaps*) — but a resize is not a drop. Enlarging yesterday's row can still run over another
  job's row on that same past day, and nothing cuts it: the past is a RECORD of what the shop did,
  and silently splitting somebody's record to make room is not obviously the right answer. The three
  candidates are refuse the resize naming the row, cut the other job exactly as a drop does, or keep
  allowing the overlap because two jobs really were on the bench at once. The same applies to the
  LIFO counterparty growing into a past row.
- **A drop exactly onto another row's start leaves a ONE-MINUTE row.** Found by dragging on
  2026-08-13; **pre-existing since v0.3** and untouched by the manual window (`rankFor` and the
  movable-row cut are both unchanged). A drop's rank must not tie with an existing start, so `rankFor`
  nudges it by a single minute, and the direction comes from the unsnapped pointer: released a hair
  BELOW the rule the rank becomes 08:01, which makes the row underneath "start before the drop" and
  *A Drop That Overlaps* cuts it there. Reproduced: `A 08:00-10:00`, `B 10:00-12:00`, B dropped on
  08:00 → `A 08:00-08:01 (0,02 h)`, `B 08:01-10:01`, `A 10:01-12:00`. Hours are conserved and nothing
  straddles the break, so no invariant is broken — but the calendar keeps a 1 px sliver too short to
  show its own hours and the day stops sitting on quarter hours. Released a hair ABOVE the rule the
  nudge goes the other way and the drop is clean (`B, A`, verified), which is why it has stayed hidden.
  The three candidates: ignore a head shorter than one `SNAP_MINUTES` when cutting (the queue rank is
  an ordering, not a position, so the head is not a real 1 min of work); nudge the rank into a
  fractional order instead of a minute; or refuse to cut and let the rank alone decide. Each changes
  drop semantics, so it is the owner's call rather than a mechanical fix.
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
buffer for next Monday; the growth of an existing job lands on it).

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
- **Nothing regressed**: a new job skips the Friday buffer for next Monday while the growth of placed
  work lands on Friday and is pulled back off it when room reappears; weekend work survives the
  "delete one job, create another" churn with no lock; the engine never writes to a past day the owner
  moved work onto; a gap over a locked block is a 409 naming the block, and a gap on movable time is
  accepted.
- **In a real browser** (Chromium, the same clean database): every block carries its own bottom-edge
  handle including the first row of a lunch-split unit; dragging that edge from 6 h to 2 h reproduces
  the worked example on screen; the row draws the ruler mark and a 2 px solid bottom edge; the toast
  reads *«Barandilla» se queda en 2 h aquí y esa duración queda fija…*; *Volver a automático* on the
  hover bar clears it, and appears only on the hand-set row. Zero console errors.

**v0.4 — the three defects found on v0.3, engine and persistence done (2026-08-12).**
All three were reproduced over real HTTP against a clean database, and all three are fixed and
re-verified the same way (today = Wed 2026-08-12, `WORKWISE_DB_PATH` on a scratch path, `next start`):
- **Friday silently swallowed a manual drop** — 200 with nothing changed, because Friday is in the
  movable pool and the reflow recovered the row. Fixed by `blocks.hand_placed`; see *A Hand-Placed
  Row*. `PATCH {action:"move", date:<Friday>, startMinutes:600}` now answers 200 with the row at
  **10:00-14:00 and `handPlaced: true`**, and it survives the create-then-delete churn that used to
  undo it. `action:"release"` brought it home to Wednesday **in that calendar** — the row goes back
  under the engine, which then places it wherever its rank allows; see *A Hand-Placed Row* on why that
  is sometimes still Friday.
- **A displaced tail jumped a week and left the day empty** — "never split a job to make it fit" was
  being applied to a continuation. See *A Continuation Fills Forward*. Dropping a 2 h job into a full
  Wednesday now gives `Bar 08:00-10:00, Marq 10:00-12:00, Bar 12:00-14:00, Bar 15:30-19:30,
  Thu 08:00-12:00` instead of emptying the day from noon; both totals intact.
- **A drop could straddle the lunch break** — the one placement that skipped the engine's
  segmentation. See *A Drop Is Stored In Segments*. 6 h onto a past Monday at 10:00 is now
  `10:00-14:00` + `15:30-17:30`, and 3 h onto a Saturday at 13:00 is `13:00-14:00` + `15:30-17:30`.

Still true, re-checked over HTTP on clean databases: a NEW 24 h job skips the buffer (Wed, Thu, next
Mon) while growing it to 28 h lands on Friday and shrinking it back pulls it off again; weekend work
survives the "delete one job, create another" churn with no lock; a hand-set 2 h row is still 2 h
after an unrelated save and the calendar comes back identical; shrinking a job's last block is still a
409 `shrink-last-block`; a gap over a hand-placed row is a 409 naming it with `reason: "hand-placed"`.
`tsc --noEmit` clean, `vitest run` 455 passing across 18 files (the 2000-seed harness now generates
hand-placed rows and continuations too), `next lint` clean, `next build` succeeds.

**v0.4 — the interface, done (2026-08-12).**
- **A drop always answers for itself** — see the section of that name. The five outcomes are decided
  by `describeDrop`, a pure module with a test per branch, and read from what the server stored.
  A drag released on the frozen past is refused out loud instead of the ghost silently vanishing.
- **The hand-placed mark**: a pointing-hand glyph plus a solid whole outline, next to the padlock's
  position and the ruler's length, with a one-line tooltip per mark saying which is which. On Friday
  it reads against `desborde 2 h`'s dashed border, which is where the two meet.
- ***Back to automatic* on either mark**, in the block's hover bar and in the job panel's row list,
  with a `restore` glyph instead of the ruler-off that named only half of what it does.
- **The floating labels** are centred on the day's longest working stretch and drawn as a pill, so
  they stop landing on the 14:00 rule.
- **The drag ghost was re-checked against the engine** and now draws the drop in the segments it will
  be stored as. `segmentDroppedRow` moved to `src/lib/dropSegments.ts` and is imported by both sides:
  before that, the ghost measured a 6 h drop at 10:00 over 10:00-16:00 and would have promised a cut
  on a row sitting in the lunch band that the server never touches.

Verified: `tsc --noEmit` clean, `vitest run` 475 passing across 19 files, `next lint` clean,
`next build` succeeds. Exercised in a real browser (Chromium, clean database, today = Wed 2026-08-12),
zero console errors: a block dragged onto Friday lands, draws the hand mark and the solid outline,
and answers *«Marquesina» se queda donde lo has soltado, el Vie 14…*; *Volver a automático* on that
row brings it home and the strip goes back to *viernes libre*; a block nudged an hour inside its own
day answers *El calendario ha dejado «Barandilla» donde estaba…*; a drop on a frozen Monday answers
*Ahí no se puede soltar: el pasado está congelado…*; and a 10 h unit dragged over the lunch break
draws two ghost rectangles with the grey band left clear between them.

**v0.4 — closed, all three defects verified BY DRAGGING (2026-08-12).** `tsc --noEmit` exit 0,
`vitest run` 475 passing across 19 files, `next lint` clean, `next build` succeeds. Driven in a real
browser (Chromium over CDP, `WORKWISE_DB_PATH` on scratch databases, `next start`, today =
Wed 2026-08-12), zero console errors. Every scenario below was performed with the mouse — the jobs
created through the *Nuevo trabajo* form, the moves by dragging block bodies, the resizes by dragging
bottom edges, *Volver a automático* from the hover bar — and the stored rows read back afterwards:

- **Defect 1, Friday.** Barandilla 12 h + Marquesina 2 h; Marquesina dragged onto Friday **lands and
  stays** at `Vie 14 10:00-12:00` with `handPlaced`, draws the hand glyph and the solid outline, and
  answers *«Marquesina» se queda donde lo has soltado, el Vie 14…*. It survived the create-then-delete
  churn that used to undo it (same id, same slot). **The buffer still self-cleans in both
  directions**: raising Barandilla to 22 h parked the engine's own overflow at `Vie 14 08:00-10:00`
  reading `desborde 2 h` with a dashed border — flowing *around* the hand-placed row, the two
  treatments adjacent and unmistakable — and shrinking back to 12 h removed exactly that row and left
  Marquesina untouched.
- **Defect 2, the continuation.** With Barandilla filling Wednesday (`08:00-14:00` + `15:30-19:30`)
  and 2 h on Thursday, a 2 h job dropped at Wed 10:00 gives
  `Bar 08:00-10:00 / Marq 10:00-12:00 / Bar 12:00-14:00 / Bar 15:30-19:30 / Thu 08:00-12:00`.
  Wednesday is **not** emptied from noon and the tail does **not** jump a week. Both totals intact.
  Seen again from the other direction: releasing a hand-set length reopened Wednesday and the 10 h
  continuation split `Wed 15:30-19:30` + `Thu 08:00-14:00` instead of leaping past the half day.
- **Defect 3, segmentation.** A 3 h row dragged onto Saturday 13:00 stored `13:00-14:00` +
  `15:30-17:30`, neither straddling the break, and the ghost drew **two** rectangles with the grey
  band clear. The frozen-past case cannot be dragged (the drag layer refuses it, out loud:
  *Ahí no se puede soltar: el pasado está congelado…*, nothing written), so it was re-checked over
  HTTP: 360 min onto past Monday 10:00 → `10:00-14:00` + `15:30-17:30`, which the grid draws as two
  desaturated rectangles, the second labelled `2 h · sigue`.
- **The re-checks.** A resize keeps the size it was dropped at (`Mié 12 08:00-10:00, 2 h`,
  `manualDuration`, ruler glyph + solid bottom edge) and it is a **fixed point** — creating an
  unrelated job let it fill the freed hours exactly as *A Hand-Set Duration*'s worked example
  predicts, and deleting that job again left the whole calendar **byte-identical**. A Mon-Thu drop
  still only re-ranks: dropped at Wed 17:00 the row came back to 10:00 with `handPlaced` false and
  said so (*El calendario ha dejado «Reja» donde estaba…*). The weekend kept its rows through every
  resize, release, refusal and churn in the session. Shrinking a job's last block by dragging is a
  spoken 409 that writes nothing. Hours were conserved after every single gesture.
- **Found here and since fixed** (2026-08-12): growing a job whose last row sat in the past wrote the
  hours onto that untouchable row, straddling the lunch break and, past midnight, taking the whole
  page down. The growth target now agrees with the movable pool, and a write-path guard makes an
  out-of-day row impossible to store. See *Job Editing: Adding/Removing Hours*.

**v0.5 — the optional start date on the create form (2026-08-12).** See *Creating a Job With a Start
Date* for the rule. `src/lib/creation.ts` is pure, holds all of it, and is the ONE planner behind both
`POST /api/projects` (with `startDate` / `force`) and `POST /api/projects/preview`, which writes
nothing — so the preview cannot promise a placement the save will not perform. It asks `compose`
itself where the rows go, on a snapshot with `today` moved to the chosen day and every existing row
force-locked into an obstacle, so segmentation, plannable minutes, no-backfill, the horizon and the
buffer are the engine's answers rather than a second implementation of them.

Verified: `tsc --noEmit` clean, `vitest run` 537 passing across 21 files, `next lint` clean,
`next build` succeeds. The new suites are `src/lib/creation.test.ts` (the decision table, the
auto-lock boundary at "the chosen day IS the last occupied day", the fixed point over five kinds of
start date) and `src/components/jobs/startDate.test.ts` (which sentences the form says, and their
order). `src/lib/scheduler.test.ts` adds the end-to-end cases, including one that creates a job with
every kind of date and asserts the **preview equals what was then written**.

Driven in a real browser (Chromium over CDP, `WORKWISE_DB_PATH` on a scratch database, `next start`),
today = Wed 2026-08-12: a date the queue runs past reports the deferral, the collision (*«Ya hay 10 h
de otro trabajo en esos días: Mié 12 ago · 10 h Barandilla»*) and the free days; ticking *Colocarlo ese
día y desplazar lo que haya* re-previews it onto the chosen day and the save then displaced the other
job forward with the buffer left clear and every total intact; a date beyond everything previews and
creates two rows tagged *Bloqueado*, and an unrelated creation afterwards does not drag them back; a
Saturday asks *¿Crear el trabajo en fin de semana?* and stores `hand_placed` rows; a past Wednesday
stores locked rows that the grid draws desaturated with the padlock glyph.

**Found here and fixed in the same pass**: the create panel reset itself whenever `defaultColor`
changed, and `defaultColor` is the least-used swatch — so creating a job changed it and the panel
wiped the "where the hours went" notice a moment after showing it. The reset now runs on the panel's
OPENING edge only.

**v0.6 — the three defects found on v0.5, and the one idea behind all three (2026-08-13).** The
owner reported a split block marked on one side only, a resize that stopped dead at the lunch break
and at the margins, and margins that were configurable but unusable. All three came from the same
gap — the code knew only the ENGINE's view of a day — so the fix is *The Manual Window*, derived
once and read by every hand gesture, with auto-fill and the capacity stop-line still reading the
periods alone.

- **`src/lib/manualWindow.ts`** (new, pure): `manualWindowsOf` (the periods fused with the margins),
  `netMinutesBetween` / `reachableRuns` (the net-minute arithmetic a resize is measured in),
  `adjacentInWindows` (one predicate for "these two rows are one stretch", used by the grid's
  grouping AND by the server's resize), and `usesManualOnlyTime` + `MIN_MANUAL_ONLY_MINUTES` (the pin
  rule and why a one-minute rank nudge is not a request for the margin). `manualWindows` rides on
  `DayShape`, `DayConfig` and the week view's `days[]`, so the two views cannot drift apart.
- **The resize** is net working minutes over that window (`durationTo`, `maxDurationFrom`), sizes the
  STRETCH from the row's start, and stores the result through `segmentDroppedRow` — the drop's own
  splitter, not a second one. See *Block Resize*.
- **The pin** (`hand_placed`) now also covers the SLOT, not only the day: a drop, the scissors or a
  resize that takes manual-only time keeps it, on any day, released by *back to automatic*.
- **Both ends of a split unit are marked**, in the label (`4 h · sigue…` / `…sigue · 4 h`), in the
  dashed edge, and in a tooltip line each.
- **The ghost** draws a resize in segments too, so a drag past the break shows two rectangles with the
  lunch band clear rather than one block swallowing it.

Verified: `tsc --noEmit` clean, `vitest run` 577 passing across 22 files (`manualWindow.test.ts` is
new; the 2000-seed harness still asserts hours conservation, no overlap and the fixed point, and a new
test pins auto-fill out of the margins), `next lint` clean, `next build` succeeds. Driven in a real
browser (Chromium, `WORKWISE_DB_PATH` on a scratch database, `next start`, today = Thu 2026-08-13),
zero console errors, every gesture made with the mouse:

- **Report A.** A 14 h job's Thursday unit draws `4 h · sigue…` above the break and `…sigue · 4 h`
  below it, dashed on the facing edges, with "Sigue después de la comida" / "Viene de antes de la
  comida" in the tooltips.
- **Report B.** The bottom edge of the `10:00-14:00` row dragged to 17:30 previews `10:00–17:30· 6 h`
  as TWO ghost rectangles with the band clear, and stores `600+240` + `930+120`, both marked — the
  owner's worked example exactly. Released inside the band it is still 4 h. Dragged back to 12:00 it
  stores `600+120` and the afternoon row is gone.
- **Report C.** A block dropped at 07:00 stays at `07:00-09:00` with the hand mark, answers *«Porton»
  se queda donde lo has soltado…*, and the next job flows around it (09:00-11:00); *Volver a
  automático* returns it to 08:00. A row dragged to 20:30 stores `600+240` + `930+300` with the ruler
  AND hand marks and survives an unrelated creation untouched.
- **The Settings guard rail still warns.** Setting the bottom margin to 0 while a hand-placed row holds
  19:30-20:30 names that row before saving (`1 tramo · Barandilla · Jue 13 · 15:30–20:30 · 5 h`).
  Confirming keeps the row exactly where it is — the engine may not move it — and the axis widens to
  21:00 so it stays visible; what the owner loses is the margin as a TARGET (the resize now stops at
  19:30), not the hours already in it, which can be dragged back inside the periods or released.

**v0.6 — re-verified by dragging, and one defect found inside the new mark (2026-08-13).** An
independent pass drove every one of the three reports with the mouse against clean scratch databases
(`WORKWISE_DB_PATH`, `next start`, real Chromium, today = Thu 2026-08-13), reading the STORED rows back
over `/api/week` after each gesture. `tsc --noEmit` exit 0, `vitest run` **581 passing across 22
files**, `next lint` clean, `next build` exit 0. Zero console errors in every session.

- **Report B, the owner's own example, exactly.** `Porton 2 h` then `Reja 4 h` puts Reja at
  `Jue 13 10:00-14:00`. Its bottom edge dragged to 17:30 previews `10:00–17:30 · 6 h` as **two** ghost
  rectangles with the lunch band left clear, and stores `10:00-14:00` **+** `15:30-17:30`, both
  `manual_duration`, with the job's total rising 4 h → 6 h (Reja is its own last row). Released at
  14:00, 14:20, 15:00 and 15:29 the ghost reads `10:00–14:00 · 4 h` every time: the band is a dead
  zone, never 7,5 h.
- **The rest of report B.** Shrunk back across the break (the `10:00` edge to 12:00) the afternoon row
  is DELETED and its hours go to the job's furthest row, which then splits across two days — total
  unchanged, every job still summing to its estimate. Dragged past the bottom of the day it caps
  cleanly at the last window's end: `10:00-14:00` + `15:30-20:30` = 9 h, pinned, and dragging to 22:00
  gives the same answer as 20:30. A row that starts INSIDE the lunch band still stops where that hole
  does (1 h at 14:00 grows to 1,5 h and no further), so nothing swallows working time it does not own.
- **Report C, both margins, both gestures.** A drop at 07:00 stays at `07:00-09:00` with the hand mark
  and the next job flows around it from 09:00; a 1 h job dropped at 19:30 stays at `19:30-20:30` and
  survives an unrelated creation; the scissors putting an hour at 07:00 pins the fragment; a resize of
  the 07:00 row grows it through 08:00 as ONE row (`07:00-12:00`, 5 h — the margin and the morning are
  one window). *Volver a automático* returns it inside the periods. **Auto-fill still never enters
  them**: 40 h laid out by the engine occupies only `08:00-14:00` / `15:30-19:30` on four days, and an
  empty Thursday still reports `plannableMinutes: 600`, not 720.
- **Report A, and the defect.** The both-ended mark is right where there IS a break, on the engine's
  own split and on a hand-set one. But it was drawn from the row's POSITION in the unit, so it also
  appeared where there is no break at all: the scissors moving an hour into the top margin gives
  `07:00-08:00` + `08:00-11:00`, one contiguous rectangle, and the grid drew `1 h · sigue…` /
  `…sigue · 3 h` across it with the tooltip "Sigue después de la comida" — a seam and a claim about
  lunch on two rows that touch. A second route reaches the same shape with no scissors (drop 1 h at
  07:00, then raise the job's hours), and a third with a margin later set to 0. **Fixed**: the seam is
  now asked of the day's manual windows, not of the position — see *Blocks and the Lunch Break*. Both
  ends still mark a real break; neither marks a join.
- **The sweep, all green.** The Friday buffer both ways (growth lands on it reading `desborde 2 h`,
  shrinking removes exactly that row, a new job skips it for next Monday); the weekend segmented,
  pinned and untouched by churn; the frozen past refusing a drop out loud while still taking a resize;
  a continuation filling forward (`Bar 08:00-10:00 / Marq 10:00-12:00 / Bar 12:00-14:00 /
  Bar 15:30-19:30 / Tue 08:00-12:00`, no empty afternoon, no jumped week); strict order; the fixed
  point (create-then-delete leaves the calendar byte-identical); the auto-lock on a job created five
  weeks out, which an unrelated creation does not drag back; adding hours to a job whose last row is in
  the past getting its own new row, with no row running past its day; and the 409 `shrink-last-block`
  spoken where the gesture happened. Hours were conserved after every gesture in every session.
- **Still red, and pre-existing**: a drop released a hair below another row's start leaves that row a
  one-minute sliver. Not caused by the manual window; recorded in *Open Decisions* with the
  reproduction and three candidate answers, because every one of them changes what a drop means.

---

## Notes for Development

- **Review `recompose-poc.js` first**: It contains validated per-day placement logic.
  Production code should derive from this, not reinvent — but see the one behaviour that must change.
- **Any change to business rules above must update CLAUDE.md** to keep specs in sync.
- **All code, comments, variable names**: English.
- **UI strings**: Only in `public/locales/{lang}/common.json`.
- **Database**: Auto-created `./data/calendar.db` on first run (the directory must be created too).
- **Complexity**: Prioritize simplicity. No multi-user, auth, subscriptions, etc. Keep it lean.
