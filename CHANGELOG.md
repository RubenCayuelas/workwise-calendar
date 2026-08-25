# Changelog

What changed in each version, newest first, in terms of what is different to use. **Why** a rule is the
way it is lives in [docs/DECISIONS.md](docs/DECISIONS.md); the rules themselves in
[docs/SPEC.md](docs/SPEC.md).

Versions are `EPIC.FEATURE.FIX`: a feature moves the middle number, a correction the last. The first
never moves without the owner asking.

---

## 0.21.1 — the week arrows are easier to hit

**The two arrows either side of the week are wider.** They were the same 28-pixel square as every
other icon button in the header, and they are the ones pressed most — every week turned goes through
one of them. They keep their height, so the header sits exactly where it did, and the arrow inside is
unchanged: what grew is only the room there is to miss by.

---

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

---

## 0.20.1 — the new-job form closes when the job is created

**Creating a job no longer leaves the form open.** It used to stay on screen with every field greyed
out and one `Cerrar` button, and until it was shut nothing else could be done: no second band could be
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

`Ausencias` closes a range of days, or repeats the same gap across it, in one save — a holiday week used
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
