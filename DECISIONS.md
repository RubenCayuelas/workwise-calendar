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
*A Continuation Fills Forward* in the other. The exceptions are sections named for a **defect that is
not fixed** — *The One-Minute Rank Nudge Crosses the Break* — which have no rule to match because
nobody has decided yet what the rule should be; each one is cross-referenced from the CLAUDE.md rule
it breaks.

> **A note on the two marks that no longer exist.** A row carries ONE mark today, the padlock. Two
> others existed and both were removed by the same argument — *the padlock already says this* — so
> anything written before those dates has to be read through them. The records are left as they were
> written, because what they measured happened.
>
> | mark | its sentence | removed | read it as |
> |---|---|---|---|
> | `hand_placed` / `handPlaced` / *the hand mark* | "a human chose this DAY" | 2026-08-14, § *The Padlock Is the Only Pin* | `locked` |
> | `manual_duration` / `manualDuration` / *the ruler mark* | "a human chose this LENGTH" | 2026-08-18, § *The Padlock Holds the Length* | `locked` |
>
> Read *back to automatic* as **pressing the padlock**, whether the sentence is about a POSITION or a
> LENGTH — the action itself (`PATCH {action:"release"}`) is deleted and now answers 400
> `invalid-action`. A record that says a gesture was *offered on every row*, or that a length *stuck
> without a padlock*, is describing code that is gone; § *The Padlock Holds the Length* says what
> replaced it.

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

### And the RENDER path fails soft, alone

`minutesToHHmm` throws on a value outside the day, which is right for the engine and for every write.
On the RENDER path that throw took the whole week view down — `Invalid minutes "1500"`, out of
`useFormat().time` — and left the owner an "Application error" with no way back to the calendar: **the
row it could not draw was the very row they needed to reach in order to fix it.** So `formatTime`
(src/lib/format.ts) returns the `--:--` placeholder and complains to the console instead.

**The complaint names BOTH suspects, because the function cannot tell them apart:**

- **a row stored out of range.** `assertRowInsideDay` makes that unstorable now, but a database
  written BEFORE the guard existed still holds one, and a shop PC's `data/calendar.db` is not
  something a fix can retroactively repair;
- **a value that was never a time of day.** `duration` is NET WORKING MINUTES, so `start + duration`
  is a clock reading only while those minutes fit inside the day from that start — the drag ghost
  added a whole RUN's 18 h to a 07:00 start and formatted 1500, once per pointer move (see Open
  Decision 13, `420 + 1080 = 1500`). The earlier wording said only "a stored row is out of range",
  which sent that investigation to the database while the database was clean the whole time.

**Leaving it throwing was the rejected alternative**, and failing soft does not hide a real bug:
`minutesToHHmm` is untouched, so the engine, the repositories, the API and every test still throw on
such a value — the loud path stays loud where it can act; the placeholder is VISIBLE on screen, which
is louder than a clamp that would have quietly drawn 25:00 as 01:00; and the console carries the
offending value with both suspects.

---

## The Padlock Is the Only Pin

**Decided with the owner, 2026-08-14.** This is the round that removed the third mark.

`hand_placed` — "a human chose this DAY", with a pointing-hand glyph of its own — was introduced on
2026-08-12 to fix the Friday black hole, and it did: `PATCH /api/blocks/:id {action:"move",
date:<a Friday>}` answered **200 and changed nothing**, because Friday is in the movable pool so the
buffer can self-clean, so the reflow pulled the hand-dropped row straight back to Monday and nothing
on the row distinguished "the engine parked overflow here" from "the owner said Friday".

**The differential is what identified the cause** (recovered from the test banners on 2026-08-18):
`startMinutes:600`, and the SAME move to a Saturday worked, and to a past Monday worked. **Only Friday
failed, and silently** — the worst mode. That pattern points at the movable pool rather than at the
move path, which is what made the pool the thing to change.

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

> **SUPERSEDED 2026-08-17 by *Fill and Overflow, Always*.** The rule this was carved out of is gone,
> so the carve-out is gone with it and the `QueueItem.continuation` FLAG was deleted. Everything below
> still happened and the defect it fixed is still fixed — by the general rule now, not by an exemption.
>
> **WHAT STILL HOLDS, because this note was misread as saying otherwise.** A `QueueItem` is still a
> run of consecutive movable blocks of one job, and the engine still places it as a **single
> indivisible piece**: the whole run moves together, exactly as the owner asked for
> (*«muevo todo hasta la tarea que los separe»*). What changed is only what happens when it does not
> fit in a day — it now fills what is left and carries the rest to the next day, instead of jumping
> whole. The flag that was deleted existed *only* to exempt a displaced tail from a rule that no
> longer exists; deleting it removed an exception, not the unit.
>
> The owner read the first paragraph alone and reasonably concluded the run had stopped moving
> together. A superseded note has to say both halves — what falls and what stands — or the next reader
> draws the same conclusion.

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

## Fill and Overflow, Always

**Decided by the owner, 2026-08-17.** Their report:

> *«Si quiero colocar la tarea test3 en el hueco del lunes no se divide sino que dice que no cabe. Si
> no cabe se desborda al siguiente día, así es como dijimos que funcionaba.»*

**Reproduced on a copy of their calendar.** `test 3` is 6 h; Monday holds 4 h of free afternoon
behind a padlocked morning. Dropping it there answered **HTTP 200 «ok» and changed nothing** — the
row stayed on Tuesday — while the ghost had already said *«6 h no pueden empezar después de las …»*
before the release. Three separate things were wrong at once, and only the third is a defect in the
ordinary sense:

| what happened | why |
|---|---|
| the drop was ROLLED onto the next day the engine would use | its 6 h footprint reaches 21:30 and the day ends at 20:30, so *Aiming Below What A Day Holds* moved it — to a day it was already on |
| the engine would not have split it anyway | *Never split a job to make it fit*: no day from the cursor could hold 6 h whole, so the item was laid back down where it was |
| the response could not say so | `BlockMutation` carried no "nothing was written", and the geometry is identical either way |

**The owner's answer removed the rule.** Work fills what is left of the day and the remainder
overflows to the next day it can use — always, and whoever placed it. They accepted the consequence
in as many words: **a job may end up in four or five pieces.**

**What it supersedes, and both of these were the owner's own earlier decisions:**

- *A Continuation Fills Forward* (2026-08-12). It exempted a displaced tail from the rule; with no
  rule there is nothing to exempt, so `QueueItem.continuation` was deleted rather than left as a flag
  with no reader. `findWholeFit`, `takeExactly` and `ItemTarget` went with it.
- *No Backfilling*'s worked example (the hole in front of a locked block stays empty and the owner
  decides by hand). Work fills up to the lock and continues after it. **The rule itself survives
  intact** — the cursor is forward-only, so nothing is ever pulled BACK into an earlier hole; what
  changed is that far fewer holes are left.

### The sharp edge: a remainder smaller than the minimum row

Once a day may take PART of an item, the arithmetic can leave any number of minutes over, and the
answer had to be decided rather than discovered. **Filling a ten-minute hole may not produce a
ten-minute row** — `MIN_LABEL_HEIGHT` makes that a nameless two-pixel stripe. The rule is in
CLAUDE.md's own table; what belongs here is why each answer is that answer:

- **A stretch too short for a row is stepped over like an obstacle.** This is the answer the deleted
  "does the whole item fit here" question used to give for free; the new engine has to make it
  explicitly, and it is the only one that keeps the invariant.
- **A remainder of one quarter but not two goes on WHOLE.** Splitting a legal 15-minute row into 10
  and 5 to fill a hole is strictly worse than waiting for somewhere it fits.
- **And the floor is never a refusal.** `compose` walks the horizon once with the floor on and, only
  if the hours still have nowhere at all to go, once more with it off. An item the cursor keeps
  stepping over ends in `horizon-exceeded`, which rolls the WHOLE save back — a short row beats that,
  and that trade was already the decision in *The Calendar Sits On The Quarter Hour*.

**Two defects the property harness found, and neither was reachable before this change.** The
2000-seed generator now produces off-grid quantities on a quarter of its calendars, because that is
where the floor is actually at risk (a real calendar gets there through the one sub-quarter row a
drop may leave behind being deleted, which takes those minutes off `total_hours`):

- **seed 275** — a free stretch spanning the comida is ONE stretch to the arithmetic and TWO rows on
  the clock, so the floor was applied to the pair. An obstacle ending at 13:50 stored
  `13:50-14:00` — ten minutes — plus the rest of the afternoon. Fixed by cutting the free stretches
  at every real break (`splitAtBreaks`), so a stretch and a stored row are the same shape.
- **seed 57** — a 15-minute remainder was cut into 10 and 5 by a ten-minute hole, which is what sent
  the "one quarter but not two" answer above the "draw it" answer.

### The drop side: a rank has no footprint

The roll and the clamp both exist so that the row a drop STORES ends inside its day. On Monday to
Thursday, inside the periods, with the row unlocked, a drop stores no geometry at all: it writes a
queue RANK and the reflow decides the clock. So neither has anything to do there, and both were
doing harm — the roll moved the row to another DATE, and the clamp pulled the ghost up to a minute
the owner had not aimed at and then sent that minute.

**One question decides it, in one place**: `dropLandsLiterally` (`src/lib/dropSlide.ts`), which is
now what the write path's `pinsTheRow`, the ghost's `dropPins` and `dropLanding`'s own roll all read.
Those first two were documented as "one rule, two mirrors" and the rule had quietly grown a third
reader.

**And the padlock question narrowed with it.** A drop asks for manual-only time by STARTING in it,
not by reaching into it: the minutes past the end of the periods are hours the reflow carries to the
next day. Read over the whole footprint, the owner's own 6 h release at Monday 15:30 scored 120
manual-only minutes and came back PADLOCKED — a mark they had not pressed for, on a row they had
aimed at a four-hour hole. A **resize** is unchanged and still reads its whole footprint, because a
length really is stored where it reaches.

### The silent no-op

`BlockMutation` gained two fields, and the shape of both is a lesson from the first attempt at each:

- **`changed`** — asked of the ROWS the owner can see, not of the row ids. Measured on the ids it
  answers `true` for a drop that produced the very calendar it started from, because moving a run
  folds it into one row and lets the reflow lay it out again: verified over HTTP, the repeat of the
  owner's own drop reported ids deleted and inserted while nothing on screen moved.
- **`placedBlockIds`** — the whole run the hours ended up as, in calendar order, because `block` is
  only the first of them and splitting is ordinary now. A client reading `block` alone would tell the
  owner about 4 h and say nothing about the other 2 h.

