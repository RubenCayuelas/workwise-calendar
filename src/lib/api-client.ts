/**
 * The typed fetch wrapper over `/api/*`. One function per endpoint.
 *
 * Built on the platform `fetch` — axios was removed and nothing here needs it.
 *
 * FOUR THINGS EVERY CALLER MUST KNOW (they are the four the API layer flagged):
 *
 * 1. Everything speaks INTEGER MINUTES. The routes accept hours too, but this client
 *    always sends `startMinutes` / `durationMinutes` / `totalMinutes` so a 2.5 h
 *    value can never drift through a float, and every response already carries
 *    minutes. Convert only where the owner reads a number (see src/lib/format.ts).
 * 2. `block` in a block mutation is NULLABLE. Auto-merge can absorb the row you just
 *    edited into a neighbouring row of the same job; `blocks` is the answer then.
 * 3. `touchedLockedBlockIds` must be SHOWN, not swallowed — CLAUDE.md: "a locked
 *    block is never grown or shrunk silently". `notices.touchedLockedBlocks` is the
 *    wording, with `count`.
 * 4. REFETCH `getWeek()` after ANY mutation. A recomposition rewrites rows in weeks
 *    the response never mentions, so a mutation result is only ever enough to update
 *    the entity you touched plus the summary strip.
 *
 * Errors are never sentences. Every failure throws `ApiError`, which carries the
 * i18n key the server chose plus the values it interpolates; `apiErrorMessage(error,
 * t)` turns one into a translated string.
 */

import type { Block, DayShape, Gap, Project, Settings } from '../types';
import type { FreedHoursChoice, ScheduleSummary } from './composition';
import type { TranslateFn } from './format';
import { formatLongDate } from './format';
import { DEFAULT_LANGUAGE } from './i18n';

// The week view's shapes are defined next to the query that builds them. `import
// type` is erased at compile time, so nothing from the server module (which opens
// SQLite) reaches the browser bundle.
export type { WeekBlock, WeekDay, WeekView } from './operations/views';
export type { FreedHoursChoice, ScheduleSummary } from './composition';
export type { Block, DayShape, Gap, Project, Settings, WorkPeriod } from '../types';
export type {
  CreationOutcome,
  CreationPreview,
  CreationPreviewCollision,
  CreationPreviewRow,
} from './operations/projects';
export type { CreationMode, StartDateDay } from './creation';

import type { WeekView } from './operations/views';
import type { CreationOutcome, CreationPreview } from './operations/projects';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** What a job write returns: the job, ITS rows, the strip, and any locked row touched. */
export interface ProjectMutation {
  project: Project;
  blocks: Block[];
  summary: ScheduleSummary;
  touchedLockedBlockIds: string[];
  /**
   * Only on a creation that named a `startDate`: the same facts the preview showed
   * before saving, so the notice afterwards repeats them instead of guessing.
   */
  placement?: CreationOutcome;
}

/** What a block gesture returns. `block` is null when auto-merge absorbed the row. */
export interface BlockMutation {
  block: Block | null;
  blocks: Block[];
  summary: ScheduleSummary;
  /**
   * THE ROWS THE GESTURE'S HOURS ENDED UP ON, in calendar order — the run the moved work is
   * stored as, so they can be read straight out of `blocks`.
   *
   * One id normally. TWO OR MORE once the hours filled what a day had left and carried on to
   * the next day, which is ordinary now: 6 h dropped into a 4 h afternoon comes back as
   * `[Monday 4 h, Tuesday 2 h]`. `block` is only the FIRST of them, so a notice built from
   * `block` alone tells the owner half of what happened.
   *
   * Empty when the row no longer exists — a row of the same job absorbed it, which
   * `mergedBlockIds` reports.
   */
  placedBlockIds: string[];
  /**
   * FALSE WHEN THE REQUEST WROTE NOTHING AT ALL. A drop writes a queue RANK, so the reflow
   * may answer it with the calendar the owner already had — and that is indistinguishable
   * from a drop that worked if you only compare rectangles, which is exactly the defect it
   * exists for. Use it, never geometry, to decide whether to say «no ha cambiado nada».
   */
  changed: boolean;
  touchedLockedBlockIds: string[];
  /**
   * Rows of the dropped row's OWN job that the drop absorbed, because it overlapped
   * them where the reflow may not reach (the weekend, the frozen past). The hours
   * were SUMMED — Sat 09:00-11:00 plus a 2 h drop at 10:00 is one 09:00-13:00 row —
   * so nothing was lost, but the ids listed here no longer exist. Show
   * `notices.mergedOverlap` with `count`. Empty for anything that is not a drop.
   */
  mergedBlockIds: string[];
  /**
   * Jobs whose row the drop cut in two, its tail pushed to just after the dropped
   * row. Their totals are unchanged. Show `notices.displacedBlocks` with `count` and
   * a `names` list — the owner's rule is "if the user does not want it, they move it
   * again", which only works if they are told.
   */
  displacedProjectIds: string[];
}

