# The day and time pickers, and the placeholders — design

**Branch** `feat/pickers-and-placeholders`, cut from `dev` at `a3920c7`.

## What changes for whoever uses the app

Three things.

**The placeholders stop looking like typed values.** Today three of the four are examples —
`Puerta metálica`, `Avería del torno`, `Feria` — in fields that already carry their label above them.
They become a statement of what to type.

**The day is chosen on a calendar, not from a list.** The dropdown offers between 84 and 140 options
in a row today. It becomes a button holding the chosen day, which opens the month grid.

**The time is typed.** The dropdown offers 96 quarter-hours today, from `00:00` to `23:45`. It becomes
an `HH:mm` field that is typed into, with `−`/`+` and `↑`/`↓` moving by a quarter of an hour and
`Shift` by an hour.

None of this changes an engine rule. No datum is stored differently.

## What the owner decided

Settled in the conversation of 2026-08-25. **It is not asked again.**

| question | answer |
|---|---|
| What a placeholder says | **It instructs** what to type. Not an example, not `p. ej. X` |
| Which of the two rounds of wording | The **second** (the imperatives, shorter) |
| Changing the `Motivo` label as well when closing days | **No**. One label, not two to keep in step |
| How the day is chosen | **The month calendar in a popover** over a button |
| How far it navigates | **The same as today**: 4 weeks back, the horizon forward, capped at 16 weeks |
| What is marked on the grid | **Today**, **the weekend**, **closed days**, and **which days still have room** |
| How a closed day looks | **The grid's grey**, and its stored reason on hover |
| What the dot means | **Nothing that has to be explained**: there is room. On hover, the free hours |
| An absence's `Desde` / `Hasta` | **A single range calendar** |
| The week label | **Under the field**, if it comes out simple and safe |
| How the time is chosen | **It is typed**, with `−`/`+` and `↑`/`↓` |
| When what is typed takes effect | **On Enter or on leaving the field.** The buttons and the arrows, at once |

Two of these answers correct a sketch of mine: hatching for closed days is **not** used, and the room
dot carries **no** definition on screen.

On the hatching, the reason changed halfway through, and for the better. This branch was rebased onto
`origin/dev` at `8669fea` while the plan was being written, and that `dev` brings a new rule: **a gap
IS hatched** (SPEC § *Calendar View*, DECISIONS § *A Gap Is Hatched, the Lunch-Break Band Is Not*). Far
from contradicting this, it sharpens it — the decision itself says why: a gap is hatched because it is
**a rectangle inside a lane that has to be told apart from the block beside it**, while the lunch band
is left plain because **it crosses all seven columns in the part of the day that carries no
information**, and decorated it became the first thing the eye found. The picker's 42 cells are the
second case, not the first: they have no neighbour to be confused with, and there are many of them. And
a closed day on the grid is already a grey (`.columnClosed`), not a hatch. So the picker says
«cerrado» with that same grey, and hatching stays for what it means: a gap.

## The tone: minimal, clean, and of the same family

Asked for by the owner on 2026-08-25: *«lo quiero minimalista, limpio y que encaje con el diseño
general de la app»* — minimal, clean, and fitting the app's general design. That is not decoration of
the document; it decides things:

- **Not one colour by hand**: everything through a token from `public/brand/workwise-tokens.css`, as
  CLAUDE.md requires, so the dark theme keeps coming out free. Tabler icons, the ones the rest already
  uses.
- **Half-pixel borders and `--radius` corners**, like any card or panel in the app.
- **No legend and no explanatory labels.** Whatever a day has to say, it says on hover, which is how
  each day's header on the grid already works. And no hatching: the hatch already means «un hueco» — a
  gap — in this app, and meaning it here in another way would be a new language.
- **One single help line under the field**, never two.
- **Lower case where the language asks for it**: `agosto 2026`, not `Agosto 2026`. The weekdays as
  their single letter — `L M X J V S D` — from `Intl` and not from a hand-written list.