**Verified 2026-08-17.** The full suite (872 tests, 28 files), the 2000-seed harness with the new
off-grid dimension and the sliver invariant added to it, and idempotence — `expectSettled` on every
rewritten scenario plus the harness. Then on a scratch database, the owner's own calendar rebuilt
and their gesture made **by dragging in a real browser**: `test 3` came back as `Lun 15:30-19:30 4 h`
plus `Mar 08:00-10:00 2 h`, unpadlocked, on the day they aimed at, with the mid-drag hint reading
*«Entra en la cola por aquí»* instead of the clamp's sentence. The repeat answered `changed: false`,
and two unrelated saves left the split untouched.

**One Open Decision fell out with the rule** — see *Reproductions behind the Open Decisions* № 1.

### Re-verified independently, 2026-08-18

Both halves — the engine and the drag — driven again from a scratch database on its own port, on a
calendar shaped like the owner's: a padlocked day the cursor cannot use, a Wednesday whose morning is
padlocked so it holds **4 h of free afternoon**, and `test 3` at 6 h.

| the case | stored |
|---|---|
| the owner's gesture, **dragged in a real browser** from Saturday into Wednesday's 4 h afternoon | `Mié 15:30-19:30 4 h` + `Jue 08:00-10:00 2 h`, neither padlocked |
| the same 6 h job created with the hole already there — the engine on its own | the same two rows |
| **the hole in FRONT of a padlocked row** (`candado` padlocked 10:00-14:00, 2 h free before it) | `Mié 08:00-10:00 2 h` + `Mié 15:30-19:30 4 h` — filled up to the lock, continues after it, whole job on one day in two pieces |
| a **ten**-minute hole in front of an obstacle | stepped over, still free; the hours go `Mié 15:30-19:30` + `Jue 08:00-10:00` |
| a **fifteen**-minute hole | taken whole: `Mié 08:00-08:15 0,25 h` + `15:30-19:30` + `Jue 08:00-09:45` |
| an **18 h run dragged** onto Monday-Thursday | 200, laid out across days, `placedBlockIds` 3 long. The same run onto a **Saturday** is still 400 `out-of-range` (Open Decision 13's remainder) |
| the **Friday buffer** | a new 6 h job with Friday empty skips it for the next Monday; a job grown 30 h → 46 h fills Friday 10 h and carries 6 h to Monday |
| the **weekend** | 46 h created puts nothing on Sat/Sun. A 6 h hand drop at Sat 12:00 stores `12:00-14:00` + `15:30-19:30`, padlocked; a second drop over it is 409 `overlaps-locked-block` and writes nothing |
| the **frozen past** | 46 h created writes nothing before today; a drop onto yesterday is 409 `drop-onto-past-day`; a past row is 409 `past-block-frozen` to drag and to delete |

**The ghost said it before the release, across columns**: measured mid-drag with the button still
down, «Se coloca así: 4 h el Mié 19 · 2 h el Jue 20» over a 4 h rectangle on Wednesday
(`15:30–19:30`, not into the bottom margin) and «…sigue aquí · 2 h» over a 2 h rectangle on
Thursday. The notice after the release: ««test 3» llena lo que quedaba del día y sigue en el
siguiente: 4 h el Mié 19 · 2 h el Jue 20. Si lo quieres entero en un día, hazle sitio o ponle el
candado.» A 7 h run dropped in front of a padlock previewed «6 h el Mié 19 · 1 h el Jue 20» over
three rectangles — two of them on Wednesday, one day's share — and stored exactly that.

`tsc --noEmit` clean, `vitest run` **899 passing across 29 files**, `next lint` clean, `next build`
clean with no dev server up. Idempotence over HTTP as well as in the suite: a rename, a recolour and
a gap added-then-removed each left the split calendar byte-identical.

**And the re-verification found one defect** — § *The One-Minute Rank Nudge Crosses the Break* below.

---

## The One-Minute Rank Nudge Crosses the Break

**Found 2026-08-18, re-verifying *Fill and Overflow, Always*. NOT FIXED, and not a question about
what a gesture means — a stated invariant is broken, so it is recorded here and beside the rule it
breaks (CLAUDE.md § *The Calendar Sits On The Quarter Hour*) rather than in *Open Decisions*.**

The gesture is ordinary: aim a run at the upper third of a row that starts at 08:00. *A Drop Onto
Another Row's Start Goes BEFORE It* makes that a rank one minute earlier, so the request carries
`startMinutes: 479` — 07:59, one minute inside the top visual margin. That much is deliberate and
right: `MIN_MANUAL_ONLY_MINUTES` exists exactly so one minute of margin is read as a tie-break and
not as a request, and the drop correctly comes back **unpadlocked**.

What is not right is what happens next. `resolveDrop` step 2 cuts the provisional row at the lunch
break **from the minute the rank names** (`segmentDroppedRow`), and it does so for a rank drop as
well as a literal one. From 07:59 a 7 h run reaches 14:59, so it is stored as `07:59 +361` and
`15:30 +59` — and the next job's row ranks between those two, so `buildQueue`, which joins only
CONSECUTIVE rows of one job, cannot put them back together. One run reaches the engine as **two
items of 361 and 59 minutes**, quantities no gesture asked for, and `takeableFrom` then leaves a
quarter behind the 361 and cuts it into 346 + 15.

Reproduced over HTTP with no browser in the loop, on a Wednesday whose only obstacle is a padlocked
Tuesday, `detras` 7 h behind `test 3` 6 h:

| the rank sent | what was stored |
|---|---|
| `480` — 08:00 | `Mié 08:00-14:00 6 h`, `Mié 15:30-16:30 1 h`, then `test 3`. Clean, strict order, everything on the quarter |
| `479` — 07:59 | `Mié 08:00-13:46 5,77 h`, `Mié 15:30-15:45 0,25 h`, then `test 3` twice, then **`Jue 10:15-11:14 0,98 h` of `detras` again** |

The same rank with a **6 h 15 m** run stores `Jue 10:15-10:29` — a **14-minute row**, which
CLAUDE.md says in as many words the engine never stores. The band is narrow and real: 476-479 all
misbehave; at 465 (a full quarter of margin) the drop becomes a literal placement and is refused
409 `overlaps-locked-block`, which is correct.

**Whose defect it is.** The nudge and the segmentation are both older than *Fill and Overflow,
Always* and neither was touched by it — `resolveDrop` step 2 is unchanged in the diff. The engine is
innocent too: handed a 361-minute item it applies the quarter-hour floor correctly, and the 2000-seed
harness's sliver rule (a short row is allowed only where a queue ITEM was itself under two quarters)
is satisfied, because the write path had already made the item 14 minutes long. What the rule change
did was remove the thing that used to hide it: an item that did not fit moved WHOLE, so an off-grid
quantity never reached the layout. Now it does, in three visible ways — off-quarter clock times, the
job's hours interleaved with the next job's, and **the ghost contradicted** (measured: the preview
said «6 h el Mié 19 · 1 h el Jue 20», the save stored 5,77 h and 1,23 h).

Hours are still conserved, nothing straddles a break, and recomposing twice changes nothing.

**Two candidate fixes, and this is the owner's call because it decides what a nudged minute MEANS:**

- **clamp the rank** to the first minute of the working periods when the manual-only time it asks for
  is under `MIN_MANUAL_ONLY_MINUTES`. This is the reading *A Minute With No Working Time* already
  gives the lunch band, applied to the sub-quarter margin, and it makes the nudge a pure ordering
  device — which is all `rankFor` ever meant it to be;
- **do not segment a rank drop at all.** A literal drop is segmented because its geometry is the
  promise; a rank's geometry is the reflow's business and gets re-derived anyway, so cutting it first
  can only invent quantities.

Same cause as Open Decisions 6 and 7 (both about the nudge), so all three want one answer.

---

## The Ghost of a Rank Is the Division

**Built 2026-08-17, the drag side of *Fill and Overflow, Always*.** The engine change left the
preview arguing with the engine in three separate ways, all of them the deleted rule still talking:

| what the drag said | what the engine did |
|---|---|
| «6 h no pueden empezar después de las 13:00» (`grid.dropNoLower`) | accepted the release and split the job |
| «6 h no caben en un solo día» (`grid.dropLongerThanDay`) | filled the day and carried the rest on |
| one rectangle at the pointer, capped at the day's manual window | two rows, on two days, neither of them where the rectangle was |

The owner chose a live preview precisely so the outcome is visible before the mouse comes up, so a
preview that cannot describe the new behaviour is not a cosmetic debt — it is the feature failing at
the one moment it exists for.

### Drawing it needed the reflow's arithmetic, not the reflow

The honest objection to drawing the split was that only `compose` knows where an item lands, because
it lays out the WHOLE queue. That is true of the POSITION and not of the DIVISION, and separating the
two is what made this buildable:

- **`planDropSpill`** answers the narrow question — *given where the work in front of this drop ends,
  how far down the day do these hours reach, and where does the rest go* — by walking the release day
  and the days after it the way `compose` does. It lives in `src/lib/dropSpill.ts` next to
  `segmentDroppedRow` and `firstClearStart`, for the same stated reason: two callers need the
  identical answer and neither may guess it. **`takeableFrom` MOVED there out of the engine**, so the
  quarter-hour floor has one implementation; a preview that re-derived it would have drawn the
  ten-minute rows the floor exists to prevent.
- **The POSITION is still not promised.** The ghost stays hollow, the clock range stays unprinted, and
  the label still says «Entra detrás de «Muro»». Where the reflow disagrees with the drawing it is
  because it found room EARLIER (the drop is a rank) — never because it stored a shape the ghost did
  not draw.

### The three answers that had to be decided

- **The hours begin where the work in FRONT of them ends** (`fillStartFor`), not at the released
  minute. This is the one that makes the label's numbers right rather than nearly right: 6 h released
  at 16:00 into an afternoon free from 15:30 is stored from 15:30, and drawn from 16:00 it would have
  printed «3,5 h el lunes · 2,5 h el martes» — two numbers the save contradicts. Measured against
  EVERYTHING on the day, gaps and ordinary rows alike, because strict queue order keeps all of it in
  front; an aim INSIDE a row is left alone, because there the row is cut and the hours really do start
  on that minute. The consequence is deliberate: over free time the ghost snaps to the top of the free
  run rather than following the pointer, which is what an insertion point means.
- **The ROOM is what nothing will move out of the way** — the gaps and the padlocked rows only. Every
  other row is ranked behind the drop and the reflow lays it out after these hours, so counting it
  would understate the room. Verified on the case that distinguishes them: a fragment aimed INSIDE
  another job's row previewed `1,25 h el Mié 19 · 3,75 h el Jue 20` and stored exactly that, because
  the server cuts the row it lands in and only the head stays in front.
- **The day's stop-line is `plannableMinutes` less what the work ahead has spent of it.** On the
  documented shift the capacity IS the whole shift, so this only bites where the owner has
  deliberately set auto-fill below their day — and there it is the difference between drawing 6 h and
  drawing 10 h.

### What was deleted rather than reworded

- `grid.dropLongerThanDay` and `grid.dropNoLower` are now asked of a drop that lands LITERALLY only.
  Both are still true there — on a Saturday a 6 h row really cannot start after 13:00 — and both are
  drawn as before.
- **The one-minute rank nudge stopped being clamped over the day.** `rankFor`'s clamp is only ever
  consulted for a drop that is a RANK, and it was `clampDropStart`: a 6 h run released on an afternoon
  row's start at Monday 15:30 was nudged to 15:29, found not to fit the day, and re-ranked at **13:00**
  — inside the morning, cutting a row nobody had aimed at. It is now the axis clamp and nothing more.
- **The scissors' second click lost the same clamp**, and gained the same plan (`placingGhost`). Left
  with the clamp it pulled a 5 h fragment aimed at 18:15 back to 15:30; taken away without the plan it
  drew a rectangle running into the bottom margin, which auto-fill never enters. Neither is a shape the
  server would store, which is why the two changes had to travel together.

### The notice, and why `changed` had to be the source

`describeDrop` gained one branch and lost its geometry:

- **`filled`** — the hours ended up on more than one DAY, so the notice names them:
  «llena lo que quedaba del día y sigue en el siguiente: 4 h el Mié 19 · 2 h el Jue 20». Grouped by
  day, not by row, or a stretch cut at the comida would be reported as an overflow. It reads
  `placedBlockIds` and shares `spillByDay` and `format.hoursOnDay` with the ghost, so the drag and the
  toast say the same words about the same gesture.
- **`unchanged` is decided from `changed`** and is asked before every other branch. It used to be
  `landed === from && to !== from`, which is exactly the comparison that cannot see the owner's
  defect: the reflow answering a drop with the calendar they already had is identical, rectangle for
  rectangle, to a drop that worked.

### Verified by dragging in a real browser

On a scratch database at two window widths (1646 and 1100), with the ghost read mid-drag over CDP and
the stored rows read back over HTTP afterwards:

| the gesture | the ghost said | the server stored |
|---|---|---|
| 6 h released at Wed 16:00, morning taken, afternoon free | `Mié 15:30-19:30` + `Jue 08:00-10:00`, «Se coloca así: 4 h el Mié 19 · 2 h el Jue 20» | exactly that, unpadlocked; `filled` notice with the same words |
| the same in front of a padlocked 17:00-18:00 row | three rectangles: `15:30-17:00`, `18:00-19:30`, `Jue 08:00-11:00`, «3 h el Mié 19 · 3 h el Jue 20» | exactly that — the hole in front of the lock filled and the work continued after it |
| an 18 h run dropped in front of a full Tuesday | four rectangles over two columns, «10 h el Mar 18 · 8 h el Mié 19» | exactly that, 200 and no `out-of-range` |
| 6 h released into a TEN-MINUTE hole in front of a lock | nothing on Wednesday, the whole gesture on Thursday, «6 h el Jue 20» | nothing on Wednesday; the row stayed where it was and the `unchanged` notice said so |
| a 5 h scissors fragment clicked at Wed 18:15, inside another job's row | `18:15-19:30` + `Jue 08:00-11:45`, «1,25 h el Mié 19 · 3,75 h el Jue 20» | exactly that; the row it landed in was cut at 18:15 |
| 6 h dropped low on Saturday | solid ghost `13:00–20:30`, «Más abajo no cabe: 6 h no pueden empezar después de las 13:00», pin hint | `Sáb 13:00 +60 [L]` + `15:30 +300 [L]`; `pinned` notice |
| 6 h dropped in Wednesday's TOP MARGIN | solid ghost `07:00–13:00`, pin hint | `Mié 07:00 +360 [L]`; `pinned` notice, and Muro reflowed around it |
| a 10 h run dropped on Thursday, whose afternoon a padlock holds | `Jue 08:00-14:00`, «6 h el Jue 20 · 4 h más adelante» — the buffer is skipped, so the remainder leaves the week | the rank was already what it is, so nothing moved: the `unchanged` notice said so |
| a drop that does not CHANGE the rank (nothing in front of it, or the same predecessor it already had) | the division measured from the release day | the reflow puts the item back where its cursor reaches, which may be an earlier day — **the standing limit of a rank's preview**: `planDropSpill` answers where the hours REACH, and only a whole pass can answer where the item STARTS. The `unchanged` and `settled` notices are what close it, and they now always fire |

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
  **DEAD SINCE 2026-08-18**: `manualDuration` and the whole `release` action are deleted, so this call
  no longer exists to allow or refuse — `PATCH {action:"release"}` answers 400 `invalid-action`. What
  the judgement call was protecting against is gone with it: there is no second mark left to strand,
  and a padlock a past row carries is drawn as a read-only state icon. Re-measured: `resize` and `lock`
  on a past row both answer 409 `past-block-frozen`, and the past row is drawn with **no bottom-edge
  strip and no action bar at all**.

**The cost, named and accepted by the owner**: this removes *correcting yesterday*, which was the
motivating case for *Block Resize* when it was designed. If it comes back, the *Bloqueo con llave*
option — an explicit "edit the past" mode in the menu — was the shape discussed.

**Two agents disagreed about the UI, and the server won (2026-08-17).** One round left the padlock
on past rows in the job panel "so no row can be stranded"; the next made it 409. The server's
reasoning is the one that holds — a padlock on a past row changes nothing the engine reads, so a
control that is only ever answered with a refusal is worse than no control — and nothing is
stranded, because the row still SHOWS its state. *(Written when there were two marks and the ruler
carried its own undo. Since 2026-08-18 there is one mark and no undo to strand, which makes the
conclusion stronger, not weaker.)* Verified by opening the panel on a past job: no buttons at all on
those rows, and on the grid a past row has no bottom-edge strip either.

---

## Block Resize, and Shrinking That Asks

> **NARROWED 2026-08-18 by § The Padlock Holds the Length below, and only in ONE place: the gesture is
> now offered only on a row the engine does not lay out (409 `resize-needs-padlock` elsewhere).**
> **What still stands, all of it:** resize as a TRANSFER inside the job with the job's last block as
> counterparty; the freed hours never going to a row outside the movable pool; `isLast` as a dead-end
> trigger; the three-way question and `choices` travelling in the refusal; and the drag being measured
> in NET WORKING MINUTES across the lunch break. The dead end and its dialog are untouched.

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

**Verified end to end by dragging (2026-08-17; re-measured over HTTP 2026-08-18).** A 4 h single-row job
shrunk to 2 h asked; *Cancelar* wrote nothing (job still 240 min, row still 4 h); *Dividir* left the row
at 2 h and put the freed 2 h on the next day, total unchanged at 240 min; *Quitar las horas del total* on
the job's last row took it from 240 to 180 min with the rows summing to 180. *(The 2026-08-17 run recorded
a ruler mark on the shrunk row. That mark is deleted — the row is held by its padlock now, which is what
the gesture requires before it will run at all. Re-measured on a Saturday-only 3 h job: shrink to 2 h →
409 `shrink-needs-choice`, `freedMinutes: 60`, `choices: [reduce-total, new-block]`; `reduce-total` → the
job is 2 h; growing the same row to 4 h → the job is 4 h.)*

