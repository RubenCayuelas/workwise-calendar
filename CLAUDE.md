# Workwise Calendar - Project Context

**Workwise** is a simple work scheduling app for a small workshop.

## Objective

Help the workshop owner see how long the workshop is booked and what dates are available for new jobs.
Track work blocks sequentially across the week, automatically respecting capacity, locks, and gaps.
Enable quick visual reorganization via drag & drop.

## Architecture
- Web app, self-hosted locally (shop PC).
- Single user (just the shop owner for now).
- Stack: Next.js 15 + TypeScript + SQLite.
- Priority: **simplicity over optimization**. 
- Code in English, UI in Spanish (i18n-ready for future languages).

## Internationalization (i18n) Strategy
- **Primary language**: Spanish (es) — initial UI/UX in Spanish.
- **Multi-language support**: The app must support language selection at any time.
  All UI strings externalized to i18n JSON files (`public/locales/{lang}/common.json`).
- **Code convention**: All comments, variable names, functions, internal docs in English.
  Only UI-facing strings in translation files.

## Data Model

**Simplified model for workshop workflow:**

- **Project** (id, name, color, total_hours, created_at, updated_at)
  - Represents a single **job/work order** (e.g., "Metal door structure", "Railing", "Staircase")
  - `total_hours`: Estimated duration. Edited when work progresses or estimate changes.
  - `color`: Visual identifier on calendar (e.g., #FF5733 for red project)
  - No status, no deadline, no client tracking (out of scope)

- **Block** (id, project_id, date, start_time, duration, locked, manually_placed, created_at, updated_at)
  - Represents a **time slot on the calendar** where part of a project sits
  - `date`: YYYY-MM-DD (e.g., "2025-01-13" for Monday)
  - `start_time`: HH:mm (e.g., "09:00")
  - `duration`: Hours as decimal (e.g., 2.5 for 2h 30min)
  - `locked`: Boolean. If true, block won't move during auto-recomposition, but user can manually move/edit it
  - `manually_placed`: Boolean. Tracks if block was drag-dropped by user to Fri/weekend (affects auto-composition rules)
  - **One Project can have multiple Blocks** across different days (e.g., Job A = Mon 2h + Tue 2h + Wed 1h)

- **Gap** (id, date, start_time, duration, reason, created_at, updated_at)
  - Represents a **break/hole** in the schedule (lunch, admin, maintenance, etc)
  - `reason`: Optional text (e.g., "Lunch", "Equipment repair"). Can be empty.
  - All gaps have the same visual color (configurable in settings, e.g., gray)
  - Treated as fixed occupancy in calendar, no auto-recomposition

---

## Work Schedule Configuration (Settings)

**Configurable by the workshop owner:**

The workshop operates with a **split shift (jornada partida)** structure by default:

- **Period 1 (Morning)**: Start "08:00", End "14:00" (mandatory)
- **Period 2 (Afternoon)**: Start "15:30", End "19:30" (optional, toggle via checkbox)
  - The gap between periods (14:00-15:30) is visually implicit (lunch break). No explicit "gap" record is auto-created.
  - If Period 2 is disabled, the workday ends at Period 1 End.
- **defaultDayCapacity**: Default 10 hours (6h morning + 4h afternoon when Period 2 active)
  - Range: 1-12 hours
  - If Period 2 is disabled, capacity = Period 1 duration (6h in this case)
- **Visual Margins** (for flexibility in exceptional cases):
  - `visualMarginTop`: Default 1 hour before Period 1 Start (e.g., 07:00 if Period 1 starts 08:00)
  - `visualMarginBottom`: Default 1 hour after Period 2 End (e.g., 20:30 if Period 2 ends 19:30)
  - Margins accept **manual drag-drop only**, no auto-composition
  - Range: 0-2 hours per margin
- `gapColor`: Color hex for all user-defined gaps (e.g., "#CCCCCC" gray)

All configuration values are user-editable in the Settings screen and apply to Monday-Friday (extendable to weekends if needed).

**Calendar Timeline Display:**
```
07:00 ├─ Visual Margin (manual drag-drop only)
08:00 ├─ Period 1 Start
14:00 ├─ Period 1 End / Lunch Break (implicit gap)
15:30 ├─ Period 2 Start (if enabled)
19:30 ├─ Period 2 End
20:30 └─ Visual Margin (manual drag-drop only)
```

---

## Composition Engine Business Rules

### Weekly Auto-Composition (Mon-Thu only)
1. **Monday-Thursday**: Auto-fill sequentially with flexible (unlocked) jobs.
   - Respect the **split shift structure**: Period 1 (08:00-14:00) then gap then Period 2 (15:30-19:30 if active).
   - Jobs can span across the lunch break (e.g., last 2h of morning + first 2h of afternoon).
   - Capacity: Fill up to `defaultDayCapacity` (10h by default, or 6h if Period 2 disabled).
   - Respect locked blocks: treat them as immovable obstacles, flow flexible jobs around them.
   - Locked blocks do **not** act as a wall; flexible blocks continue flowing after them.
   - Respect user-defined gaps: treat gaps as occupied time.
2. **Friday**: No auto-composition by default. Only accepts:
   - Overflow from Thursday (if job doesn't fit Mon-Thu)
   - Manual drag-drop by user
3. **Weekends**: No auto-composition ever. Only accepts manual drag-drop.
   - Once a job is manually placed on weekend, it's marked `manually_placed = true`
   - Future auto-recompositions won't try to move it

### Job Editing: Adding/Removing Hours (LIFO - Last In First Out)
- **Add hours**: Append to the **last block** of that job.
  - If job has blocks: Mon 2h + Wed 1h + Fri 3h, adding 2h makes Fri 5h.
  - Subsequent jobs cascade forward (displaced by the extra 2h).
- **Remove hours**: Decrement from the **last block**.
  - If last block becomes 0, it's deleted, and next block becomes the new "last" (keeps decrementing if needed).

### Job Editing: Name/Color Changes
- No impact on calendar layout or block positions. Just metadata updates.

### Manual Drag-Drop & Merging
- User can move a **portion** of a job (fragment it) or the entire block.
- On DROP: Auto-recomposition triggers for remaining calendar.
- **Auto-merge**: If two blocks of the same job end up adjacent/contiguous, they merge into one.

### Locked Blocks Don't Act as Walls
- `locked = true` means: "Don't auto-move this block during recomposition"
- Flexible blocks **flow around** locked blocks normally (don't stop at them)
- User CAN manually move locked blocks, change duration, or place other jobs around them
- User CAN toggle `locked` on/off at any time

### Overflow Behavior (Default)
- If job doesn't fit in current day (exceeds `defaultDayCapacity`), move overflow to next available day.
- Respects: Mon-Thu auto-fill, Fri/weekend manual-only.
- If placement would collide with a locked block, recomposition fails (error: "Can't fit job due to blocked slot")

### Edge Cases Handled
1. **Delete job**: Confirmation required. Blocks deleted in cascade. Calendar recomposes if space frees up.
2. **Edit total_hours to exceed remaining week**: Distributes across multiple future days (or next week if needed).

---

## UI/UX Behavior

### Calendar View
- **Horizontal week layout**: Mon-Fri (with Sat/Sun optional)
- **Time axis**: Vertical, from `workStartTime` to `workEndTime`
- **Visual blocks**: Colored rectangles for jobs, gray rectangles for gaps
- **Drag-drop**: Click and drag job blocks to new date/time. Shows ghost/preview during drag.

### Job Management
- **Create**: Name + Color + Hours (e.g., "Door frame" + Red + 8h)
  - Auto-places on first available slot (Monday onwards)
  - Or user specifies a start day
- **Edit**: Change name, color, total hours (affects last block per LIFO rules)
- **Delete**: Requires confirmation. Blocks deleted; calendar recomposes.
- **Lock/Unlock**: Toggle `locked` flag per block

### Gap Management
- **Create**: Date + Start Time + Duration + Reason (optional)
- **Edit**: Modify any field
- **Delete**: Frees up time; auto-recomposition runs if needed

### Settings
- Work start/end hours, default capacity, gap color, etc.

---

## Composition Algorithm Notes

The per-day placement logic is validated in `recompose-poc.js`. The production implementation should:
1. Extend it to **weekly chaining** (Mon-Thu overflow to next day, Fri/weekend manual-only)
2. Support **gaps** as fixed occupancy (treated like locked blocks)
3. Handle **LIFO editing** (always append/decrement from last block)
4. Support **manual placement** flag and **auto-merge** for contiguous blocks

---

## Current Project Status

**v0.1 (Current):**
- ✅ Data model finalized (simplified: Project + Block + Gap only)
- ✅ Database schema and migrations set up
- ✅ Composition algorithm (per-day placement) validated in `recompose-poc.js`
- ✅ Project skeleton (Next.js, TypeScript, SQLite, i18n)

**v0.2 (Next):**
- [ ] Port `recompose-poc.js` to `src/lib/composition.ts` (weekly chaining + gap support + LIFO editing)
- [ ] API routes for CRUD (Project, Block, Gap)
- [ ] Settings screen (work hours, capacity, colors)
- [ ] Calendar week view component
- [ ] Drag-drop integration
- [ ] Database initialization on app startup

---

## Notes for Development

- **Review `recompose-poc.js` first**: It contains validated per-day placement logic.
  Production code should derive from this, not reinvent.
- **Any change to business rules above must update CLAUDE.md** to keep specs in sync.
- **All code, comments, variable names**: English.
- **UI strings**: Only in `public/locales/{lang}/common.json`.
- **Database**: Auto-created `./data/calendar.db` on first run.
- **Complexity**: Prioritize simplicity. No multi-user, auth, subscriptions, etc. Keep it lean.