export interface GapMutation {
  gap: Gap;
  summary: ScheduleSummary;
}

export interface SettingsView {
  settings: Settings;
  /** The same configuration in minutes, including the timeline the grid draws. */
  shape: DayShape;
  /** The ceiling `defaultDayCapacity` may not exceed. Show it next to the field. */
  maxDayCapacityHours: number;
}

export interface SettingsUpdate extends SettingsView {
  summary: ScheduleSummary;
}

export interface SummaryView {
  today: string;
  summary: ScheduleSummary;
}

export interface ProjectDetail {
  project: Project;
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  description?: string;
  color: string;
  totalMinutes: number;
  /**
   * An optional FLOOR: "not before this day". Omit it for the ordinary creation, which
   * appends the job to the end of the queue. It is not stored anywhere — it decides
   * where the rows are born, and a job born beyond the last occupied day comes back
   * with every row LOCKED, because the reflow would otherwise drag it to today.
   * `previewProjectCreation` answers all of that before you send this.
   */
  startDate?: string;
  /**
   * Only with `startDate`, and only worth sending when the preview says `canForce`:
   * place the job on that day and push what follows, instead of letting it land at the
   * end of the queue.
   */
  force?: boolean;
}

export interface PreviewProjectInput {
  startDate: string;
  totalMinutes: number;
  force?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  /** `null` clears the description. Omit the key to leave it alone. */
  description?: string | null;
  color?: string;
  totalMinutes?: number;
}

export interface MoveBlockInput {
  date: string;
  /**
   * The drop point, as a RANK rather than a time. The block keeps this place in the
   * queue and then settles contiguously after whatever precedes it — it does not
   * stay at these minutes. Lock it afterwards to pin it.
   *
   * A drop exactly on an existing row's start means BEFORE IT: the row underneath stays
   * whole and follows, and nothing is cut. The server settles that tie in the drop's
   * favour, so the rank does not have to be nudged off the minute the owner aimed at; to
   * cut a row, aim below its start.
   *
   * Aimed below what the day can hold, the whole drop moves to the next day the calendar
   * would use — the response says where it really landed.
   */
  startMinutes: number;
  /**
   * The rows drawn as ONE UNIT with this one — a job cut at the lunch break is two rows
   * with a single drag handle, so a body drag is about all of them. Sending the list moves
   * the unit in ONE request and ONE transaction; sending each row separately re-flowed the
   * calendar between them and left part of the unit behind.
   */
  unitBlockIds?: readonly string[];
}

export interface SplitBlockInput {
  /** The part that leaves this row. Must be smaller than the row. */
  durationMinutes: number;
  date: string;
  startMinutes: number;
}

export interface CreateGapInput {
  date: string;
  startMinutes: number;
  durationMinutes: number;
  reason?: string;
}

export interface UpdateGapInput {
  date?: string;
  startMinutes?: number;
  durationMinutes?: number;
  /** `null` clears the reason. */
  reason?: string | null;
}

/** Every request takes one, so a screen can drop a stale fetch on unmount. */
export interface RequestOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The body every non-2xx response carries. Mirrors `ApiErrorBody` in src/lib/errors.ts. */
interface ApiErrorPayload {
  error?: {
    code?: unknown;
    messageKey?: unknown;
    field?: unknown;
    details?: unknown;
  };
}