---

## The Padlock Holds the Length

**Decided with the owner, 2026-08-18. This deletes *A Hand-Set Duration*, below.**

The owner asked what the hand-set duration was for, and answered it themselves:

> *"la duración de un bloque nunca es fija. Es fija cuando se aplica entre bloques de otras tareas
> porque eso es lo que dura… si lo reduce de miércoles crece en jueves y sitio se libera en miércoles
> y pasa allí quedando exactamente igual. Si el usuario quisiera hacer eso, significa que quiere
> acabar la jornada antes… tendrá que añadir un gap."*

**Why they are right, and why the column had to go rather than be renamed.** *Fill and Overflow,
Always* made it plainly true that **a block is exactly as big as the room it has**. On a row the engine
lays out there is no length to set: shrinking Wednesday grows Thursday, frees exactly those minutes on
Wednesday, and the job flows straight back into them. `manual_duration` was a stored exception to the
model, and an exception to a model does not stay one thing — it grew rules to hold it up:

| what existed only for the mark | where it was |
|---|---|
| a hand-set length ENDS the job's run | `buildQueue`, `unitOf`, the grid's `buildRuns` |
| "no more of that job lands on that day" | `closedDays` + `dayKey` + `acceptsItem`'s third argument |
| the remainder is DEFERRED while the jobs behind fill that day | `compose`'s `deferred` / `deferralDate` / `remainderOf` / `drain` / `startsOn` / `lastItemOfProject` |
| auto-merge may not fold a hand-set row | `mergeTouchingRows`'s two guards |
| the stretch absorbs rows already hand-set | `stretchFrom` |
| the mark is LOST when anything else rewrites the length | `setDuration` vs `pinDuration`, and a rule per gesture |
| *back to automatic* | `releaseBlock` ×2, `PATCH {action:"release"}`, `releaseBlockDuration`, `manualBlockIds`, a glyph, two buttons, `notices.released` |
| a resize into a margin PADLOCKS the row | `usesManualOnlyTime` (its only reader) |

114 references across 20 files, 47 of them in the engine — and **one open question nobody could
answer** (should padlocking a hand-set row re-open the day its ruler had closed?), which is the shape
of a rule that does not belong.

**What replaced it: nothing.** The padlock already does the whole job. The engine does not lay a locked
row out, does not merge one and does not re-derive its length, so a length on a locked row is a stored
fact — and one piece, visible on the row, with one undo, fixes the position AND the length. That is
why the four decisions this round rests on are all *subtractions*:

1. **The edge still resizes a LOCKED row** and stores nothing new.
2. **On a row the engine lays out, the bottom edge does not resize** (409 `resize-needs-padlock`).
   The UI does NOT withhold the strip, and that is a correction to this round's own first answer —
   see *The edge does not go silent, it explains itself* below.
3. **The gap is NEVER created for the owner** — *"no se creará el hueco automáticamente, sino que si el
   usuario lo quiere lo deberá de crear él"*. The refusal names *Cerrar el día aquí*; they take it.
4. **The dead-end question stays.** Growing a locked row still takes the hours from the job's later
   rows, and asks when there are none — `shrink-needs-choice`, unchanged.

**Two things had to be ADDED, and both are consequences of 1 and 2 rather than new rules.**

- **The whole stretch comes out as fixed as the row that was dragged.** A 6 h drag on a padlocked
  `10:00-14:00` writes a second segment at 15:30; when that landed on an automatic row it stayed
  automatic, and the reflow immediately made it `15:30-19:30` — the drag stored 4 h where the owner
  drew 2 h. So every row the stretch writes or absorbs inherits the target's padlock. It is `autoLock`'s
  rule for a job born on a chosen day: what holds a hand-made shape has to hold all of it.
