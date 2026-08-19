/**
 * The HTTP edge: responses, and hand-written validation — no schema library, by project rule. A
 * reader returns `undefined` when the key is absent and throws an `AppError` (i18n key + `field`)
 * when it is present and wrong. Responses speak integer MINUTES; every time-valued field accepts
 * either unit (`totalHours` or `totalMinutes`, `startTime` or `startMinutes`), because a form holds
 * hours and a drag holds minutes, and sending both is an error rather than a precedence puzzle.
 */

import { NextResponse } from 'next/server';
import { MINUTES_PER_DAY, hhmmToMinutes, hoursToMinutes, isValidDate } from './dates';
import { AppError, ERROR_MESSAGE_KEYS, badRequest, internal } from './errors';
import { PROJECT_COLORS, normalizeProjectColor } from './projectColors';
import { SettingsValidationError } from './settings';

export type JsonBody = Record<string, unknown>;

/** The largest estimate a job may carry: a guard against a mistyped stepper. */
export const MAX_TOTAL_HOURS = 9999;

/** Free text is bounded so a paste cannot fill the database. */
export const MAX_NAME_LENGTH = 120;
export const MAX_TEXT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * Wraps a handler's body so every route reports failures identically. An `AppError` is THROWN rather
 * than returned because that is what rolls a `better-sqlite3` transaction back; anything else is a
 * 500 with `errors.unexpected` and the real reason logged to the shop PC's console.
 */
export async function route<T>(work: () => Promise<T> | T): Promise<NextResponse> {
  try {
    return jsonOk(await work());
  } catch (error) {
    return failure(error);
  }
}

export function failure(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(error.toBody(), { status: error.status });
  }
  if (error instanceof SettingsValidationError) {
    return NextResponse.json(
      badRequest('settings-invalid', ERROR_MESSAGE_KEYS.settingsInvalid, {
        field: error.field,
        details: { reason: error.message },
      }).toBody(),
      { status: 400 },
    );
  }
  if (error instanceof RangeError) {
    // A date or clock helper rejecting its input: a malformed payload that got past a reader.
    return NextResponse.json(
      badRequest('invalid-payload', ERROR_MESSAGE_KEYS.invalidPayload, {
        details: { reason: error.message },
      }).toBody(),
      { status: 400 },
    );
  }
  console.error('[workwise] unhandled request failure', error);
  return NextResponse.json(internal('unexpected', ERROR_MESSAGE_KEYS.unexpected).toBody(), { status: 500 });
}

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

/** Parses a JSON object body. Anything else — an array, a string, nothing — is a 400. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest('invalid-payload', ERROR_MESSAGE_KEYS.invalidPayload);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('invalid-payload', ERROR_MESSAGE_KEYS.invalidPayload);
  }
  return parsed as JsonBody;
}

/** True when the caller mentioned the key at all — `null` counts, `undefined` does not. */
export function hasField(body: JsonBody, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

interface TextOptions {
  maxLength?: number;
  messageKey?: string;
}

/** A trimmed non-empty string, or `undefined` when the key is absent. */
export function readText(body: JsonBody, key: string, options: TextOptions = {}): string | undefined {
  if (!hasField(body, key)) return undefined;
  const value = body[key];
  const messageKey = options.messageKey ?? ERROR_MESSAGE_KEYS.invalidPayload;
  if (typeof value !== 'string') throw badRequest('invalid-field', messageKey, { field: key });
  const trimmed = value.trim();
  if (trimmed === '') throw badRequest('invalid-field', messageKey, { field: key });
  if (trimmed.length > (options.maxLength ?? MAX_TEXT_LENGTH)) {
    throw badRequest('field-too-long', messageKey, { field: key });
  }
  return trimmed;
}

export function requireText(body: JsonBody, key: string, options: TextOptions = {}): string {
  const value = readText(body, key, options);
  if (value === undefined) {
    throw badRequest('missing-field', options.messageKey ?? ERROR_MESSAGE_KEYS.invalidPayload, { field: key });
  }
  return value;
}

/**
 * Optional free text that can be CLEARED: `null` or `""` both come back as `null`, which the
 * repositories write as SQL NULL. `description` and a gap's `reason` are the fields the owner may
 * empty.
 */
export function readClearableText(
  body: JsonBody,
  key: string,
  options: TextOptions = {},
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const value = body[key];
  if (value === null || value === undefined) return null;
  const messageKey = options.messageKey ?? ERROR_MESSAGE_KEYS.invalidPayload;
  if (typeof value !== 'string') throw badRequest('invalid-field', messageKey, { field: key });
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > (options.maxLength ?? MAX_TEXT_LENGTH)) {
    throw badRequest('field-too-long', messageKey, { field: key });
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Dates and flags
// ---------------------------------------------------------------------------

/** A local `YYYY-MM-DD`. `2026-02-30` is rejected, not rolled into March. */
export function readDate(body: JsonBody, key = 'date'): string | undefined {
  if (!hasField(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== 'string' || !isValidDate(value)) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidDate, { field: key });
  }
  return value;
}

export function requireDate(body: JsonBody, key = 'date'): string {
  const value = readDate(body, key);
  if (value === undefined) {
    throw badRequest('missing-field', ERROR_MESSAGE_KEYS.invalidDate, { field: key });
  }
  return value;
}

/** A `YYYY-MM-DD` from the query string, or `undefined` when absent. */
export function readDateParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value.trim() === '') return undefined;
  if (!isValidDate(value)) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidDate, { field: key });
  }
  return value;
}