- **No new state to learn.** The six marks are the ones the owner asked for and not one more, and every
  one of them can be clicked.

## The four placeholders

| key | today | becomes |
|---|---|---|
| `jobPanel.namePlaceholder` | `Puerta metálica` / `Metal door` | `Ponle un nombre que reconozcas` / `Give it a name you will recognise` |
| `jobPanel.descriptionPlaceholder` | `Notas, medidas, material…` | **unchanged**: it already names categories, not a value |
| `gapForm.reasonPlaceholder` | `Avería del torno` / `Lathe breakdown` | `Qué ocupa esas horas` / `What takes up those hours` |
| `absenceForm.notePlaceholder` | `Feria` / `Fair` | `Por qué cierras esos días` / `Why you are closing those days` |

`gapForm.reasonPlaceholder` is the text of three forms at once — editing an absence, closing the day
here, and the *Un hueco* mode — so it cannot name «the day»: it would be a lie in two of the three.
`absenceForm.notePlaceholder` appears only in *Cerrar días*, where the text goes to
`day_overrides.note` and the day header prints it in place of the word `cerrado`.

**A consequence that will be seen**: the examples stay on screen on the mode cards
(`absenceForm.modeGapHint` = «Unas horas del día: una avería, gestiones, media tarde.» and
`absenceForm.modeClosedHint` = «Vacaciones, feria, festivo: el día entero, sin horas planificables.»),
but **those cards are only drawn in the multiple mode**. In the single-absence form and in the
close-the-day form no example will be left. Judged acceptable: both already explain themselves in three
help lines of their own.

## `DayPicker` — the day picker

Replaces `DateSelect` in its four places: `NewJobPanel:393`, `AbsencePanel:571` (`Desde`),
`AbsencePanel:619` (`Hasta`) and `SplitBlockPanel:236`.

### The trigger

A `<button type="button">` with the day already written by `format.dayOption(value)` — `Mié 12 ago`,
the same string as today — and `Field`'s chevron. It inherits the generated id, the `aria-describedby`
and the invalid ring from `Field`, and it respects `disabled`.

**It carries no `aria-label`.** For a button the accessible name comes from `aria-label` before its
content, and `<label for>` does not enter that calculation: an `aria-label` would erase both the
field's name and the chosen date at once. It carries `aria-labelledby` pointing at the `Field`'s label
and at its own id — «Desde, Mié 12 ago» —, `aria-haspopup="dialog"`, `aria-expanded`, and
`dayPicker.open` as `title` only. The chevron is `aria-hidden`, like `Select`'s.

Just as `ColorSwatches` receives `label={t('jobPanel.color')}` because a `radiogroup` cannot carry the
generated id, `DayPicker` receives the label's id from the place that uses it.

### The line under the field

**One single line**, not two: `miércoles 12 de agosto · Semana 33`, joined with `units.listSeparator`
— « · » — the way a day's header composes its own today. It comes out of `format.longDate`, out of the
number `isoWeekNumber` already computes, and out of **one new key** `units.week` = «Semana {{week}}»:
the one that exists, `header.week`, carries the date range inside it and is redundant here, because the
long date already says it.

What it does is the one thing that was lost by dropping the list: the dropdown grouped the days under
the week label **exactly as** the grid header does, so that a form and the grid could not call one and
the same day two different things. `Semana 33` keeps that without repeating the date range, which the
long date already says.

It goes in the three single-day pickers. Not in the range: that slot carries the day count. And `Field`
replaces the help with the error when there is an error, so the line disappears exactly when a date is
being refused — which is right, and what the rest of the app already does.

### The grid

Six rows of seven cells, **always six**, Monday first. A weekday header from `Intl` through `format`.
The month and the year as the title. `‹` and `›` to change month. A `Hoy` button that **picks today and
closes**, like any other cell — it does not merely navigate.

Six fixed rows and not five or six depending on the month: that way the popover's height is a constant
and the clamping against the window is pure arithmetic with a test, instead of a measurement.

### The marks

