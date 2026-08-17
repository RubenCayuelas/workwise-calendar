# Workwise Calendar — Decision Record

**This file is the WHY. [CLAUDE.md](CLAUDE.md) is the WHAT.**

CLAUDE.md states the rules an implementer must follow. This file records how each of them was
decided and what was measured to confirm it: the owner's own words, the defect that forced the
question, the alternatives that were considered and rejected, and the reproductions.

Keep them in sync in one direction: **a rule changes in CLAUDE.md, and the reasoning for the change
is appended here.** Neither file is a summary of the other, and neither is optional — the reasons in
this file have saved several rounds of re-deciding things the owner had already settled, and the
rules in CLAUDE.md are unreadable when the reasons are interleaved with them.

Section names here match the rule names in CLAUDE.md, so *A Continuation Fills Forward* in one is
*A Continuation Fills Forward* in the other.

> **A note on `hand_placed`.** Everything dated up to 2026-08-13 was written while a THIRD mark
> existed — the pointing hand, "a human chose this DAY". It was removed on 2026-08-14 (*The Padlock
> Is the Only Pin*), and every row those records describe as hand-placed carries a **padlock** now.
> The records are left as they were written, because what they measured happened; read `hand_placed`
> / `handPlaced` / *the hand mark* as `locked` throughout, and *back to automatic* as the padlock
> wherever the sentence is about a POSITION rather than a length.

---

## How the owner works

Recorded because two rounds were spent learning it.

They answer product questions well and quickly, and they push back usefully when a question is
malformed. Several of the questions they have been asked should never have been asked — the answer
was obvious from how a calendar works, and being asked it read as the app not knowing what a
calendar is (*«¿Sabes cómo funciona un calendario?»*). **Ask about genuine forks in intent; decide
the rest and say what was decided.**

Their model of the app is simple and has been stated more than once, in the same words:
**padlock = fixed, no padlock = free.** A change that adds a third state, or that makes a mark
appear behind their back, is a change that will be reported as a defect.

---

## The Manual Window

**Decided 2026-08-13.** Three defects the owner reported turned out to be one defect: a resize
stopped at the end of its own period, a drop into a margin was pulled straight back out, and margin
time was unreachable by hand. Each was a place where the only view available was the engine's.

The alternative considered and rejected: an `if (isMargin)` in the drag layer, another in the
engine, a third in the scheduler. The reason for rejecting it is that a future reader must not be
able to add a rule to one view and forget the other. So both views are derived in ONE place
(`manualWindowsOf` in `src/lib/manualWindow.ts`, called by `dayShapeFromSettings`) and travel
together on `DayConfig` and on the week view's `days[]`.

---

## The Capacity Is Never Touched Alone

**Decided with the owner, 2026-08-17; built the same day.** The owner reported that afternoon hours
had stopped being placed. Their real settings held `defaultDayCapacity = 6` against a 10 h shift
(08:00-14:00 plus 15:30-19:30), so the engine spent its six hours on the morning and stopped — day
after day of `08:00-14:00 6h` with every afternoon empty. **They had never chosen 6.**

**The reproduction, on a clean database.** Three writes, and the third is the defect:

| step | capacity |
|---|---|
| factory | 10 h, afternoon on |
| turn the afternoon OFF | **6 h** — re-capped to the shift, which is reasonable on its own |
| turn the afternoon back ON | **6 h** — not restored, and nothing said |

One toggle and the shop is at half a day for ever. With capacity 6 on a 10 h shift a 20 h job lays
out `6h, 6h, 6h, 2h` across four mornings and the afternoons stay blank.

**We built the trap ourselves.** The re-cap came in when the owner decided the capacity must never
exceed the shift, and CLAUDE.md wrote it down as "re-capped automatically when period times change".
That is a rule that lowers silently and never raises — the asymmetry is the whole bug, and it sat in
`writeSettings` as the ONE deliberate exception in a validator that otherwise refuses everything.

**The alternative the owner rejected** was restoring the capacity when the shift grows again, which
would have made the reproduction above end at 10 h. Their answer chose the stricter reading:

> *«Nunca la toques sola.»*

So the capacity is now refused rather than corrected, and the Settings screen ASKS — the same
confirmation it already raises when a change would strand existing work, naming both numbers and the
hours a day the lower one costs. Cancel writes nothing.

**Why the refusal lives in `validateSettings` and the question in the form.** The server cannot ask; a
400 is not a choice. But it must be impossible to save a capacity the shift cannot buy, or the trap
comes back through the next caller. So the shape is: the server refuses and names the ceiling
(`maxDayCapacityHours`), and the form — which already mirrors the shift arithmetic client-side for the
live preview — works out the implied number BEFORE it sends, asks, and puts the answer in the same
patch. One round trip, and the lowered capacity exists in exactly one place (`patchToSave`), which is
what makes "cancel saves nothing" true by construction rather than by care.

**Why the read path still clamps.** `readSettings` repairs a stored capacity above the shift, because
a hand-edited row would otherwise let `capacityMinutes` claim hours the periods do not have, and the
engine and the grid both read that as a fact. Repairing a READ was never the trap. Repairing a WRITE
was.

**The form does not adjust it either, and that was half the defect.** `applySettingsPatch` used to
re-cap the draft as the owner edited a period, so the number moved under their cursor one layer above
the server doing the same thing. It is a plain merge now, and the capacity field's stepper max opens
up to the current value while it exceeds the shift — otherwise the control's own blur-clamp would
lower the number the owner is about to be asked about.

**A reduced capacity is now stated out loud** — flagged here for the owner to veto, since it goes
beyond what they asked for. It is the half that makes the trap unreachable from any direction: the
Settings field says which hours auto-fill is leaving free, and so does the header strip, because *"why
is my afternoon empty"* is a question about the WEEK and the answer had been living in a field the
owner had no reason to open. Both are flat statements of two numbers, not warnings: choosing to work
six hours is legitimate.

**Verified 2026-08-17.** The reproduction above, asserted at every step in `settings.test.ts` and over
`updateSettings` in `scheduler.test.ts` — the toggle off is a 400 naming `defaultDayCapacity` with the
week and the settings untouched, the owner's confirmed 6 h saves and reflows, and the toggle back on
leaves 6 h alone. Then in a real browser on a scratch database: cancelling the confirmation left the
stored settings and the unsaved form exactly as they were, and the same three steps through the form
ended at capacity 6 h on a 10 h shift — asked for, and stated on screen. The consequence is gone too:
with the capacity left at 10 a 20 h job lays out `Mon 08:00-14:00 + 15:30-19:30`, `Tue` the same,
instead of four mornings.

### Its siblings: the same question asked of every other setting

A validator that corrects instead of refusing is a pattern, so the sweep asked one question of all ten
fields: **is there a value the write path accepts that the read path then quietly changes?** For nine
of them, no. For `defaultDayCapacity` there were two more, both in the repair the trap left behind —
`clampCapacityToShift` enforces `[min(1, shift), shift]` *in whole minutes*, while the write only ever
checked "more than zero" and the ceiling:

| sent to PATCH | write said | on disk | next GET said |
|---|---|---|---|
| `0.5` | 0.5 | `0.5` | **1** |
| `5.7777` | 5.7777 | `5.7777` | **5.783333333333333** |

Half an hour of auto-fill a day, appearing out of nowhere, and a response the Settings screen renders
that is not the configuration the engine runs. **Fixed**: `validateSettings` refuses below the floor
and off a whole minute, so the repair is the no-op its own comment claims. The tolerance on "whole
minute" is deliberate — the form legitimately offers the shift itself as the capacity, and a 593-minute
shift is `593/60`, whose double times 60 is 592.999….

**And one outside the settings module, in the control.** `NumberStepper` bounded the value first and
snapped it to `step` second, so a bound that is not a multiple of the step was rounded straight back
past itself: `min 1, max 9.75, step 0.5` returned **10** for an input of 9.75. On a 9.75 h shift (the
afternoon ending at 19:15 — quarter-hour period times are ordinary) that made *focusing the capacity
field and clicking away* raise the capacity to 10 and then ask to lower it again. Snapping now comes
first and the bounds win; the arithmetic moved to `src/components/ui/stepper.ts` so it could be tested
without a DOM, and the browser confirms 9.75 stays 9.75 with Save still disabled. The same latent
rounding was reachable from the gap duration (max = the drawn timeline, e.g. 13.25 h) and the scissors
(max = the block minus a step, e.g. 1.75 h).

**Recorded, not fixed** — all three are self-consistent between write and read, which is the line:

- **`gapColor` is canonicalised**: `"  #aabbcc  "` is stored `#AABBCC` (the route trims, the validator
  upper-cases). The same colour, and the form uppercases as it goes, so nothing the owner chose is
  changed. Left alone.
