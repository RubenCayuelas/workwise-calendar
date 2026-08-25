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
- ***Añadir otra parte*** on the job panel *(decided 2026-08-14)*: a second job entry with the name and
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

**Why** — the new-job form used to remain on screen with every field disabled behind a single *Cerrar*,
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
nothing changed. Clamping said *«6 h no pueden empezar después de las …»* about a release that works
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

**Why the direction is derived and not passed in** — the header buttons, the arrow keys, `Hoy` and the edge
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
morning of a 10 h absence and pressing Guardar sent 360 minutes for the whole unit and the reconcile deleted
the afternoon. Four hours destroyed by a save that changed nothing.

---

## A Long Absence Is One Gesture, and a Closed Day Has a Screen

**Rule** — SPEC § *Gap Management*. `Ausencias` has two modes over one date range, and a range is one
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

**Why painting only ever opens the form** — the app never creates an absence by itself. That also dissolved the
gap-versus-closed-day threshold: painting a whole column gives a 12 h gap in two rows, which looks like a
closed day and is not one. Do not add a threshold.

**Why there is no half-day** — the owner was asked and said no: a short day is a gap. `capacity_hours` stays
without a screen.

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
second row. Two jobs with the same name is what the owner does today, and *añadir otra parte* on the job panel —
a second entry with the name and colour pre-filled — is the whole of what was agreed.

---

## The Job Palette Is Chosen Against the Fill, Not the Swatch

**Rule** — SPEC § *Visual Design*. The eight job colours each hold at least 3:1 against both the light and the
dark surface, clear the brand amber and the gap fill by dE 30, and are kept apart from one another in the fill
they are drawn with rather than at full strength.

**Why** — a block is its colour twice over: a hairline border and the padlock mark at full strength, over a fill
of itself mixed into the surface at `--ww-block-tint-strength`. The fill is most of what the eye sees, and eight saturated values collapse
into eight very close washes there — so a set chosen by looking at swatches can hold two jobs that are plainly
different in the picker and the same colour on the grid. The retired set did exactly that: its green and its dark
green sat at dE 2.1 in the fill, no difference at all, and its blue, violet, red, dark green and grey all fell
below 3:1 on the dark surface, where the border that identifies a job goes murky. The band that satisfies both
surfaces is relative luminance 0.14 to 0.30, which is why none of the eight is a pastel or a deep tone — "light
green" and "light blue" are the lightest members of their hue the dark surface still allows, not washes.

**Rejected** — repainting stored jobs by nearest colour, one at a time. Both retired greens find the single green
there is now, so two jobs the owner had told apart come out identical — the whole complaint, reintroduced by the
fix for it. The mapping is the whole-set assignment with the smallest total distance instead, which is a
bijection; the one visible jump is the old dark green, which takes the slot nothing else claims.

---