| day | how it looks | where it comes from |
|---|---|---|
| the chosen one | the cell filled | from the value itself |
| today | a ring around the number | `today`, which already reaches the three panels |
| Saturday and Sunday | the number dimmed | `isWeekend`, on the client |
| the past | the number dimmed, the same as the weekend | `compareDates(date, today) < 0`, on the client |
| closed | the cell's **background** in grey, the same `--ww-surface-alt` the grid paints a closed column with | from the server |
| with room free | a dot under the number | from the server |

Two channels and not three: the **number** dims when the engine does not work that day because of the
calendar (weekend, past), and the **background** goes dull when the shop is closed by the owner's
decision. A closed Saturday carries both, which is the truth.

**Every one of them can be chosen.** No mark disables anything: DECISIONS § *A Closed Day Chosen As A
Start Date Is Honoured* records the owner's decision, «Dejar elegirlo, pero cumplirlo de verdad» — let
them choose it, but honour it for real.

**On hover, the cell says whatever that day has to say**, composed with `units.listSeparator` out of
keys that already exist: `format.dayOption`, and then `day.today`, `day.weekend`, `day.closed` or the
day's stored reason, and `day.freeHours` = «{{hours}} h libres» or `day.full` = «Día completo». It is
exactly how `DayHeader` composes its own `title` today.

**There is no legend.** The owner did not ask for one, and each cell's `title` teaches the marks better
than a line of small print in a narrow popover.

### The dot, and why this arithmetic and not another

The dot means one thing only: **the engine still places hours here**. Its absence asserts nothing.

The two figures that already exist on `WeekDay` are no use, and their own comment says why they answer
different questions: `plannableMinutes` does not subtract the work already sitting there, so it would
put a dot on a Tuesday the grid draws full; `bookedMinutes` would say «full» about a day the engine is
going to clear on the next write, which is a state the owner did not choose. Per date, inside the new
operation:

```
freeMinutes = max(0, plannableMinutesOf(snapshot, date)
                     − Σ durationMinutes of that day's movable blocks)
longestRun  = max(freeStretchesFrom(config.periods, that day's gaps and blocks))
hasRoom     = date <= horizonEndDate(...) && min(freeMinutes, longestRun) >= MIN_ROW_MINUTES
```

Every term has its reason. Subtracting the movable minutes is the engine's own arithmetic: `openDay`
starts the day at `plannableMinutes` and `planTake` draws it down, and the day's movable rows are
exactly what the last pass spent that budget on. The quarter-hour floor is SPEC § *Fill and Overflow,
Always*: a day whose 40 free minutes are four holes of ten has no room the engine is going to use. And
the horizon has to be checked separately because `buildDayPlan` does not know it: without that, a day
beyond the horizon declares all of its minutes plannable and the dot would promise space in exactly the
days that produce the `horizon-exceeded` refusal.

As a bonus, the marks' consistency comes out of a single line: `buildDayPlan` returns zero plannable
minutes for four reasons at once — a past date, a closed day, a `manual` day, a shift of zero minutes —
so **a weekend, a closed day and a past day are left without a dot with no further code**, and the dot
cannot contradict the grey they already carry.

### How far it reaches

`planningWindow` still rules: 4 weeks back from this week's Monday, the horizon forward, capped at 16
weeks. The `‹ ›` arrows go dead at that window's edges.

The window almost always falls mid-month, so the grid draws days the window does not offer — for a
today of 2026-08-12 with horizon 8, the window is 2026-07-13 … 2026-10-04, and July has twelve days
outside it. **Those days are drawn dull and cannot be clicked.** It is exactly the set of days
reachable today: if they could be clicked, forward the save answers 409 `horizon-exceeded`, and
backward a job's start date writes past, locked rows the owner did not want.

A stored value **outside** the window is kept, as today: the popover opens on its month and that cell
can be clicked; the rest of that month cannot.

### The range mode

Only in the absences panel's multiple mode, where there are two fields today. One `Field` with one
calendar, and with an error slot of its own.

