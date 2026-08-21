# Changelog

What changed in each version, newest first, in terms of what is different to use. **Why** a rule is the
way it is lives in [docs/DECISIONS.md](docs/DECISIONS.md); the rules themselves in
[docs/SPEC.md](docs/SPEC.md).

Versions are `EPIC.FEATURE.FIX`: a feature moves the middle number, a correction the last. The first
never moves without the owner asking.

---

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

**`main` only receives releases.** Work happens on `develop`; a pull request into `main` has to come from
`develop` or a `hotfix/*` branch, and `main` cannot be force-pushed or deleted.

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