- **`stretchFrom` keys on the POOL, not on the mark.** "A row already hand-set" became "a row the
  engine does not lay out either", which is the same set in practice (the gesture pins everything it
  writes) and is what keeps shrinking a padlocked cross-break stretch from leaving its padlocked
  afternoon half behind. The other reason to absorb a row — the new segments land on it — is unchanged.

### The edge does not go silent, it explains itself

**Corrected inside the same round, 2026-08-18, after driving it.** "The app must not offer what the
server refuses" pointed at withholding the handle, and withholding it is what was built first. In the
browser that turned out to open a hole worse than the one it closed: with no strip there, a press on an
automatic row's bottom ten pixels **fell through to the block body and started a MOVE**. A reach for a
length silently re-ranked the queue — the one thing a resize must never be mistaken for.

So the strip stays on every row but a past one, and it says which of the two it is:

| the row | the strip |
|---|---|
| padlocked, or on a weekend, and not past | live: `ns-resize`, the job-coloured pill, `block.resizeHint` |
| anything else the engine lays out | `.resizeInert`: `cursor: help`, a grey hairline pill, a two-line tooltip |
| a PAST row | none at all — the body answers with `notices.pressOnPastDay` |

The inert press is handed to the drag as a fourth `InertReason`, **`automatic`**, so the machinery that
already existed for a press that cannot write does the rest: no ghost, nothing written, ONE sentence the
moment travel proves a drag, and a press that does not travel is still a CLICK that opens the job panel.
`INERT_KEYS` is typed `Exclude<InertReason, 'automatic'>`, so this branch cannot silently fall back into
a generic sentence — `automatic` is the only reason that is about a ROW rather than about the calendar,
which is also why `onInert` now carries the `DragTarget`.

The two lines say what the length IS and what does change a day, which is the part a refusal alone
cannot: *«Este borde no cambia la duración: un bloque automático mide el sitio que tiene y el motor la
vuelve a calcular. Con candado, la fijas tú.»* / *«Lo que sí cambia la forma del día: un hueco que lo
cierre antes, otro trabajo detrás, o las horas del trabajo en su ficha.»*
(`block.lengthIsAutomatic`, `block.lengthIsAutomaticHow`.)

**And the gap is one tap away while still never being automatic.** The sentence carries a *Cerrar el día
aquí* button pre-filled for the row whose edge was pressed; pressing it dismisses the sentence and opens
the gap form, and **the owner presses Guardar.** Absent when the row has nothing left to close. To stop
the two entry points proposing different gaps, `WeekGrid`'s private `closeDayAfter` and its
`closeDayInput` memo were extracted to `src/components/calendar/closeDayOffer.ts`, imported by the hover
bar and by this sentence, with seven cases in `closeDayOffer.test.ts`.

### This reverses the owner's own v0.3 request, and here is why

In v0.3 the owner's report was that the bottom edge *"only works in one direction"*, and the answer then
was to **offer the edge on every row** — the two strings that had explained why it was inert were
deleted, and a row the engine re-laid-out kept its hand-drawn number in `blocks.manual_duration`. That
was the right answer to the complaint AT THE TIME, because the mark existed to make the number stick.

**What changed is not the owner's mind about the gesture; it is what a length MEANS.** With
`manual_duration` deleted, "resize is always available" would mean offering a gesture the engine undoes
on its next pass — precisely the silent no-op v0.3 was fixing. The owner's own words are the reversal:
*«si lo reduce de miércoles crece en jueves y sitio se libera en miércoles y pasa allí quedando
exactamente igual»*. So the availability moved rather than shrank: the gesture is available wherever it
can be HONOURED (a padlocked row, a weekend row), and everywhere else the edge is still there and still
answers — with the padlock, the gap, another job behind this one, or the job's own hours — instead of
being deleted or, worse, quietly becoming a drag.

**Measured, 2026-08-18, both halves.** A padlocked `Mar 18 15:30-19:30 4 h` of a 12 h job, dragged at
its bottom edge from 19:30 to 18:30 in a real browser, stored `15:30-18:30 3 h [locked]` and the freed
hour reappeared as `18:30-19:30 1 h` automatic of the same job, total still 12 h — and it SURVIVED a
full reflow (a second job created afterwards left the locked row at 3 h). That is the owner's argument
demonstrated from the other side: without the padlock the row would have gone straight back to 4 h; with
it, the gesture is real and the hours it frees go to the queue. On the same calendar, dragging the
automatic `Mié 19 08:00 2 h` row's edge 108 px produced no ghost, no request and no change on disk, one
sentence, and the *Cerrar el día aquí* offer — which, pressed and saved, made a `Mié 19 10:00 9,5 h`
gap and moved Porton's 5 h whole to `Jue 20 08:00`. Nothing disappeared and nothing was created behind
the owner's back.

**Migrating the shop's file.** `manual_duration = 1` rows were SIZED BY HAND, and afterwards the only
thing that can hold a length is the padlock, so they come out `locked = 1` (`REMOVED_COLUMNS` in
src/lib/migrations.ts, beside `hand_placed`, same argument and same transaction). Freeing them instead
would let the very next reflow re-derive the length the owner had drawn. Verified against a database
built with the old schema — including a row carrying `manual_duration = 1` with `locked = 0`, which
comes out padlocked with its date, start and duration untouched — and on a file that never had the
column, where `PRAGMA table_info` skips both carry-overs and nothing is padlocked by accident.

**What got simpler, measured rather than claimed.** `compose` lost its two-phase queue walk: no
`closedDays`, no deferral, no `startsOn`, no `roomFor` (its only reader was the deferral), and the
2000-seed harness now asserts **strict order on every seed** where it used to skip the calendars that
had a hand-set item. `acceptsItem` has one refusal left (the buffer) instead of two. `resizeBlock` lost
its padlock arithmetic. `setDuration`/`pinDuration` became plain assignments. `mergeTouchingRows` lost
both guards. The engine is a single forward pass again, and *the one documented break in strict order is
gone with the mark that needed it.*

### What two removals cost, and what they bought

Counted, not estimated (`git diff --numstat` against 5e8a9e1, the commit this round started from):

| | this round |
|---|---|
| files touched | 34 — 23 production, 9 test, 2 spec |
| production code | **+568 / -906** — a net 338 lines gone |
| tests | +487 / -692, and the suite got STRICTER (see below) |
| spec | CLAUDE.md +181/-118, DECISIONS.md +281/-20 |
| stored columns | 1 removed; **0 added** |
| API actions | 1 removed (`release`); 0 added |
| locale keys | 4 removed, 3 added |
| rules removed from CLAUDE.md | 7 — the run break, the closed day, the deferral, auto-merge's two guards, the cut-releases-the-mark rules, the margin-padlocks-a-resize rule, *back to automatic* |
| open questions closed | 2 (Open Decisions 3 and 9), **both by removal rather than by an answer** |
| open questions made worse | 1 (Open Decision 4), stated plainly and left to the owner |

The suite going from 899 to 887 tests is not coverage lost: the deleted tests were the mark's own, and
two 2000-seed harnesses had an EXEMPTION deleted — placement now asserts strict order on every seed
where it used to skip any calendar containing a hand-set item, and shrinking asserts the new
precondition on every movable target. Fewer tests, more assertions per calendar.

**THE TREND IS THE POINT.** Two extra marks have now been deleted by the same argument, four days apart:

| mark | added | deleted | what the argument was |
|---|---|---|---|
| `hand_placed` | v0.2 | 2026-08-14 | it said "a human chose this DAY", which is what the padlock says |
| `manual_duration` | v0.3 | 2026-08-18 | it said "a human chose this LENGTH", which is what the padlock says |

Both were introduced to make a gesture stick; both grew rules to hold them up; both were removed
by noticing that the padlock already fixes the row ENTIRE. The migration carries both into `locked = 1`,
in the same list, by the same reasoning. **The rule that falls out of it, and the one to apply next time
this comes up: a second column that means "the owner decided this" is the padlock under another name.
Before adding one, work out what it would say that `locked` does not.** The reverse also held both
times — each removal shortened the engine and closed an open question that had no answer while the
column existed.

**What this round leaves open, and it is the honest cost:** every resize is now on the fixed side of
the calendar, where nothing separates an overlap afterwards — so **Open Decision 4** (a resize may grow
a row over another job or over a gap) got BROADER, not narrower. Measured, with no margins involved: a
padlocked `Mon 08:00-12:00` grown to 6 h is stored over a padlocked `12:00-14:00` of another job. It is
a decision about what the gesture means and the mechanisms to answer it already exist
(`findGapConflicts`, `otherJobOverlaps`), so it is left for the owner. Open Decision 2 is still open and
now arrives as a DIALOG rather than a silent mark (a 6 px drag on a locked lunch-split unit sends
`resize 360` against a 600-minute stretch and gets `shrink-needs-choice`, `freedMinutes: 240`). Open
Decision 3 closed by removal: it needed a movable target.

---

## A Hand-Set Duration — SUPERSEDED

> **DELETED 2026-08-18 by § The Padlock Holds the Length above.** `Block.manualDuration` no longer
> exists. Read the two lists below before you use anything on this page — the last superseded note in
> this file said only what fell, and the owner reasonably read it as meaning a RUN had stopped moving
> together, which had never been proposed.
>
> **WHAT FALLS.** The stored mark itself; a hand-set length **ending a job's run** in `buildQueue`,
> `unitOf` and the grid's `buildRuns`; **"no more of that job lands on that day"** (`closedDays`) and
> the **deferral** behind it, which was the one documented break in strict order; the mark being LOST
> when another gesture rewrote the length; and ***back to automatic*** in all six places it lived. The
> "Verified surviving a reflow" measurement at the foot of this section is about the deleted mark and
> proves nothing about the code today.
>
> **WHAT STANDS, and is still load-bearing.**
> - **A run still moves as one, and a job's rows still group as before.** Nothing about the drag unit
>   changed: a run is a job's consecutive movable groups, and the lunch break and a night still do not
>   break one. What changed is only that there is no longer a FOURTH thing that could break one.
> - **Do not derive grouping from the placement.** This is the constraint the section was written to
>   record, and deleting the mark makes it STRONGER, not weaker: grouping is now a function of movable
>   order alone, with no stored flag to read at all. The earlier critical defect it guards against —
>   grouping derived from the layout while the layout was derived from the grouping, so an unrelated
>   save silently resized the owner's blocks — is unchanged and still the reason.
> - **Recomposing twice must change nothing.** The `QueueItem` doc comment in
>   `src/lib/composition.ts` states the stronger version, and the 2000-seed harness still asserts the
>   fixed point on every seed.
> - **The strict-order break is gone, and that is a gain, not a loss.** The trade-off recorded below
>   ("a newer job starts before the older job's remainder") no longer has to be made by anyone.

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

## A Drop That Overlaps — the failure was invisible, which is why it needed a resolver

**Recovered from the code comments on 2026-08-18** when they were cut back; the rule was in CLAUDE.md
but this reproduction was in neither document, and it is the reason the mechanism exists at all.