Four things that have to be respected, each with its defect behind it:

1. **The error needs somewhere to go.** `localError` is drawn nowhere except in the `error=` of the
   five `Field`s. Merging `Desde` and `Hasta` would remove the only slot where `errors.rangeBackwards`
   and the server's 400 `invalid-range` appear — and `Guardar` would go silent, writing nothing and
   saying nothing. The range's `Field` carries `error={errorFor('date') ?? errorFor('endDate')}`, and
   `API_FIELD` still maps `from → date` and `to → endDate`.
2. **The server skips Saturdays and Sundays** inside the range, unless the whole range is a weekend. A
   stretch painted Monday to Sunday would paint seven cells while the write makes five. Weekend cells
   **inside the stretch are painted as excluded**, and that is decided with the same pure function the
   server uses (`absenceRange`), never re-derived in the component.
3. **The day count stays where it is**, under the field: it is not the count of cells in the stretch,
   it is the one the preview says is going to be written. That is why the week label does **not** go in
   the range mode — that slot already has a job. While the second end is missing, the popover says
   `dayPicker.rangePending` inside itself, not in the form.
4. **The first click does not leave the calendar.** The popover keeps the pending end and only calls
   `onChange` when it has both. If the first click wrote `date` and `endDate`, every click while
   browsing the month would fire `previewAbsence`, which is a real write inside a transaction that is
   rolled back, announcing displaced work for a half-chosen range. And if it left `endDate` unset,
   `rangeValid` would fall over, the preview with it, and the `Reabrir` button would disappear
   mid-selection.

The second click closes the popover. The two ends always come out ordered, so
`compareDates(endDate, date) >= 0` cannot be broken from here and `errors.rangeBackwards` becomes
unreachable through the calendar — the error slot stays for the server's 400, which two clicks do
reach (`MAX_ABSENCE_DAYS` = 120).

### When it tells the form

**On the click, immediately**, in the three single-day pickers. Not on closing the popover: the panels
set the date optimistically because the band painted on the grid has to follow the field, and a field
frozen behind a question would freeze the band mid-edit. The four contracts around it are kept intact:
the `lastVisible` note for the week warning, `NewJobPanel`'s `setForce(false)`, the `Hasta` that is
dragged forward in `AbsencePanel`, and the `disabled` while a save is in flight.

The range mode is the justified exception of point 4 above: there is no painted band there — painting
only opens the single-absence form, never the range.

### The keyboard

The arrows move the focused cell; `Home` and `End`, to the ends of the week; `Page Up` and `Page Down`,
by month; `Enter` chooses; `Escape` closes and returns the focus to the trigger. On opening, the focus
goes to the selected cell.

**The arrows are swallowed.** The trigger becomes a `<button>`, and `isTypingTarget` only recognises
`INPUT`, `TEXTAREA`, `SELECT` and `contenteditable` — with a `<select>` the week pager skipped it
twice; with a button, the only thing that would stop the week turning under an open calendar today is
`CalendarScreen` looking at whether a panel is open, which is coincidence and not contract.

## `TimeField` — the time picker

Replaces `TimeSelect` in its seven places: the four shift rows in Settings, an absence's start time,
the moment of closing the day, and the scissors' time. It is built on the `Input` that already exists,
so it inherits `Field`'s wiring without touching anything.

### How it behaves

- **It draws its own string**, not the result of `format.time`. Putting every keystroke through
  parse→format would rewrite `8:00` to `08:00` under the cursor, and `formatTime` fails soft: out of
  range it writes a diagnostic to the console and returns `--:--`, which is the exact opposite of
  «whatever is not understood stays in sight». `format.time` has one use in the control: the two hours
  named inside a refusal. The initial value and the result of the buttons and the arrows come from
  `minutesToHHmm`.
- **What is typed takes effect on `Enter` or on leaving the field.** `−`/`+` and `↑`/`↓` take effect at
  once, by a quarter of an hour, and with `Shift` by an hour.
