# Workwise Calendar

Work scheduling for a small metalworking workshop: how long the shop is booked, what dates are
free, and drag-and-drop to reshuffle. Self-hosted on the shop PC, single user, no auth.

`CLAUDE.md` is the authoritative spec — the business rules there win over anything written here.

## Setup

```bash
nvm install 22
nvm use 22

npm install
npm run dev            # http://localhost:3000
```

There is no database step. `data/calendar.db` (and its WAL sidecars) is created on the first
request that touches the database, and migrations run once per process behind a single lazy
accessor — `getDb()` in `src/lib/db.ts`. `npm run build` deliberately writes nothing: the build
has no business touching the shop's data.

Point `WORKWISE_DB_PATH` at another file to run against a throwaway database.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Vitest suite (engine, repositories, API client, components' pure logic) |
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` | ESLint via `next lint` |

## Layout

- **app/** — App Router pages (`/` is the week view, `/settings`) and the `app/api/*` route handlers
- **src/lib/** — the engine (`composition.ts`, `scheduler.ts`), `operations/` (one transaction per
  write), `repositories/` (SQL), `dates.ts` (all local-date arithmetic), `api-client.ts`
- **src/components/** — `calendar/` (grid, gestures), `jobs/` (side panels), `settings/`, `ui/`
- **public/locales/{es,en}/common.json** — every user-facing string
- **public/brand/** — logo, icons and `workwise-tokens.css` (the colour tokens)

## Conventions

- Code, comments and identifiers in **English**; UI strings **only** in the locale files, read
  through i18n. Spanish is the primary language.
- Time is **integer minutes from midnight** everywhere inside the engine and the components.
  Decimal hours exist only at the database boundary and in what the user reads.
- Dates are **local `YYYY-MM-DD`** (Europe/Madrid), produced only by `src/lib/dates.ts`. Never
  derive a calendar day from a UTC timestamp.
- Styling is plain **CSS Modules** against the brand tokens. Tailwind is not installed. Never
  hardcode a colour — always a token, so a dark theme stays cheap. `<html>` carries
  `data-theme="light"`.
- SQLite driver is **better-sqlite3** (synchronous). Icons are **Tabler**, bundled locally.
- Every mutating operation is one transaction: a refusal leaves the calendar untouched rather than
  half-recomposed.

## Status

Wired end to end: the engine, the API, the week view with drag / resize / lock / split / delete, the
job panel, the absences screen (gaps and closed days), and Settings. `tsc`, `vitest`, `next lint` and
`next build` are all green — **CLAUDE.md § Current Project Status has the version and the test count**,
and it is the only place they are written down, so this file cannot drift from them.

Still open, all recorded in `CLAUDE.md` § Open Decisions: backups (an Export button), one-level undo,
and *añadir otra parte* on the job panel.