**A hand drop is what creates a fixed-side overlap.** Drop 2 h on a Saturday that already holds a row
of the same job and BOTH rows are outside the movable pool the instant they are written, so no reflow
will ever separate them. Verified before the fix: **the two rows overlapped by an hour, the hours
invariant held, and the grid drew them as two side-by-side lanes with no warning.** Splitting 2 h onto
a Saturday the job already occupied did the same thing.

**That combination is the whole argument.** Hours conserved, every invariant green, no error, no toast
— the only symptom a silent two-lane render the owner would have to notice by eye. A failure that
cannot be detected by the checks is worse than one that throws, so it could not be left to a general
pass over the calendar; it had to be resolved in the same transaction as the drop that caused it.
`manualPlacementBlockId` is what closes it, and the test harness therefore asserts the invariants over
the RESOLVED calendar rather than over the drop's own request.

**Since the padlock became the only pin, a drop into a MARGIN is the same situation on an ordinary
weekday** — see the margin-collision reproduction under § *Reproductions behind the Open Decisions*.

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

## No Press Ends In Silence

**The press layer's own defects, gathered 2026-08-13 to 2026-08-18**, and written down here because
the numbers in `useBlockDrag.ts` and `geometry.ts` are otherwise unexplainable. All of them are one
shape — the app appearing to ignore the owner, or quietly doing something they never aimed at — and
all were found by pressing on the running app rather than by reading the code.

**How often the bar sits under the cursor, measured:** the action bar is **102 px** anchored 4 px from
the block's right edge, and it appears UNDER the cursor on the first mouse move. So on every weekend
column (**129 px** measured) and on every weekday block from about **210 px** down it covers the
block's own name — the owner's most natural grab point. Swallowing the press there made the drag do
NOTHING: no ghost, no request, no toast, **and no console error**, which is what makes it a silence
rather than a mis-click, and what «la app me ignora» actually looks like.

**Three presses ended in silence.** A press has exactly three honest outcomes: it starts a drag, it
opens the job, or it says why it can do neither (`InertReason`).

- **A press while a save or a reload was in flight was dropped on the floor**, because "a mutation is
  in flight" lived in `enabled` — and that is precisely the second AFTER a drop, when the next press
  is most likely. It is an `inert` press now (`busy`): tracked, so a click still opens the job panel,
  and it explains itself as soon as the travel proves a drag was meant. Asked as a FUNCTION
  (`writable()`) rather than read from render state, because state arrives one render late and the
  frame between a mutation starting and the grid re-rendering is exactly where a fast second press
  lands.
- **A press on the RESIZE EDGE that did not travel was not read as a click** (the branch asked
  `kind === 'move'`), so clicking the bottom ten pixels of a row — most of a short row — opened
  nothing. A click is a click wherever on the block it lands; only the DRAG differs between the two
  surfaces.
- **A press that travelled five pixels was a DRAG**, and a five-pixel drag resolves to the slot it
  started from, so it wrote nothing and was not a click either. `CLICK_SLOP` (12 px) re-reads it as a
  click, and only when the gesture came to nothing: a drag that really travelled and was deliberately
  put back stays silent, because the ghost was under the pointer the whole way.

**The hover action bar covered the block it belongs to, on both axes.**

- **Height — measured 2026-08-13.** The bar is 24 px tall and sits 3 px down from the row's top edge;
  the resize handle takes the bottom `min(10px, 34%)`. A half-hour row is 24 px tall at the fitted
  scale, so the bar covered all of it and overhung by 4 px, and every press on the row landed on a
  button — *Cerrar el día aquí* down the middle, *Eliminar* at the right end. The drag still worked (a
  press on the bar begins the same move); the CLICK could no longer open the job.
  **`MIN_ACTIONS_HEIGHT` is 56 px**, which leaves at least 19 px of body between the bar and the
  handle — a target a mouse on a shop PC can acquire. Below it the bar lifts off the row entirely
  (`.detached`).
- **Width — the same defect on the other axis, still open until 2026-08-14.** The bar is anchored at
  the block's right edge and takes the WHOLE top of a narrow block, name included: on a weekend column
  (116 px floor) and on any weekday column once the window is small enough. Such a block is TALL, so
  it is not cramped and the bar stayed inside it — a click on the block's own name landed on
  *Eliminar*, and a gesture that quietly does something else is worse than one that does nothing.
  **`MIN_BLOCK_GRAB_WIDTH` is 44 px**, about two characters of the job's name plus its padding: enough
  to see there is block left to press, small enough that the bar is not thrown out of every column on
  the shop's own monitor. Below it the bar docks outside the top edge, exactly as a cramped row's
  does — one behaviour, two ways to reach it.
