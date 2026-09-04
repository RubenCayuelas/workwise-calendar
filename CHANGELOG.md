# Changelog

What changed in each version, newest first, in terms of what is different to use. **Why** a rule is the
way it is lives in [docs/DECISIONS.md](docs/DECISIONS.md); the rules themselves in
[docs/SPEC.md](docs/SPEC.md).

Versions are `EPIC.FEATURE.FIX`: a feature moves the middle number, a correction the last. The first
never moves without the owner asking.

---

## 0.25.4 — Electron update for the desktop app

**The desktop application's framework is updated.** This release bumps Electron to version 44.1.0 to stay up to date. Nothing about how the calendar works has changed.

## 0.25.3 — security updates for the desktop app

**The desktop application's dependencies are updated.** This release bumps `@xmldom/xmldom` and `fast-uri` to fix several security advisories in the packages the installer builds with. Nothing about how the calendar works has changed.

## 0.25.2 — an empty week says nothing

**The paragraph under the grid is gone when the week has no work in it.** It explained where a new job
goes in the queue and what Friday is for, and it sat there for as long as the week stayed empty — which
is exactly when there is nothing to read it against. That sentence still appears where it is useful, on
the form that creates a job. Under the grid now, only a gesture in progress ever speaks.

## 0.25.1 — the installer builds again

**The check that refuses a broken installer now recognises its own files on Windows**, which is the
only machine that ever builds one. It read the paths inside the package as though they were written
the way Linux writes them, so it refused a package that was in fact correct — and 0.25.0 produced no
installer at all.

## 0.25.0 — it keeps itself up to date

**Workwise updates itself now.** When it opens it looks for a newer published version, downloads it
quietly in the background and, once it is ready, asks in one message whether to restart and install it
now or install it the next time the app is closed. Nothing installs while the calendar is on screen,
and nothing installs unasked. No more fetching an installer and carrying it over on a USB stick.

**And it will not install one until it has copied the calendar.** The moment a version has finished
downloading — while the calendar is still the one the previous version wrote — a copy is saved, named
for the update it comes before. **If that copy cannot be saved, nothing is installed**: it says so, and
tries again the next time the app opens. It is saved even with the automatic copies switched off,
because that setting is about how much sits in the folder and an installed update cannot be undone.

**The last three of those copies sit in Settings, beside the weekly ones.** Their own list, each row
saying the day, the hour and the version it comes before, and each restoring with one press like any
other copy. They count on their own, so a busy week of releases cannot use up the weekly copies, and a
quiet month cannot use up these.

**A version only reaches the shop once it has been published.** A release still arrives as a draft, so
the notes get read first; until then the app sees nothing at all. And with no internet, or nothing
published, the calendar opens exactly as it always has and says nothing.

**Going back to an earlier version is still done by hand.** The calendar itself is safe either way,
because the copy is right there in the folder, but the older installer comes from the releases page.

**And the four checks a commit must pass now run before any merge into any branch, not only when a
version is released.** They ran on the machine the change was written on and nowhere else. The build
that makes the installer runs them too, because a version that installs itself unattended raises what
a broken one costs.

## 0.24.1 — one click is one day

**Choosing a single day for an absence takes one click.** The calendar that picks an absence's days
wanted two even when the answer was one day — the same day, clicked twice. A click now answers with that
day, and only an absence that runs longer needs a second one, which stretches it to the day it lands on.

**And the press that closes the calendar is no longer spent closing it.** Pick the day and go straight to
the save button: that press saves. Before, it only shut the calendar and the button had to be pressed
again. Over the week grid it still only closes, because a stray press there starts painting a band.

**And the four documents describe the screen in English.** They quoted its Spanish here and there — a
button, a placeholder's example, the line under a day field — which is how a document ends up half
translated. The wording lives in the language files and nowhere else.

**The ring around today is a circle again.** It was drawn around the number itself, so it sat tight
against the digits and came out a different shape on the 9th than on the 26th. The number now sits
centred inside a circle of its own, and the calendar's rows are a little taller to give it room.

## 0.24.0 — the day comes from a calendar, the hour is typed

**Choosing a day is a calendar now, not a list.** Every form that asks for one — a new job, the scissors,
an absence — shows the day it holds on a button, and pressing it opens the month: six rows of seven,
Monday first, an arrow either side to change month, and a Today button that picks today and closes. The
list it replaces ran to well over a hundred days one after another.

