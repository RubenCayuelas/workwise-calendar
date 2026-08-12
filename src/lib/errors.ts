/**
 * The one error shape the whole API speaks.
 *
 * Two rules, both from CLAUDE.md:
 *
 * - An error never carries a translated sentence. It carries an i18n KEY, and the
 *   Spanish and English wordings live in `public/locales/{es,en}/common.json`.
 *   The engine already works this way (`ComposeError.messageKey`), so a route can
 *   forward an engine failure without inventing prose.
 * - Anything the caller may need in order to word the message goes in `details`,
 *   never spliced into the key. `errors.gapOverLockedBlock` interpolates
 *   `{{projectName}}` from `details`, so one key covers every locked block.
 *
 * `field` exists for form validation: the Settings screen and the job form point
 * at the offending input with it.
 */

export type ErrorStatus = 400 | 404 | 409 | 500;

/** The JSON body of every failed request. */
export interface ApiErrorBody {
  error: {
    /** Machine-readable, kebab-case. Stable: the UI may branch on it. */
    code: string;
    /** i18n key under `errors.` in public/locales/{lang}/common.json. */
    messageKey: string;
    /** The input to highlight, when the failure belongs to one. */
    field?: string;
    /** Anything the message interpolates, plus context for the console. */
    details?: Record<string, unknown>;
  };
}

interface AppErrorInit {
  code: string;
  messageKey: string;
  status: ErrorStatus;
  field?: string;
  details?: Record<string, unknown>;
}

/**
 * Every deliberate refusal in the data layer throws this. `src/lib/api.ts` is the
 * only place that turns one into a response, so a route handler never builds an
 * error body by hand.
 *
 * Throwing rather than returning is load bearing: a mutation runs inside a
 * `better-sqlite3` transaction, and a throw is what rolls it back. A refusal that
 * came back as a value would have to be re-thrown to undo the write, so it is
 * thrown from the start.
 */
export class AppError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly status: ErrorStatus;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(init: AppErrorInit) {
    super(`${init.code} (${init.messageKey})`);
    this.name = 'AppError';
    this.code = init.code;
    this.messageKey = init.messageKey;
    this.status = init.status;
    this.field = init.field;
    this.details = init.details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        messageKey: this.messageKey,
        ...(this.field === undefined ? {} : { field: this.field }),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

type ErrorExtra = { field?: string; details?: Record<string, unknown> };

/** 400: the payload is malformed or out of range. */
export function badRequest(code: string, messageKey: string, extra: ErrorExtra = {}): AppError {
  return new AppError({ code, messageKey, status: 400, ...extra });
}

/** 404: the row the request names is gone. */
export function notFound(code: string, messageKey: string, extra: ErrorExtra = {}): AppError {
  return new AppError({ code, messageKey, status: 404, ...extra });
}

/**
 * 409: the payload is well formed but a business rule refuses it — a gap over a
 * locked block, hours past the planning horizon, shrinking a job's last block.
 * Nothing was written.
 */
export function conflict(code: string, messageKey: string, extra: ErrorExtra = {}): AppError {
  return new AppError({ code, messageKey, status: 409, ...extra });
}

/** 500: a bug or a corrupt database. */
export function internal(code: string, messageKey: string, extra: ErrorExtra = {}): AppError {
  return new AppError({ code, messageKey, status: 500, ...extra });
}

/**
 * Every i18n key the data layer can return, in one list so it can be diffed
 * against the locale files. The engine owns the keys in `EDIT_MESSAGE_KEYS` and
 * `HORIZON_EXCEEDED_KEY` (src/lib/composition.ts); these are the rest.
 */
export const ERROR_MESSAGE_KEYS = {
  invalidPayload: 'errors.invalidPayload',
  invalidName: 'errors.invalidName',
  invalidDescription: 'errors.invalidDescription',
  invalidColor: 'errors.invalidColor',
  invalidTotalHours: 'errors.invalidTotalHours',
  invalidDate: 'errors.invalidDate',
  invalidTime: 'errors.invalidTime',
  invalidDuration: 'errors.invalidDuration',
  invalidReason: 'errors.invalidReason',
  invalidFlag: 'errors.invalidFlag',
  invalidAction: 'errors.invalidAction',
  projectNotFound: 'errors.projectNotFound',
  blockNotFound: 'errors.unknownBlock',
  gapNotFound: 'errors.gapNotFound',
  splitExceedsBlock: 'errors.splitExceedsBlock',
  deleteLastBlock: 'errors.deleteLastBlock',
  gapOverLockedBlock: 'errors.gapOverLockedBlock',
  gapOverHandPlacedBlock: 'errors.gapOverHandPlacedBlock',
  gapOverPastBlock: 'errors.gapOverPastBlock',
  gapOverWeekendBlock: 'errors.gapOverWeekendBlock',
  invariantViolated: 'errors.invariantViolated',
  settingsInvalid: 'errors.settingsInvalid',
  unexpected: 'errors.unexpected',
} as const;