- **Sub-minute margins are kept but draw as nothing**: `visualMarginTop: 0.008` stores and reads back
  as `0.008`, and `hoursToMinutes` renders it 0 minutes. The number is never rewritten, so the field
  and the axis merely disagree at a resolution nobody can point at. Unreachable from the form (the
  stepper's step is half an hour).
- **An afternoon that is switched off keeps inconsistent times**: with `period2Enabled: false`, times
  like `10:00-11:00` behind a morning that ends at 14:00 save happily and are held for the day the
  afternoon comes back. Switching it on is then REFUSED naming `period2Start` — a refusal, not a
  correction, and the form disables Save on the same rule. Deliberate: a disabled period is a
  scratchpad.

The read path's other repairs stay as they are, for the reason the capacity's does: they exist so a
hand-edited row cannot take the calendar down, and none of them can be reached by a write. The
strongest is `normalizeSettings` **switching the afternoon off** when a corrupt row holds an afternoon
that cannot exist behind its morning; the write path refuses that combination outright.

---

## The End of the Day Is a Line No Write May Cross

**2026-08-13.** CLAUDE.md already said this twice — in the data model, and in *Block Resize*'s "it
stops at the end of the day's last manual window" — and **nothing enforced it**. Four gestures
reached past it, all answering 200, all storing a row hanging below the grid's own last rule:

| gesture | what it stored |
|---|---|
| a drop released at 13:15 with 6 h | `13:15-14:00` + `15:30-20:45` |
| a bottom-edge resize (over HTTP, and by mouse on a row already outside the windows) | `15:30-21:30`; `19:30-21:00` |
| the scissors' second click | `19:45-20:45`, and `19:30-23:00` |
| a same-job merge | one `13:00-23:00` row, straight through the lunch band |

One line was drawn at MIDNIGHT (`assertRowInsideDay`, which is about a row being *renderable*) and
three were not drawn at all.

**The axis was worse than no limit.** `cover` widens it to keep a row left over from a longer
working day visible, so the drag read its cap off the very space the previous overrun had opened,
and each drop could land lower than the last — verified: three drags compounded into a 10 h row
`13:00-23:00`.

`clockEndOf` is the conversion everything else was missing: `duration` is NET working minutes, so
only it can say that 6 h at 13:15 reaches 20:45. `clampDropStart` replaced `axisEnd −
durationMinutes`, which mixed net minutes with clock minutes.

The write-path guard is **tolerant in exactly one direction** — no write may make an overrun WORSE
— because without that clause it would refuse every unrelated save on a calendar that already has
one stranded row.

---

## The Padlock Is the Only Pin

**Decided with the owner, 2026-08-14.** This is the round that removed the third mark.

`hand_placed` — "a human chose this DAY", with a pointing-hand glyph of its own — was introduced on
2026-08-12 to fix the Friday black hole, and it did: `PATCH /api/blocks/:id {action:"move",
date:<a Friday>}` answered **200 and changed nothing**, because Friday is in the movable pool so the
buffer can self-clean, so the reflow pulled the hand-dropped row straight back to Monday and nothing
on the row distinguished "the engine parked overflow here" from "the owner said Friday".

It solved that at the cost of a third state whose meaning was invisible and which contradicted the
owner's model, stated twice:

> *"el bloque normal que ha colocado una persona no es inamovible y no debe tener un estado
> especial"* (2026-08-11)

> *"aunque esté puesto a mano o no, si tiene huecos para moverse libre lo hará puesto que no tiene
> el candado, ¿no?"* (2026-08-14, on being shown the margin collision)

**Rejected: "padlock everything the user drags"** (considered 2026-08-12). That covered Mon-Thu
drops, which are the majority, and would have frozen the working week. What was built instead covers
only days and bands where the engine never places anything anyway, so it freezes nothing.

**Rejected: making a drop's day a floor, or padlocking automatically when the engine would pull the
row back** (2026-08-14). The owner: *"mejor que no haga nada, si lo quiere mover sin que se reordene
que ponga el candado y luego lo mueva."* So a drop stays a re-ranking, and when the queue puts the
row back the app SAYS so and teaches the route — padlock first, then move.

**What fell out for free:**

- **The margin collision resolved itself.** A row sitting in a margin has a padlock, so a drop on
  top of it takes the refusal a locked row has always had. The defect — the old row silently evicted
  to Monday with its mark cleared — cannot be expressed any more, because there is no longer a mark
  that can be silently cleared.
- Friday still works in both directions: engine-placed overflow has no padlock and stays
  reclaimable; work the owner dropped there has one and stays.

**Migrating the shop's file.** `hand_placed = 1` meant the owner had pinned that row, so the
migration (`REMOVED_COLUMNS` in src/lib/migrations.ts) sets `locked = 1` on every such row before
dropping the column, in one transaction, guarded by `PRAGMA table_info` so both paths are
idempotent. Freeing them instead would let the next recomposition move exactly the work the owner
had placed on purpose. Verified against a database built with the old schema.

---

## A Continuation Fills Forward

**Decided with the owner, 2026-08-12.** The defect, in the owner's words:

> *«al mover un bloque a otro, en vez de adaptarse, desplazó el bloque al día siguiente sin partirlo
> ni nada, dejando el día vacío después de la tarea que he movido».*

Reproduced: Barandilla 12 h filling Thursday, a 2 h job dropped at Thursday 10:00. The cut was right
(`Barandilla 2 h, Marquesina 2 h`) and then Barandilla's remaining 10 h went **whole to the
following Monday**, leaving Thursday 12:00-19:30 completely empty.

The cause was *Never split a job to make it fit* being applied to a tail that is **already a
continuation of work under way**. The owner chose that rule for *placing a job*; applied to the
remainder of a job that has just been cut or shortened it produces exactly a hole for the rest of
the day and the work thrown a week forward.

**Why "not its job's first item in the queue" is the right test**: it is the same population by
construction — a job only ever gets a second item because a drop cut it, the scissors fragmented it,
or a hand-set length pushed the rest of it out of a day. A brand-new job has one item, so it still
moves whole or not at all.

This also fixed the owner's second complaint, *«redimensiona mal empujando de forma errónea otros
bloques»*: after a resize the remainder used to leap past a day it could partly fill.

---

## Creating a Job With a Start Date

**Decided with the owner, 2026-08-12.**

**Why the date is not stored.** CLAUDE.md excludes deadlines deliberately, and a stored `not_before`
column is how that exclusion erodes. The date decides where the rows are born and nothing else.
Where a date genuinely has to survive, the automatic padlock is what survives.

**Why the lock is mechanical rather than a preference.** Queue order IS calendar position and the
engine fills forward from today, so a rank on a later day is not a reservation: a job with nothing
in front of it is placed at the cursor, which is today. A half-locked job would come apart on the
next reflow.

The owner stated the rule as "later than the last currently occupied day", and on the dense calendar
they were describing that is the same test. The code measures the reason directly instead — it asks
the engine where an appended job would land and compares — because on a sparse calendar a single
locked row far out makes "the last occupied day" say nothing about where the engine would fill.
Worked examples, both unchanged by the refinement: work planned through 30 Sep, job placed 15 Sep →
no lock, it flows; job placed 20 Oct → locked, or the engine pulls it back to today. The boundary
where the chosen day IS the last occupied day gives no lock, and has its own test.

**Note on the two flags.** `autoLock` (every row) subsumes `dayLock` (the chosen day's rows only)
whenever the chosen day is beyond where the engine would fill — which is the common case for a
buffer or weekend start. Measured 2026-08-17: a 15 h job started on a Friday four weeks out comes
back with its Monday tail padlocked too. That is correct and not a defect: nothing but the padlocks
holds any part of that job where it was asked for.

---

## The Past is Frozen — And Read-Only To The Block Gestures

**Revised with the owner, 2026-08-13.**

**Why the engine**: recomposition reflows unlocked blocks to close holes. If the past were in scope,
a Monday cut short by a breakdown would get its hole closed by pulling Tuesday's work back into it —
silently rewriting the record of what the shop actually did.

**Why the HAND**, which is the 2026-08-13 change: the same argument, one step further. A gesture on
a past row edits a day no schedule can still change, and the marks say nothing there either — a past
row is outside the movable pool because of its DATE, so a padlock on it changes nothing the engine
reads.

**Two judgement calls made while building it (2026-08-14), both deliberate:**

- **`deleteBlock` is refused too**, though the spec listed only drag/resize/split/padlock. Deleting
  a past row takes hours off a day the shop worked and drops the job's total — strictly more
  destructive than the resize that is refused — and its only route (the hover bar) is already absent
  on past days.
- **`release` (back to automatic) is still allowed on a past row.** It only clears `manualDuration`,
  which the engine no longer consults there, and refusing it would strand the ruler mark in the job
  panel with no undo beside it.

**The cost, named and accepted by the owner**: this removes *correcting yesterday*, which was the
motivating case for *Block Resize* when it was designed. If it comes back, the *Bloqueo con llave*
option — an explicit "edit the past" mode in the menu — was the shape discussed.

**Two agents disagreed about the UI, and the server won (2026-08-17).** One round left the padlock
on past rows in the job panel "so no row can be stranded"; the next made it 409. The server's
reasoning is the one that holds — a padlock on a past row changes nothing the engine reads, so a
control that is only ever answered with a refusal is worse than no control — and nothing is
stranded, because the row still shows both marks and the ruler keeps its undo. Verified by opening
the panel on a past job: no buttons at all on those rows.

---

## Block Resize, and Shrinking That Asks

**Decided with the owner, 2026-08-13; built 2026-08-14.** The owner's report was that resize
*"only works in one direction"*: growing the last row raises the estimate, and shrinking answered a
flat 409 `shrink-last-block` — including when the row was **not** the job's last, since a 7 h job
stored `08:00-14:00` + `15:30-16:30` is ONE stretch to the gesture and its counterparty lives inside
it.

**Why the freed hours never go to a row outside the movable pool.** There a raw `duration` writes
geometry that stays: verified in six configurations, a 1 h Saturday row handed 4 h became
`12:00-17:00` (minutes on both sides of the lunch break) and a 15:30 one became `15:30-21:30` (an
hour past the end of the day). Laying those hours out with `segmentDroppedRow` and refusing when the
day could not hold them was the first answer (`receiver-cannot-hold-hours`); the owner's own answer
replaced it, and it is simpler — a job with no row in the pool has *no block that can take the
hours*, so it ASKS.

**Why `isLast` stays a dead-end trigger.** The spec says "it is the job's last… ask", and pushing
freed hours *backwards* into a job's earlier rows would answer "this row is shorter" with "so the
week before it is longer".

**Why `choices` is in the refusal.** So the dialog is built from the server's list rather than from
a rule the client re-derives, in ONE round trip. `new-block` is absent when the freed hours are
under a quarter of an hour, since a row that short is one no gesture may ask for.

**Removed as unreachable when this landed**: `shrink-last-block`, `receiver-cannot-hold-hours`,
`layOutFixedRow`, `BlockResize.dayOf`, and the locale keys `errors.shrinkLastBlock` /
`errors.receiverCannotHoldHours`.

**The drag's measurement is the owner's report, in three parts:**

> *«al aumentar de tamaño o empequeñecer un bloque este no pasa de las horas de comer y las de
> margen, debería dejarme hacerlo más grande, y que ignore la hora de comer, ejemplo arrastro hasta
> las 17:30 una tarea que empezaba a las 10, en vez de la hora del medio sumarla, ignorarla y sería
> de 10 a 14 y de 15:30 a 17:30.»*

**Verified end to end by dragging (2026-08-17).** A 4 h single-row job shrunk to 2 h asked; *Cancelar*
wrote nothing (job still 240 min, row still 4 h); *Dividir* left the row at 2 h with the ruler mark
and put the freed 2 h on the next day, total unchanged at 240 min; *Quitar las horas del total* on
the job's last row took it from 240 to 180 min with the rows summing to 180.

---

## A Hand-Set Duration

**Decided with the owner, 2026-08-12.**

**Why breaking a job's run on a STORED column is safe.** Breaking it on a stored column is
layout-independent, so `compose` stays a fixed point. Breaking it on anything *derived from the
placement* is what caused an earlier critical defect, where grouping was derived from the layout
while the layout was derived from the grouping, and an unrelated save silently resized the owner's
blocks. Recomposing twice must change nothing; the 2000-seed property harness asserts it with
hand-set rows in the generated calendars.

**This is the constraint the `QueueItem` doc comment in `src/lib/composition.ts` records, and six
rounds of engine work rest on it. Do not derive grouping from the placement.**

**Why the strict-order break was chosen.** Honouring a hand-set duration means a newer job starts
before the older job's remainder for that day. That was chosen over leaving a hole: if no job
follows in the queue the hours stay free, because the shop really is free then.

**Verified surviving a reflow (2026-08-17).** Two hand-set rows of one job, 2 h on Monday and 1 h on
Tuesday; a 30 h job inserted behind them. Both kept their exact lengths, and the Tuesday row kept
its 1 h while being MOVED to Thursday — the ruler is about length, not position.

---

## The Calendar Sits On The Quarter Hour

**2026-08-13.** A row shorter than a quarter of an hour cannot show its own hours
(`MIN_LABEL_HEIGHT`): on screen it is a nameless two-pixel stripe. Two paths could produce one:

- **the scissors**, the one gesture that names a duration outright, checked only that the fragment
  was smaller than the row: `durationMinutes: 5` stored a 5-minute fragment and a 10-minute
  remainder;
- **the engine**, when a quantity in the calendar is already off the grid. A 19 h 59 min job on days
  holding 600 and 590 plannable minutes placed `360 + 230` and then a NINE-MINUTE row on a day no
  gesture had touched.

The honest boundary, tested: with fewer than two quarters left there is no split that avoids a short
row, and drawing it is far better than refusing to place it (an item the cursor keeps stepping over
ends in `horizon-exceeded`, which rolls the whole save back).

**Why it is deliberately NOT a write-path guard.** A floor on the write path would answer the sliver
Open Decision by accident, and would leave the owner unable to delete the sliver it refuses to
store.

---

## Blocks and the Lunch Break

**The unit is marked at both ends** (decided with the owner, 2026-08-13). Only the continuation used
to say anything, so looking at the morning row alone there was nothing to tell the owner the job
went on after lunch.

**What the mark names is the BREAK BETWEEN TWO WINDOWS, not the join between two rows** (corrected
2026-08-13 after dragging it). Being one unit is not enough, because a unit joins any two rows with
nothing *workable* between them, and that covers two more shapes than "cut at lunch":

- **rows that TOUCH**, with no hole at all — reachable whenever auto-merge may not fold them, which
  is exactly the margins: the scissors moving an hour to 07:00 leaves a padlocked `07:00-08:00`
  against `08:00-11:00`, and auto-merge never folds a padlocked row;
- **a hole left by a margin the owner has since set to 0**, real but not the comida.

Read off the row's position in the unit (`!isFirst` / `!isLast`), the marks drew a dashed seam down
the middle of one unbroken rectangle and the tooltip announced a lunch break three hours away.

---

## The Unit of a Drag Is the RUN

**Decided with the owner, 2026-08-14.** Their own refinement is the rule:

> *«Mueve el trabajo si este no ha sido dividido. Si tengo pedazos de hoy por la mañana, hoy por la
> tarde y pasado por la mañana, todo eso si no lo he dividido yo a mano (no hay ninguna tarea en
> medio) muevo todo hasta la tarea que los separe, indicativo de que esa división la he hecho yo.»*

That is **exactly the engine's `QueueItem`**: a run of consecutive movable blocks of the same
project with no other movable project between them. The lunch break does not break a run — nothing
else is between the pieces. A NIGHT does not break one either. Another job does, and that separation
is the owner's own decision, so the drag must respect it and stop there.

**Why the engine's own grouping rather than a second one.** The engine will lay the run out as one
item however it is dragged, so a drag that moved anything else would be arguing with the reflow.

**One request, not one per row** (2026-08-13). It used to be one `PATCH` per row of the unit, each
its own transaction with a full reflow between them — and that is not a smaller version of the same
thing. The reflow re-laid the job's remaining hours onto DIFFERENT ids in between, so the second
request moved whatever row now carried the id the drag had captured: a 3 h unit dragged onto
Saturday moved 2 h and left an hour on Thursday, while the message said no hour had been lost (true,
and beside the point). The same race raised *«Ese bloque ya no existe»* on drops that had in fact
succeeded.

**The cross-day defect, found and fixed 2026-08-17.** `unitOf` opened with
`blocks.filter(row => row.date === target.date)`, so the intersection in `moveBlock` discarded every
id on another day and a run spanning days moved only its first day's part. Measured on the running
app: `Ventanas` 11 h stored as Wed 08:00-14:00 + Wed 15:30-19:30 + Thu 08:00-09:00 — grabbing the
Thursday hour lifted all three rows and the ghost drew 11 h (correct), and the commit moved 10 h and
left `Thu 08:00 60 min` exactly where it was. The ghost promised more than the drop delivered for
any job spanning days, which is the common case.

`unitOf` is now a transcription of the grid's two steps — `groupBlocks` then `buildRuns` — in the
grid's order, so a unit on screen and a unit on the server cannot disagree. Re-measured after the
fix: the whole 11 h landed on Saturday, `08:00-14:00` + `15:30-20:30`, both padlocked.

---

## A Drop Onto Another Row's Start Goes BEFORE It

**Decided with the owner, 2026-08-13; built 2026-08-14.** The client's nudge is what the rule used
to rest on, and its history is what the sliver came from:

- released a hair **below** the rule, the rank became `08:01`, which made the row underneath "start
  before the drop", so *A Drop That Overlaps* cut it there: `Beta 08:00-08:01 (0,02 h)`,
  `Alfa 08:01-10:01`, `Beta 10:01-12:00`. Measured by dragging, twice, at 1646 px and 1100 px;
- released a hair **above** it, the same gesture came out clean.

Two opposite answers for a difference the owner can neither see nor aim at, and a stored row below
`MIN_ROW_MINUTES` that nothing asked for.

**The server settles the tie now** (2026-08-14), so the rank no longer has to be nudged off the
minute the owner aimed at. A drop's `(date, start)` is its place in the queue and the order is total
— ties break by `created_at` then `id`, and `id` is a random UUID, so a tie between two rows created
in the same second used to be decided by a coin flip. Both regression tests fail without the change
(verified by disabling it).

**And a PINNED placement is never nudged at all.** Nudged, a Saturday drop released on 10:00 came
back as `09:59`, the row it landed on was re-placed at `11:59`, and their durations read **2,02 h**
and **1,98 h**: minutes the owner never drew, on the one kind of day whose whole promise is that
what they drew is what they get.

---

## A Drop Onto a Day the Engine Reflows Is Never Refused

**Decided 2026-08-13.** The owner's report, in full:

> *«cuando intento mover algo se coloca antes de recalcularse, por lo que si lo intento pasar al día
> siguiente en el que ahora no hay hueco pero si lo muevo se recalcula y queda disponible, no lo
> puedo asignar directamente porque "aún no cabe"».*

Every refusal answered *does this fit here as the calendar stands at this instant*, and on a
reflowing day that question is not merely wrong, it is **circular**: the row is leaving another day,
everything behind it moves up into the hole, and that is exactly what opens the room on the target
day.

Measured: Monday and Tuesday both full at the 10 h line, a gap in Tuesday's top margin, and the drop
that answered 409 now lands on Tuesday at 08:00 while Tuesday's first job moves back into Monday's
afternoon.

**Why the refusal stands after the slide** (revised 2026-08-14). It used to give up the pin and
settle as an ordinary queue rank; it may not any more, because the pin IS the padlock and taking a
padlock off a row behind the owner's back is the one thing this app must not do.

**Re-measured by dragging, 2026-08-17.** On a reflowing Monday, a drop onto a padlocked margin row
SLID: the ghost read *«Ahí hay algo que no se mueve: el bloque bajará a las 08:00»* before release,
and the padlocked row was untouched. On a Saturday — which does not reflow — the same shape was
REFUSED: *«…esas horas son de «Tope», que está bloqueado (sábado 22 de agosto, de 09:00 a 10:00).
Desbloquéalo o suéltalo en otro momento. No se ha guardado nada.»*, and nothing was written.

---

## Aiming Below What A Day Holds Means The Next Day

**Decided with the owner, 2026-08-14.** On being shown the refusal:

> *«Que se rechaza, de qué friki. Pasa al siguiente día. ¿Sabes cómo funciona un calendario?»*

They are right, and it is the plainest rule in the app. What it replaces is the *dead zone at the
bottom of a reflowing day*, which was an engine limit dressed as a pointer one: a 6 h unit could not
be aimed below 13:00 on the documented shift, because its footprint ends at 20:45 and the
end-of-day guard answered 409 `row-past-day-end`.

**Why it is measured over the PERIODS on the day it rolls to, and over the MANUAL WINDOWS where it
was released.** The second keeps a legitimate release into the bottom margin from rolling off the
day; the first stops a run landing in a margin it never asked for — a margin footprint padlocks the
row, and the owner asked for the next day, not for a mark.

**One rule, one implementation** (reconciled 2026-08-17). The server and the ghost were briefly two
implementations of this: `dropLanding` in `src/lib/dropSlide.ts` and `resolveDropDay` in
`src/components/calendar/dropAim.ts`. The client now imports the server's, adding only what the
server has no opinion about — the clamp, which is a fact about the drag axis, and the two flags the
ghost speaks with. That is the same arrangement `segmentDroppedRow` and `firstClearStart` already
have, and for the same reason: a hand-written mirror of an engine branch drifts the first time the
shift is reconfigured.

The client's walk stops at the week on screen rather than the server's fortnight, deliberately: a
roll off the end of the week would put the ghost on a column the owner is not looking at, so it
clamps and says so instead. The server never sees the difference, because a clamped release fits by
construction and `dropLanding` returns a fitting release untouched.

**Verified mid-drag, 2026-08-17.** A 2 h run aimed at the bottom of Monday moved the ghost to the
Tuesday column at 08:00, with the line *«Más abajo no cabe en ese día: pasa al Mar 18.»* drawn while
the pointer was still down.

---

## Thirds

**Assumption taken 2026-08-14, still uncorrected by the owner.** They did not answer this one; they
pivoted to the model question, which mattered more.

The upper third of a row means "before it", the lower third "after it", the middle third "cut it
here".

**Why cutting has to stay reachable by drag.** With the run as the drag unit, a cut is what
*creates* the separation between runs, and a separation is what tells the app "I divided this on
purpose". Removing the cut (the "halves" option) would leave the owner unable to express by dragging
the very thing their own drag rule depends on.

Thirds also removes the exact-minute aiming and the one-minute rank nudge that produced the sliver
rows. And because the ghost previews the real outcome, hovering the middle third shows the block
actually splitting, so the rule explains itself instead of being learned.

`rankFor` lost its `exactMinutes` parameter when this landed — it was already dead code, and it was
the input that made "before it" unaimable. The one-minute nudge stays, because it is the mechanism
"before it" is expressed with.

**Verified by dragging, 2026-08-17**, on `Puerta 4 h` (08:00-12:00) with `Barandilla` beside it:

| aimed at | stored |
|---|---|
| Puerta's upper third | `Barandilla 08:00-12:00`, `Puerta 12:00-14:00` + `15:30-17:30` — Puerta whole, no cut |
| Barandilla's middle third | `Barandilla 08:00-10:00`, `Puerta 10:00-14:00`, `Barandilla 15:30-17:30` — a clean 2 h/2 h cut, no sliver |
| Puerta's lower third | nothing changed: "after Puerta" is where Barandilla already was |

---

## A Drop Always Answers For Itself

**Decided 2026-08-12.** This is the owner's Friday defect generalised. A drop writes a queue RANK,
so the row lands where the reflow puts it, and four different things look identical on screen to a
drag the app ignored.

**The `unchanged` notice teaches the route rather than reporting the fact** (2026-08-14), because
the owner's decision was that a drag the engine would undo must NOT padlock automatically — so the
notice has to name the way to get what they wanted. Padlock first, then move. The same order was
applied to `notices.dropSettles` and `grid.dropRankHint` so the three agree.

**Verified by dragging, 2026-08-17.** A 2 h row dragged to a much later rank on a reflowing Monday
came back to its own slot and said: *«La cola ha devuelto «Barandilla» a donde estaba: de lunes a
jueves soltar cambia el puesto, no la hora. Para dejarlo donde lo has soltado, ponle primero el
candado y muévelo después.»*

**One case is deliberately silent**: a drag that really travelled and resolved to the row's own
current slot says nothing, because the ghost was under the pointer the whole way and already showed
it. Only a drag that barely wandered (under `CLICK_SLOP`) is re-read as a click.

---

## One Axis Per Gesture

**Decided 2026-08-13.** This is the answer to *«a veces no se coloca exactamente donde quiero»*.

The axis is fitted to the height the grid is measured at, and the drag hint under the grid is ONE
line where the resting legend is TWO — so publishing the drag's own preview shrank the legend,
`.gridArea` took the 9 px, and the axis re-fitted by 1.2% about 50 ms into the drag. A resize
released on 17:30 was read as 17:22 and stored 5,75 h. "A veces" because it depended on how fast the
drag was and on how many lines the hint wrapped to at that window width.

A move looked safe only by accident: subtracting the grab offset cancels an ORIGIN error, and this
was a SCALE error, which it merely re-anchors to the press depth — visible wherever the exact minute
is KEPT rather than re-flowed (Friday, the weekend and the margins, all of which padlock the row).

The invariant underneath is `minutesAt(yOf(m)) === m` for every minute of the axis, margins and
lunch band included.

**Paging the week mid-drag does not touch it** (2026-08-17). The axis is VERTICAL and a week is a
set of COLUMNS, so a page turn changes what the pointer is over horizontally and nothing about the
mapping the gesture fixed at press. The screen already holds the painted axis for as long as a block
is in the air, so the new week is drawn on the press's own axis and the two stay one ruler; the axis
re-fits on release, like any other late re-fit. The one visible cost is a week whose rows fall
outside the held axis — a row in a margin the previous week had none of — which is drawn clamped to
the axis end until the hand comes off. Widening the axis mid-drag would be the SCALE change this
whole decision exists to forbid.

---

## Dragging To The Edge Changes Week

**Decided 2026-08-14, built 2026-08-17**, after the owner tried to use it: *«lo de arrastrar a la
siguiente semana no sé cómo funciona o no lo he conseguido hacer funcionar»*. There was nothing to
find — the decision had never been implemented — and that is the first thing this build had to
answer: a gesture with no visible affordance is indistinguishable from a gesture that does not
exist. Hence the rails, which are not decoration but the feature's discoverability.

**The three numbers, and why they are those numbers.**

- **The strip: 40 px at the frame's ends, and the whole 58 px gutter on the left.** Measured from
  the FRAME rather than from the columns because on a narrow window the columns scroll INSIDE the
  frame, and a strip pinned to Monday's left edge would then sit where no pointer can reach. That
  choice pays twice: the left strip lands in the time-axis gutter, which belongs to no day, so
  nothing is taken from anything. It was 40 px there for one afternoon and left the hour labels
  sliced down the middle (`08:00` reading as `0`), so it became the gutter's own width — and the
  rail draws itself over `max(--ww-edge-zone, --ww-axis-width)`, the same number the grid's column
  template is built from, so the trigger and the paint cannot drift apart.
- **The wait: 500 ms, then ~~320, 240, 200~~ a constant 800 ms** (revised 2026-08-17, see *The
  Repeat Is a Metronome* below). 500 ms is long enough that no drag merely PASSING through the strip
  ever fires and short enough not to feel stuck — the owner asked for *«fluido y ligero»*.
- **The rail's fill lasts exactly the wait that is running** — `EdgeHold.delayMs` is published by
  the drag layer rather than re-derived in CSS, because a progress bar that finishes before or after
  the thing it measures is worse than none.

**Sunday is the cost, and the dwell is what pays it.** There is no gutter on the right, so the strip
lies over the last 40 px of Sunday's 134. Two things keep that honest: a RELEASE there is still a
drop on Sunday (the rail is `pointer-events: none`; only HOLDING pages), and a strip the pointer
STARTED in does not arm until it has been left once — otherwise a block grabbed at Sunday's right
edge and dragged up its own column would page the week out from under itself.

**The arrow keys were already a hole.** The screen binds them to the pager at the window, and it did
so during a drag too: pressing one paged the calendar with a block in hand and nothing re-resolved
the ghost. They are now handled by the gesture itself, in the capture phase, so the screen's listener
never sees them — the shortcut and the fix are the same three lines.

**What "the drop resolves against the week it is released in" cost.** Almost nothing, because every
fact a release needs is read at the release from `viewRef` — the day, its windows, the rows to aim
at, the starts already taken. Three seams needed work:

1. **The remembered column.** `previewMove` falls back to the last column it was over when the
   pointer is on none — which is exactly where the left strip is. After a page turn that date names
   a day no longer on screen, so the ghost would be drawn nowhere and the drop resolved against a day
   `dayAt` cannot find. It now keeps the remembered date only while it is still a column, and
   otherwise takes the nearest one.
2. **The ghost without a pointer event.** A hand holding still at an edge sends no events, so the
   preview is re-resolved from the last pointer position the moment the columns change (`weekKey`).
   Without it the block vanishes from the hand until the mouse is jiggled.
3. **The release that beats the fetch.** Verified with 700 ms of injected latency: the turn fires,
   the block is released before the new week arrives, and the drop belongs to the week that was on
   screen — so the pending page turn is cancelled (`showWeekOf`), or the owner would be left looking
   at a week their block is not in. The repeat is also gated on the week ARRIVING, which is what
   stops a hold outrunning the calendar.

**The two new outcomes are the honest part.** Dragging into a later week and releasing on a
Monday-Thursday day does NOT leave the block there: a drop on an auto day is a rank, so the reflow
lays it out where the queue reaches — measured, a 10 h run dragged from Monday 17 August into the
week of 7 September came back on **Wednesday 19 August**. That is the documented rule working, and
the ghost said so before the release («Entra en la cola por aquí», hollow, no clock range). But the
toast said *«ya no cabía en esta semana: sus horas continúan…»*, which describes the opposite
journey, so `leftWeek` was split by direction and `pulledBack` says what really happened and how to
get the other behaviour (padlock first, or drop on a day that keeps the minute). `movedWeek` covers
the case where the row DID stay: it names the day, the week, and the way back to today's.

**Verified in a real browser, 2026-08-17** (scratch DB, 1646×963): rails drawn on both ends the
moment a block leaves the ground, naming `10–16 ago 2026` and `24–30 ago 2026`; a hold at the right
edge pages after ~500 ms and then repeats at a steady pace; the ghost follows onto the new week's column
without the pointer moving; the arrow keys page both ways mid-drag; a padlocked run dropped on
Wednesday 26 August landed exactly there with the `movedWeek` sentence; a 10 h run released on
Saturday 29 August landed on the two ghost rectangles **to the pixel** (`top 257 h 261` and
`top 546 h 261`, stored `09:00 +5 h` and `15:30 +5 h`, padlocked).

---

## The Repeat Is a Metronome, Not an Acceleration

**Revised 2026-08-17, from the owner using it:** *«si mantengo el ratón ahí empieza a ir como loco
semana a semana»*. The ramp — 320, then 240, then 200 ms — was argued from "by the second turn the
owner has already said what they want". What it actually proved is that a hold had no brakes. Measured
before the change: 2.5 s at the edge walked from **week 34 to week 41**, nine weeks, and a hold that
travelled 34 → 41 in 2.9 s.

**Nobody at the edge of a calendar is looking two months out.** They are looking one or two weeks
ahead and want to stop on one. So the number is chosen for STOPPING, and the three constraints pin it
between about 600 and 1000 ms:

- **Stoppable.** Reaction to a change on screen is around 250 ms and the hand then has to travel out
  of the strip. Under about half a second the week the owner meant to stop on is already gone, which
  is exactly what «como loco» describes.
- **Readable.** The rail names its destination by DATES. A pace that outruns its own label makes the
  label pointless, and the label is how the owner knows where they are going.
- **Alive.** Past about a second the calendar feels stuck to the pointer, which is the failure the
  500 ms first wait was tuned away from.

**800 ms.** A little over a week a second: brisk, and countable. The ramp is gone entirely —
`edgeDelayFor` is two values, because the first turn is the one the owner must be protected from
firing by accident and every turn after it is one they must be able to stop on. A test holds the
constant inside the 600–1000 ms window so the next agent has to argue with the reasoning rather than
just the number.

**Measured on the running app** (holding still, no pointer events, six seconds at each end): first
turn at **503 ms** going forward and **497 ms** going back; then 809, 885, 896, 870, 897, 887, 880 ms
forward and 875, 879, 868, 847, 878, 863, 842 ms back. The ~70 ms over 800 is the repeat being gated
on the week ARRIVING, which was already the design. Eight weeks in 6.6 s, both directions — 1.2 weeks
a second. The owner's own 2.5 s now travels **3 weeks** instead of nine.

---

## A Week Change Says Which Way It Went

**Asked for by the owner, 2026-08-17:** *«estaría bien alguna animación fluida que indique visualmente
que se ha cambiado de semana tanto adelante como hacia atrás»*. Paging was silent: seven columns
replaced in one frame, and the only thing saying which way was the header label — which the owner is
not reading, because they are looking at the block in their hand.

**Directional, or it says nothing.** An animation that looks the same both ways says "something
changed", which the owner already knew. Forward the new week enters from the right, back from the
left: two mirror keyframes and no other difference between them, so the direction is readable without
being counted. 180 ms (`--ww-duration`, the number the rest of the app moves at), `ease-out`, 26 px,
opacity 0.2 → 1. `from`-only keyframes with no fill mode, so nothing is left behind.

**The direction is derived, not passed in.** `useWeekSlide` compares this week's Monday with the last
one (ISO dates compare chronologically), so the header buttons, the arrow keys, `Hoy` and the edge
hold all get it for free and none of them can get it wrong. The first week never slides — opening the
app is not a page turn — and a same-week refetch remounts nothing, so a save never looks like one.

**The ghost is why `.columnBody` exists.** Everything belonging to the WEEK (blocks, gaps, the `libre`
pill) went into a wrapper so the animation has something to move that is NOT the ghost. A block held
at an edge pages the calendar, and the one rectangle that must never slide out from under the pointer
is the one promising where that block will land. Measured through a mid-drag page turn: the ghost's
`animationName` is `none` and its `transform` is `none` on every one of 155 sampled frames while the
column body runs `weekFromNext`.

**The header slides its WORDS, not its box.** The first attempt moved the header cell, which put its
`border-left` 26 px from the column border directly under it: for 180 ms the grid read as
MISALIGNED rather than as moving, the opposite of a cue. Frame-sampled proof of the final version:
`headBox: none`, `headWord: +26px → 0`, `columnBody: +26px → 0`, `axis/band/tick: none`.

**And then it moved the whole calendar, which the integration pass caught.** `translateX(26px)` on the
last column's body reaches 26 px past the grid's own right edge, and that is SCROLLABLE overflow. The
scroll container answered with a cascade: a horizontal scrollbar appeared (−15 px of height), which
made the grid taller than its box, which raised a vertical scrollbar (−15 px of width), which
re-laid-out every column. Measured: `clientWidth` 1566 → 1551, `clientHeight` 736 → 721, Sunday's left
edge 1453.17 → 1439.45, twice per page turn. **During a drag — which is when paging is used at all —
the ghost therefore jumped 14 px sideways under a perfectly still hand at every turn**: the horizontal
twin of the drift *One Axis Per Gesture* exists to forbid. It was easy to miss because only the
FORWARD direction does it — overflow to the left of the scroll origin is not scrollable, so
`weekFromPrevious` was already clean.

**Three fixes were tried and two were wrong, both instructively:**

- **`overflow-x: clip` on `.grid`** stops it and silently breaks the documented "the scroll container
  absorbs it on a window too narrow for the whole week": the grid's box is `min-width: 100%`, so it is
  the column TRACKS that overflow it, and clipping them makes Saturday and Sunday unreachable rather
  than scrollable. Measured with the floors forced past the viewport: Sunday's right edge at 1975 px,
  `scrollWidth` still 1566, `scrollLeft` stuck at 0.
- **`clip-path` in the keyframes** does not reduce scrollable overflow at all — the cascade was
  identical with it in place.
- **`overflow-x: clip` on `.column`** stops it and is the right place, but NOT permanently: the SETTLE
  animates a row in from the column it was released over, so `dx` is a whole column width, and a
  column that clipped for ever would trade one animation for another. Measured on a real travelling
  settle: `translate(249.672px, -360px) → 0`, 248 px of it outside the destination column.

**So the clip lasts exactly as long as the slide.** `DayColumn` holds a `sliding` flag, true from the
mount of a column that arrived with a page turn until its own `animationend`, and false for ever
after. `slide` itself cannot serve — it is the direction of the LAST page turn and stays non-null for
the rest of the session, which is what makes it correct for the animation (a page turn remounts every
column, so the class is present exactly when a fresh element needs it) and useless as "is it moving
now". Only the X axis is clipped, because the hover action bar docks OUTSIDE a short row's TOP edge;
`contain: paint` and a container query would clip both, which is the trap CLAUDE.md already warns
about. Verified after: `clientWidth`, `clientHeight` and Sunday's left edge constant across three page
turns; `overflow-x` observed going `visible → clip → visible` with 0 sliding columns left at the end;
one distinct ghost `left` across 145 frames and three turns; the sticky day header still at top 0
after scrolling 143 px down; the action bar drawn inside its column and every button reachable by
`elementFromPoint`, including a 30-minute row in Saturday's top margin whose bar docks below.

---

## The Lunch Break Is a Seam, and Every Hour Is Labelled

**Decided with the owner, 2026-08-17, as two requests that turned out to be one:**

> *«Haz el hueco del medio para la comida pequeño, para indicar que hay un hueco pero es
> despreciable ya que no podemos trabajar ahí.»*
>
> *«En la división de horas de 8 a 11 es un salto muy grande, coloca todas las horas.»*

The second is paid for by the first. Measured at a 876 px window the axis was 655 px for
07:00-20:30 and the comida took 73 of them; the labels the axis could carry were the period edges
plus one interior tick per three hours, so the morning read `08:00 … 11:00 … 14:00` and judging
where a block sat inside a three-hour box was done by eye. Compressing the break to a flat 28 px
gives back 45 px and raises the working hour from 48.5 px to 52.25 px — which is the room an hourly
label needs.

**Why 28 px, and why a flat number rather than a fraction.** The band carries its own two labels
(14:00 and 15:30, both period edges, both times the whole screen is stated over) and a 12 px label's
line box is 18 px, so under ~26 px they touch. A flat height rather than "a third of what it was"
because the point is that the break is NEGLIGIBLE: it should not grow when the window does.

**Only the hole BETWEEN two periods is compressed. The margins are the day.** They are non-working
time too, and the temptation is to treat them the same — but the owner PUTS REAL WORK in a margin by
hand, and an hour of margin drawn shorter than an hour of the morning would make the block sitting
in it lie about its length. `breaksBetween` therefore starts at the first period and stops at the
last, which is a different set from `nonWorkingBands`'.

**What a pointer inside the seam means — asked deliberately rather than left implied.** It is
unchanged, and that is the answer:

- the mapping stays an exact inverse in there. It would have been easy to clamp the band to a single
  minute and call it a dead zone, and that would have broken *One Axis Per Gesture* at the one place
  the ghost and the server would never disagree loudly enough to be noticed;
- a RESIZE released in the band was already a dead zone by ARITHMETIC — `durationTo` counts net
  working minutes, so 14:00, 15:00 and 15:29 have always committed the same duration. Compressing
  the band shrinks a zone in which the pointer already did nothing, which is the right direction;
- a DROP released in there ~~still lands on its minute and padlocks the row~~ **is now read the same
  way the resize always was: every minute of the band means the first minute that can hold work** (see
  § *A Minute With No Working Time*, decided later the same day). It is a 28 px target — ~3.2 minutes
  to the pixel, a `SNAP_MINUTES` step every ~4.7 px — so it has to be aimed at on purpose. Nobody
  works there, so a harder target is a feature, and a target that redirects to the first minute they
  DO work is a better one still.

**The dangerous part was never the paint, it was the arithmetic.** A piecewise axis has no single
"pixels per minute", and the drag layer rests on the mapping being an exact inverse BOTH ways; the
last scale defect here cost a round (*One Axis Per Gesture*, a 1.2% drift that made a resize commit
5,75 h for a gesture that drew 6). So the axis is held as explicit segments with `yOf` and
`minutesAt` reading the SAME table from the same side — a time on a seam is converted with a zero
offset into the segment below it, so both functions return the stored number there and cannot
disagree by a rounding error. The round trip is asserted minute by minute over the whole axis at six
fitted scales, and monotonicity beside it.

**AND THEN MADE DISCREET** (also 2026-08-17, the owner: *«para la zona del medio que has modificado
me gustaría que fuera más discreta»*). It shipped as a 45° hatch between two solid graphite rules
(`--ww-border-strong`, #444441), and those rules were the highest-contrast thing on the whole
calendar — darker than any block's own border, drawn straight across all seven columns, in the one
part of the day that carries NO information. The eye went to it first.

What is left is the hole itself, and that turns out to be enough. Three things say "nothing lives
here" with no decoration at all: it is **the same grey as the top and bottom margins**
(`--ww-margin-fill`), which is honest — a margin and the comida are the same kind of nothing, and the
legend already lumps them together; it **spans the week edge to edge, square**, which nothing else on
the grid does, so it cannot be misread as a very short block (the original argument for the hatch);
and **28 px where an hour is 52 px is itself the statement**. The two edges keep a rule, because a
boundary must survive its LABEL being dropped, and it is now the ordinary `--ww-border` at hairline
weight — measured identical to what `.lineBoundary` draws every other period edge with
(`1px rgb(211, 209, 199)`), so the band's edges match the rest of the axis instead of shouting over
it. Verified at the documented shift and at a 10-minute break (`08:00-14:00` / `14:10-18:10`), where
the band draws at its own 8 px, `14:00` survives, `14:10` is dropped and no labels collide.

**`heightOf(duration)` was REMOVED from `Timeline`, not fixed.** "How tall is 90 minutes" has no
answer on a piecewise axis without saying where, and the two callers that asked it were wrong in
opposite directions: a gap running 12:00-19:30 (its duration is CLOCK minutes — *stop the day here*
makes one across the comida) drew 50 px past the end of the day. `heightBetween(from, to)` cannot be
called without the answer being well posed, and for every row the invariants permit it is
`duration * pixelsPerMinute` to the pixel, because no stored row straddles a break.

**A label is dropped only where it would print over one already placed.** Measured in label BOXES
rather than in minutes or in centre-to-centre pixels, because the two labels at the ends of the axis
are anchored differently (`.tickFirst` / `.tickLast` hang them inside the frame): at the shop's
window 20:00 sits 26 px above 20:30 — far apart by any centre test — and printed straight through it.

**"AND NEVER A PERIOD EDGE" WAS TOO STRONG A PROMISE, and it was found by driving the settings rather
than the calendar (integration pass, 2026-08-17).** Settings accepts a shift with a very short break —
`08:00-14:00` then `14:10-18:10` — and the seam deliberately draws that 10-minute hole at its own
9 px, because *compressing may only ever make a hole smaller*. Two 18 px labels do not fit in 9 px of
axis, so `14:00` and `14:10` printed one through the other: an unreadable smudge down the side of the
calendar, in a configuration the test suite already exercised for its band height. The rule protected
edges from HOURS and never asked what protects an edge from another EDGE.

So the guarantee is now a PRECEDENCE instead of an exemption — period edges, then the two ends of the
axis, then the hours — and every rank is checked against the boxes already taken:

- **an hour yields to everything**, because it can be counted from its neighbours;
- **an axis end yields to a period edge.** The margins step in half hours (`HOUR_STEP`), so a 0.5 h
  margin is two clicks away, and at `MIN_PIXELS_PER_HOUR` half an hour is 21 px — less than one label.
  An axis end is only the outer lip of a grey band nobody works in; `08:00` is when work starts. The
  first attempt at this fix forced the axis ends and dropped `08:00`, which is the wrong way round;
- **an edge yields only to an earlier edge**, because the earlier one is when work STOPS, and the
  boundary is not lost with its label — the seam draws a solid rule on each of its own edges.

**Forcing the axis ends also coupled the arithmetic to the stylesheet, which is why it was abandoned
rather than kept as a special case.** `.tickFirst` / `.tickLast` were applied by INDEX in WeekGrid: drop
the first tick and index 0 becomes a label the CSS hangs below its rule while `labelBox` had measured
it as centred — the collision model and the paint disagreeing by a whole label, which is precisely the
defect class this axis was rebuilt to remove. Both classes are now keyed on the MINUTE, matching
`labelBox`'s own test, so either end can be dropped safely.

**The property is now the assertion, not the examples.** "Nothing left on the axis overlaps anything
else" is checked over five shifts × four margin widths × seven fitted heights, because the cases that
bite are the ones nobody thought to write down — a 10-minute break was one, and it had been sitting in
the suite as a band-height test for a day.

**Re-measured on the running app, 2026-08-17 (integration pass)** across six shift configurations at
two window heights each: the documented shift, the 10-minute break, half-hour margins, the afternoon
switched off, no margins at all, and a long `06:30-21:00` split shift. No two labels overlap in any of
them. The afternoon-off axis is LINEAR (uniform 84.875 px per hour, no seam at all), the 10-minute
seam is 9.04 px at 1440x900 and 7 px at 1280x560 — never stretched to 28 — and the half-hour-margin
axis at the clamped scale drops BOTH axis ends and keeps every period edge and every hour.

**Measured on the running app, 2026-08-17**, at two window heights (876 px and 1093 px), against a
week holding a unit cut at the comida, a 15-minute row, a padlocked Saturday row and a gap spanning
the break. The axis was rebuilt from the ticks the PAGE printed and every rectangle held against the
minutes the API stored: all of them match to under 0.05 px, the band is 28 px at both heights, and
the margins are a full hour each. Then the two gestures that cross the seam: a Saturday unit pressed
on 09:00 and released on 17:00 stored `16:00` exactly (a pinned drop keeps its minute, so an axis
error there is stored), and a resize of the Monday morning row released on the 19:00 label stored
`08:00-14:00` + `15:30-19:00` — 9,5 h.

---

## A Minute With No Working Time

**2026-08-17.** This was Open Decision 5 and it should not have been one. What it was listed as — "a
drop released in the lunch band stores one solid row straight through the break" — reads as a
question about what a gesture MEANS. It is not, because CLAUDE.md had already answered it twice, in
two places that contradicted each other:

| where | what it said |
|---|---|
| the data model | "a stored block never straddles a non-working interval… **this holds for a HAND DROP too**: the drop is cut at the break when it is saved" |
| *A Drop Is Stored In Segments* | a row that "**starts** outside every window (the lunch band itself)" is deliberately left uncut |

The first is stated as an INVARIANT and three things rest on it — rendering (`heightBetween` is
`duration * pixelsPerMinute` only because no row straddles a break), the overlap arithmetic, and
auto-merge. The second is a latitude. So the contradiction had a right answer, and applying the
stronger rule is not inventing one.

**It was never an off-by-one at 14:00.** The reproduction handed over was `startMinutes: 840` — the
minute period 1 ends, the exclusive end of the first manual window and before the start of the
second, belonging to neither. Sweeping the band minute by minute showed **every** minute from 14:00
to 15:29 storing the same illegal row, on the weekend and on Monday-Thursday alike, and the
scissors' target doing it too:

```
dropped 13:59  ->  13:59-14:00 (1m)  + 15:30-17:29 (119m)     cut, correct
dropped 14:00  ->  15:30-17:30 (120m)                          was: 14:00 +120m -> 16:00
dropped 15:29  ->  15:30-17:30 (120m)                          was: 15:29 +120m -> 17:29
```

**Why "the next working minute" and not the two other candidates.**

- **Cutting it at 15:30 and leaving the head in the band** (candidate (a) as listed) removes the
  straddle and keeps the other half of the defect: `14:00 +90m` books ninety minutes of work over
  lunch, and the day then reports itself booked while the morning is empty. The complaint was never
  only the straddle.
- **Refusing a release inside the band** answers a plain gesture — "put it after lunch" — with an
  error about a minute. The owner's recorded reaction to exactly that shape of refusal is
  *«Que se rechaza, de qué friki. Pasa al siguiente día. ¿Sabes cómo funciona un calendario?»*
- **The next working minute is the reading the app already had everywhere else.** A RESIZE released
  in the band has always been a dead zone by arithmetic — `durationTo` counts net working minutes, so
  14:00, 15:00 and 15:29 commit the same duration — and the axis draws the band as a 28 px seam
  labelled *solo arrastre manual*. Making the drop agree costs nothing and removes a boundary.

**Why it is NOT the visual margins' latitude, though it looks adjacent.** A margin is workable time
the owner chose to have and a row may legitimately sit in one; that is why a margin pins its row. The
break is not workable at all. `firstWorkingMinute` is stated over the MANUAL windows, so the margins
are inside them and nothing about them changes.

**The consequence that is a real behaviour change, and the reason it is right.** A Monday-Thursday
drop aimed at the break used to PADLOCK, and it had to: the row was stored where it was released, and
the engine's only possible answer to a row in the break is to undo the drop. Read as 15:30 it is an
ordinary request inside the periods, so it takes a queue rank like every other Mon-Thu drop. Keeping
the padlock would have made the POINTER decide the mark for two identical stored rows — 15:29 pins,
15:31 does not — which is the same off-by-one class this round exists to remove. The DAY still pins
(Friday, the weekend), and so does a margin.

**Four siblings the sweep found, all of them the same missing reading:**

1. **`reachableRuns`** read a start in the band as "the hole alone, up to 15:30", so `clockEndOf`
   measured a 2 h release at 14:30 as ending at 16:30 while the segmenter stored it at 15:30-17:30 —
   the end-of-day guard and the drag's clamp deciding from a number the write path disagreed with by
   the whole break. They now read it through the same helper.
2. **The ghost re-derived the start.** `resolveDropDay` took `dropLanding`'s answer only when the DAY
   changed and otherwise returned `input.startMinutes`, so a preview drawn in the band promised a
   rectangle the server would store after it. The file's own doc comment warns against exactly that
   ("this file and the write path were briefly two implementations of one rule").
3. **The drop's write path ignored the segmenter's start**, reading back only `durationMinutes`. It
   matters for a MERGE, whose survivor takes the earlier of two starts and so can be moved backwards
   into a break a settings change opened under it.
4. **The property harness could not see the shape.** `straddlesABreak` tested
   `startMinutes < period.end && end > next.start`, which is false for `14:00 +120m` because no period
   covers 14:00 — so 2000 generated calendars had been green over a row holding ninety minutes of
   lunch. Fixed, it fails at seed 17 with the old segmenter and passes with the new one, which is what
   makes it a regression guard rather than a description.

**A row can still START in a break, and it is left where it is.** The owner shortens the morning under
a row that was legally placed; nothing rewrites it in place, because the tolerance the end-of-day
guard already has ("no write may make an overrun WORSE") is the right shape here too and a new refusal
would have made every unrelated save on that calendar fail. But the moment a gesture rewrites its
LENGTH the new segments are laid out from the first minute that can hold work, so it stops crossing
the break instead of being grown further through it. No write-path straddle guard was added, for that
reason.

**Verified over HTTP on the running app, 2026-08-17** (scratch DB, `WORKWISE_DB_PATH`), sweeping a 2 h
job onto Saturday 22 August: 13:15 → `13:15-14:00` + `15:30-16:45`; 13:30 → `13:30-14:00` +
`15:30-17:00`; 13:59 → `13:59-14:00` + `15:30-17:29`; and 14:00, 14:01, 14:30 and 15:00 all →
`15:30-17:30 (120m)`, one legal row after the break. Then at the operations layer against a real
migrated SQLite database, over every boundary minute plus the scissors' target, a resize of a row a
settings change stranded in the break, a gap across the break (unchanged, as it must be), and a day
whose afternoon is switched off (no later working minute, so the roll or the refusal answers).

---

## Deleting a Job Leaves Its Past Intact

**Decided with the owner, 2026-08-13.** The past is a record. Cascading the whole job away would
free hours the shop actually worked, and while the engine may not write to the past, the days would
still be left claiming a shape they never had.

**Why the name is stored rather than composed on read.** There is nowhere to look it up afterwards:
the project row is gone and its blocks went with it.

**Why storing the composed sentence is the right trade**, accepted by the owner: it is frozen in
whatever language the app was in when the job was deleted, and switching to English later will not
translate it — but a gap's `reason` is user data, the same field that holds *Avería torno*, and it
stays editable and deletable like any other gap.

`src/lib/text.ts` reads the locale JSON directly rather than going through `src/lib/i18n.ts`, which
would pull react-i18next into the data layer. It is the only prose the data layer ever produces;
every other message is an i18n KEY the UI resolves.

**Verified end to end, 2026-08-17.** A job with two past rows (Thu 12:00-14:00, Fri 15:30-16:30) and
no future rows, deleted from the job panel: both rows came back as gaps at the same dates, times and
durations, each reading `Trabajo «Historico» eliminado`, and the toast said *«Se ha eliminado el
trabajo. Las 2 partes que ya estaban trabajadas se quedan en el calendario como huecos, para que
esos días no cambien de forma.»*

---

## Two Parts of One Job — no structural change

**Considered and rejected for now, 2026-08-14.** The owner's real case: *«el cliente quiere preparar
Ventanas X h todas seguidas y luego días después tenga su colocación, la cual es parte del
trabajo»* — and today it is easier to create a second, unrelated job than to express that.

Rejected: phases inside a job, and linked jobs with a dependency. Chosen instead: **reduce the
friction of the workaround** — a button in the job panel, *añadir otra parte*, that creates the
second entry with the name and colour already filled in and asks for its date. The relationship
stays a naming convention; the app does not know the two are related. *(Not built yet.)*

Consequences to keep in view, since they are the price of this choice:

- the two entries' hours do not add up anywhere;
- if the fabrication slips, the installation does not follow and nothing warns;
- so the app cannot answer *«no llegas: la fabricación acaba el 22 y la colocación es el 20»*.

That last one is adjacent to deadlines, which CLAUDE.md excludes deliberately. If it is ever wanted,
it should be entered on purpose rather than through the back door.

---

## Recorded as direction, deliberately not built

**2026-08-13.**

- **Backups**: an Export button in Settings, for the future.
- **Holidays and closed weeks** (`day_overrides`, whose table and engine support already exist):
  they will **behave like a weekend day**. Not applied until the main engine is properly polished.
- **The `sigue` and `colchón` text tags will eventually disappear** in favour of understanding it
  visually: a continuation already reads as one because it is the same job, and the buffer already
  reads as one because it is a Friday. No work now; do not invest further in that copy.

---

## Reproductions behind the Open Decisions

The questions themselves are in CLAUDE.md, *Open Decisions* — that is where an implementer needs
them, because the rule there is "do not invent an answer". What follows is the evidence each one
rests on, kept out of the way.

**The eight below came out of the 2026-08-13 defect hunt** (the one that fixed *The End of the Day*,
the unit drop, the gap refusal and the quarter-hour floor). Every one of them was reproduced, none
of them breaks an invariant of the battery — hours are conserved, nothing straddles the break,
nothing overlaps that did not already, recomposing twice changes nothing — and every one of them is
a question about what a GESTURE MEANS. That is why they were deliberately left alone: guessing would
waste the answer.

1. **Taking a row out of the movable pool empties the rest of the day and parks the work a week
   later.** `Barandilla 14 h` then `Porton 6 h`, today Thu; drag the bottom edge of Barandilla's
   `Thu 15:30-19:30` row down to 20:30 → Thursday MORNING (6 h of today) is emptied and stays empty,
   Friday stays clear, and Porton slides Monday → Tuesday. The gesture added one hour and moved
   nine. Cause: an item is treated as its job's FIRST placement whenever the reason it heads the
   queue is that its earlier rows LEFT the pool, so `continuation` is false, *Never split a job to
   make it fit* applies, and the remainder moves whole. It arrives three ways at once: growing a row
   into the bottom margin, padlocking a row, and growing a row up against a gap.

2. **A 6-pixel drag on the bottom edge of a lunch-split unit's first row reshuffles the week while
   the ghost promises nothing.** The ghost reads `08:00–14:00 · 6 h` — no change — and the request
   `resize 360` is still sent, because `useBlockDrag`'s no-op guard compares the released NET minutes
   from the row's start (360) with `target.durationMinutes`, which for a resize is the STRETCH (600).
   The two can never be equal on a multi-row unit, so no micro-drag is ever suppressed. The resize is
   then a zero-delta one whose only effect is to set `manual_duration`. The mechanical half could be
   fixed tomorrow; the semantic half cannot, because the edge the owner can grab sits at 14:00 while
   the value the client is editing ends at 19:30.

3. **A resize whose result does not fit the day leaves the dragged row untouched, invents a row on
   another day, and the toast says it worked.** Gap Thu 18:30-19:30, then `Barandilla 13 h`; drag the
   `15:30-18:30` row's edge to 19:30 → ghost `15:30–19:30 · 4 h`, request `resize 240`, and the
   Thursday row is still 3 h while a NEW 1 h row appears on Monday. The toast says «pasa a 4 h aquí».

4. **A resize may grow a row over another job, or over a gap, wherever the reflow cannot separate
   them.** Both rows are padlocked (the margin does that), so both are outside the pool and the
   reflow flows around both: `Barandilla` grown to 20:30 sits on top of a padlocked
   `Porton 19:30-20:30` on TODAY, and a Friday row grown from 12:00 to 13:00 sits on a gap at
   12:00-14:00. `resizeBlock` never looks at other projects' rows and never at gaps; only the drop
   path resolves overlaps.

5. **A drop released in the lunch band stores one solid row straight through the break.** 6 h
   released at Thu 14:00 is stored as ONE `14:00-20:00` row, of which only 15:30-19:30 is inside a
   period, and `/api/week` then reports the day 360/360 booked while 08:00-14:00 is empty.
   `segmentDroppedRow` skips the cut whenever the row STARTS outside every window, which is latitude
   *A Drop Is Stored In Segments* grants on purpose — written for a row that stays inside the hole,
   not one six hours long.
   **ANSWERED 2026-08-17. See § A Minute With No Working Time above**, including why this was not
   really an open question, and the four siblings the boundary sweep turned up beside it.

6. **A drop whose grab offset pushes the unit above the axis lands hours away from the pointer and
   padlocks it on a Monday-Thursday day.** `grabOffsetMinutes` is measured on the CLOCK, so grabbing
   inside the afternoon row of a lunch-split unit includes the 90-minute hole and the unit's head
   tracks 4.5 h above the pointer; the clamp then floors it at the top of the axis, and
   `usesManualOnlyTime` reads the resulting hour of top margin as the owner ASKING for margin time.

7. **On a day that pins, the one-minute rank nudge becomes the stored time.** `Alfa 4 h` by hand on
   Saturday 10:00, `Beta 2 h` dropped 3 px above the 10:00 rule → `Sáb 09:59-11:59 Beta`,
   `11:59-14:00 Alfa` (121 min) and `15:30-17:29 Alfa` (119 min). On Mon-Thu the rank is only an
   ordering and the reflow rewrites it, which is why this stayed hidden.

8. **The scissors never answer for themselves.** A fragment that reflows back inside the row it came
   from is a 200 that changes nothing, and the UI says nothing — the shape that made the owner report
   Friday drops as "the app ignored me".

**Two more, decisions rather than defects:**

- **A hand-set row that has LEFT the pool stops closing its job's day.** `closedDays` is seeded from
  the QUEUE, and a locked, weekend or past row is not a queue item — so padlocking a hand-set row
  re-opens the day the ruler had closed and pulls the same job back onto it. Reproduced:
  `Barandilla 14 h` + `Porton 6 h`, shrink Barandilla's Thu 08:00 row to 2 h, then padlock it → 2 h
  of Barandilla come back to Thursday 17:30-19:30 and the Tuesday row disappears. Hours conserved,
  no overlap, idempotent — so this is not an invariant break, and the mechanical "fix" (seed
  `closedDays` from the stored flag) makes the padlock leave the day EMPTY instead, which is
  decision 1 arriving from a third direction.

- **A sub-quarter row deleted leaves `total_hours` off the quarter hour for ever.**
  `DELETE /api/blocks/:id` does `total -= row.duration` with no floor, so deleting the 1-minute head
  the sliver decision leaves behind makes a 20 h job 19.98333 h. It cannot be fixed without
  answering the sliver: the minutes are real, `SUM(blocks.duration) == total_hours` must hold, and
  refusing the delete would leave the owner unable to remove the very row the app should not have
  created.

**Open Decisions 13 and 14 came out of the integration pass on 2026-08-17**, driving the three
parallel changes (the piecewise axis, the ghost's labels, edge paging) against each other on the
running app. Both are questions about what a gesture MEANS, which is why only the part that violated
an already-written rule was fixed.

**13 — a run longer than the day.** The drag unit is the whole RUN (§ *The Unit of a Drag Is the
RUN*), so its duration is a total across days, and every consumer downstream is handed a number that
is not a length on one day's clock. The label half of this was fixed earlier the same day
(`footprintEnd`, which stopped `420 + 1080 = 1500` being printed as a time and stopped the console
filling with `formatTime` complaints, forty per drag). The integration pass measured what is left:

- **the DRAWN rectangle, which WAS fixed** because CLAUDE.md already forbade the shape: "one
  rectangle straight through the grey band promises a shape that will never exist". `dropFootprint`
  returns a stretch UNCUT when its tail would pass midnight — deliberate, so the server can refuse
  the drop as it was made — and for a multi-day run that is the ORDINARY path. An 18 h run picked up
  on Tuesday drew a single translucent rectangle over the whole 679 px column, the comida band
  included, on every one of the seven days the pointer crossed. `footprintWithinDay` caps the drawing
  at the net minutes the day can still hold, so it is two rectangles with the seam left clear, which
  is what the label beside it already said in words. Storage is untouched — only the rectangle;
- **the OUTCOME, which was not.** Released, the drop is refused: `moveBlock` folds the run into one
  row of 1080 minutes and `assertFitsInDay` compares it to MIDNIGHT, giving 400 `out-of-range`
  {startMinutes: 420, durationMinutes: 1080, endOfDayMinutes: 1440}. The owner reads *«Esa hora no
  cabe en el día»* — a sentence about an hour, for a gesture about a length — while the ghost had
  just said *«este tramo no termina hoy»*, which reads as a promise that it will be placed and carry
  on. **The line is midnight, not the end of the day**, so this is not a clean predicate the preview
  could simply mirror: a 13 h run at 07:00 is ACCEPTED (1200 ≤ 1440) and the reflow just puts it back
  where it started. Answering "should an over-long run be cut across days on drop?" decides the other
  three at once, which is why they are left alone: the collision test, the pin decision and the clamp
  all read the same run total and all three would change meaning.

**14 — a resize ghost's tail on an occupied day.** Measured both ways on 2026-08-17. With Wednesday
afternoon FREE, growing the 6 h Wednesday row to 8 h previewed two rectangles — `08:00-14:00`
(325.5 px) and `15:30-17:30` (108.5 px) — and stored exactly `2026-08-19 480+360` and `930+120`. With
Wednesday afternoon held by another job the same gesture previewed the same shape and stored
`Wed 480+360` + `Thu 480+120`: the hours are right, the estimate went 6 h → 8 h, every invariant
holds, and the rectangle and the `17:30` are wrong. The ghost has no reflow to consult, which is the
whole difficulty — a resize is documented as the one gesture whose range is literal, and that was
true while its tail stayed on its own day.

### Closed, and how

- ~~**A resize that overlaps another job in the frozen past.**~~ **CLOSED 2026-08-14 by removing the
  gesture, not by adding a rule.** *Block Resize* was offered on past rows precisely so yesterday
  could be corrected; the past is now read-only to every block gesture. The other half — the LIFO
  counterparty growing into a past row — went the same way. Both were reproduced before the change
  and neither is reachable now.
- ~~**A drop exactly onto another row's start leaves a ONE-MINUTE row.**~~ **ANSWERED** by the owner
  on 2026-08-13, built 2026-08-14. Re-measured by dragging from both sides of the minute: the two
  rows swap cleanly and no sub-quarter row is created.
- ~~**A drop into a margin evicts a HAND-PLACED row backwards and silently unpins it.**~~ **CLOSED
  2026-08-14 by removing the concept, not by adding a rule.** Reproduced by dragging at both widths:
  `Corto 1 h` hand-placed in Tuesday's bottom margin (`19:30-20:30`), `Alfa 2 h` dropped into the
  same margin and clamped to `18:30`; `Alfa` pinned `Tue 18:30-20:30` and `Corto` — a row the owner
  had put there by hand — came back on **Monday 08:00-09:00** with its mark **cleared**. A row in a
  margin now carries a padlock, and a drop onto another job's padlocked row has always been refused
  naming it. The reproduction is a regression test in `scheduler.test.ts`.
- ~~**The dead zone at the bottom of a reflowing day is an engine limit, not a pointer one.**~~
  **ANSWERED by the owner on 2026-08-14 and built the same day**: *«Pasa al siguiente día»*.
- ~~**Shrinking a job's only or last row still answers 409 `shrink-last-block`**~~ — the owner's
  "resize only works in one direction". **BUILT 2026-08-14**: the engine asks instead.

---

## Release history

Each entry records what was built, what was measured, and what the measuring found. They are left as
they were written.

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
  movable pool and the reflow recovered the row. Fixed by `blocks.hand_placed` — the padlock does
  that job since 2026-08-14, see *The Padlock Is the Only Pin*.
  `PATCH {action:"move", date:<Friday>, startMinutes:600}` now answers 200 with the row at
  **10:00-14:00 and `handPlaced: true`**, and it survives the create-then-delete churn that used to
  undo it. `action:"release"` brought it home to Wednesday **in that calendar** — the row goes back
  under the engine, which then places it wherever its rank allows; see *The Padlock Is the Only Pin*
  on why that is sometimes still Friday.
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
  *(That last sentence was SUPERSEDED on 2026-08-17: a row starting in the break now begins at the
  first minute that can hold work, so it reaches as far as one starting at 15:30. See § A Minute With
  No Working Time — the old reading is what let the drop store a row through the break.)*
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
  **Answered by the owner the next day and closed in v0.7** — see *A Drop Onto Another Row's Start
  Goes BEFORE It*.

**v0.7 — the friction round: the wrong question removed, and the ghost made to agree (2026-08-14).**
Three parallel fronts (engine, pointer, a 72-cell measured matrix) landed on one tree and were
reconciled here. `tsc --noEmit` exit 0, `vitest run` **685 passing across 23 files**, `next lint`
clean, `next build` exit 0. Verified by DRAGGING on the running app at **1646 px and 1100 px**, on a
scratch database, reading the stored rows back over `/api/week` after every gesture.

- **The headline defect is gone.** *«…no lo puedo asignar directamente porque "aún no cabe"»*: a drop
  onto a day the engine reflows is a re-ranking, never a placement, so it is never refused for a
  collision. Measured: Monday and Tuesday both full at the 10 h line, a gap in Tuesday's top margin,
  a 6 h row dragged from Wednesday and released at **Tue 07:30**, straight on top of the gap. It
  lands — `Tue 08:00-14:00, 6 h [HAND]` — and Tuesday's own 10 h job moves whole to Wednesday. The
  room was made BY the move. Identical at both widths.
- **The ghost was reconciled with the server branch for branch**, which is what the round was for. The
  preview asked one question where the server asks two, so it refused Friday drops the server accepts
  and drew Monday margin/lunch drops as harmless re-ranks the server pins. It now asks both
  (`dropPins` / `dayReflowsOn`), applies the server's own SLIDE from a shared implementation
  (src/lib/dropSlide.ts, imported by the engine and by the preview), and draws the rectangle where the
  row will really be, saying who moved it. Control case, same gesture with the row **locked**: the
  ghost states the refusal before release and the server refuses with the same sentence, 409, nothing
  written.
- **Two silent data defects closed.** The one-minute sliver (`0,02 h`) and the pinned-day rank nudge
  (a Saturday drop stored at `09:59`, durations `2,02 h` / `1,98 h`). Both were the same nudge; the tie
  now always resolves *before* the row, and a pinned placement is not nudged at all.
- **The copy stopped claiming things that were not true**: a row consumed from its very start is
  *apartado*, not *partido* (the ghost tells the two apart, `dropDisplaces`), and displaced hours are
  no longer promised to be *justo detrás* when the engine re-places them elsewhere.
- **The sweep, all green.** Friday buffer both ways (a 10 h unit pinned `09:00-14:00` + `15:30-20:30`,
  then *Volver a automático* re-laying it inside the periods); the weekend never auto-recovered (3 h
  parked on a Saturday survived a job growing 10 h → 26 h and spilling into the next week); the frozen
  past never rewritten and never silent; continuation tails filling forward; hand-set durations
  surviving a reflow; hours conserved after every gesture; no row straddling a break, past its day's
  end, before its day's start, or under 15 minutes — asserted over the whole database after each step.
- **Still red, and recorded with candidates**: a drop into a margin evicts a hand-placed row backwards
  and unpins it (**closed the next day** — see v0.9); the dead zone at the bottom of a reflowing day;
  `shrink-last-block` still refuses instead of asking; the action bar over a tall block's name on a
  narrow column.

**v0.9 — three marks collapsed into two (2026-08-14).** `hand_placed` is gone: the column, the type,
the row mappers, the engine predicates, the API fields, the pointing-hand glyph, its locale strings
and its tests. A drop onto a visual margin, a Friday or a weekend now sets **`locked`**. See *The
Padlock Is the Only Pin* for the decision and *Data Model* for the column that is left.

- **Why.** The owner's model, stated twice: *"el bloque normal que ha colocado una persona no es
  inamovible y no debe tener un estado especial"*. A third state whose only visible effect was that
  the row stopped obeying the engine made "padlock = fixed, no padlock = free" false, and it is the
  model they reason with.
- **What it cost, and what it bought.** One predicate where there were two, everywhere: `isMovable`,
  `lastAutomatic`, `pinsTheRow`, the queue the ghost ranks against, the grid's grouping (one list of
  releasable rows instead of two, since *back to automatic* now means one thing). And the margin
  collision **closed itself**: a row in a margin carries a padlock, and a drop onto another job's
  padlocked row has always been refused naming it. Reproduction now a test — `Corto 1 h` in Tuesday's
  bottom margin, `Alfa 2 h` dropped on the same margin → 409 `overlaps-locked-block` naming Corto,
  nothing written. Confirmed over HTTP on a scratch database, and on screen: the margin row draws the
  padlock and the solid outline, and there is no hand glyph left in the app.
- **Two asymmetries deliberately changed, both because the pin is now the owner's mark.** A drop that
  cannot find a clear slot on a reflowing day is **refused naming what is in the way** instead of
  giving up the pin — giving it up would mean taking a padlock off a row behind their back. And a
  padlocked row being dragged is **slid** like any other padlocking drop, since a drop onto the buffer
  IS one now.
- **One asymmetry deliberately removed.** Two rows of the same job merge whatever their padlocks (the
  merged row keeps one), because otherwise stacking more of a job on the Saturday it already sits on
  answered "«Puerta» está bloqueado" about the owner's own row.
- **The shop's file migrates pinned, not free.** `REMOVED_COLUMNS` sets `locked = 1` on every
  `hand_placed = 1` row and then drops the column, in one transaction, idempotent on both paths and
  tested against a database built with the old schema.
- **Verified**: `tsc --noEmit` exit 0, `vitest run` **692 passing across 23 files** — including the
  2000-seed engine harness and the 2000-seed manual-placement harness (both now generating padlocked
  rows), idempotence, the Friday buffer both ways, the weekend, the frozen past and the hours
  invariant — `next lint` clean.

**v0.10 — the past becomes a record, and the walls become answers (2026-08-14).** Five decisions the
earlier rounds had left unbuilt, all on the server side. The theme is the same in each: where the app
used to stop, it now either does the obvious thing or asks.

- **The past is read-only to the block gestures.** Move, resize, split, delete and the padlock are
  refused on a row dated before today (409 `past-block-frozen`), and a drop AIMED at a past day is
  refused too (409 `drop-onto-past-day`). *Back to automatic* survives, because it moves nothing. The
  cost — "correcting yesterday", the case the resize was designed for — was named to the owner and
  accepted. It closes the *resize that overlaps another job in the frozen past* decision by removing
  the gesture rather than by answering it.
- **Deleting a job leaves its past intact.** Future rows go and the calendar recomposes; past rows
  become GAPS carrying `Trabajo «X» eliminado`, composed at deletion time out of the locale files
  (src/lib/text.ts, `?lang=` on the request) because there is nothing left to look the name up in.
  `preservedGapIds` reports them.
- **Shrinking asks instead of refusing.** The freed hours go to the job's last row the engine still
  lays out, skipping the locked ones; the dead end answers 409 `shrink-needs-choice` carrying
  `freedMinutes` and the `choices` that exist, and the owner's answer comes back as
  `freedHours: "reduce-total" | "new-block"`. `shrink-last-block` and `receiver-cannot-hold-hours` are
  gone, along with the code that wrote hours onto a row the engine cannot re-place.
- **A drop onto another row's exact start goes before it, guaranteed by the server.** The tie used to
  be broken by `created_at` and then by a random UUID; the movable rows that tie with a drop are now
  re-ranked behind it. Nothing is cut, so there is no sliver to special-case.
- **A drop aimed below what the day holds moves to the next day the ENGINE would use**, at the top of
  its periods — Mon-Thu and the Friday colchón roll forward; the weekend, a closed day and the past do
  not roll at all, and keep the end-of-day refusal. `dropLanding` (src/lib/dropSlide.ts) is the rule,
  agreed edge for edge with the ghost's `resolveDropDay`.
- **Verified**: `tsc --noEmit` exit 0, `vitest run` **743 passing across 25 files** — the two
  2000-seed harnesses, idempotence and the hours invariant included — `next lint` clean, plus the new
  paths driven over HTTP against a scratch database (the 409 with its choices, both answers, the
  Saturday drop landing on Sunday 08:00 padlocked, and `DELETE …?lang=en`).

---

**v0.11 — three parallel rounds integrated, and the drag unit made whole (2026-08-17).** Three agents
had changed overlapping concerns; this round reconciled them, verified every decided behaviour by
driving the app, and split this file out of CLAUDE.md.

*The integration breaks that were real:*
- **A run spanning days moved only its first day's part.** `unitOf` filtered to the target's own
  date while the drag layer had started sending cross-day runs, so `moveBlock`'s intersection
  discarded the rest. Rewritten as a transcription of the grid's `groupBlocks` + `buildRuns`, in the
  grid's order, so the two answers cannot disagree. Three regression tests in `scheduler.test.ts`
  cover the run crossing a night, another job ending it, and a padlocked row NOT ending it.
- **`resolveDropDay` and `dropLanding` were two implementations of one rule.** The client now
  imports the server's and adds only the clamp and its two ghost flags. The client's `DropDay` was
  renamed `AimedDrop`, because two exported types with one name and opposite meanings — one an
  input to the roll, one its answer — is how the next agent wires the wrong one.
- **`BlockRows` still drew the padlock and the scissors on past rows**, both of which the server had
  just made 409. They are absent now, and the padlock renders as its read-only state icon.
- **`CalendarScreen` still branched on `shrink-last-block`**, a code the server no longer emits, and
  rendered a locale key that had been deleted. Replaced with `ResizeChoiceDialog`, which is built
  from the server's own `choices` list.
- **`deleteProject` was never told the language**, so the preserved gaps would have been named in
  Spanish whatever the owner was reading. `JobPanel` now sends `i18n.language` and raises the
  `notices.deletedJobPast` toast, which nothing had been raising.

*One test was failing and it was not a logic failure.* The 2000-seed shrink property crossed the 5 s
default timeout under worker contention while proving exactly what it was written to prove (1.2 s
when run alone). `testTimeout` is now 30 s in `vitest.config.mts`, with the reason recorded there:
the seed counts are the guard, so the timeout must not be what decides how many run.

*Verified by driving the app* on a scratch database (`WORKWISE_DB_PATH`, port 3911, headless
chromium over CDP; the repo's `data/` untouched). Every case below is a real pointer drag unless
marked HTTP, and the stored rows were read back from `/api/week`:

| what | result |
|---|---|
| 11 h run grabbed by its Thursday tail → Saturday | all 11 h moved: `Sat 08:00-14:00` + `15:30-20:30`, both padlocked. Previously 10 h moved |
| thirds — upper | `Barandilla` went before `Puerta`; Puerta stayed whole, no cut |
| thirds — middle | `Barandilla` cut 2 h/2 h at exactly 10:00, `Puerta` between the halves |
| thirds — lower | resolved to where the row already was; nothing written |
| a rank the reflow undoes | the notice named the padlock route first, then the move |
| aiming below what Monday holds | ghost moved to the Tuesday column at 08:00 mid-drag, saying so |
| hand drop onto Friday | `Fri 10:00-12:00 [locked]`, with the notice naming the padlock |
| the buffer both ways | a 44 h job flowed around the padlocked Friday row; shrinking it back reclaimed the engine's own Friday hours and left the padlocked one |
| drop into the top margin | `Mon 07:00-08:00 [locked]` |
| drop onto that padlocked margin row (Monday, reflows) | SLID forward to 08:00, said so before release, old row untouched |
| drop onto a padlocked Saturday row (does not reflow) | 409 naming the row, its day and its hours; nothing written |
| past row: move / lock / resize / split / delete (HTTP) | all 409 `past-block-frozen` |
| a drop aimed AT a past day (HTTP) | 409 `drop-onto-past-day` |
| past row: release (HTTP) | allowed, as decided |
| past rows in the job panel | no buttons at all; padlock drawn as state |
| delete a job with two past rows | both kept as gaps named `Trabajo «Historico» eliminado`; toast fired |
| shrink with nowhere to put the hours | asked; *Cancelar* wrote nothing, *Dividir* kept the total at 240 min and put 2 h on the next day, *Quitar del total* took 240 → 180 min |
| a 30 h job inserted behind everything | both hand-set lengths survived, one of them while MOVING day; the padlocked margin, Friday and Saturday rows all stayed |
| split below 15 min, and a remainder below it (HTTP) | 409 `split-below-minimum` both ways |
| a row that would run past the end of its day (HTTP) | 409 `row-past-day-end` |
| job created on a Saturday four weeks out (HTTP) | `locked: true`, `autoLock` and `dayLock` both reported |
| dragging a gap | exactly ONE answer, and the gap form did not also open |
| hours invariant across all five jobs | every `SUM(blocks.duration) == projects.total_hours` |

*Still open and unverified by this round:* the Ctrl+Z undo, dragging to the edge to change week, and
*añadir otra parte* were decided in earlier rounds and are **not built**. See CLAUDE.md,
*Open Decisions*. (Dragging to the edge was built on 2026-08-17 — see § *Dragging To The Edge
Changes Week*.)

---

**v0.12 — the break boundary, the band and the paging, integrated (2026-08-17).** Two parallel rounds:
one made the lunch break a redirect rather than a slot (§ *A Minute With No Working Time*), the other
made the band discreet, re-paced the edge hold, closed the lost drop and added the week-change
animation (§ *The Repeat Is a Metronome*, § *A Week Change Says Which Way It Went*). This round
reconciled them, drove all four in a browser and found one defect neither had.

*The defect the integration found:* **the week-change animation moved the whole calendar.** The
arriving week's `translateX(26px)` reaches past the grid's right edge, which is scrollable overflow, and
the scrollbar cascade that followed narrowed the grid by 15 px for the length of every page turn — and
jumped the drag GHOST 14 px sideways under a perfectly still hand. Two candidate fixes were wrong for
recorded reasons before the third was right; all of it is in § *A Week Change Says Which Way It Went*.

*Reconciliation:* the two fronts turned out to agree on the break already — the break front had fixed
the ghost's own re-derivation of the start in `dropAim.ts` — so this round's work there was to PROVE it
and to clear the comments the change had left stale in `geometry.ts`, `dropEffect.ts`,
`useBlockDrag.ts` and `manualWindow.ts`, each of which still described the band as manual-only time
that padlocks a Monday drop.

*Verified by driving the app* on an isolated copy of the source (`diff -r` clean) with its own scratch
database (`WORKWISE_DB_PATH`, port 3479, chromium over CDP; the repo's `data/` untouched):

| what | result |
|---|---|
| a 2 h run released 4 px INTO the band, Saturday | ghost drew one rectangle at `relTop 415.328 h 110.656` labelled `15:30–17:30 · 2 h`; stored `Sat 15:30 +120 [locked]` |
| the same on Wednesday (auto) | ghost at 15:30, no clock range, «Entra detrás de…»; stored unlocked and settled by the reflow — the documented behaviour change |
| the same with the row already padlocked | landed on the exact minute, `Wed 15:30 +120 [locked]` |
| every minute 13:45–15:45, Saturday, over HTTP | 13:45–13:59 cut correctly at 14:00; **every minute 14:00–15:30 stored one legal row at 15:30**; no straddle anywhere |
| 6 h released at 14:00 on Saturday | 409 `row-past-day-end`, nothing written (no room after the break, and a weekend does not roll) |
| a row a settings change stranded at 15:30 | left where it sat through an unrelated save; the next resize laid it out from 16:30 |
| the band's weight | 28 px, `--ww-margin-fill` solid, edges `1px rgb(211,209,199)` — byte-identical to what `.lineBoundary` draws every other period edge with |
| the band at a 10-minute break | 8 px, `14:00` kept, `14:10` dropped, no labels overlapping |
| holding at each edge for 6 s | first turn 503/497 ms, then 809–897 ms (mean ~875); 8 weeks in 6.6 s both ways — 1.2 weeks a second |
| holding to a later week, then releasing on that week's Saturday | ghost `10:00–12:00` on `2026-09-05`; stored `2026-09-05 10:00 +120 [locked]`, screen stayed on week 36 |
| the same released on that week's Wednesday | a queue rank: pulled back to `Thu 20 Aug`, and the `pulledBack` notice named the date and the padlock route |
| the animation, both ways, frame-sampled | `weekFromNext` +26 → 0 and `weekFromPrevious` −26 → 0, opacity 0.2 → 1; `headBox: none`, `headWord` and `columnBody` travelling, `axis`/`band`/`tick`: none; `Hoy` on the same week: nothing moves |
| the ghost through three mid-drag page turns | ONE distinct `left` across 145 frames, `transform: none`, `animationName: none` |
| a travelling settle | `translate(249.672px, -360px) → 0`, 248 px of it outside the destination column and drawn |
| `minutesAt(yOf(m)) === m` and every drawn block vs its stored minutes | at 692 px and 532 px of axis (55.33 and 42.00 px/hour): every hour rule within **0.011 px**, every block within **0.011 px**, band exactly 28 px at both |
| a release on the pixel meaning a given minute | **34/34 at each of two viewport heights**, every quarter hour of both windows, margins included |
| 770 drops over HTTP: 7 days × every quarter hour 07:00–20:30 × two durations | 0 straddling rows, 0 sub-quarter rows, 0 hours-invariant breaks, 0 refusals without a `messageKey` |
| 36 resizes over HTTP across the break | same, and the only refusals were `shrink-needs-choice` and `row-past-day-end` |
| the Friday buffer both ways | a new job's tail skipped it to next Monday; GROWTH landed on it unlocked; freeing Mon-Thu reclaimed it; a HAND drop on it padlocked and survived later recompositions |
| the weekend never auto-recovered | a Sunday row stayed on Sunday with the padlock taken OFF, through an unrelated 6 h job's placement |
| the frozen past | move / resize / lock / delete / split all 409 `past-block-frozen`; a drop ONTO a past day 409 `drop-onto-past-day`; *back to automatic* still 200 |
| a 26 h job | split across Mon-Thu only, starting at the top of the first day it can use |
| the scissors' floor | 5 min refused, a split leaving 5 min refused, half-and-half accepted |
| no gesture ending in silence | a dragged gap said so exactly once and did NOT open the form; a refused drop raised the `role=alert` banner; a rank the reflow undid raised the `unchanged` notice teaching padlock-then-move |

*Still open, and deliberately:* Open Decisions 1-4 and 6-14 in CLAUDE.md. Two of them were touched
by this round's measurements and left exactly as they were — 13 (an over-long RUN cannot be dragged:
a 14 h run aimed at 09:00 is clamped to 07:00 and refused with a sentence about a clock time) and the
`out-of-range` refusals in the 770-drop sweep, which are the same thing.

---