- **Only what has actually been changed is snapped to the quarter**, comparing against the value that
  was there on entering the field. Snapping on every exit would move an `08:10` saved by hand with
  nothing more than a tab across it: `changedFields` compares strings, so `08:10` → `08:15` would enter
  the patch, and a Settings save recomposes the calendar and empties the undo line. It is the exact
  defect `timeOptionMinutes`'s comment exists to prevent.
- **An unreadable value stays in sight** with the invalid ring and `errors.invalidTimeFormat`, never
  replaced.
- **The ceiling is `23:45`**, the last quarter, which is what the dropdown could emit.
  `hhmmToMinutes` reads `24:00` as 1440, and with that the band stops being drawn with no explanation
  while the field looks legal.
- **The bounds refuse in sight; they do not clip in silence.** The only place that passes bounds is the
  moment of closing the day, and they are the working periods: clipping would turn an `18:00` that was
  typed into `17:45` — a value changing under the owner, which is what the off-grid-value rule forbids.
  Not clipping would let `23:00` be typed and reach a dead end with `Guardar` disabled. It is refused
  with `errors.timeOutOfBounds`, which says between which hours it has to be.
- **`Escape` inside the field reaches the panel and closes it**, just as it does today inside the name's
  `Input`. There is no state to revert: a hidden buffer of «what was there before» would be a third
  state to explain.

None of this touches the quarter-hour grid: `TIME_STEP_MINUTES` is still 15 and is still tied by test
to `SNAP_MINUTES` and to `MIN_ROW_MINUTES`.

## The new read route

The two marks the client cannot deduce — closed, and room free — only the server knows, and today they
arrive only for the seven days of the week on screen.

- **`GET /api/days?from=&to=`**, in `app/api/days/route.ts`, wrapped like the calendar's and
  `dynamic = 'force-dynamic'` like all its sisters.
- **`readDays(from, to, db)`** in `src/lib/operations/views.ts`, beside `readWeek`, so the logic sits
  where it can be tested. It reuses `listDayOverridesBetween`, which already exists and is already the
  source of `readWeek`'s reasons, and `createDayConfigResolver`, so the picker's grey cannot disagree
  with the grid's.
- **It returns per day what the client cannot deduce**: `date`, `isClosed`, `note` and `freeMinutes`
  (plus `hasRoom`, derived from the formula above). Neither the weekend nor the past travels: they are
  computed on the client.
- **A cap of its own**, `MAX_DAY_MARK_DAYS = 200`, neither the absences' nor the options'.
- **One single request when the popover opens**, covering the whole navigable window, not one per month
  arrow.
- **It is fired off the week's revision.** `useWeek` already reloads after any write because a
  recomposition rewrites rows in weeks the response does not even mention; the marks hang off that same
  counter, with their own `AbortController`.

**Cost**, counted against `readWeek`: one `readSnapshot` and one `listDayOverridesBetween`, the same as
the week, and then 42 `getDayConfig` and 42 `plannableMinutesOf` where the week does 7 — each
`plannableMinutesOf` is a `buildDayPlan` over the snapshot. In exchange it builds none of the rest the
week does: the blocks with their labels, the projects, the gaps, the summary and the undo state.
Acceptable for a local single-user SQLite, and CLAUDE.md asks for simplicity before optimisation. If it
is ever measured slow, what has to be cut is the range, not the formula.

**Accepted risk**: it is a second snapshot. The panel has no scrim on purpose — the owner edits while
looking at the calendar — so between a write behind the panel and its reload the dot can be an instant
behind the column beside it. The owner approved it knowing that.

**Designed for the automatic public holidays** being built on another branch: sending `note` from the
start is what will let the grey name the holiday without changing the route, and keeping it by range is
what makes it serve holidays written far beyond the 16-week cap.

## The pure modules, and what is tested