- The two companion numbers are the same measurement from the other side. **`ACTIONS_BAR_HEIGHT`
  (27 px**, `--ww-control-height-sm` plus its inset) is what a row needs ABOVE it to dock the bar
  there rather than under the sticky day header, so a row without it docks below instead;
  **`ACTIONS_BUTTON_WIDTH` (26 px**, the button plus the bar's 2 px gap) is what lets
  `blockHoldsActions` measure a bar whose width depends on how many buttons it is showing — three on
  an ordinary row, four when *cerrar el día aquí* is offered.
- What is left open is CLAUDE.md's **Open Decision 12**: on a ~150 px weekday column a TALL block
  still has its top ~28 px covered, and moving the bar outside on narrow columns too would put it over
  the neighbouring day.

**A press that explained itself must not also do the other thing** (2026-08-14). Dragging a gap said
*«Los huecos no se arrastran…»* AND opened its form in the same breath: the element is a `<button>`, so
the browser delivers its click on release however far the pointer travelled in between. Two answers to
one gesture, one contradicting the other — the owner is told the gesture does nothing and is then shown
a form they did not ask for. The click is swallowed at the RELEASE rather than where the sentence is
spoken, because the swallow only survives to the end of the current task and the sentence can be said
seconds earlier.

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
   **In a LAYOUT effect, and that is correctness rather than a frame of polish.** A passive effect is
   flushed in a scheduler callback, so there is a moment when the new columns are in the DOM and the
   preview still names a day of the week that has left the screen — and a `pointerup` dispatched in
   that moment was committed against the OLD week. Measured 2026-08-17 by releasing from inside a
   MutationObserver callback: the columns read `2026-08-24`, no ghost was drawn at all, and the drop
   was stored on `2026-08-23` and padlocked there, after which `showWeekOf` pulled the screen back a
   week to show the owner where their block had gone. A layout effect runs inside the same
   synchronous commit, so that moment does not exist.
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

**The gap's exemption lasted two days.** It was right while a gap's `duration` was clock minutes — there
was no straddle to remove, because the row meant the wall clock. On 2026-08-19 the units changed and the
exemption went with them: a gap reads `firstWorkingMinute` like every other gesture now. See § *Gaps Are
Cut At The Comida Too*.

---

## Gaps Are Cut At The Comida Too

**2026-08-19.** A gap's `duration` was CLOCK minutes and a gap was the one row in the app allowed to
span a non-working interval. It is NET WORKING MINUTES now, like a block's, and a stored gap row is cut
at the break like everything else. This is phase 1 of the round the owner opened with *«los gaps
actuarán como tareas con candado, en el sentido de que donde se crean ahí se quedan pero las puedo mover
desde la interfaz»*: the STORED SHAPE only. The drag, the resize, the painting gesture, the absences
screen and the closed-day screen are later phases and are not built.

**The evidence, from the shop's own database.** Four gaps, `2026-09-01` to `09-04`, each `08:00 +11,5 h`,
reason "Feria" — a whole week away at the fair. **11.5 and not 10 because the comida was paid for.** The
owner had typed the wall clock, the app had stored the wall clock, and every reader then had to remember
that this one table meant something different from the other one. And `day_overrides` had 0 rows: a
whole-week absence had been built out of gaps because the closed-day mechanism has never had a screen.

**What it buys.** *No stored row straddles a non-working interval* stops being a rule with an exception
and becomes an invariant of the schema. Everything downstream then follows from ONE fact rather than
from two: `start + duration` is any row's clock extent, so the plannable-hours union, `findGapConflicts`,
`firstClearStart`, `mergeIntervals`, `manualDaySegments`, `coveredMinutes`, the ghost's spill and
`heightBetween` are all correct for a gap for exactly the same reason they were already correct for a
block. Nothing on the grid is drawn over the 28 px seam any more, which is what the seam was for.

**What it costs, and the owner accepted it in as many words: a gap can no longer be recorded inside the
comida.** A gesture aimed at a minute no window covers starts at the first minute that can hold work, so
a gap aimed at 14:00 is stored from 15:30 — the rule *A Minute With No Working Time* already governing
every drop, now reaching the one row that was exempt. Nothing happens during the break by definition, so
there was never anything to record there.

**Two smaller consequences, both wanted.** Segmentation reads the MANUAL WINDOW, margins included,
because a gap is a hand gesture and that is what hand gestures read: a gap may sit in a margin, and "all
day" on the documented shift is 12 h in two rows (`07:00 +7 h`, `15:30 +5 h`), not 10. And *Cerrar el día
aquí* now proposes TWO rows where it used to write one across the break, still only proposing —
*«no se creará el hueco automáticamente, sino que si el usuario lo quiere lo deberá de crear él»*.

**The silent-failure risk was the whole of the work.** A gap is part of the occupancy set the engine
unions to compute plannable hours, so a net duration read as clock mis-sizes a day with nothing thrown.
The answer was not to teach eleven call sites to derive a clock end: it was to make the stored row
satisfy the invariant those sites already assume, and gate it on the way IN. `createGap` and `patchGap`
segment through `segmentDroppedRow` — the drop path's own function, so a gap and a drop cannot be cut
differently — and `assertGapFits` then asks the day's end and the fixed work OF EACH ROW.

**One real defect was found by asking it per row rather than per gap** (measured over HTTP, no browser):
a padlocked `Porton 18:00-19:30` on a Tuesday, and a gap of 8 h from 10:00.

| the question asked | the answer |
|---|---|
| over `start + duration` — `10:00-18:00` | names rows inside the comida, where nothing can be; MISSES the padlocked row; **saves on top of it** |
| over the rows — `10:00-14:00` and `15:30-19:30` | 409 `gap-over-fixed-block` / `errors.gapOverLockedBlock`, naming *Porton 18:00-19:30*, nothing written |

And the mirror holds: 3 h from 10:00 stops at 13:00 and saves, because the padlocked row is no longer in
its way. The slide agrees too — a padlocked row dropped at 10:00 onto a day carrying `08:00 +6 h` and
`15:30 +2 h` of gap lands at **17:30**, having stepped past both halves.

**The day's end, not midnight.** `assertFitsInDay` (midnight) was the only ceiling a gap had, which was
right while a gap's minutes were clock minutes and wrong the moment they became net: 13 h from 08:00
would have stored a second row running to 22:30. The line is now `dayEndMinutes` over the manual
windows — 409 `row-past-day-end`, the block path's own guard — and it keeps that guard's one latitude, so
a gap a settings change stranded past the day's end stays editable as long as the edit does not make the
overrun worse.

**The migration splits, it does not convert.** Turning the four Feria rows into closed days would rewrite
what the owner recorded into a different statement about the same week. `08:00 +11,5 h` becomes
`08:00 +6 h` and `15:30 +4 h`, the reason on both, the morning half keeping the row's id and the
afternoon half its `created_at`. Re-measured on the real thing: opening the fixture over HTTP gives eight
rows across the four days and each of those days reports `plannableMinutes: 0`, exactly as the 11.5 h
rows did — **the meaning is preserved, only the units changed.**

- **What it writes is the same stretch of clock in the new units**: the old interval intersected with the
  manual windows. A gap already inside one window is therefore left BYTE-IDENTICAL, not rewritten with
  the values it already has — `2026-08-24 09:00 +1 h` keeps its `updated_at` — and a gap that included
  minutes the shop cannot work loses exactly those. A gap with no working minutes at all is left alone:
  there is nothing to convert it to, and deleting what the owner recorded is not a migration's business.
- **The ordering problem, and the answer.** The split needs the SHIFT to know where the break is, and a
  stored gap carries no record of the shift it was typed under, so the settings are the only evidence
  there is. It therefore runs LAST in `runMigrations`, after `seedDefaultSettings`, which is what makes
  it correct on a database that has never been configured — proved by the fixture, whose file has no
  `settings` table at all and is migrated against the documented `08:00-14:00` / `15:30-19:30`.
- **It runs ONCE, and that is a decision.** `data_migrations` is a new table and the first guard of its
  kind: `PRAGMA table_info` can see a column appear or go, and can see nothing at all when what changed
  is what a NUMBER MEANS. Re-running would be a no-op today — every row now sits inside one window — but
  not after the owner narrows the shift, and re-cutting gaps they have since put where they want them,
  silently, on an app restart, is not a repair.

**The two halves are ONE unit on screen**, joined with the seam and the `sigue…` marks like a job cut at
the comida, sharing one reason and one lane. Grouping goes through `adjacentInWindows`, the predicate the
grid already groups blocks with, so a gap unit and a block unit cannot disagree about where a unit ends.

**The reason stands where a block's `projectId` stands**, and it has to be something: two gaps that
merely touch must NOT be merged, in storage or on screen, because each carries its own reason and
merging would destroy one. The reason is all a gap has to be identified by. Two rows with the same
reason and nothing workable between them are drawn as one unit whether one save or two made them —
there is nothing on them to tell apart, and nothing is claimed on screen beyond what they say.

**What phase 1 deliberately did not do**, so the next round is not misled: a gap is still not dragged
and not resized (pressing one opens its form); a PATCH edits ONE ROW, so editing one half of a gap
leaves the other where it is, and a delete removes one half; there is no absences screen, no range, no
painting gesture and no closed-day screen. `MIN_ROW_MINUTES` is still not a write-path guard, so a
sub-quarter gap row remains reachable over HTTP exactly as a sub-quarter block row is.

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
   **ANSWERED 2026-08-17 — by the owner removing the rule, not by anyone answering the question.**
   The cause quoted above no longer exists: there is no `continuation` and nothing moves whole. The
   answer is candidate (c), *prefer the current day for the remainder even when it must split*, and it
   arrives for the same three gestures at once. Re-measured on a scratch database, all three: growing
   the row into the margin left Monday's morning intact and moved exactly the one hour it added
   (Barandilla's Tuesday row 4 h → 3 h, Porton up by an hour); padlocking the row moved nothing at
   all; and a gap under the following morning split Barandilla around it (`08:00-11:00` +
   `12:00-13:00`) instead of throwing it forward.

2. **A 6-pixel drag on the bottom edge of a lunch-split unit's first row reshuffles the week while
   the ghost promises nothing.** The ghost reads `08:00–14:00 · 6 h` — no change — and the request
   `resize 360` is still sent, because `useBlockDrag`'s no-op guard compares the released NET minutes
   from the row's start (360) with `target.durationMinutes`, which for a resize is the STRETCH (600).
   The two can never be equal on a multi-row unit, so no micro-drag is ever suppressed. The mechanical
   half could be fixed tomorrow; the semantic half cannot, because the edge the owner can grab sits at
   14:00 while the value the client is editing ends at 19:30.
   **Re-measured 2026-08-18, on the gesture as it now is:** the zero-delta resize is no longer a
   silent mark (`manual_duration` is deleted) — a padlocked 10 h unit whose first row is dragged by
   6 px answers **409 `shrink-needs-choice`, `freedMinutes: 240`, `choices: [reduce-total, new-block]`**.
   The drag that went nowhere now opens a dialog, which makes the question louder, not answered.

3. ~~**A resize whose result does not fit the day leaves the dragged row untouched, invents a row on
   another day, and the toast says it worked.**~~ Gap Thu 18:30-19:30, then `Barandilla 13 h`; drag the
   `15:30-18:30` row's edge to 19:30 → ghost `15:30–19:30 · 4 h`, request `resize 240`, and the
   Thursday row was still 3 h while a NEW 1 h row appeared on Monday. The toast said «pasa a 4 h aquí».
   **CLOSED 2026-08-18 BY REMOVAL.** The shape needed a MOVABLE target — the transfer was applied and
   the reflow then re-derived the row it had grown — and the edge no longer sizes such a row. The same
   reproduction, with the row padlocked first: `Thu 15:30-19:30` really is stored, the hour comes off
   the job's Monday row (`08:00-12:00` → `08:00-11:00`), the total stays 780 min, nothing is invented.
   What is left of it is decision 4.

4. **A resize may grow a row over another job, or over a gap, wherever the reflow cannot separate
   them.** Both rows are padlocked (the margin does that), so both are outside the pool and the
   reflow flows around both: `Barandilla` grown to 20:30 sits on top of a padlocked
   `Porton 19:30-20:30` on TODAY, and a Friday row grown from 12:00 to 13:00 sits on a gap at
   12:00-14:00. `resizeBlock` never looks at other projects' rows and never at gaps; only the drop
   path resolves overlaps.
   **BROADER since 2026-08-18, and now the round's one real hole.** The edge only sizes rows the engine
   does not lay out, so EVERY resize is on this side; no margin is needed to reach it any more. Measured
   on a plain Monday: a padlocked `08:00-12:00 Barandilla` grown to 6 h is stored `08:00-14:00` over a
   padlocked `12:00-14:00 Porton`, and closed decision 3 leaves `15:30-19:30` sitting on a gap at
   `18:30-19:30`. The two halves of an answer already exist (`findGapConflicts`, `otherJobOverlaps`).

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
   **Verified on a real server** (recovered from `SplitBlockPanel.tsx` on 2026-08-18): *splitting 2 h
   onto Wednesday moved those hours behind «Barandilla» on Monday.* The fragment is a queue rank, so
   to park hours on a day, lock them — which is what `block.splitHint` says in the form.

**Two more, decisions rather than defects:**

- ~~**A hand-set row that has LEFT the pool stops closing its job's day.**~~ `closedDays` was seeded
  from the QUEUE, and a locked, weekend or past row is not a queue item — so padlocking a hand-set row
  re-opened the day the ruler had closed and pulled the same job back onto it. Reproduced:
  `Barandilla 14 h` + `Porton 6 h`, shrink Barandilla's Thu 08:00 row to 2 h, then padlock it → 2 h
  of Barandilla came back to Thursday 17:30-19:30 and the Tuesday row disappeared. Hours conserved,
  no overlap, idempotent — never an invariant break — and the mechanical "fix" (seed `closedDays` from
  the stored flag) made the padlock leave the day EMPTY instead, which was decision 1 arriving from a
  third direction. The chain to decision 1 was cut on 2026-08-17.
  **CLOSED 2026-08-18 BY REMOVAL, and confirmed rather than assumed.** Every noun in the question is
  deleted: there is no mark, no `closedDays`, no `dayKey`, no `handSetDate` and no deferral in
  `compose`, so there is no day for a padlock to re-open and no asymmetry between a stored flag and the
  queue. The evidence that nothing was quietly kept: the 2000-seed harness asserts strict order on
  every seed now, where it used to skip the calendars that had a hand-set item. A day the owner wants
  closed to a job is a GAP — see § The Padlock Holds the Length.

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
filling with `formatTime` complaints, forty per drag). **The sub-midnight overruns were worse for
being quiet**: 13 h released at 07:00 printed `21:30`, an hour past every rule the grid draws, with
no complaint anywhere — so the guard could not be "does it render", it had to be the day's own end.
The integration pass measured what is left:

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

  **MOSTLY ANSWERED 2026-08-17, and the answer was "yes, cut it across days" — arriving as a
  consequence of *Fill and Overflow, Always* rather than as a decision about the drag.** A drop that
  is only a queue rank stores no geometry, so `assertFitsInDay` is not asked of it and the engine lays
  the run out. Measured over HTTP on a scratch database: an 18 h run dragged onto Monday-Thursday
  answers 200, and dropped behind a 2 h job it came out `Corto 08:00-09:00` then Nave across two days.
  Two of the three consumers went with it — the PIN now reads the drop's START (a footprint past the
  end of the periods is overflow, not a request for the margin) and the CLAMP does not run on a rank
  at all. What is LEFT is the same drag onto a day that keeps the minute, where the row really would
  be stored inside one day: still 400 `out-of-range`, still a sentence about an hour, still worth
  rewording. And `dropEffectOf`'s collision test still measures against the uncut footprint.

**14 — a resize ghost's tail on an occupied day.** Measured both ways on 2026-08-17. With Wednesday
afternoon FREE, growing the 6 h Wednesday row to 8 h previewed two rectangles — `08:00-14:00`
(325.5 px) and `15:30-17:30` (108.5 px) — and stored exactly `2026-08-19 480+360` and `930+120`. With
Wednesday afternoon held by another job the same gesture previewed the same shape and stored
`Wed 480+360` + `Thu 480+120`: the hours are right, the estimate went 6 h → 8 h, every invariant
holds, and the rectangle and the `17:30` are wrong. The ghost has no reflow to consult, which is the
whole difficulty — a resize is documented as the one gesture whose range is literal, and that was
true while its tail stayed on its own day.

**15 — a division inside one day says nothing.** Measured 2026-08-18 while re-verifying *Fill and
Overflow, Always*, both in a browser and over HTTP. Wednesday holds a padlocked `candado 10:00-14:00`;
`sujeto`, 6 h, is dropped at Wednesday 08:00. The ghost is right and complete — two rectangles on the
one column, `08:00-10:00` and `15:30-19:30`, the bare hours line «6 h» (correctly NOT the split
sentence, since the hours never leave the day) and one insertion rule. The save is right too:
`Mié 08:00-10:00 2 h` + `Mié 15:30-19:30 4 h`, `changed: true`, `placedBlockIds` two long,
`block` = `480+120`. **And the toast never appears**: `filled` counts DAYS and there is one, `pinned`
is false, the row is at the minute released so nothing else fires.

