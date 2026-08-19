/**
 * The typed fetch wrapper over `/api/*`. One function per endpoint, on the platform `fetch`.
 *
 * Everything speaks INTEGER MINUTES — convert only where the owner reads a number
 * (src/lib/format.ts). `getWeek()` must be refetched after ANY mutation: a recomposition
 * rewrites rows in weeks the response never mentions. And errors are never sentences — every
 * failure throws `ApiError` carrying an i18n key, which `apiErrorMessage(error, t)` renders.
 */

import type { Block, DayShape, Gap, Project, Settings } from '../types';
import type { FreedHoursChoice, ScheduleSummary } from './composition';
import type { TranslateFn } from './format';
import { formatLongDate } from './format';
import { DEFAULT_LANGUAGE } from './i18n';

// Defined next to the query that builds them. `import type` is erased at compile time, so
// nothing from the server module (which opens SQLite) reaches the browser bundle.
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
  /** Must be SHOWN, never swallowed (`notices.touchedLockedBlocks`): a locked row is never grown silently. */
  touchedLockedBlockIds: string[];
  /** Only on a creation with a `startDate`: the facts the preview showed before saving. */
  placement?: CreationOutcome;
}

/** What a block gesture returns. `block` is null when auto-merge absorbed the row. */
export interface BlockMutation {
  block: Block | null;
  blocks: Block[];
  summary: ScheduleSummary;
  /**
   * The rows the gesture's hours ended up on, in calendar order. More than one once the hours
   * filled a day and carried on; `block` is only the FIRST, so a notice built from it alone
   * tells the owner half of what happened. Empty when a row of the same job absorbed this
   * one.
   */
  placedBlockIds: string[];
  /** False when the request wrote nothing at all. Read it, never the geometry. */
  changed: boolean;
  /** Must be SHOWN, never swallowed (`notices.touchedLockedBlocks`): a locked row is never grown silently. */
  touchedLockedBlockIds: string[];
  /**
   * Rows of the dropped row's OWN job it absorbed where the reflow may not reach. The hours
   * were SUMMED, so nothing was lost, but these ids no longer exist. Show
   * `notices.mergedOverlap`.
   */
  mergedBlockIds: string[];
  /**
   * Jobs whose row the drop cut in two, the tail pushed after it. Their totals are unchanged.
   * Show `notices.displacedBlocks` with `count` and a `names` list.
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
   * An optional FLOOR: "not before this day", and it is not stored. A job born beyond the
   * last occupied day comes back with every row LOCKED; `previewProjectCreation` answers all
   * of that before you send this.
   */
  startDate?: string;
  /** Only with `startDate`, and only worth sending when the preview says `canForce`. */
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
   * The drop point, as a RANK rather than a time: the row keeps this place in the queue and
   * settles after whatever precedes it. Exactly on an existing row's start means BEFORE it,
   * and the row underneath stays whole; to cut a row, aim below its start. The response says
   * where it landed.
   */
  startMinutes: number;
  /**
   * The rows drawn as ONE UNIT with this one — a job cut at the lunch break has a single drag
   * handle. Sending the list moves the unit in ONE request and ONE transaction.
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
 * A failed request. `messageKey` is an i18n key under `errors.` — never a sentence — and
 * `details` carries whatever that key interpolates. `field` names the input to highlight on a
 * 400.
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
 * The i18n key to render for a failure. It differs from `error.messageKey` in one place, the
 * planning horizon: the richer key naming the date wins whenever `horizonEndDate` is present.
 */
export function apiErrorMessageKey(error: unknown): string {
  if (!isApiError(error)) return 'errors.unexpected';
  if (error.code === 'horizon-exceeded' && typeof error.details.horizonEndDate === 'string') {
    return 'errors.horizonExceededUntil';
  }
  return error.messageKey;
}

/**
 * The values that key interpolates, with dates made readable. `details` arrives in machine
 * form, so any `YYYY-MM-DD` becomes a long local date and `horizonEndDate` is also exposed as
 * `date`.
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
 * The whole message, ready to put in a banner or a toast. `t` is deliberately a plain
 * function type, so this module never imports i18next.
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
      // The whole API is `force-dynamic`; a cached GET would show a calendar already
      // rewritten.
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
    // A crash before the error handler, or an HTML error page: fall through to the generic
    // key.
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
 * Appends a job to the END of the queue: it fills Mon-Thu and, if it does not fit, skips
 * Friday for next week's Monday. With `startDate` the job is born on that day instead — see
 * `CreateProjectInput`.
 */
export function createProject(
  input: CreateProjectInput,
  options?: RequestOptions,
): Promise<ProjectMutation> {
  return send<ProjectMutation>('POST', '/projects', definedOnly(input), options);
}

/**
 * Where a job WOULD land if it were created with that start date. Writes nothing, and it is
 * the same planner the POST uses, so what it reports is what the save will do. Call it
 * whenever the owner changes the date, the hours or the force flag.
 */
export function previewProjectCreation(
  input: PreviewProjectInput,
  options?: RequestOptions,
): Promise<CreationPreview> {
  return send<CreationPreview>('POST', '/projects/preview', definedOnly(input), options);
}

/**
 * Name, description and colour move nothing. `totalMinutes` goes through LIFO: added minutes
 * land on the job's last unlocked row, removed minutes come off it.
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
 * Deletes the job. Its FUTURE rows go and the calendar closes the hole; its PAST rows stay as
 * gaps naming the job, counted in `preservedGapIds`.
 *
 * PASS THE LANGUAGE THE OWNER IS READING (`i18n.language`): those gap reasons are stored user
 * data and cannot be re-translated later. Recomposes, so it can fail with `horizon-exceeded`.
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
 * A drop. On MONDAY-THURSDAY it sets the row's place in the queue and the whole calendar
 * reflows; on the FRIDAY buffer, the WEEKEND or a VISUAL MARGIN it PADLOCKS, keeps the exact
 * slot and the engine never recovers it. The way off a padlock is `setBlockLock(id, false)`.
 * Either way the row is stored in SEGMENTS, and `block` is the first of them.
 *
 * So expect a landing that is neither the drop point nor a refusal — see `describeDrop`. The
 * 409s (`overlaps-gap`, `overlaps-locked-block`, `merge-exceeds-day`,
 * `displaced-hours-unplaceable`) belong to a drop that lands literally, and a PAST day is
 * refused at either end (`past-block-frozen`, `drop-onto-past-day`).
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
 * Dragging the bottom edge: a transfer INSIDE the job, its last row the counterparty. The
 * total changes only when the row being resized IS the last one.
 *
 * It only sizes a row the engine does not lay out — padlocked, or on a weekend. Anything else
 * is 409 `resize-needs-padlock` and a past row is 409 `past-block-frozen`, both writing
 * nothing, so do not offer the edge there: padlocking first is what fixes a length, and a GAP
 * is what ends a day early. Shrinking with nowhere to put the freed hours answers 409
 * `shrink-needs-choice` carrying `freedMinutes` and `choices`; send the owner's answer back
 * through `freedHours`.
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
 * The scissors. The source row shrinks, the fragment becomes a new row of the same job, and
 * the job's total does not change. The fragment takes a queue rank and then settles.
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
 * A gap is time: it consumes the day's plannable hours, so saving one pushes the flexible
 * work forward. Refused with `gap-over-fixed-block` when the space is held by a row the
 * engine may not move — `details.reason` is `locked`, `past` or `weekend`, whichever actually
 * binds.
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
 * Saves any subset. Two things the Settings screen must do: send `defaultDayCapacity`
 * whenever the patch shortens the shift below it, because the capacity is never re-capped
 * for you; and surface `error.field` on a
 * 400, since every value is rejected rather than repaired. A save recomposes, so it can fail
 * with `horizon-exceeded`.
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
 * Everything the week grid draws, from ONE snapshot: the seven days, the blocks with their
 * job's name and colour, the gaps, the settings, the timeline shape and the summary. `date`
 * may be any day of the wanted week; omitted, it means the current week.
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