**The month says what it knows about each day.** Today wears a ring; Saturday, Sunday and anything past
are dimmed; a closed day carries the same grey the grid gives its column and, under the mouse, the reason
written on it; and a day the shop can still take work on carries a dot — hover it for the hours still
free. Every one of them can still be chosen, so a closed day picked on purpose is honoured exactly as it
was before.

**The days a form cannot reach now look unreachable.** They are drawn faint and will not take a press,
instead of accepting one and coming back with a refusal after the save.

**Under the field the day is spelled out in full**: the weekday, the day, the month, and the week number
after them. The old list grouped its days by week, and this is what keeps a form and the calendar calling
one day by one name.

**An absence over several days is one calendar.** It used to ask for the first day and the last in two
separate fields; they are one range now, picked in two clicks, and the Saturdays and Sundays the save is
going to skip are drawn as skipped before it is pressed. The count of days that will really be written
stays under the field.

**Every hour is typed.** `08:00` straight into the field, Enter or leaving it to make it count, and the
two buttons beside it or the up and down arrows to move a quarter of an hour — a whole hour with Shift.
The four schedule rows on the settings screen are the same field. Nothing is rewritten behind your back:
an hour that cannot be read stays on screen and says so, an hour already stored off the quarter hour
survives being tabbed past, and the one hour that has bounds — where the day stops when you close it
from the grid — is refused naming the two hours it has to be between instead of being pulled inside them.
An hour the field refuses also holds the save: the message appears under the field and the save button
waits, so what is stored can never be the hour the screen stopped showing.

**The placeholders say what to write.** The name of a job, the reason for a gap and the note on a closed
day each showed a made-up value of the kind the field expects, which reads like something already filled
in. They now say what the field is for.

**An absence stays on the one day it names.** Moving a gap's day back to an earlier one — in the
calendar, or with the button that offers the week you came from — used to save it on every weekday
from the new day to the day it had been on, three days for a band drawn on one, and push work out of
all of them.

## 0.23.5 — the buttons' outlines are quieter

**Every button and icon button rests on a soft grey outline now instead of a near-black one** — 3.2:1
where it was 9.8:1, a third of the contrast. The amber button's rim came down with them, so the row
still reads as one family rather than one loud control among quiet ones. The week arrows, the gear and
a block's hover actions all follow: it is one value for every control.

The firm line is still there wherever it does work — a text field's edge under the pointer, and the
dashed marks a drag draws.

## 0.23.4 — the calendar reaches closer to the bottom of the window

**The dead space under the grid is down from 24 px to 8 px, and the calendar has taken the
difference** — 16 px taller at 1920x1080, so an hour of the day is that much easier to aim at. Half of
what was there was holding a gap open in front of a box with no height in it, which bought nothing.
The rest came off the page's bottom padding. Nothing is cut: the last hour of the axis still ends
inside the frame at every window size.

## 0.23.3 — the week sits in the middle of the window

**The week label and its two arrows are centred on the window now**, instead of in the middle of
whatever room was left between the logo and the buttons — which put them 166 px to the left of centre,
at every window size. On a narrow window, where the row of buttons is wider than its half, the pager
stops 35 px short rather than crowd it; nothing is ever cut.

## 0.23.2 — the amber button has an edge, like every other control

**Every button in the app is a fill inside a hairline now, the amber one included.** It was the only
control drawn with no edge at all, and beside four outlined buttons in the same row it looked
unfinished. Its edge is the brand's dark amber rather than the graphite the white buttons wear, so it
carries the same weight of line without putting a black ring around orange. Pressing a button still
changes only its fill.

This reaches every amber button, not just the header: the save button on each panel, the paint chooser
and settings.

## 0.23.1 — the absences screen is a button, not a menu item

**The `…` menu is gone, and both things it held are on the header.** Absences now sits beside the new
job button with its name on it, and settings is the gear at the end of the row. Nothing else in the
header moved.

That menu was costing more than a click. With nothing on screen saying the shop's time off had a screen
of its own, days off were being entered as jobs instead — which counts hours nobody is going to work,
pushes the *booked until* date further out than the shop really is, and leaves the calendar planning
work into days the shop is shut.

## 0.23.0 — a gap or a job can be started in the middle of a job