/**
 * A failed request. `messageKey` is an i18n key under `errors.` — never a sentence —
 * and `details` carries whatever that key interpolates.
 *
 * `field` names the input to highlight on a 400, which is what the Settings form and
 * the job form use to point at the offending control.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly messageKey: string;
  readonly field?: string;
  readonly details: Record<string, unknown>;

  constructor(init: {
    code: string;
    status: number;
    messageKey: string;
    field?: string;
    details?: Record<string, unknown>;
  }) {
    super(`${init.code} (${init.messageKey})`);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.messageKey = init.messageKey;
    this.field = init.field;
    this.details = init.details ?? {};
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True when the request never reached the server. Nothing was written. */
export function isNetworkError(error: unknown): boolean {
  return isApiError(error) && error.code === 'network';
}

/** True when the caller aborted the request. Screens should ignore these silently. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * The i18n key to render for a failure.
 *
 * The one place it differs from `error.messageKey` is the planning horizon: the
 * server always attaches `horizonEndDate` there, and CLAUDE.md wants the UI to say
 * WHICH date the work no longer fits before while pointing at Settings. So the
 * richer key is chosen whenever that detail is present.
 */
export function apiErrorMessageKey(error: unknown): string {
  if (!isApiError(error)) return 'errors.unexpected';
  if (error.code === 'horizon-exceeded' && typeof error.details.horizonEndDate === 'string') {
    return 'errors.horizonExceededUntil';
  }
  return error.messageKey;
}

/**
 * The values that key interpolates, with dates and times already readable.
 *
 * `details` arrives in machine form (`2026-10-04`, minutes from midnight), and every
 * message that mentions one is prose. So any `YYYY-MM-DD` becomes a long local date
 * and `horizonEndDate` is also exposed as `date`, which is what the horizon key uses.
 */
export function apiErrorValues(error: unknown, language: string = DEFAULT_LANGUAGE): Record<string, unknown> {
  if (!isApiError(error)) return {};

  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error.details)) {
    values[key] = typeof value === 'string' && isIsoDate(value) ? formatLongDate(value, language) : value;
  }

  if (typeof error.details.horizonEndDate === 'string' && isIsoDate(error.details.horizonEndDate)) {
    values.date = formatLongDate(error.details.horizonEndDate, language);
  }

  return values;
}

/**
 * The whole message, ready to put in a banner or a toast:
 *
 *     catch (error) { setError(apiErrorMessage(error, t, language)); }
 *
 * `t` is deliberately a plain function type, so this module never imports i18next.
 */
export function apiErrorMessage(
  error: unknown,
  t: TranslateFn,
  language: string = DEFAULT_LANGUAGE,
): string {
  return t(apiErrorMessageKey(error), apiErrorValues(error, language));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const API_BASE = '/api';

async function request<T>(
  path: string,
  init: RequestInit & RequestOptions = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      // The whole API is `force-dynamic`; a cached GET would show a calendar that a
      // recomposition has already rewritten.
      cache: 'no-store',
      ...init,
      headers:
        init.body === undefined
          ? init.headers
          : { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({
      code: 'network',
      status: 0,
      messageKey: 'errors.networkFailed',
      details: { cause: String(error) },
    });
  }

  if (!response.ok) throw await readError(response);

  // 204 has no body; nothing in this API returns one today, but a DELETE easily could.
  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({
      code: 'invalid-response',
      status: response.status,
      messageKey: 'errors.unexpected',
    });
  }
}

async function readError(response: Response): Promise<ApiError> {
  let payload: ApiErrorPayload = {};
  try {
    payload = (await response.json()) as ApiErrorPayload;
  } catch {
    // A crash before the error handler, or an HTML error page. Fall through to the
    // generic key rather than showing the user a stack trace.
  }

  const body = payload.error;
  return new ApiError({
    code: typeof body?.code === 'string' ? body.code : `http-${response.status}`,
    status: response.status,
    messageKey:
      typeof body?.messageKey === 'string' ? body.messageKey : defaultMessageKey(response.status),
    field: typeof body?.field === 'string' ? body.field : undefined,
    details: isRecord(body?.details) ? body.details : undefined,
  });
}