Why it is a question rather than a defect: the documented silence rule is "the row is visible, at the
minute it was released, with nothing else changed", and by the letter of it this qualifies. What makes
it worth asking is the asymmetry — the same 6 h split across a night gets a full sentence naming both
days, and the same 6 h split across the comida gets none, while four of the hours are five and a half
hours below the pointer. It is also the only shape the rule change made ordinary that the notice table
does not cover, which is the kind of gap the 14:00 defect lived in.

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
  "resize only works in one direction". **BUILT 2026-08-14**: the engine asks instead. *(The QUESTION is
  untouched by 2026-08-18. What changed is only which rows the gesture runs on at all: a row the engine
  does not lay out. The dead end, the three answers and `choices` in the refusal are all as built.)*
- ~~**Open Decision 3 — a resize whose result does not fit the day invents a row on another day while
  the toast says it worked.**~~ **CLOSED 2026-08-18 BY REMOVAL.** The shape needed a MOVABLE target: the
  transfer was applied, the reflow re-derived the row it had grown, and the hour surfaced elsewhere. The
  edge no longer sizes such a row. Re-measured on the original reproduction — gap Thu 18:30-19:30,
  `Barandilla 13 h`, the padlocked `15:30-18:30` row dragged to 19:30 — the row really becomes
  `15:30-19:30`, the hour comes off the job's Monday row (4 h → 3 h), the total stays 780 min and no row
  is invented. What it leaves behind is Open Decision 4, and only that.
- ~~**Open Decision 9 — does padlocking a hand-set row re-open the day its ruler had closed?**~~
  **CLOSED 2026-08-18 BY REMOVAL, not by an answer.** Every noun in the question is deleted: the mark,
  the day it closed (`closedDays`) and the deferral behind it. Confirmed rather than assumed —
  `closedDays`, `dayKey` and `handSetDate` do not appear in `compose` any more, and the 2000-seed
  harness now asserts strict order on **every** seed instead of skipping the calendars that had a
  hand-set item. If the owner ever wants a day closed to a job, that is a GAP.
- **NOT closed, and made WORSE: Open Decision 4** (a resize may grow a row over another job, or over a
  gap). Every resize is now on the fixed side of the calendar, where nothing separates an overlap
  afterwards, so this is the one real hole the round leaves. **Both halves re-measured over HTTP on
  2026-08-18, on a plain future Monday and Tuesday with no margins involved and nothing clever set up:**

  | set up | the resize | what was stored |
  |---|---|---|
  | `Barandilla Lun 24 08:00 4 h [locked]` + `Porton Lun 24 12:00 2 h [locked]` | Barandilla → 6 h | **200.** `Barandilla 08:00 6 h [locked]` (08:00–14:00) lying straight over `Porton 12:00 2 h [locked]` |
  | `Reja Mar 25 15:30 3 h [locked]` + `gap Mar 25 18:30 1 h «mantenimiento»` | Reja → 4 h | **200.** `Reja 15:30 4 h [locked]` (15:30–19:30) covering the whole gap |

  `resizeBlock` never looks at another project's rows and never at gaps; only the drop path resolves
  overlaps, and `findGapConflicts` / `otherJobOverlaps` — its two halves — already exist. So whichever
  answer the owner picks (refuse naming the row or the gap; cut at the obstacle the way a drop does;
  allow it and draw the overlap on purpose) is a call rather than a new mechanism.

---

## The Comments Were a Third Copy

**Asked for by the owner, 2026-08-18:** *«algunos son gigantes y no necesarios, la ruta y el archivo
deberian de ser autoexplicativos dejando a los comentarios como innecesarios»*.

**Measured before touching anything.** `src/` was 39,394 lines: **11,027 of comment against 24,525 of
code**, 0.45 comment lines per code line. 1,751 of them sat in 50 blocks of 25 lines or more, the
largest 88 lines. Files existed where the prose outweighed the program — `edgePaging.ts` carried 115
comment lines over 25 of code, `dropOutcome.ts` 149 over 51.

**Why it was safe, and this is the whole argument.** This repository already separates the three kinds
of writing, and says so in CLAUDE.md's own opening: CLAUDE.md is the WHAT, DECISIONS.md is the WHY.
The code comments had become a THIRD copy, and usually the lossiest of the three. The case that
settled it: `edgePaging.ts` spent 24 comment lines justifying `EDGE_REPEAT_DELAY_MS = 800`, while
§ *The Repeat Is a Metronome, Not an Acceleration* above holds strictly more — the owner's quote, the
deleted 320/240/200 ramp, the week-34-to-41 measurement, the 600–1000 ms window **and** the per-turn
timings (503, 809, 885 ms …) that the comment never had. Deleting that essay lost nothing.

**What went:** file-header essays restating the path; restatements of a CLAUDE.md rule; obituaries for
deleted code (221 lines of *«X used to…», «removed 2026-08-18»* — git holds it); owner quotes (109
lines, all of them already here); ALL-CAPS rhetorical headings and bulleted justifications of a
constant; comments restating the line beneath them.

**What stayed:** a trap the next reader would fall into, or a local invariant the types cannot state —
one sentence. The engine's *do not derive grouping from
the placement* rule is the model: it survived whole, because the reflow really is derived from the
grouping and a reader who does not know that will break the fixed point.

**The safeguard, and it fired.** A comment recording a measured defect, a reproduction, or an
obvious-looking alternative that had been tried and failed was only removable if the note already
existed in CLAUDE.md or here. **14 notes turned out to be recorded in neither** — the `updated_at`
trigger that only fires because the UPDATE omits the column, the non-modal side panel, error toasts
that never auto-dismiss, `getDb` being lazy so migrations do not run during `next build`, the eight-
swatch deviation from the wireframe — and every one was kept in the code instead of dropped. They are
the backlog for a later pass, not a loss.

**Result over both passes: 11,375 comment lines became 5,395** — `src/` from 0.45 to **0.21** per
code line, `app/` from 0.83 to **0.35** — with **zero** references to either document left in the
code, and 2 remaining comment blocks over 15 lines instead of 50 over 25.

**Not one non-comment line changed**, verified mechanically rather than by eye: comments were
stripped from both revisions of every touched file and the code compared token by token — 97
identical line for line, 5 identical once the line-splitting of a JSX comment's braces is ignored,
**0 genuine changes**. That check earned its keep twice: it caught a JSX comment of my own adding an
expression node, and it localised the damage when eight agents died mid-edit on a session limit and
left `Timeline` missing `endMinutes`, `yOf` and `GridMetrics.columns` — three declarations whose doc
comments were still sitting there orphaned. `tsc` clean, 887 tests in 30 files, lint clean, build
clean.

**`app/` was found late and was the worst of it**: 0.83 comment lines per code line, and
`app/api/blocks/[id]/route.ts` carried a 104-line header over 49 lines of code — a complete
re-statement of the drop, padlock, resize and overflow rules. What earns a place in an HTTP route is
the request and response SHAPE, which a caller reads, and the fields that mislead if read alone
(`placedBlockIds` is normally longer than one; `block` can be null; `changed` is the only honest
answer to "did anything happen").

**A SECOND PASS, and a correction from the owner.** Reviewing the first, they asked for two more
things: *«no menciones todo el rato que está en el decisions puesto que ya se sabe implícitamente»*,
and *«elimina todo lo no necesario repetitivo o que se puede omitir como comentario indicando que hace
una función y el nombre de la misma ya te dice lo que hace»*.

Both are right, and the first is a correction of the first pass's own output: it had ADDED
`CLAUDE.md §` / `DECISIONS.md §` pointers as the cheap way to keep a deleted essay reachable — 97 of
them across 55 files. That the rules live in one file and the reasoning in the other is understood by
anyone reading this repository; repeating it on every symbol is the same noise in a shorter form. They
are gone, and the rule in CLAUDE.md now forbids writing them. Also gone: docs recoverable from the
identifier and its type, and the decorative rules of dashes around section labels.

**The rule that stops it growing back** is in CLAUDE.md § Notes for Development. It was missing, which
is why the essays were written in the first place: nothing said not to.

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
  **The exact reproduction**, kept because it needed no unusual gesture at all — a past Mon-Thu row is
  never marked (its day role is `auto`) and a row on TODAY becomes a past row overnight: a 2 h job on
  yesterday raised to 6 h stored `12:00 + 360 min`, one row straight through the lunch break claiming
  6 h where the clock holds 4.5 h; raised to 13 h it became `12:00-25:00` and took the whole calendar
  page down from `useFormat().time`. `lastAutomatic` had tested the stored MARKS only, which read like
  the whole rule because a hand drop onto Sat/Sun always left one — so the weekend was covered in
  practice and only the past was reachable.

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
and at the margins, and margins that were configurable but unusable. Measured on the middle
one: `maxDurationFrom` stopped at 14:00 for a row starting at 12:00 — **120 minutes** — so a 4 h
morning row could not be made longer by any gesture at all. All three came from the same
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

**v0.13 — the owner deleted a rule, and two layers came apart behind it (2026-08-17/18).** The owner's
report was one drop that answered 200 and changed nothing; the answer was to remove *Never split a job
to make it fit* for the engine and for a hand drop alike (§ *Fill and Overflow, Always*), which
superseded two of their own earlier decisions and let three things be deleted rather than maintained:
`findWholeFit`, `takeExactly`, `ItemTarget` and `QueueItem.continuation` — the last of these existing
only to exempt a displaced tail from the rule now gone. Then the drag layer, which had been built to
refuse exactly the release that now works, was rewritten to draw the division instead
(§ *The Ghost of a Rank Is the Division*): one shared arithmetic (`src/lib/dropSpill.ts`, imported by
the engine so the two cannot disagree), a ghost that spans columns, and a drop that always answers —
`changed` and `placedBlockIds` on every mutation, and a `filled` notice naming the days.

*Re-verified independently on 2026-08-18* from a scratch database on its own port with the repo's
`data/` untouched: `tsc --noEmit` clean, `vitest run` 899 passing across 29 files, `next lint` clean,
`next build` clean with no dev server up. The owner's own gesture driven by dragging in a real browser
gave `Mié 15:30-19:30 4 h` + `Jue 08:00-10:00 2 h` with the ghost naming both columns before the
release and the toast naming them after; the reversal it created — work filling the hole in FRONT of a
padlocked row and continuing after it — measured as `Mié 08:00-10:00` + `Mié 15:30-19:30` around a
padlocked `10:00-14:00`; and the rules that did not change (a hole under a quarter of an hour, a run
longer than a day, the Friday buffer, the weekend, the frozen past, idempotence) each measured on the
running app. The full table is in § *Fill and Overflow, Always* → *Re-verified independently*.