- **The leftmost 21 px of a day now CREATE, whatever is drawn there.** A gap of a quarter of an hour at
  11:00 inside a job that runs 10:00 to 12:00 is one drag: press the left edge of the column, pull, and
  answer the question. The job is cut in two around it, the head staying where it was. Before this the
  only way in was the 3 px of background a full-width block leaves beside it.
- **Nothing about the calendar looks different until the pointer is there.** The rail draws nothing: the
  cursor changes, a hairline marks the minute across the row and a badge names it — and that only
  appears where a press would really create, so it never says "create" over pixels that move a row.
- **The free part of a day says it too.** Empty grid space had no cursor and no mark of any kind; the
  same hairline and hour now appear there, which is the first time the paint gesture announces itself.
- **A closed day and the weekend take a band too.** Only the past still refuses. Pressing a dimmed
  column without dragging still opens the screen that reopens the day, so nothing is lost.
- A still press on the rail opens the row underneath, exactly as pressing the row does.
- The band a drag draws is translucent now, so the row it is about to cut stays readable underneath it.
- Dragging an absence onto the middle of a job says it will CUT the job in two, instead of only saying
  it moves its hours aside.
- **The two lines of small print under the grid are gone, and the calendar is 38 px taller for it.** A
  gesture's hint still appears in that corner while the gesture lasts; it no longer holds a strip of
  every screen open to say what the grey bands mean.

## 0.22.1 — closing a day by hand asks the same question

**The absences screen now asks before a close moves any work**, the way the automatic holiday check
already did. One line per day of the range that has work on it, with the hours and the jobs named, and
the same two answers in the same words: move the work on, which stays the default, or keep it where it
is, which padlocks it and closes the day around it. A day whose work is already padlocked has nothing
to choose and says so.

**And the notice says it once.** Each day's line now names where its hours go — the date they land on
when they move, or that they stay put when they do not — and the list of pushed jobs underneath is
gone, because it was saying the same thing a second time. The answer travels with the preview too, so
the sentence about how far the workshop reaches follows what you actually chose.

Until now that screen had stopped refusing but had not started asking, so a close from there moved
work — or closed around work it could not move — without a word.

## 0.22.0 — the town's public holidays close the shop by themselves

**The holidays no longer have to be typed in by hand.** Settings has a new block for them, with the
municipality — Priego de Córdoba to begin with, and any Andalusian town if it is ever needed. From
there the app reads the official labour calendar, closes each holiday and writes its name in the day
header, and looks again once a week, with a button for when it cannot wait. Underneath it always says
how many holidays it holds, how far ahead they reach, and when it last looked.

**A holiday with work on it asks before it moves anything.** Opening the app brings up a list of those
days with two answers each: move the work on, which is what closing a day has always done, or keep it
where it is, which padlocks it and closes the day around it. Work that already carries a padlock has
nothing to choose: the day closes around it and says so. Closing the list without answering writes
nothing.

**Closing a day is no longer refused because there is work on it**, neither here nor from the absences
screen: what can be moved is moved, and what cannot stays with the day closed around it, exactly as a
Saturday already works. Only the past still refuses to be touched.

**What you write wins.** Change a holiday's reason, or close a day yourself, and the app never touches
that day again. It only corrects the ones it wrote and nobody has touched since: it gives them their
real name once it is published — a local holiday gets a generic one until anyone knows what it is
called — and reopens them if they stop being holidays. With no connection nothing is lost: it keeps
what it already knew and tells you when it last tried.

Data: Junta de Andalucía and festivos.io (CC BY 4.0).

**The working agreement now says it in so many words**: everything written is in English — code, the
documents, commit subjects and a pull request — and any wording the server produces is composed from
the locale files in the language being read, never written into a module.

## 0.21.1 — the week arrows are easier to hit

**The two arrows either side of the week are wider.** They were the same 28-pixel square as every
other icon button in the header, and they are the ones pressed most — every week turned goes through
one of them. They keep their height, so the header sits exactly where it did, and the arrow inside is
unchanged: what grew is only the room there is to miss by.

## 0.21.0 — new job colours, and absences that no longer look like jobs

**The eight colours a job can be painted are new**: green, blue, red, yellow, orange, purple, pink
and grey, in that order in the picker. The set the client asked for is seven; the eighth is there
because the app has eight slots and a job more that can be told apart is worth having.