function defaultMessageKey(status: number): string {
  if (status === 404) return 'errors.notFound';
  if (status === 400) return 'errors.invalidPayload';
  return 'errors.unexpected';
}

function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: 'GET', signal: options.signal });
}

function send<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(path, {
    method,
    signal: options.signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Drops the keys a caller left `undefined`, so a PATCH never blanks a stored value. */
function definedOnly<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(options?: RequestOptions): Promise<Project[]> {
  return get<{ projects: Project[] }>('/projects', options).then((data) => data.projects);
}

export function getProject(projectId: string, options?: RequestOptions): Promise<ProjectDetail> {
  return get<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`, options);
}

/**
 * Appends a job to the END of the queue. It fills Mon-Thu and, if it does not fit,
 * skips Friday for next week's Monday — the colchón never takes new work.
 *
 * With `startDate` the job is born on that day instead (or later, if the queue already
 * runs past it — send `force` to override that). See `CreateProjectInput`.
 */
export function createProject(
  input: CreateProjectInput,
  options?: RequestOptions,
): Promise<ProjectMutation> {
  return send<ProjectMutation>('POST', '/projects', definedOnly(input), options);
}

/**
 * Where a job WOULD land if it were created with that start date. Writes nothing.
 *
 * Call it whenever the owner changes the date, the hours or the force flag: it is the
 * same planner the POST uses, so what it reports is what the save will do — where the
 * hours start, what is already sitting across the whole span they would occupy, whether
 * every row would be locked, and which days are free instead.
 */
export function previewProjectCreation(
  input: PreviewProjectInput,
  options?: RequestOptions,
): Promise<CreationPreview> {
  return send<CreationPreview>('POST', '/projects/preview', definedOnly(input), options);
}

/**
 * Name, description and colour move nothing. `totalMinutes` goes through LIFO: added
 * minutes land on the job's last unlocked row, removed minutes come off it and
 * delete any row that reaches zero.
 */
export function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  options?: RequestOptions,
): Promise<ProjectMutation> {
  return send<ProjectMutation>(
    'PATCH',
    `/projects/${encodeURIComponent(projectId)}`,
    definedOnly(input),
    options,
  );
}

/**
 * Deletes the job. Its FUTURE rows go and the calendar closes the hole; its PAST rows stay
 * as GAPS, one per row, each named `Trabajo «X» eliminado` — the days the shop has already
 * worked keep their shape, and `preservedGapIds` says how many there were
 * (`notices.deletedJobPast`, with `count`).
 *
 * PASS THE LANGUAGE THE OWNER IS READING. Those gap reasons are stored user data and
 * cannot be re-translated later, so they are written in the language given here; Spanish
 * when it is left out. `i18n.language` is the value to send.
 *
 * Recomposes, so it can fail with `horizon-exceeded`.
 */
export function deleteProject(
  projectId: string,
  options: RequestOptions & { language?: string } = {},
): Promise<{ deleted: true; summary: ScheduleSummary; preservedGapIds: string[] }> {
  const query = options.language === undefined ? '' : `?lang=${encodeURIComponent(options.language)}`;
  return send(
    'DELETE',
    `/projects/${encodeURIComponent(projectId)}${query}`,
    undefined,
    options,
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A drop.
 *
 * On MONDAY-THURSDAY it sets the row's place in the queue and the whole calendar
 * reflows; the row settles contiguously after whatever precedes it rather than staying
 * at the minute it was dropped at.
 *
 * On the FRIDAY buffer, the WEEKEND or a VISUAL MARGIN it PADLOCKS: the row comes back
 * with `locked: true`, keeps the exact slot, and the engine never recovers it — which is
 * how work stays on the colchón at all. The padlock is only ever added by a drop; the way
 * off is `setBlockLock(id, false)`, the one undo the app has.
 *
 * Either way the row is stored in SEGMENTS: a drop crossing the lunch break comes back
 * as two rows of one job, and `block` is the first of them.
 *
 * A DROP THE ENGINE STILL OWNS IS NEVER REFUSED FOR A COLLISION — an unlocked row inside
 * the periods of Monday to Thursday or the Friday buffer, from today on. There a drop is a
 * rank and the reflow is what finds the room. A drop that PADLOCKS is slid forward past a
 * gap or a lock in its way, on the day it was aimed at, and refused when the day has no
 * clear slot. The 409s — `overlaps-gap`, `overlaps-locked-block`, `merge-exceeds-day`,
 * `displaced-hours-unplaceable` — therefore belong to a drop that lands literally: the
 * weekend, a closed day, a margin, and a locked row being dragged. So the
 * caller must expect a landing that is neither the drop point nor a refusal, which is what
 * `describeDrop` is for.
 *
 * TWO MORE LANDINGS THAT ARE NOT THE DROP POINT, and neither is a refusal:
 *
 * - aimed BELOW what the day can hold, the drop moves to the next day the ENGINE would use,
 *   at the top of its working periods — Mon-Thu and the Friday colchón roll forward, while
 *   the weekend, a closed day and the past keep the day and the end-of-day refusal;
 * - aimed exactly at another row's start, it goes BEFORE that row, which stays whole.
 *
 * A PAST day is the one place a drop is refused outright, at either end: moving a past row
 * is `past-block-frozen` and aiming at a past day is `drop-onto-past-day`, both 409.
 */
export function moveBlock(
  blockId: string,
  input: MoveBlockInput,
  options?: RequestOptions,
): Promise<BlockMutation> {
  return send<BlockMutation>(
    'PATCH',
    `/blocks/${encodeURIComponent(blockId)}`,
    { action: 'move', ...input },
    options,
  );
}

/**
 * Dragging the bottom edge. A transfer INSIDE the job: growing a row takes the hours off
 * the job's last row (the total only changes when the row being resized IS the last one),
 * shrinking one hands them to it.
 *
 * SHRINKING ASKS WHEN THE HOURS HAVE NOWHERE TO GO — the job's only row, or every other
 * one locked, on a weekend or in the past. The request answers 409 `shrink-needs-choice`
 * and writes nothing; `error.details` carries `freedMinutes` and `choices`,
 * which is everything a dialog needs to offer all three ways out in one go. Send the
 * owner's answer back through `freedHours`; cancelling is not calling again.
 *
 * IT ONLY SIZES A ROW THE ENGINE DOES NOT LAY OUT — one carrying a padlock, or one on a
 * weekend. Anything else is 409 `resize-needs-padlock` with nothing written, because an
 * automatic row is exactly as big as the room it has and the reflow would undo the number
 * on the next save. So do not offer the edge on a row the engine still owns: padlocking it
 * first is what fixes its length, and a GAP is what ends a day early. THE APP NEVER CREATES
 * THAT GAP BY ITSELF — it names the action and the owner takes it.
 *
 * A PAST row is refused first (`past-block-frozen`, 409): the past is a record, and the
 * hours of a job whose work is behind it are changed in the job form.
 */
export function resizeBlock(
  blockId: string,
  durationMinutes: number,
  options: RequestOptions & { freedHours?: FreedHoursChoice } = {},
): Promise<BlockMutation> {
  return send<BlockMutation>(
    'PATCH',
    `/blocks/${encodeURIComponent(blockId)}`,
    {
      action: 'resize',
      durationMinutes,
      ...(options.freedHours === undefined ? {} : { freedHours: options.freedHours }),
    },
    options,
  );
}

/** The padlock. `locked` only exempts the row from AUTO-move; the owner can still drag it. */
export function setBlockLock(
  blockId: string,
  locked: boolean,
  options?: RequestOptions,
): Promise<BlockMutation> {
  return send<BlockMutation>(
    'PATCH',
    `/blocks/${encodeURIComponent(blockId)}`,
    { action: 'lock', locked },
    options,
  );
}

/**
 * The scissors. The source row shrinks, the fragment becomes a new row of the same
 * job, and the job's total does not change. The fragment takes a queue rank and then
 * settles — it does not stay where it was dropped.
 */
export function splitBlock(
  blockId: string,
  input: SplitBlockInput,
  options?: RequestOptions,
): Promise<BlockMutation> {
  return send<BlockMutation>(
    'POST',
    `/blocks/${encodeURIComponent(blockId)}/split`,
    input,
    options,
  );
}

/**
 * Takes those hours OFF the job — the job's total drops. Refused on a job's only row
 * (`delete-last-block`); delete the job instead.
 */
export function deleteBlock(
  blockId: string,
  options?: RequestOptions,
): Promise<{ deleted: true; projectId: string; summary: ScheduleSummary }> {
  return send('DELETE', `/blocks/${encodeURIComponent(blockId)}`, undefined, options);
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Every gap, or the ones inside an inclusive window (pass both bounds or neither). */
export function listGaps(
  range: { from?: string; to?: string } = {},
  options?: RequestOptions,
): Promise<Gap[]> {
  const query = new URLSearchParams();
  if (range.from !== undefined) query.set('from', range.from);
  if (range.to !== undefined) query.set('to', range.to);
  const search = query.toString();
  const suffix = search === '' ? '' : `?${search}`;
  return get<{ gaps: Gap[] }>(`/gaps${suffix}`, options).then((data) => data.gaps);
}

/**
 * A gap is time: it consumes the day's plannable hours like locked work does, so
 * saving one pushes the flexible work forward. Refused with `gap-over-fixed-block`
 * when the space is held by a row the engine may not move — `details.reason` is
 * `locked`, `past` or `weekend`, and `details` also names the job and the times. The
 * first is the one the owner can act on, so it is reported in preference when several
 * rows conflict.
 */
export function createGap(
  input: CreateGapInput,
  options?: RequestOptions,
): Promise<GapMutation> {
  return send<GapMutation>('POST', '/gaps', definedOnly(input), options);
}

export function updateGap(
  gapId: string,
  input: UpdateGapInput,
  options?: RequestOptions,
): Promise<GapMutation> {
  return send<GapMutation>(
    'PATCH',
    `/gaps/${encodeURIComponent(gapId)}`,
    definedOnly(input),
    options,
  );
}

export function deleteGap(
  gapId: string,
  options?: RequestOptions,
): Promise<{ deleted: true; summary: ScheduleSummary }> {
  return send('DELETE', `/gaps/${encodeURIComponent(gapId)}`, undefined, options);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings(options?: RequestOptions): Promise<SettingsView> {
  return get<SettingsView>('/settings', options);
}

/**
 * Saves any subset. TWO THINGS THE SETTINGS SCREEN MUST DO:
 *
 * - Send `defaultDayCapacity` whenever the patch shortens the shift below it. The
 *   capacity is never re-capped for you: a shift that cannot buy it is refused with
 *   `field: 'defaultDayCapacity'`, so the owner is asked and the answer travels in the
 *   same request (CLAUDE.md, *The Capacity Is Never Touched Alone*).
 * - Surface `error.field` on a 400: every value is rejected, not repaired.
 *
 * A save recomposes, so NARROWING `planningHorizonWeeks` can fail with
 * `horizon-exceeded` and roll the whole settings change back with it.
 */
export function updateSettings(
  patch: Partial<Settings>,
  options?: RequestOptions,
): Promise<SettingsUpdate> {
  return send<SettingsUpdate>('PATCH', '/settings', definedOnly(patch), options);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The amber strip. Also embedded in `getWeek`, so a page load needs only one call. */
export function getSummary(options?: RequestOptions): Promise<SummaryView> {
  return get<SummaryView>('/summary', options);
}

/**
 * Everything the week grid draws, from ONE snapshot: the seven days with their
 * state, the blocks with their job's name and colour, the gaps, the settings, the
 * timeline shape and the summary.
 *
 * `date` may be any day of the wanted week; omitted, it means the current week.
 */
export function getWeek(date?: string, options?: RequestOptions): Promise<WeekView> {
  const suffix = date === undefined ? '' : `?date=${encodeURIComponent(date)}`;
  return get<WeekView>(`/week${suffix}`, options);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