The tests run in Node with no DOM (`environment: 'node'`, only `src/**/*.test.ts`) and nothing is ever
rendered in this repository. The pattern already established is a sibling module in `.ts` —
`dateOptions.ts`, `timeOptions.ts`, `stepper.ts`, `offWeek.ts`, `draftBand.ts`, all of which open by
saying «so it can be tested without a DOM» — and even the drag is tested through exported pure
functions.

| new module | what it decides |
|---|---|
| `monthGrid.ts` | which 42 dates a month's grid holds, Monday first, and which marks come out without the server |
| `monthReach.ts` | which month the popover opens on, and how far the arrows reach |
| `dayPickerKeys.ts` | the keyboard movement, over a structural event and not a DOM one |
| `dayRange.ts` | the range's state machine, in the shape of `paintSession.ts` |
| `pickerDays.ts` | the grey and the dot out of the server's two figures |
| `timeField.ts` | parsing, snapping, stepping, and what each of the three moments stores |
| `popoverBox.ts` | the clamping against the window, with the six rows' constant height |

`src/lib/dates.ts` needs four month helpers that do not exist today — the start of a month, the days in
a month, adding months, and the month of a date; they go there because that module is the only one
allowed to turn parts into an instant, and it already has the lever: `formatDate({year, month, day: 0})`
normalises out-of-range parts. In `src/lib/format.ts` and `useFormat`, the long month and the short
weekday for the header, from `Intl` and never from a hand-written list.

**What is left without a test, said rather than assumed**: opening and closing the popover, the
`Escape`, the click outside, the focus order, the portal and its layer, the accessibility wiring and the
invalid ring. `DateSelect` and `TimeSelect` have not one component test today either, so it is not a
regression — but it is a good deal more surface uncovered, and that is why everything decidable comes
out into a module.

## The popover mechanics

It would be the app's first shared popover, so every piece is a choice.

- **A portal to `document.body`**, like `SidePanel`: the grid has `overflow: auto`, the column
  `overflow-x: clip` while it slides, and the week-change animation applies a `transform`, which
  creates a stacking context and a containing block for any `position: fixed` inside it for its 180 ms.
- **A new token, `--ww-z-popover: 45`**, beside the other three. Reusing the panel's 40 would be a tie
  that mount order resolves: today the popover wins by luck, and it would invert as soon as something
  mounted a portal in between. The 45 states the two orderings that are needed: the calendar paints
  over the panel it sits in, and a confirmation paints over the calendar.
- **`Escape` on `window`, in the capture phase, with `stopPropagation`.** `SidePanel` listens on
  `document` in the bubble phase, and two listeners on the same node in the same phase cannot be
  ordered — which is why `closeOnEscape={!confirmOpen}` exists, and had to be threaded by hand through
  three panels. Capturing on `window` runs before the event descends, so the panel never sees the key.
  It is the shape `PaintChooser` and the two gesture hooks already use. **Cost across the eleven
  places: zero.**
- **`pointerdown` on `window`, in capture, swallowed.** The defect is measured in `PaintChooser`:
  «without this, the press that dismisses this lands on the column underneath and starts a second
  band». And the grid stays alive behind the panel on purpose, so it could also open another job's
  panel. Five branches: inside the popover, it passes; on the trigger, it is swallowed and the popover
  closes (portalled, letting the `click` through would reopen it and the popover would look as if it
  never closes); on the grid, swallowed; on another field of the same panel, swallowed — one press
  closes, the next does what it says; and it is not filtered by button, since a right click dismisses
  too.
- **Leaving by tab** fires no pointer event: it is covered with a `focusout` on the box, closing when
  the destination is neither inside it nor on the trigger.
- **Fixed to the window and clamped there**, like `.paintChooser`, so as not to cover the band the
  field is moving — the popover opens to the left of the panel, over the columns, which is exactly
  where the band is. With six fixed rows the height is a constant and the clamping is pure arithmetic.
- **The focus** goes to the selected cell on opening and returns to the trigger on closing, always
  explicitly: `preventDefault()` on the `pointerdown` suppresses the implicit focus move. There is no
  focus trap anywhere in the app, and that is deliberate.