**Two jobs no longer end up looking alike.** The old set held a green and a dark green whose blocks
were, in the tint the grid actually paints, the same colour — and its blue, violet, red, dark green
and grey all went murky against a dark background. Every new value is legible on both, and every pair
is kept apart in the pale fill, which is where two jobs start to blur long before their borders do.

**The yellow is a yellow, not a gold.** It runs a little fainter on a light background than the other
seven do — a yellow bright enough to read as one cannot also be dark enough to hold its border — and
that trade was made deliberately.

**Blocks carry their colour a little more strongly.** The fill behind a job was a very pale wash of
it; it is a touch stronger now, and the colours themselves are slightly more saturated, so a block
reads as its job from further away without the grid turning loud.

**Jobs already on the calendar are repainted when the app next starts**, each to the nearest colour in
the new set, and no two jobs that were different colours come out the same. The one that visibly moves
is a job that was dark green: there is a single green now, so it takes the colour nothing else claims.
The padlock, the hours and the position of every block are untouched.

**An absence is now drawn with diagonal stripes** instead of a flat colour. A gap and a job were the
same rectangle in the same lane, and the only thing separating them was which colour one happened to
be — so an absence read as a job that had been painted grey. The stripes come from the gap colour
itself, a lighter version of whatever is set in Ajustes, so changing that colour carries them with it
and there is nothing extra to configure. The band drawn while painting a new absence is hatched too,
so what is previewed looks like what gets saved. It is only a way of drawing: nothing about how a gap
behaves has changed.

## 0.20.1 — the new-job form closes when the job is created

**Creating a job no longer leaves the form open.** It used to stay on screen with every field greyed
out and one button to close it, and until it was shut nothing else could be done: no second band could be
painted on the grid, and undo was off. The form now closes on the save, and what the engine did with
the hours — the days and times they were born on, and the sentence explaining a padlock the chosen
date left behind — is said in a notice at the corner of the calendar, the same way saving an absence
already answered.

## 0.20.0 — the first release

Everything below 0.20.0 was development; nothing had been published. This is the first version anyone
installs.

**Workwise is a Windows application.** An icon, a double click, the calendar — no terminal, no browser
window, and nothing to install first. The installer needs no administrator, and uninstalling never
touches the calendar or its backups.

**Backups.** Save a copy of the calendar wherever you choose, restore one from the list of automatic
copies or from a file anywhere on the disk, and let it take a copy every few days keeping the last few.
Settings holds the interval, how many to keep, and the folder they live in.

**Runs on Next.js 16.** Nothing about the app changed; it closed five security advisories.

**The documentation is split by what it is for.** `CLAUDE.md` is the working agreement for an agent —
conventions, the data model, the invariants, and where to look. The behaviour specification is
`docs/SPEC.md`, the reasoning `docs/DECISIONS.md`, and this file records the versions.

**`main` only receives releases.** Work happens on `dev`; a pull request into `main` has to come from
`dev` or a `hotfix/*` branch, and `main` cannot be force-pushed or deleted.

## 0.19.0 — undo and redo

Ctrl+Z and Ctrl+Y, many steps deep, over a run of the app. Every mutation is one step, so a refusal
leaves nothing to undo.

## 0.18.0 — painting makes a job too

A band painted on empty grid space now asks whether it is a gap or a job. Choosing a job opens the
ordinary form with the hours pre-filled and pins the work on the exact minute painted.

Growing a job's last row past what its other rows hold now asks whether to add the hours to the
estimate, the way shrinking already asked where freed hours should go.

## 0.17.0 — a long absence is one gesture

The absences screen closes a range of days, or repeats the same gap across it, in one save — a holiday week used
to be one gap typed per day. It previews the hours it will push and which jobs they belong to before
anything is written. A closed day has a screen at last, and its reason shows in the day header.

## 0.16.0 — gaps are dragged and resized

An absence moves and changes length with the same two gestures a padlocked block has. A plain click
still opens its form, and the past stays read-only to both.

## 0.15.0 — no stored row crosses the lunch break

A gap's duration became net working hours, like a block's, so an absence across the break is two rows
drawn as one and "all day" means the hours the shop actually works.

## 0.1.0 – 0.14.0 — the app itself

The engine and its queue, the week view, drag, resize, split, lock and delete, the job panel, gaps and
closed days, Settings, the Friday buffer, the visual margins, work filling a day and overflowing to the
next, the week-change gestures, and Spanish and English throughout.
