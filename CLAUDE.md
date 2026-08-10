# Workwise Calendar - Project Context
*Interactive calendar app to track and distribute work hours across project clients and weekdays.*

## Objective
App to log estimated/actual hours for various client projects and distribute them across the week,
making it easy to see when there's capacity for more work.

## Architecture
- Web app, self-hosted locally (client's PC). No multi-device or cloud support needed right now,
  but keep frontend and backend separated (API + client) to allow cloud migration later.
- Single user (possibly an assistant in the future). No auth/roles required yet.
- Recommended stack: all JS/TS (avoid mixing with Ruby/PHP — single runtime locally is simpler).
  Suggested starting point: Next.js + SQLite.
- Developer's explicit priority: simplicity over optimization. This is their first app of this kind.

## Internationalization (i18n) Strategy
- **Primary language**: Spanish (es) — initial UI/UX will be developed in Spanish.
- **Multi-language support**: The app MUST be architected to support language selection at any time.
  All UI strings, labels, messages, and docs must be externalized (e.g., i18n JSON files).
- **Implementation approach**: Use i18n library (e.g., next-i18n-router or i18next) to manage
  translations. Store translations in structured JSON files (e.g., `public/locales/{lang}/common.json`).
- **Code convention**: All code comments, variable names, function names, and internal documentation
  must be in English. Only UI-facing strings go into translation files.

## Data Model
- **Client** (id, name) — 1 to N with Project
- **Project** (id, client_id, name, color) — 1 to N with Task
- **Task** (id, project_id, name, estimated_hours, actual_hours) — 1 to N with Block
- **Block** (id, task_id, date, start_time, duration, locked) — the actual unit placed on calendar.
  Normally a Task has 1 Block, but can have multiple, non-contiguous blocks on different days when
  the user manually splits a task (see rules below).
- **Gap** (id, date, start_time, duration, reason) — independent of client/project, occupies
  calendar space like a Block, with mandatory reason/justification.

## Composition Engine Business Rules
- Default workday: 8h. Mon–Thu auto-fill; Fri and weekends do NOT auto-fill by default but accept
  manually placed tasks — once moved manually, they're protected from future auto-composition
  (like implicit locking).
- If an edited task doesn't fit the day: by default it overflows to the next day. User can opt
  per-task to expand capacity (stack up to 10h+) instead of overflowing, to avoid missing deadlines.
- A locked Block (fixed date/time) does NOT act as a wall: flexible blocks of that day flow around
  it normally; the cascade doesn't stop there.
- No overlaps ever: each day is a strictly sequential queue of blocks/gaps.
- "Splitting" a task (inserting a priority task in the middle of an already placed task) is a
  MANUAL user action (drag & drop), not something the engine does automatically. Doing so simply
  creates a second Block for the same Task — the model already supports this without changes.
- Gaps: point-in-time for now, no recurrence (can be added later without schema changes).

## Current Project Status
- Architecture and business rules finalized (all above). The per-day composition algorithm is
  validated with a proof-of-concept (`recompose-poc.js` in this directory), covering: default
  overflow vs. stacking extra hours, a locked block that doesn't act as a wall, and a task split
  into two blocks with another inserted in between.

## Next Steps
1. Chain `recomposeDay()` into a weekly function that passes overflow from one day to the next
   (Mon–Thu), respecting that Fri/weekends don't auto-fill.
2. Integrate Gaps into the engine (behave like flexible blocks without `task_id`).
3. Set up technical skeleton (Next.js + SQLite).
4. Wireframe weekly calendar interface (drag & drop blocks).

## Notes for Development
- Before writing app code, review `recompose-poc.js` — it already contains validated placement logic;
  the real implementation should derive from this, not reinvent it.
- Any change to the business rules above must also be reflected in this file.
- **All code, comments, variable names, and internal docs must be in English.** Only UI-facing
  strings go into the i18n translation files.