- **Export `useFieldBinding`** from `Field.tsx` and from `ui/index.ts`: today it is private to the
  module, and `DateSelect`/`TimeSelect` inherit the wiring only because they render the `Select` that
  lives right there.

## What dies and what survives

| piece | what happens to it |
|---|---|
| `DateSelect.tsx`, `TimeSelect.tsx` | they die, and leave `ui/index.ts` |
| `dateOptions.ts` | `planningWindow` and the four constants stay as they are; `dayOptionDates` and `groupDaysByWeek` die |
| `timeOptions.ts` | `TIME_STEP_MINUTES` and `clockMinutes` stay; `timeOptionMinutes` dies and its two real properties move to `timeField.ts` |
| `Field.tsx` | `Select` stays; `SelectOptionGroup` and the `groups` prop are left with no user at all |
| `dateOptions.test.ts` | the `planningWindow` part stays; the lists part moves to `monthGrid`/`monthReach` |
| `timeOptions.test.ts` | **the test that ties `TIME_STEP_MINUTES` to `SNAP_MINUTES` and to `MIN_ROW_MINUTES` is not touched**: it is the only thing holding the quarter-hour grid |

`TIME_STEP_MINUTES` cannot be renamed or deleted with the rest: that would untie the grid in silence.

## The new keys

A `dayPicker` block with `open`, `previousMonth`, `nextMonth`, `today`, `todayHint`, `rangeStart` and
`rangePending`; a `timeField` block with `earlier`, `later` and `hint`; `units.week`; `day.weekend`
beside the day's other state words; and in `errors`, `invalidTimeFormat` and `timeOutOfBounds`. The two
key sets are held identical by test, interpolations included.

`timeField.hint` — «Escríbela, o muévela con ↑ y ↓ de cuarto en cuarto; con Mayús, de hora en hora.» —
is drawn as the field's `title`, **not** as the `Field`'s help: four of the seven places are the shift
rows in Settings, which sit inline, and there the help takes a whole row to itself — four identical
copies would add four lines to that screen. It is said once.

No more are needed: a cell's `title` is composed of `format.dayOption`, `day.today`, `day.weekend`,
`day.closed`, `day.freeHours` and `day.full`, which already exist, and the rest of the line under the
field comes out of `format.longDate` and `isoWeekNumber`.

## What is owed to the documents

- **SPEC § *Visual Design*** is rewritten: today it names the two controls and their mechanics. The
  prohibition above it — «No native `<input type="time">` or `<input type="date">` anywhere» — stays
  exactly as it is, because it is the reason this is built by hand.
- **SPEC § *The Absences Screen — One Place, Two Modes***: it says the two modes share
  `Desde`/`Hasta`. Now they share one range calendar.
- **SPEC § *Settings***: the shift rows are typed.
- **SPEC § *Calendar View***: the picker's new marks.
- **SPEC § *A Date That Leaves the Week On Screen***: the date is still set optimistically, and that
  has to stay true of the new control.
- **DECISIONS**: one entry per decision, each in the shape the test demands — the first non-empty line
  after the title starts `**Rule** — ` with an em dash, and there is a `**Why**`. There are four: the
  time that is typed (that is where «Permite escribir para no hacer 2000 clicks para ir de 00:00 a
  23:45» goes), the month calendar with its reach, the marks and the dot, and the range chosen in one
  go.
- **CLAUDE.md**: the *Implementer Default* for the picker's reach is still true and is not touched.
- **Version**: it is a feature, so `0.21.1` → `0.22.0` in `package.json` and in
  `desktop/package.json`, with its `## 0.22.0 — …` entry at the top of the CHANGELOG, written in terms
  of what is different to use.
- `npx vitest run src/lib/docs.test.ts` after touching any of them.

## The four gates

`tsc --noEmit`, `vitest run`, `eslint .` and `next build`, all green before any commit. This branch's
starting baseline, measured after the rebase onto `origin/dev` at `8669fea`: 44 files,
1178 tests, 0 failures.