export function readFlag(body: JsonBody, key: string): boolean | undefined {
  if (!hasField(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== 'boolean') {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidFlag, { field: key });
  }
  return value;
}

export function requireFlag(body: JsonBody, key: string): boolean {
  const value = readFlag(body, key);
  if (value === undefined) {
    throw badRequest('missing-field', ERROR_MESSAGE_KEYS.invalidFlag, { field: key });
  }
  return value;
}

/**
 * A list of block ids — the rows a drop names as ONE unit with the row it is about. Ids that turn
 * out not to belong to the unit are the OPERATION's business: this only refuses a payload that is
 * not a list of strings.
 */
export function readIdList(body: JsonBody, key: string, max = 64): string[] | undefined {
  if (!hasField(body, key)) return undefined;
  const value = body[key];
  if (!Array.isArray(value) || value.length > max) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidPayload, { field: key });
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > 64) {
      throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidPayload, { field: key });
    }
    return entry;
  });
}

/**
 * An OPTIONAL member of a fixed set, such as `freedHours` on a resize. Present and wrong is a 400: a
 * misspelled answer must never be read as "no answer" and quietly asked again.
 */
export function readOneOf<T extends string>(
  body: JsonBody,
  key: string,
  allowed: readonly T[],
): T | undefined {
  if (!hasField(body, key)) return undefined;
  return requireOneOf(body, key, allowed);
}