*The defect the re-verification found:* **the one-minute rank nudge crosses the lunch break**, and the
day comes back off the quarter hour — including one 14-minute stored row, which is the invariant this
round's own table is built on. Not fixed: the fix decides what a nudged minute means, which is the
owner's call, and it is the same cause as Open Decisions 6 and 7. Reproduction, mechanism and the two
candidates in § *The One-Minute Rank Nudge Crosses the Break*.

*Still open, and deliberately:* Open Decisions 2-4, 6-12 and the remainders of 8, 13 and 14 in
CLAUDE.md. Two closed with this round: 1 (its stated cause was the deleted rule) and 5.

---

**v0.14 — the owner deleted the second mark, and the engine lost a rule per consequence (2026-08-18).**
The owner asked what a hand-set duration was for and answered it themselves: a block is exactly as big
as the room it has, and shortening a day is what a gap is for (§ *The Padlock Holds the Length*).
`manual_duration` is gone — 114 references across 20 files, 47 of them in the engine — and with it
every rule that existed only to hold it up: the run break in `buildQueue` / `unitOf` / `buildRuns`, the
closed day (`closedDays`, `dayKey`, `acceptsItem`'s third argument), the deferral (`deferred`,
`deferralDate`, `remainderOf`, `drain`, `startsOn`, `lastItemOfProject`, `roomFor`), auto-merge's two
guards, `setDuration`/`pinDuration`, `usesManualOnlyTime`/`manualOnlyMinutes`, and *back to automatic*
in all six places it lived (`releaseBlock` ×2, `PATCH {action:"release"}`, `releaseBlockDuration`,
`manualBlockIds`, the ruler glyph, two buttons, `notices.released`). **`compose` is a single forward
pass again: 82 statements against 123**, and the ONE documented break in strict order went with the
mark that needed it. What replaced the mark is nothing at all — the padlock already fixes a row's
length, because the engine neither moves a locked row nor re-derives it.

*The gesture that changed:* the bottom edge now sizes only a row the engine does not lay out; anything
else is 409 `resize-needs-padlock`. **Withholding the handle there was this round's own first answer and
was reverted before it shipped** — driven in a browser, a press on an automatic row's bottom ten pixels
fell through to the body and started a MOVE, so a reach for a length re-ranked the queue. The strip
therefore stays on every row but a past one and says which of the two it is: live where the server will
size it, `.resizeInert` with `cursor: help` and a two-line tooltip everywhere else, handed to the drag
as a fourth `InertReason` (`automatic`) so nothing is written, no ghost is drawn, and a press that does
not travel is still the click that opens the job panel. The sentence names the padlock, a gap, another
job behind this one and the job's own form, and carries a *Cerrar el día aquí* button pre-filled for that
row — **the app never creates that gap by itself**, from either entry point, which was the owner's own
condition. Both entry points read one `closeDayOffer.ts`. **On a PAST row no edge is drawn at all**,
which the spec already required and the code did not do.

*Verified 2026-08-18*, twice and by two agents, from a scratch database on its own port
(`WORKWISE_DB_PATH`, repo `data/` untouched): `tsc --noEmit` clean, `vitest run` **887 passing across 30
files**, `next lint` clean, `next build` clean with no dev server up. All FIVE 2000-seed harnesses pass
(placement, manual placement, drops, editing, shrinking), and two of them got STRICTER rather than being
relaxed: placement now asserts **strict order on every seed** (it used to skip any calendar with a
hand-set item), and shrinking asserts the new precondition on every seed where the target is in the
movable pool.

Over HTTP: `resize` on an automatic row answers 409 `resize-needs-padlock` with
`{projectId, blockId}` and nothing written; `{action:"release"}` answers 400 `invalid-action` naming
`[move, resize, lock]`; on a PAST row **`past-block-frozen` wins first** even though the row is locked and
the arithmetic would have worked, and `lock` is refused there too; the dead-end question still asks — a
Saturday-only 3 h job shrunk to 2 h answered 409 `shrink-needs-choice` with `freedMinutes: 60` and
`choices: [reduce-total, new-block]`, `reduce-total` took the job to 2 h, and growing the same row to 4 h
raised the total to 4 h. No block payload anywhere carries `manualDuration`.

In a real browser at 1600×1000, on a 12 h job laid out `Mar 18 08:00 6 h` + `15:30 4 h [locked]` +
`Mié 19 08:00 2 h`: dragging the padlocked row's edge from 19:30 to 18:30 stored
`Mar 18 15:30 3 h [locked]` with the freed hour back on the calendar as `Mar 18 18:30 1 h` automatic of
the same job, total unchanged at 12 h — **and the locked row was still 3 h after a whole second job was
created and the week reflowed**, which is the padlock holding a length, measured. Dragging the automatic
`Mié 19 08:00` row's edge 108 px produced no ghost, no request, no change on disk and one sentence with
the *Cerrar el día aquí* button; clicking that button opened the gap form pre-filled *«miércoles 19 de
agosto · 10:00–19:30 · el día pierde 8 h planificables»* and naming the 5 h of Porton the engine would
move; pressing *Cerrar el día* stored `gap Mié 19 10:00 9,5 h` and moved Porton's 5 h whole to
`Jue 20 08:00 5 h` — hours conserved on both jobs, nothing invented. A click on the same inert edge with
no travel opened the job panel. On the previous week the past row had **no edge and no action bar at
all**.

*The migration:* `manual_duration = 1` rows come out `locked = 1` (`REMOVED_COLUMNS`, beside
`hand_placed`, same transaction and the same argument). **Re-verified independently by booting the real
app against a database carrying BOTH retired columns** — not through a unit test — with four rows chosen
to cover every combination:

| row on disk before | after the first boot |
|---|---|
| `manual_duration = 1, locked = 0` | `locked = 1`, date / start / duration **untouched** |
| `manual_duration = 0, locked = 0` | `locked = 0` — nothing padlocked by accident |
| `hand_placed = 1, locked = 0` | `locked = 1` (the 2026-08-14 carry-over, still working) |
| `manual_duration = 1, locked = 1` | unchanged, `updated_at` not even touched |

`PRAGMA table_info(blocks)` afterwards is `id, project_id, date, start_time, duration, locked,
created_at, updated_at` — both columns gone — and `GET /api/week` returns block payloads whose key set
contains no `manualDuration`. A **second boot on the same file** re-runs both carry-overs as no-ops and
answers 200 with the schema and the rows identical, which is the idempotence the list is built for.
`ADDED_COLUMNS` is now empty and the comment says that empty is the correct state.

*Closed by removal, not by an answer:* the open question about whether padlocking a hand-set row should
re-open the day its ruler had closed (every noun in it is deleted), and Open Decision 3 (it needed a
movable target; re-measured, the padlocked row now really keeps the length it was given). *Made
broader, and left for the owner:* **Open Decision 4** — every resize is now on the fixed side of the
calendar, so a grown row can sit on another job or on a gap with nothing to separate them afterwards;
measured on a plain Monday with no margins involved. Open Decision 2 is still open and now arrives as a
dialog rather than a silent mark.

**v0.15 — built: a gap is cut at the comida, and no stored row straddles a break any more.** Phase 1 of
the gaps round (2026-08-19), and the STORED SHAPE only. `duration` became NET WORKING MINUTES for a gap
too, segmented over the MANUAL WINDOWS on the way in (`createGap` / `patchGap` → `segmentDroppedRow`), so
a gap may sit in a visual margin and "all day" is 12 h in two rows. The reasoning, the evidence and what
it costs are in § *Gaps Are Cut At The Comida Too*.

- [x] `assertGapFits` cuts first and then asks the day's end (`dayEndMinutes`, 409 `row-past-day-end`,
      keeping the block guard's one latitude) and `findGapConflicts` OF EACH ROW
- [x] `planCloseDay` reports net minutes and the rows it proposes; the form still posts ONE request
- [x] `groupGaps` / `gapSegmentsOf` beside the block pair, `packDay` over units, the seam and the
      `sigue…` marks on the grid, `grid.gapContinuesAbove` / `Below` in both locales
- [x] `data_migrations`, the first data migration: the four `08:00 +11,5 h` Feria rows split, once

Verified on 2026-08-19: `tsc --noEmit` clean, `vitest run` **903 passing across 30 files** (the five
2000-seed harnesses among them, untouched and green), `next lint` clean. Driven over real HTTP against a
scratch database seeded to the SHAPE OF THE SHOP'S FILE — a `gaps` table in clock minutes, no
`data_migrations`, no `settings` — on a port of its own: the four Feria rows came back as eight
(`08:00 +6 h`, `15:30 +4 h`, reason on both), the `2026-08-24 09:00 +1 h` row byte-identical with its
`updated_at` untouched, and each Feria day still reporting `plannableMinutes: 0`. A second boot changed
nothing. Then: a gap aimed at `14:00` stored from `15:30`; `07:00 +12 h` stored `07:00 +7 h` and
`15:30 +5 h`; `08:00 +13 h` refused `row-past-day-end` naming `20:30`; `19:30 +1 h` accepted in the
bottom margin and `20:00 +1 h` refused; a gap wholly in the top margin costing the day nothing plannable;
`13:00` + 5 net hours (what *Cerrar el día aquí* posts) stored `13:00 +1 h` and `15:30 +4 h`, the day
dropping from 10 h to 5 h plannable; 8 h from 10:00 refused by the padlocked `18:00-19:30` it would
have silently covered, and 3 h from 10:00 saving beside it; a padlocked row dropped at 10:00 onto a day
holding both halves of a gap sliding to `17:30`. In a real browser at 1500×950 the two halves draw joined
— `Avería… sigue…` above the seam, `…sigue` below it, dashed edges facing each other, one lane between
them — and a 12 h gap reaches into both margins with nothing drawn over the seam.

*Not built, deliberately:* the gap drag and resize, the absences screen and its date range, the painting
gesture, the bulk-creation warning and the closed-day screen. A gap still opens its form when pressed.

*One thing went wrong while building it, and it is worth the paragraph.* `readWeek(db, MON)` — a `Db`
passed where the reference DATE belongs — let the trailing `db` parameter fall back to `getDb()`, and the
new data migration ran over `data/calendar.db`, the shop's real file, from inside a test run. Nothing was
damaged: it did exactly what it is for, splitting the four Feria rows into `08:00 +6 h` and `15:30 +4 h`
with the reasons kept, touching no block, project or setting (verified by their `updated_at`), and the
result is even correct under a code revert, since the two rows cover the same clock the one row did. But
it should have been the owner's own first boot, and `tsc` would have caught the call: it was run after
`vitest`, not before. `openDatabase` now REFUSES that path whenever `VITEST` is set, with a test of its
own — the house rule became a mechanism.
