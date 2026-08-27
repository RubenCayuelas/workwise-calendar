# Workwise — why the rules are what they are

Every entry answers the same three questions in the same order, so an agent can stop reading as soon as
it has what it came for:

- **Rule** — what holds, and the [SPEC.md](SPEC.md) section it governs.
- **Why** — the reason it is this and not the obvious thing.
- **Rejected** — what was tried instead and what it cost. Present only where something was.

**This file is not history.** It states what is true in the repository today. A superseded decision is
deleted rather than annotated: an agent reading "this used to be X" is an agent that may restore X. What
survives of a discarded idea is one line under **Rejected**, kept only where repeating it would cost
real work.

[Open Decisions](#open-decisions) is first because it is the only part that asks something of you.

---

## Open Decisions

**Three lists, and the difference between them is the whole point.** *ANSWERED, NOT BUILT* has the
owner's decision already in it — build it, do not re-ask. *STILL OPEN* has no answer — ask before
inventing one. *SET ASIDE* was looked at and deliberately dropped.

None of these is a broken invariant: hours are conserved, no stored row straddles a break, nothing
overlaps that did not already, and recomposing twice changes nothing.

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
- **An *add another part* action** on the job panel *(decided 2026-08-14)*: a second job entry with the name and
  colour pre-filled. § *Two Parts of One Job* below.

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
- **A reopened holiday comes back on the next check.** The owner reopens an automatic holiday because
  the shop is working that day; seven days later the check closes it again. The app cannot tell that
  reopening from a day that was never written — the row is gone, and the two leave the same picture.
  Chosen deliberately on 2026-08-25 as the simplest behaviour available, with the failure named rather
  than hidden: *«posible bug donde el usuario sí que quiere mantenerlo eliminado»*. The `holidays`
  table is where the answer goes when it is wanted — a column saying the day was dismissed — so the
  fix stays cheap. **Ask before building it.**

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
  set aside**.
- **A micro-drag on a bottom edge sends a request that changes nothing.** Measured in a browser
  2026-08-20 on a padlocked lunch-split unit: from the 4 px drag threshold every small drag sends
  `resize` with the row's EXISTING duration and gets 200 with the calendar unchanged. **No dialog ever
  appeared** — the older note claiming one was wrong, and the owner was right that the 15-minute snap
  keeps every value legal. What is left is a wasted round trip and a recompose; a one-line no-op guard
  would close it.

### Deferred by direction

- **Whether a closed day belongs in the summary strip's sentence**, and whether a gap unit should be
  reachable from the job panel's list. Both left open by the owner, 2026-08-19.
- **`day_overrides.capacity_hours` has no screen**, and that is a decision rather than a gap: a short
  day is a gap.

---

## The Capacity Is Never Touched Alone

**Rule** — SPEC § *The Capacity Is Never Touched Alone*. `defaultDayCapacity` changes only when the
owner changes it. A settings change that would leave it above the hours the shift buys makes the app
ask, naming the old number, the new one and what it costs per day.

**Why** — the write path refuses out-of-range values, exactly as it does for every other field, so a
caller shortening the shift must send the capacity it wants in the same patch. That is what lets the
screen ask first and save the answer in one round trip. The read path still repairs a hand-edited row,
because `capacityMinutes` must never claim hours the periods do not have.

**Rejected** — silently re-capping the value on write. It made the app change a number the owner had
typed, behind their back. The read and the write must agree on the whole range or the repair becomes the
trap again: *what `writeSettings` returns is what the next `readSettings` gives back*. It did not once —
0.5 h saved fine and read back as 1 h.

---

## The End of the Day Is a Line No Write May Cross

**Rule** — SPEC § *The End of the Day Is a Line No Write May Cross*. A stored row ends inside its day,
the line being the end of the day's last manual window.

**Why** — four places enforce it and the order matters: the pure helpers say where the line is, the drag
layer clamps to the latest legal START (not to an interval end, because a row crosses the break for
free), the resize caps at the day's end and at the row's own end, and the write path refuses with 409
`row-past-day-end`. The backstop is tolerant in exactly one direction: no write may make an overrun
worse, so a row a settings change stranded outside the windows stays savable, movable and shrinkable.

---

## The Padlock Is the Only Pin

**Rule** — SPEC § *The Padlock Is the Only Pin*. One mark stops a row reflowing, and a drop onto a place
the engine would never choose sets it.

**Why** — the owner's model is *padlock = fixed, no padlock = free*, stated more than once in those
words. Anything that fixes a row without showing the padlock is a mark appearing behind their back.

**Rejected** — two extra columns, both deleted for being a second way to say what the padlock already
says: `hand_placed` (2026-08-14) and `manual_duration` (2026-08-18). Each cost a rule for every
consequence and bought nothing. **Do not add a third.**

---

## Fill and Overflow, Always

**Rule** — SPEC § *Fill and Overflow, Always*. Work fills what is left of the day and the remainder goes
to the next day it can use, whoever placed it. A job may end in four or five pieces.

**Why** — the owner asked for it in those terms and accepted the consequence in as many words. It
replaced *never split a job to make it fit*, which produced two defects: a job that did not fit moved
whole to the next day leaving that day's tail empty, and the hole in front of a locked block was left
for the owner to decide about.

**Rejected** — the *continuation*, a distinction that existed only to exempt a displaced tail from the
deleted rule. Every item is now placed by one path.

**Do not** — reintroduce backfilling. The cursor walks forward and never returns: minutes the queue has
already passed are never reclaimed. And every piece must still be a legal row — `takeableFrom` is the
one place that decides, and it steps over a stretch too short to hold a quarter of an hour rather than
storing a sliver.

---

## The Ghost of a Rank Is the Division

**Rule** — SPEC § *The Ghost of a Rank Is the Division*. A drop that is only a queue rank is drawn as the
rows the reflow will store, across every column they reach.

**Why** — once work fills a day and overflows, one rectangle at the pointer could only ever be half the
answer. `planDropSpill` walks the days exactly as `compose` does, and the engine imports `takeableFrom`
from it so the preview and the write cannot disagree.

**Why the hours are drawn where the work in FRONT of them ends**, not at the released minute: the engine
places the item at its cursor, so 6 h released at 16:00 into an afternoon free from 15:30 is stored from
15:30. Drawn from 16:00, the label's two numbers would be the two the save contradicts.

**Do not** — expect the ghost to promise a POSITION. Only a whole pass knows where the cursor reaches.

---

## Creating a Job With a Start Date

**Rule** — SPEC § *Creating a Job With a Start Date*. The date is a floor — "not before this day" — and
it is not stored.

**Why** — deadlines are excluded deliberately and this must not grow into one. One function serves both
the save and the form's preview, so the form cannot promise a placement the save will not perform.

**Why a job born earlier than the queue would reach is padlocked on every row**: the padlock is the only
thing holding it there, and a half-locked job comes apart on the next reflow.

---

## A Form Closes On The Write That Ends It

**Rule** — SPEC § *Creating a Job With a Start Date*. A form whose question the write has answered
closes itself, and what the write DID is said in a toast. A refusal is the opposite: the form stays and
stays editable, because there is still something to fix.

**Why** — the new-job form used to remain on screen with every field disabled behind a single button to close it,
and it read as the app having hung. It also held the grid: `enabled` and `nothingOpen` both count an open
panel, so no second band could be painted and undo stayed off until it was shut.

**Why the placement is not simply dropped** — `autoLock` and `dayLock` are padlocks nobody asked for,
and a mark that appears behind the owner's back is a defect. The toast carries the same rows and the
same sentence; `announceCreation` decides both, and it runs longer than a toast's default because it is
more than a confirmation.

**Rejected** — closing with `Trabajo creado.` alone. The calendar does show the new rows, but the
padlock arrives as a glyph with nothing anywhere saying why it is there.

---

## The Past is Frozen

**Rule** — SPEC § *The Past is Frozen*. The engine never writes before today, and no grid gesture reaches
there. A form still does.

**Why** — the past is the record of what the shop did. A form is how a mis-recorded day is corrected,
which is why `action` on a gap PATCH exists: it distinguishes a drag from a form save.

**Do not** — withhold a control to enforce it. Withholding the bottom-edge strip was tried twice and
reverted twice: the press fell through to the body and started a MOVE. Not offering and not being there
are different things — on a past row there is no strip at all; on an automatic row it is drawn inert and
explains itself.

---

## Block Resize Is a Transfer, and Both Dead Ends Ask

**Rule** — SPEC § *Block Resize*. The bottom edge is on every row but a past one and means one thing:
make this stretch longer or shorter. The hours come from, or go to, the job's other rows;
`total_hours` moves only when there is nothing left to draw from.

**Why the padlock is not a precondition** — it decides whether the new geometry SURVIVES, which is a
different question and the owner's to answer by pressing it. On a row the engine lays out, a length
inside the working periods is re-derived on the next pass, so the gesture may look like nothing
happened. The owner accepted that knowingly.

**Why a length that takes margin time padlocks the row** — auto-fill never enters a margin, so without
the padlock the next pass pulls the row back and the gesture undoes itself. The margin is how the owner
gets ahead of the work, so it has to hold.

**Why the whole stretch inherits the target's padlock** — half a stretch left to the engine came apart on
the very next pass: a padlocked `10:00-14:00` beside an automatic `15:30-17:30` was reflowed, so the drag
stored a length nobody asked for.

**Rejected** — requiring a padlock before the edge would work at all (409 `resize-needs-padlock`). It
silently reversed the owner's own earlier request and was recorded as *"decided with the owner"* when it
was an inference. Removing it then over-corrected the other way, making a grow add to the estimate on any
row; the owner caught that within the day. The transfer table was right all along.

**Do not** — hand freed hours to a row outside the movable pool. Hours written straight onto the clock
have nothing to settle them, which is why a shrink with no counterparty ASKS instead.

---

## The Calendar Sits On The Quarter Hour

**Rule** — SPEC § *The Calendar Sits On The Quarter Hour*. A quarter of an hour is the smallest row the
calendar can draw and the smallest amount the owner can aim at.

**Why it is deliberately not a write-path guard** — the one sub-quarter row a gesture can still produce is
an open question, and a floor on the write path would answer it by accident and leave the owner unable to
delete the sliver it refuses to store.

**Why the floor is never a refusal** — `compose` walks the horizon once with it on and, only if the hours
still have nowhere to go, once more with it off. An item the cursor keeps stepping over would otherwise
end in `horizon-exceeded`, and a short row beats rolling the whole save back.

---

## Blocks and the Lunch Break, Gaps the Same Way

**Rule** — SPEC § *Blocks and the Lunch Break*. `duration` is net working minutes, so every stored row is
a solid rectangle on the clock and can be read without consulting Settings. Work across the break is two
rows of one job, drawn as one unit.

**Why a free stretch is cut at every real break** — a stretch spanning the lunch break is one stretch to
the arithmetic and TWO rows on the clock. Without the cut, an obstacle ending at 13:50 stored a ten-minute
`13:50-14:00` row plus the rest of the afternoon.

**Why the seam mark names the BREAK and not the join between two rows** — the hole must start where one
window ends and finish where the next begins. The rounded corners follow the row's position in the unit,
which is a different question.

**Why two gaps that merely touch are never merged** — each carries its own reason, and merging would
destroy one. A gap unit is grouped by adjacency *and* the reason, because the reason is all a gap has to
be identified by.

---

## The Unit of a Drag Is the RUN

**Rule** — SPEC § *The Unit of a Drag Is the RUN*. Dragging any block moves its whole run: the consecutive
blocks of that job with no other movable job between them. The lunch break does not break a run; a night
does not; another job does.

**Why** — that is exactly the engine's `QueueItem`, read the same way on purpose. The engine will lay the
run out as one item however it is dragged, so a drag that moved anything else would be arguing with the
reflow.

**Do not** — filter `unitOf` to the target's own date. That was a real defect: it made every cross-day run
move only its first day's part.

**Why unknown ids are ignored rather than refused** — the list describes what the owner saw; the server is
the authority on what it means. An HTTP caller naming one row still moves one row.

---

## A Drop Is Stored In Segments

**Rule** — SPEC § *A Drop Is Stored In Segments*. A dropped row is cut at the break between two manual
windows, exactly as everything the engine places is cut between two periods.

**Why a minute with no working time means the next minute that has some** — the break is not a slot.
Aiming at it asks for work in time the shop cannot work, and the band is already an arithmetic dead zone
for a resize, so the drop reads it the same way. `firstWorkingMinute` is read in exactly two places, so a
preview and a write cannot disagree, and **its returned start may differ from the one asked for** — every
caller reads it back.

**Why that is not the visual margins' latitude** — a margin is workable time the owner chose and a row may
sit in one; the break is not workable at all.

---

## A Drop That Overlaps

**Rule** — SPEC § *A Drop That Overlaps*. A drop onto the weekend, the frozen past or a padlocked row is
resolved when it is saved, in the same transaction, before recomposition.

**Why same-job rows are summed and not unioned** — an interval union would silently eat an hour. Sat
09:00-11:00 plus a 2 h drop at 10:00 is one 09:00-13:00 row of 4 h, not 09:00-12:00.

**Why a movable row is cut too** — queue order is `(date, start_time)`. Without the cut, dropping B at
10:00 into A's 08:00-14:00 row leaves the queue reading `A, B`, so A is laid out whole and B lands after
the entire block: the drop is silently ignored. Cutting A at the drop's start makes the queue read
`A, B, A`.

---

## A Drop Onto a Day the Engine Reflows Is Never Refused

**Rule** — SPEC § *A Drop Onto a Day the Engine Reflows Is Never Refused*. On a day the engine lays out, a
drop is a re-ranking of the queue, so it may never be refused for colliding with work or a gap.

**Why a drop that padlocks gets one latitude and then the refusal stands** — it slides forward to the first
start where its footprint touches neither a gap nor a locked row, on the day the owner named. If the day
has none it is refused naming what is in the way, because giving up the pin would mean taking a padlock off
a row behind the owner's back.

**Why a closed day pins** — its `role` is still `auto` on a weekday, so a 2 h row released on a closed
Thursday at 09:00 was read as a rank, stored unlocked, and carried to the next open Monday with nothing
said. `DropPin.closed` is asked alongside `role` now.

---

## Aiming Below What A Day Holds Means The Next Day

**Rule** — SPEC § *Aiming Below What A Day Holds Means The Next Day*. A drop that lands literally and whose
footprint would run past the end of its day lands on the next day the calendar would use.

**Why a drop that is only a queue rank is neither rolled nor clamped** — it has no footprint to fit. Rolling
it was the owner's own defect: the row moved to a day it was already on and the request answered 200 with
nothing changed. Clamping said *6 h cannot start after …* about a release that works
perfectly well.

**Why it never leaves the weekend, a closed day or the past** — there the drop is a literal placement on a
day the owner named on purpose, so moving it to another DATE would be a bigger surprise than the refusal.

---

## Thirds Decide Where a Drop Lands Relative to the Row Under It

**Rule** — SPEC § *Thirds*. Over another row the aim collapses to before / cut / after. Over free time it is
left exactly as it came.

**Why** — exact-minute aiming asked for a precision a mouse on a shop PC does not have.

**Why a row under half an hour has two targets and not three** — neither half of a cut could be a legal row.

**Why the cut is the row's own midpoint** — the owner is choosing a ROW to cut, not a minute to cut it at.

---

## A Drop Always Answers For Itself

**Rule** — SPEC § *A Drop Always Answers For Itself*. Every drop reports what became of it. The only drop
that may say nothing is one whose row is visible, at the minute it was released, with nothing else changed.

**Why the server says it and the client does not infer it** — a drop is a rank, so the reflow may answer with
the calendar the owner already had, and that is indistinguishable from a drop that worked. `changed` is
asked of the ROWS and not of the ids: moving a run folds rows together and lets the reflow lay them out
again, so ids churn on a pass that moved nothing.

**Why `placedBlockIds` exists** — the hours routinely end on more than one row now. A notice built from
`block` alone tells the owner half of what happened.

---

## No Press Ends In Silence

**Rule** — SPEC § *Block Gestures*. A gesture that cannot write says so exactly once, and does not also do
something else.

**Why the hint is not behind a modifier** — on a shop PC an Alt-drag would never be discovered.

**Why the action bar is a `div role="button"` and not a `<button>`** — `preventDefault` on a pointer-down
does not stop a button firing its own click, so a press that did not travel would open the form twice.

---

## One Axis Per Gesture

**Rule** — DECISIONS § here, and SPEC § *Calendar View*. A gesture is resolved against the axis as it was
when the pointer went down. Only the grid's ORIGIN is re-measured while the pointer is down.

**Why** — an origin that moves means the grid moved under a still hand and the minute under the pointer
really did change. A SCALE that changes means the same pixel now means a different minute, and the gesture
ends somewhere the owner never chose.

**Why the invariant is asserted minute by minute and not at sample points** — since the axis became
piecewise, `minutesAt(yOf(m)) === m` is a stronger claim: the two directions have to agree segment by
segment and on every seam.

---

## Dragging To The Edge Changes Week

**Rule** — SPEC § *Dragging To The Edge Changes Week*. Holding a dragged block at either end of the grid
pages the calendar with the block still in hand. Paging is a GET; nothing is written.

**Why the repeat is a metronome and not an acceleration** — 500 ms for the first turn, then a constant
800 ms. A hold has to be stoppable on the week it was aimed at, and the rail names its destination by
dates, which a pace that outruns its own label makes pointless. A repeat is only scheduled once the week
the last one asked for has arrived, so the gesture can never outrun the calendar.

**Why the hold must be gone to** — a hold that begins inside a strip does not arm until the pointer has left
it once, or a block grabbed at Sunday's right edge would page the week out from under itself.

**Why the release re-resolves instead of committing the preview it holds** — the day, the rows and the taken
starts are all read at the release. The re-resolve is pure, so with nothing changed underneath it returns
the ghost the owner was looking at, to the minute.

---

## A Week Change Says Which Way It Went

**Rule** — SPEC § *A Week Change Says Which Way It Went*. A new week slides in from the side it came from.
The first week never slides, and a refetch of the same week never slides.

**Why the direction is derived and not passed in** — the header buttons, the arrow keys, the today button and the edge
hold all get it for free, and none of them can get it wrong.

**Why the column clips sideways only while its contents travel** — `translateX` past the last column's edge
is scrollable overflow, and a scrollbar appearing for 180 ms narrowed the grid by 15 px and jumped the ghost
sideways under a still hand. Clipping permanently would hide most of the settle.

**Why the ghost does not slide** — it is a sibling of the sliding wrapper, not a child. The one rectangle
that promises where the block in the owner's hand will land may never slide out from under the pointer.

---

## The Lunch Break Is a Seam, and Every Hour Is Labelled

**Rule** — SPEC § *Calendar View*. The axis is piecewise and only the break between two periods is
compressed, to a fixed 28 px seam. A margin is never compressed.

**Why** — *«hay un hueco pero es despreciable»*, and the owner puts real work in a margin by hand.

**Why the seam is discreet** — three things already say "nothing lives here": it is the same grey as the
margins, it spans the week edge to edge and square, and 28 px where an hour is 50-plus is itself the
statement.

**Why what gives way is a precedence and not an index** — every period edge, then the two ends of the axis,
then the hours. An hour can be counted from its neighbours; an edge cannot. Both demotions are real
configurations Settings can produce, not hypotheticals. The hanging classes are keyed on the MINUTE, never
the tick's index: either end can be dropped, and by index the label inheriting position 0 would be hung
below its rule while the collision arithmetic had measured it as centred.

---

## Gaps Are Cut At The Lunch Break, Dragged And Resized

**Rule** — SPEC § *Gap Management*. A gap's duration is net working minutes, it is cut at the break like
every other row, and it has the two gestures a padlocked block has.

**Why** — in engine terms a gap was always a padlocked task: fixed occupancy, consumes plannable hours,
never recomposed. What it lacked was the gestures.

**Why the resize is absolute and not a transfer** — there is no job to hand hours to, so
`shrink-needs-choice` can never appear on a gap. This is not an exception to *the padlock holds the length*:
that rule is about rows the engine lays out, and a gap never is one.

**Why its day is as literal as its minute** — the owner named the day the machine broke. A footprint the day
cannot hold is clamped, never carried to another date.

**Why the refusal is asked of every ROW the gap will become** — measured over `start + duration` instead, 8 h
from 10:00 tests `10:00-18:00`, names rows inside the break where nothing can be, and MISSES the padlocked
`18:00-19:30` its real second half lands on.

**Why the form is handed the UNIT and never one row** — handed one half instead, opening the `08:00 +6 h`
morning of a 10 h absence and pressing save sent 360 minutes for the whole unit and the reconcile deleted
the afternoon. Four hours destroyed by a save that changed nothing.

---

## A Long Absence Is One Gesture, and a Closed Day Has a Screen

**Rule** — SPEC § *Gap Management*. The absences screen has two modes over one date range, and a range is one
transaction.

**Why** — the evidence was in the shop's own database: four gaps of `08:00 +11,5 h` reason "Feria", typed one
per day, because a whole-week absence had no other way to be said and `day_overrides` had **0 rows**. Judge a
change here by whether that week still takes one gesture.

**Why bulk creation previews by running the real write and rolling it back** — a model of the reflow would be
a second answer to the same question. Only a whole pass knows where the cursor reaches, so the preview
refuses whatever the save would refuse.

**Why the overrides are written inside the reflow's transaction** — they were not once, so a close the horizon
could not absorb stayed on disk and **every later write answered the same 409**, including the deletion of the
job that would not fit.

**Why closing a day no longer refuses over work it cannot move** — it used to, in both doors, and the reason
was that nothing could be ASKED at the moment of closing. Now something can. A closed day is a weekend to the
engine, and a weekend has always held padlocked work without complaint; the refusal was protecting against a
state that was never wrong. Only the past still refuses, because nothing may be written there at all.

**Why BOTH doors ask, and out of one module** — the refusal was removed from both and the question added to
only one, so the absences form went from refusing loudly to closing in silence, which is worse than what it
replaced. The decision now lives in one place and the wording in one set of keys: the same situation reached
by two routes must not have two answers.

**Why painting only ever opens the form** — the app never creates an absence by itself. That also dissolved the
gap-versus-closed-day threshold: painting a whole column gives a 12 h gap in two rows, which looks like a
closed day and is not one. Do not add a threshold.

**Why there is no half-day** — the owner was asked and said no: a short day is a gap. `capacity_hours` stays
without a screen.

---

## Public Holidays Are The App's Until You Touch Them

**Rule** — SPEC § *Public Holidays Close The Shop By Themselves*. The municipality's holidays become closed
days written by the app. A future day whose note is exactly what the last check wrote there stays the app's to
rename or reopen; the moment the owner edits it, closes it themselves or reopens it, the day is theirs.

**Why the dates and the names come from different places** — the Junta de Andalucía's open data is official,
covers every Andalusian municipality and already carries a year that festivos.io has not published; but it
names a local holiday nothing at all, only `FIESTA LOCAL EN <municipio>`. festivos.io names them, and its own
`source.ref` on those rows points back at the Junta dataset, so it is a naming layer over the same official
data rather than a second opinion about the dates. A missing name is never a failed check.

**Why the horizon is not a number we chose** — local holidays for a year are published in the October before
it, so no source can know more than about fifteen months ahead. *How far do we write?* has an answer already:
everything known, from today onwards, with Settings saying how far that reaches.

**Why a rename EDITS the day instead of rewriting it** — a local holiday's date exists months before anyone
names it, so `Fiesta local` becoming *Feria Real de Priego de Córdoba* on a later check is the normal case, not
an edge one. Reopening and rewriting would land on the same date looking identical afterwards while, in
between, releasing the day, shuffling the queue and asking again about work whose displace-or-keep answer had
already been given. A better label must not be able to move an hour.

**Why the ownership test is a string comparison against the cache** — it needs no mark on any calendar row.
The `holidays` cache already records what the app last wrote on each day, so the day itself carries the
evidence, and the cache must be read before it is replaced.

**Why a day whose work is padlocked is stated and not asked about** — the only other answer would clear a
padlock, and the padlock is cleared by the padlock and nothing else.

**Why the fallback names come out of the locale files** — a holiday's note is the SECOND piece of prose the
data layer produces, after a deleted job's gap reason, and it obeys the same rule: composed from the bundles
in the language the owner is reading, because it is stored user data from the moment it is written. Written
into the module as Spanish literals first, which put untranslatable wording in the data layer and made the
English interface print Spanish.

**Rejected** — bundling the holiday table in the installer, so the app never touches the network. It matches
everything else about this app, but a year's holidays would then arrive only with a new release, and the owner
asked for the check instead. Also rejected: extending beyond Andalucía, which means seventeen regional
calendars, 8,132 municipalities and abandoning the official source for an aggregator.

---

## The Create Rail Draws Nothing

**Rule** — SPEC § *The Create Rail*. The leftmost 21 px of a column create whatever is drawn there, and
the rail itself paints nothing: the cursor, a hairline on the minute and a badge naming it are the whole
of what announces it. It takes the DRAG and never the click.

**Why** — the strip a full-width block leaves beside it is 3 px, 1.65% of an hour at 1920x1080, and it
was the only way to start a band over occupied time. The owner asked for the target without the paint:
*«tener ese margen pero invisible, desde fuera se ve normal»* (2026-08-26). Hiding a control until the
pointer finds it is this grid's own idiom rather than a new one — the action bar, the resize pill and a
gap's edge strip are all invisible until hovered — and unlike a modifier key, a strip is discovered by
moving the mouse, which happens all day.

**Why a closed day and the weekend take one** — the brush used to stop at a closed column because
pressing one already meant "reopen this day". The rail splits that press in two: a drag creates, a still
press still opens the screen that reopens the day. With the collision gone there was no reason left to
refuse, and the owner asked for it (2026-08-26). The weekend never refused.

**Why 21 px and not 3, and what the width costs** — 3 px is all a full-width row leaves beside it, 1.65%
of an hour at 1920x1080, measured against a resize handle of 10 px that had itself been widened from 7
for being a mean target, and a mouse floor of 24 px. Drawing nothing, the width costs no layout at all:
it costs a row its leftmost 21 px as a place to start a move or a resize from, and — only where two
lanes share a column — the left half of a hover bar's first button.

**Why the click is left to the row** — the rail lies over 21 px of every row, so taking the click as
well would silently cost the job panel a target the owner already aims at: the beginning of the name.
Only the drag is new, and that is what makes an invisible surface safe. A press that TRAVELLED without
drawing a band is a click too: the paint had no answer for a wobble where the drag layer had 12 px of
slop, so the rail would have turned an old silence into a lost click.

**Why the band became translucent** — the same measurement that made the drag ghost translucent on
2026-08-13. A band can now START over occupied time, so an opaque fill hid the very row the gesture is
about to cut in two, from the first pixel of the drag.

**Rejected** — a PAINTED rail: a 12-14 px gutter, or the block's text pushed in to clear the strip.
Both work and both change how the calendar looks at rest for a control that is only needed part of the
time, which the owner turned down in those terms. An armed create mode with the scissors' machinery was
costed too — the whole column as a target — and turned down for being a mode and a click before every
create. A modifier and a long press were closed already: *«no modifier key, ever»*, and an Alt-drag
would never be discovered on a shop PC.

---

## Painting Makes a Job As Well As a Gap

**Rule** — SPEC § *Calendar View*. A released band asks which it is, and a job made that way starts on the
exact minute painted, padlocked.

**Why the band sets the START and the field sets the LENGTH** — the owner answered by analogy with a gap: the
band fills the time, and the form's hours are what the job really is.

**Why the head is padlocked on every day** — asked what should happen when the queue would place it elsewhere,
they chose *«siempre donde se pintó»*. It is the first pin inside Monday to Thursday and a deliberate exception
to *padlock everything the user drags*.

**Why the kind is asked out loud instead of inferred from the band's size** — a threshold would put a guess
where the mode selector already asks the question.

---

## A Closed Day Chosen As A Start Date Is Honoured

**Rule** — SPEC § *Creating a Job With a Start Date*. Asked whether to refuse a closed day, honour it, or
leave it, the owner chose to honour it: *«Dejar elegirlo, pero cumplirlo de verdad»*.

**Why the confirmation is derived from the weekday on the client and from the server for a closed day** — a
failed preview request must never let a save honour a Friday or a weekend silently.

---

## Deleting a Job Leaves Its Past Intact

**Rule** — SPEC § *Deleting a Job Leaves Its Past Intact*. Future rows go, past rows become gaps naming the
job that was there.

**Why the sentence is composed at deletion time and stored** — it is user data from then on, and cannot be
re-translated. The server composes it out of the locale files with the language the owner is reading, which is
why callers must pass `i18n.language`. It is the only prose the data layer ever produces.

---

## Undo and Redo Are a Line of States

**Rule** — SPEC § *A Settings Save Empties the Line*, § *What Ctrl+Z Is Not*. A step is a whole state of the
calendar, not the inverse of a gesture.

**Why** — the reflow recreates rows on every pass, so what a move did is not derivable from the move.

**Why the step is written inside the transaction it describes** — a refusal or a horizon rollback discards it
for free, with no special case.

**Why the line is emptied when the database is OPENED and not when it is closed** — a close can be skipped by a
power cut or a kill, and rows outliving their run would describe a previous day's calendar. No run can begin
without opening the file.

**Why a settings save empties the line instead of joining it** — the scope is the calendar, and that was the
owner's call. With a panel open the shortcut is inert and says so rather than risking a half-written form.

**Why a write that changed nothing earns no step** — otherwise a micro-resize that stores the length it already
had would cost one.

---

## Backups

**Rule** — SPEC § *Backups*. A copy is a file SQLite writes, never a file copy. Automatic copies live beside
the database and rotate; a copy the owner saves goes where they point it and is never touched.

**Why not `copyFile`** — WAL holds recent pages outside the main file. Measured on the shop's own calendar, the
sidecar was **688 KB against 73 KB** of database, and on a young database the WAL still holds the SCHEMA — so a
file copy has no `projects` table at all, not merely no rows.

**Why beside the database and not in the install folder** — on Windows that needs elevation and an update
replaces it.

**Why "when was the last copy" is derived from the FOLDER and never stored** — in the database it would be
restored along with an old copy, and the app would believe it had just run one.

**Why the rotation only deletes names it could have written itself** — a copy saved by hand into the same folder
survives a limit of three, and so does the pre-restore copy.

**Why a copy is taken even when nothing changed** — the owner was shown that the rotation can then retire the
last copy from before a mistake, and chose it anyway.

**Why restoring is one implementation for both ways in** — a name from the folder and a file from anywhere, so
neither can be the less tested one. It recognises the file, migrates it, keeps the replaced calendar, and only
then closes, swaps and reopens — which also clears the undo line, because an undo must not reach into a
calendar that no longer exists.

---

## A Windows Application, Not a Local Server

**Rule** — `desktop/README.md`. An Electron window around the app's own standalone server, which runs on a
`node.exe` bundled in the package. `src/` and `app/` are untouched.

**Why a bundled Node instead of Electron's own** — `better-sqlite3` is compiled, so its binary must match the
runtime's ABI, and there is **no supported Electron with a ready-made one**: the prebuilds stop at Electron
39/40 while the supported majors are 41-43, and `better-sqlite3` 13.x publishes none at all. A bundled Node uses
the Node-ABI prebuild, which exists, so Electron stays current and **nothing is ever compiled**. That is worth
87 MB: a C++ toolchain in the build path is the thing most likely to stop a fix shipping months later.

**Rejected** — compiling for Electron with `@electron/rebuild` (one runtime, but a compiler in the build path),
and pinning Electron to 39/40 (ships an unsupported Chromium and returns the same problem at the first upgrade).

**Three traps, each of which cost a build** — the payload aimed at `resources/app`, which is electron-builder's
own directory; `node_modules` dropped silently from `extraResources`, which no filter can override, so it is
copied to `deps` and found through `NODE_PATH`; and the file tracer following `getDbPath()` into `data/`, so the
installer carried the shop's own calendar. `desktop/verify-package.mjs` fails the build on all three.

---

## An Update Waits For Its Copy

**Rule** — SPEC § *Updates*. The app looks for a published release when it opens and downloads it in the
background, but it installs nothing until a copy of the calendar has been written, and nothing at all until the
owner has chosen the moment. Three of those copies are kept, on a count of their own, and they are listed and
restored like any other.

**Why the copy is what decides** — `autoInstallOnAppQuit` defaults to TRUE, and the library's own installer runs
synchronously inside `quit`, where an awaited `VACUUM INTO` cannot veto anything: left alone, an update installs
with no copy at all. It is switched off and `quitAndInstall` is driven by hand, only after the copy resolves. What
this covers is a migration in the arriving version rewriting the calendar unattended — and the weekly copy can be
six days stale at exactly that moment.

**Why the shell asks the server for the copy** — `better-sqlite3` is built for the bundled `node.exe`, not for
Electron's ABI, so the window cannot open the database at all; and a copy is `VACUUM INTO`, never a file copy. The
shell POSTs to the server that already holds the handle and reads anything but a 200 as a refusal to update.

**Why three, and counted apart from the weekly ones** — a bad release is both the moment the copy is wanted and
the moment more releases follow within hours, so one shared count would spend them precisely when they matter.
The version is not what orders them: `0.9.0` follows `0.26.0` alphabetically while preceding it in time, so the
stamp comes first in the name and the rotation reads recency off the sorted name, as the weekly one does.

**Why these copies are listed and `workwise-before-restore.db` is not** — a restore is something the owner just
did and can remember. An update installs itself, possibly twice more before anything looks wrong, and a way back
nobody can see is not one.

**Three traps in the copy itself, each of which destroyed a way back** — a downloaded update that has not
installed is re-offered at EVERY opening, so one version is copied over and over; each copy replaces its own
earlier attempt rather than taking a slot, or three mornings of a shutdown that never installs would erase
every copy from before the version now running. The rotation is told which copy was just written, because a
machine that boots with a dead clock names it in the past and ordering by name alone deletes it while still
reporting it written. And the download the check starts is a SEPARATE promise that rethrows: dropped, a lost
connection or a checksum mismatch reaches the main process as a fatal unhandled rejection and takes the
calendar down — the one thing an updater must never do.

**Why the artifact name carries no spaces** — GitHub rewrites a space in an uploaded asset to a dot, while
electron-builder writes the hyphenated form into `latest.yml`. The two disagreed, every check passed, and every
download would have been a 404. `artifactName` is fixed so the file on disk, the name in `latest.yml` and the
asset all read the same.

**Rejected** — a GitHub token inside the installed `.exe`, which is what a private repository needs. It expires,
and the day it does the app stops finding updates in silence; the repair is a hand-carried build, which is the
one thing this exists to remove. The repository is public instead, and the app carries no credential.

---

## Next 16

**Rule** — the app runs on Next 16 with Turbopack, React stays on 18, and the lint gate is the ESLint CLI.

**Why React stays on 18** — Next 16 still declares it as a peer and the App Router runs React out of
`next/dist/compiled/` regardless, so the installed version reaches types and nothing else. One major per change.

**Why `next build` is not deterministic, and was not before** — building untouched `main` seven times on Next 15
produced two different CSS chunk orderings. Any "did my change alter the build?" question needs that control run
first, or the flap reads as a regression.

**Rejected** — patching the two vulnerable transitive dependencies with npm `overrides` and staying on Next 15.
It worked, but left the framework a major behind. One thing from it is worth keeping: **the scoped override form
silently does nothing** — only the unscoped form removes a nested copy.

---

## Two Parts of One Job

**Rejected, 2026-08-14.** The owner's real case is a job fabricated in one stretch and installed days later, the
installation being part of the job.

**Why not** — modelled as one job it would need a dependency between two spans, a lead time between them, and a
warning when the fabrication slips and the installation no longer follows. That is a scheduling feature, not a
second row. Two jobs with the same name is what the owner does today, and *add another part* on the job panel —
a second entry with the name and colour pre-filled — is the whole of what was agreed.

---

## The Job Palette Is Chosen Against the Fill, Not the Swatch

**Rule** — SPEC § *Visual Design*. The eight job colours each hold at least 3:1 against both the light and the
dark surface, clear the brand amber and the gap fill by dE 30, and are kept apart from one another in the fill
they are drawn with rather than at full strength. The yellow is the one exception, at 2.2 on white.

**Why** — a block is its colour twice over: a hairline border and the padlock mark at full strength, over a fill
of itself mixed into the surface at `--ww-block-tint-strength`. The fill is most of what the eye sees, and eight saturated values collapse
into eight very close washes there — so a set chosen by looking at swatches can hold two jobs that are plainly
different in the picker and the same colour on the grid. The retired set did exactly that: its green and its dark
green sat at dE 2.1 in the fill, no difference at all, and its blue, violet, red, dark green and grey all fell
below 3:1 on the dark surface, where the border that identifies a job goes murky. The band that satisfies both
surfaces is relative luminance 0.14 to 0.30, which is why none of the eight is a pastel or a deep tone — "light
green" and "light blue" are the lightest members of their hue the dark surface still allows, not washes.

**The yellow is the owner's exception, and they made it knowing the cost.** The rule produces a gold, because
yellow carries more luminance than any hue at the same saturation and the dial that makes it read yellow is the
same one that makes it fail on white. Shown the gold they asked for a true yellow anyway — *hazlo un poco más
amarillo aún, que desencaje un poco con la lógica de colores* — so it sits at 2.2 against white and keeps the
full 3:1 against the dark surface. It is named in the test rather than the floor being lowered, so the other
seven still hold the rule and the exception cannot spread to a swatch nobody weighed it for.

**Rejected** — repainting stored jobs by nearest colour, one at a time. Both retired greens find the single green
there is now, so two jobs the owner had told apart come out identical — the whole complaint, reintroduced by the
fix for it. The mapping is the whole-set assignment with the smallest total distance instead, which is a
bijection; the one visible jump is the old dark green, which takes the slot nothing else claims.

---

## A Gap Is Hatched, the Lunch-Break Band Is Not

**Rule** — SPEC § *Calendar View*. A gap is drawn hatched: `gapColor` under `/`-leaning stripes mixed from
that fill toward the surface. The band between two work periods stays undecorated.

**Why** — a gap and a block are the same shape in the same lane, and with a flat fill the only thing telling
them apart was which colour one happened to be, so an absence read as a job painted grey. Mixing the stripe
from the fill rather than giving it a colour of its own is what lets it follow `gapColor` anywhere the owner
takes it without a second setting to keep in step. At 65% of the fill toward the surface the stripe sits
about dE 6 from its own fill on the default grey — visible at a glance, and an order of magnitude below the
dE 73 a job's border stands at against its own tint, so a gap never outshouts the work around it.

**The lunch-break band keeps none of this, and the difference is the point.** A 45-degree hatch was tried there
on 2026-08-17 and taken back out the same day: that band spans all seven columns in the part of the day that
carries no information, and decorated it became the first thing the eye found. A gap is the opposite case —
it is a rectangle inside one lane, it is time the shop has actually lost, and it has a neighbour it must not
be confused with. The band is told apart by being a band; a gap has to be told apart from a block.

**Rejected** — a fixed translucent veil rather than a mix of the fill. Measured across the colours `gapColor`
can hold, it drifts from dE 4.8 on the default grey to dE 30.8 on a dark one — the same runaway contrast the
lunch-break hatch was removed for, reappearing the moment the owner changes a setting.

---

## The Header Hides Nothing

**Rule** — SPEC § *Calendar View*. Every action in the calendar header is its own control: undo, redo,
today, new job, absences, language, settings. There is no overflow menu. The absences button carries its
name; the settings gear does not need one.

**Why** — the absences screen is the only way to say the shop is not working, and behind a `…` it was not
found. What the calendar filled up with instead was JOBS: hours entered as work to stand in for a gap, and
whole days off entered as a job covering the day. The loss is not cosmetic. `projects.total_hours` then
counts hours nobody is going to work, the summary strip says the workshop is booked further out than it
is, and `day_overrides` stays empty — so the engine keeps planning into days the shop is shut, and every
one of those days has to be argued with by hand. Reported by the owner on 2026-08-26, and it is the second
time this same screen has been reached for and not found:
§ *A Long Absence Is One Gesture, and a Closed Day Has a Screen* was built on the first.

**A NAME is what the menu was costing, not the click.** Measured at 1280 px, the narrowest desktop the app
supports: the absences button is a 113 px control, the right-hand toolbar goes from 347 px to 466 px, and
the flexible space either side of the week label from 178 px to 119 px. Nothing overflows, nothing had to
be shortened, and the label was measured in Spanish, the longer of the two. The width a menu saves here
was never needed. Which of the two carries a label is the owner's choice: absences, because no calendar
glyph says *the shop is shut*, while a gear reads as settings everywhere.

**Rejected** — the `…` overflow menu that held both. One click is cheap; what it cost was that neither
action had a name anywhere on screen, and an owner who cannot see the absences button does not go hunting
for it behind a glyph — they reach for the tool they can see, which is the new job button.

---

## Every Control Is a Fill Inside a Hairline

**Rule** — SPEC § *Visual Design*. Every button and icon button is a fill inside a 0.5px RESTING edge: the
neutral ones `--ww-control-border`, the amber one `--ww-control-border-accent`. `--ww-border-strong` is the
firmer weight and is a resting edge on nothing — it is what a field's edge becomes under the pointer, and
what a gesture's dashed marks are drawn in.

**Why** — two things were wrong at once. The amber button took its own fill as its border, so it was the
only control in the app drawn with no edge, and beside four outlined ones it read as unfinished. And those
four rested on `--ww-border-strong`, #444441 at 9.8:1 against white, which reads as a black box round every
button — while every text field beside them rested on something far quieter. Both now rest on one soft
edge, #908f88 at 3.2:1: a third of the contrast, still enough to bound the shape.

**The amber edge is matched by register, not by number.** It is a darker amber at dE 13.5 from its own
fill, where the neutral edge is dE 28.5 from the white it sits on. Those are different jobs: a white fill
on a white header has nothing but its edge to say where it ends, while amber already stands dE 33 clear of
the surface on its own and only needs its boundary drawn.

`--ww-control-border` mixes toward `--ww-text` rather than toward graphite, so it lightens on a dark
surface instead of sinking into it.

**Rejected** — resting the neutral controls on `--ww-border` itself, #d3d1c7 at 1.5:1, which is what every
input rests on and would have been one vocabulary instead of two. Rendered side by side it inverts the row:
at that weight the amber button's rim is the most visible line in the header and the white buttons read as
unbounded. For the amber edge, three more, all measured against its fill: graphite-soft at dE 50.7, a black
ring around orange; amber-ink at dE 31.8, louder than the neutral edges beside it; and amber-soft at dE
11.2, which lightens rather than darkens and so reads as a highlight instead of an edge.

---

## The Week Label Sits On the Window's Centre Line

**Rule** — SPEC § *Calendar View*. The week pager is centred on the WINDOW. The logo and the actions are
one flex basis each, so the pager between them lands on the header's centre line rather than in the
middle of whatever room those two leave.

**Why** — the week label is the only thing on screen that says which week is being looked at, and it is
read on every page turn. Centred in the leftover room it sat 166px left of the window's centre at every
width — half the 334px by which the action row outweighs the logo — so the one label the eye returns to
was not where the eye returns to. Measured after: dead centre from 1360px up, and 35px shy of it at
1280px, where the action row is wider than its half and the pager gives ground rather than crowd it.
Nothing is clipped at any width.

**Rejected** — absolute centring (`left: 50%` and a translate), which ignores what is beside it: at
1280px the pager would have run 25px into the action row. Flex flanks let the pager yield exactly as
far as it has to and no further.
## The Hour Is Typed, Not Chosen From 96 Options

**Rule** — SPEC § *The Hour Is Typed*. Every hour in the app is an `HH:mm` field that is typed. What is
typed takes effect on `Enter` or on leaving the field; `−`/`+` and `↑`/`↓` take effect at once, a quarter
of an hour at a time and an hour with `Shift`.

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

**Why a refusal is handed to the form and holds the save** — the refused string stays on screen while the
form goes on holding the last settled hour, so the two disagree. With the message only on the field's own
`title` — not announced to a screen reader, and easy to press past — the save wrote the previous value:
a day typed to close at `23:00` closed at `08:00`, and a Settings shift row showing an unreadable hour
saved the old shift. That is the clamping above, arrived at from the other side. `onInvalid` is required
rather than optional so a new call site cannot quietly reintroduce it, and the field clears the refusal
itself on mount, on being disabled and on unmount, so the caller needs no rule of its own for a control
the screen has stopped drawing.

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

**Why** — the list it replaces offered between 35 and 140 consecutive days, 84 of them on the horizon's own
default, and no list answers "which Thursday" the way a month does. The window is unchanged because it is
exactly the set of days a form can reach today: forward, a day past the horizon is a 409
`horizon-exceeded` on the save; backward, a job's start date writes padlocked rows in the past, which the
owner did not ask for.

**Why six rows always, and never five or six by the month** — the popover's height is then a constant, so
clipping it against the window is arithmetic with a test rather than a measurement of the DOM.

**Why a stored day outside the window is still pressable** — a control that drops the day already on disk
replaces it the moment the form is saved. It was true of the list and it stays true here.

**Why the line under the field carries the week number** — the list grouped its days under the very week label the
grid's header carries, so a form and the grid could not name one day two ways, and that is the only thing
leaving the list would have lost. `units.week` keeps the number; `header.week` carries the date range
inside it, which the long date beside it already says.

**Why the trigger is a `<button>` and the picker swallows its own arrow keys** — `isTypingTarget` recognises
only `INPUT`, `TEXTAREA`, `SELECT` and `contenteditable`. With the old `<select>` the header's week pager
saw the arrows and turned two weeks at once; with a button, nothing but the picker swallowing them stops
the week turning under an open calendar.

**Why the trigger's own press is left to its click** — `preventDefault` on a `pointerdown` does not cancel
the click that follows, so dismissing on that press closed the popover and the click reopened it: a
calendar that looked like it never closed. The press is ignored on the trigger and on the `<label>` the
browser forwards a click from, and the trigger's click is a toggle.

---

## Six Marks in the Month, and the Dot Only Promises Room

**Rule** — SPEC § *The Day Is Picked From a Month*, § *Calendar View*. A month cell carries six marks and no
more — the chosen day, today, the weekend, the past, a closed day, room left — and every one of them can
still be chosen. The number dims for what the calendar makes of the day, the background greys for what the
owner decided, and the dot says only that the engine still places hours there.

**Why** — the owner named FOUR of the six: today, the weekend, a closed day, and which days still have
room. The chosen cell and the past are the implementer's, inferred from what a calendar is. What the owner
did decide is that none of it is explained on screen: the dot gets no definition, each cell says the rest
on hover the way a day header already does, and there is no legend. Nothing is hatched either — the one
hatch this app tried lasted a day, and the measurement is in
§ *A Gap Is Hatched, the Lunch-Break Band Is Not*.

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

**Why no mark ever disables a cell** — § *A Closed Day Chosen As A Start Date Is Honoured* holds that
decision and the owner's own words for it.

**Why the grey and its reason come from the server** — they are one `day_overrides` row, read through the
same `listDayOverridesBetween` and the same snapshot's `getDayConfig` the week is read through, so the
picker's grey cannot disagree with the column's, and a note written by another writer names the day in both
places at once.

---

## A Range Is Chosen In One Calendar, and One Click Is One Day

**Rule** — SPEC § *The Absences Screen*. The multiple mode's two ends are one range calendar. A click
answers with the day it landed on as BOTH ends and leaves the popover open; a second click extends the
span to its day, always ordered, and closes. The weekend cells inside the span are drawn excluded by the
same `absenceRange` the server writes with.

**Why one click and not two** — the common absence is a single day, and the first shape of this calendar
asked for two clicks even for that: the owner met it as being made to click the same day twice, on the
case that happens most. Two clicks were there to protect the rare one.

**Why that costs nothing it was protecting** — the shape it replaces kept the first end inside the popover
so a half-chosen range could not reach the form, because `date` alone would fire `previewAbsence` — the
real write inside a transaction that is rolled back — on every step across a month, and leaving `endDate`
unset instead collapses `rangeValid`, the preview and the `Reabrir` button mid-selection. **Committing the
first click as a one-day span removes the half-chosen state itself**, so there is nothing left to protect
against: every click hands over a complete, ordered span. The provisional end, its paint rule and its
visual state all went with it.

**Why the closing press is swallowed on the grid alone** — the press that dismisses the popover used to be
swallowed wherever it landed, so the save needed two: the first only closed the calendar. Underneath the
GRID the swallow is measured and stays — that press starts a paint band or opens the panel of the job
below it — but inside the panel nothing is underneath, and a control that ignores the first press is the
wrong bargain for someone who does not read the screen before using it.

**Why the excluded cells are not re-derived in the screen** — the server skips Saturday and Sunday unless
the whole range is a weekend. A span drawn Monday to Sunday as seven cells promises seven days of a write
that makes five.

**Why one error slot is still needed** — `localError` is drawn nowhere but in a `Field`'s `error=`. Two
fields became one, so the range's `Field` takes `rangeError`, which answers with whichever of the span's
two ends was refused; without it the save would write nothing and say nothing when the server answers 400
`invalid-range`, which two clicks reach at `MAX_ABSENCE_DAYS` (120). Ordered ends make
`errors.rangeBackwards` unreachable from the calendar.

**Why the week label is not under this field** — that line already carries the day count, and the count is
the days the preview says will be written, not the cells of the span.

---