/** A discriminator such as `action: "move" | "resize" | "lock"`. */
export function requireOneOf<T extends string>(body: JsonBody, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest('invalid-action', ERROR_MESSAGE_KEYS.invalidAction, {
      field: key,
      details: { allowed },
    });
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * A job colour, checked against the fixed swatch set: an arbitrary `#rrggbb` is refused even though
 * the column would store it, and the allowed values travel back in `details` so a mis-set picker is
 * debuggable. Storage is upper case.
 */
export function readProjectColor(body: JsonBody, key = 'color'): string | undefined {
  if (!hasField(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== 'string') {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidColor, { field: key });
  }
  const color = normalizeProjectColor(value);
  if (color === undefined) {
    throw badRequest('invalid-color', ERROR_MESSAGE_KEYS.invalidColor, {
      field: key,
      details: { allowed: PROJECT_COLORS },
    });
  }
  return color;
}

export function requireProjectColor(body: JsonBody, key = 'color'): string {
  const color = readProjectColor(body, key);
  if (color === undefined) {
    throw badRequest('missing-field', ERROR_MESSAGE_KEYS.invalidColor, { field: key });
  }
  return color;
}

// ---------------------------------------------------------------------------
// Time, in whichever unit the caller holds it
// ---------------------------------------------------------------------------

interface MinutesSpec {
  minutesKey: string;
  hoursKey?: string;
  timeKey?: string;
  messageKey: string;
  min: number;
  max: number;
}

/**
 * Reads one time-valued field in any of its accepted units and returns whole minutes. A minutes
 * value is ROUNDED rather than rejected — a resize handle computes minutes from pixels, so
 * `149.9997` means 150. Two units for one field ARE refused: guessing one would silently discard
 * the owner's other number.
 */
export function readMinutes(body: JsonBody, spec: MinutesSpec): number | undefined {
  const present = [spec.minutesKey, spec.hoursKey, spec.timeKey].filter(
    (key): key is string => key !== undefined && hasField(body, key),
  );
  if (present.length === 0) return undefined;
  if (present.length > 1) {
    throw badRequest('ambiguous-field', spec.messageKey, {
      field: present[0],
      details: { conflictingFields: present },
    });
  }

  const key = present[0];
  const value = body[key];
  let minutes: number;

  if (key === spec.timeKey) {
    if (typeof value !== 'string') throw badRequest('invalid-field', spec.messageKey, { field: key });
    try {
      minutes = hhmmToMinutes(value);
    } catch {
      throw badRequest('invalid-field', spec.messageKey, { field: key });
    }
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw badRequest('invalid-field', spec.messageKey, { field: key });
    }
    minutes = key === spec.hoursKey ? hoursToMinutes(value) : Math.round(value);
  }

  if (minutes < spec.min || minutes > spec.max) {
    throw badRequest('out-of-range', spec.messageKey, {
      field: key,
      details: { min: spec.min, max: spec.max },
    });
  }
  return minutes;
}

function requireMinutes(body: JsonBody, spec: MinutesSpec): number {
  const value = readMinutes(body, spec);
  if (value === undefined) {
    throw badRequest('missing-field', spec.messageKey, { field: spec.minutesKey });
  }
  return value;
}

const START_SPEC: MinutesSpec = {
  minutesKey: 'startMinutes',
  timeKey: 'startTime',
  messageKey: ERROR_MESSAGE_KEYS.invalidTime,
  min: 0,
  max: MINUTES_PER_DAY - 1,
};

const DURATION_SPEC: MinutesSpec = {
  minutesKey: 'durationMinutes',
  hoursKey: 'durationHours',
  messageKey: ERROR_MESSAGE_KEYS.invalidDuration,
  min: 1,
  max: MINUTES_PER_DAY,
};

const TOTAL_SPEC: MinutesSpec = {
  minutesKey: 'totalMinutes',
  hoursKey: 'totalHours',
  messageKey: ERROR_MESSAGE_KEYS.invalidTotalHours,
  min: 1,
  max: MAX_TOTAL_HOURS * 60,
};

/** A time of day: `startMinutes` (0-1439) or `startTime` ("HH:mm"). */
export function readStartMinutes(body: JsonBody): number | undefined {
  return readMinutes(body, START_SPEC);
}

export function requireStartMinutes(body: JsonBody): number {
  return requireMinutes(body, START_SPEC);
}

/** A duration: `durationMinutes` or `durationHours`. Always more than zero. */
export function readDurationMinutes(body: JsonBody): number | undefined {
  return readMinutes(body, DURATION_SPEC);
}

export function requireDurationMinutes(body: JsonBody): number {
  return requireMinutes(body, DURATION_SPEC);
}

/**
 * A job's estimate: `totalHours` (what the stepper holds) or `totalMinutes`. Zero is refused —
 * there is nowhere to park hours off the calendar, so a nought-hour job would be a job that is
 * nowhere. `DELETE /api/projects/:id` is how a job goes away.
 */
export function readTotalMinutes(body: JsonBody): number | undefined {
  return readMinutes(body, TOTAL_SPEC);
}

export function requireTotalMinutes(body: JsonBody): number {
  return requireMinutes(body, TOTAL_SPEC);
}

