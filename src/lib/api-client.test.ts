/**
 * The client's contract with the API, in particular the error mapping.
 *
 * The point of the error tests is that a refusal must never reach the owner as a
 * dotted key, a raw `2026-10-04`, or the word "undefined" — those are the three ways
 * an i18n-keyed error layer usually leaks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiErrorMessage,
  apiErrorMessageKey,
  apiErrorValues,
  createGap,
  createProject,
  getWeek,
  isApiError,
  isNetworkError,
  listGaps,
  moveBlock,
  moveGap,
  previewAbsence,
  reopenDays,
  resizeBlock,
  resizeGap,
  saveAbsence,
  setBlockLock,
  updateProject,
  updateSettings,
} from './api-client';
import es from '../../public/locales/es/common.json';

/** Minimal i18next stand-in: resolves the key and substitutes `{{name}}`. */
function translate(key: string, values: Record<string, unknown> = {}): string {
  const template = key.split('.').reduce<unknown>(
    (node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined),
    es,
  );
  if (typeof template !== 'string') return key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    values[name] === undefined ? `{{${name}}}` : String(values[name]),
  );
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}

function stubFetch(response: { status?: number; body?: unknown }): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string> | undefined,
    });
    const status = response.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response.body ?? {}),
    } as Response);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requests', () => {
  it('always sends minutes, never hours, so 2.5 h cannot drift', async () => {
    const { calls } = stubFetch({ body: { project: {}, blocks: [], summary: {}, touchedLockedBlockIds: [] } });
    await createProject({ name: 'Door', color: '#3087DF', totalMinutes: 150 });
    expect(calls[0].body).toEqual({ name: 'Door', color: '#3087DF', totalMinutes: 150 });
    expect(JSON.stringify(calls[0].body)).not.toContain('totalHours');
  });

  it('omits the keys a caller left undefined, so a PATCH never blanks a stored value', async () => {
    const { calls } = stubFetch({ body: {} });
    await updateProject('p1', { name: 'Railing', description: undefined, color: undefined });
    expect(calls[0].body).toEqual({ name: 'Railing' });
  });

  it('keeps an explicit null, which is how a description is cleared', async () => {
    const { calls } = stubFetch({ body: {} });
    await updateProject('p1', { description: null });
    expect(calls[0].body).toEqual({ description: null });
  });

  it('discriminates the three block gestures by action', async () => {
    const { calls } = stubFetch({ body: {} });
    await moveBlock('b1', { date: '2026-08-12', startMinutes: 480 });
    await resizeBlock('b1', 360);
    await setBlockLock('b1', true);
    expect(calls.map((call) => call.body)).toEqual([
      { action: 'move', date: '2026-08-12', startMinutes: 480 },
      { action: 'resize', durationMinutes: 360 },
      { action: 'lock', locked: true },
    ]);
    expect(calls.every((call) => call.method === 'PATCH')).toBe(true);
  });

  it('sends a JSON content type only when there is a body', async () => {
    const { calls } = stubFetch({ body: { gaps: [] } });
    await listGaps();
    await createGap({ date: '2026-08-12', startMinutes: 600, durationMinutes: 60 });
    expect(calls[0].headers).toBeUndefined();
    expect(calls[1].headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('builds the gap window query and omits it when empty', async () => {
    const { calls } = stubFetch({ body: { gaps: [] } });
    await listGaps();
    await listGaps({ from: '2026-08-10', to: '2026-08-16' });
    expect(calls[0].url).toBe('/api/gaps');
    expect(calls[1].url).toBe('/api/gaps?from=2026-08-10&to=2026-08-16');
  });

  it('never caches a GET, because a recomposition rewrites rows behind it', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    });
    await getWeek('2026-08-12');
    expect(calls[0].cache).toBe('no-store');
  });

  it('percent-encodes an id into the path', async () => {
    const { calls } = stubFetch({ body: {} });
    await setBlockLock('a/b?c', false);
    expect(calls[0].url).toBe('/api/blocks/a%2Fb%3Fc');
  });

  it("names the GESTURE on a gap's PATCH, which the payload alone cannot say", async () => {
    // A drag and a form save send the same three fields; only `action` lets the server freeze the
    // two gestures in the past while the form still reaches it.
    const { calls } = stubFetch({ body: {} });
    await moveGap('breakdown', { date: '2026-08-12', startMinutes: 600 });
    await resizeGap('breakdown', 240);
    expect(calls[0].body).toEqual({ date: '2026-08-12', startMinutes: 600, action: 'move' });
    expect(calls[1].body).toEqual({ durationMinutes: 240, action: 'resize' });
    expect(calls[0].url).toBe('/api/gaps/breakdown');
  });

  it('sends an absence range as one request, and previews it at its own path', async () => {
    const { calls } = stubFetch({ body: {} });
    await saveAbsence({ kind: 'closed-days', from: '2026-09-01', to: '2026-09-04', reason: 'Fair' });
    await previewAbsence({ kind: 'gap', from: '2026-09-01', startMinutes: 780, durationMinutes: 180 });
    expect(calls[0].url).toBe('/api/absences');
    expect(calls[0].body).toEqual({
      kind: 'closed-days',
      from: '2026-09-01',
      to: '2026-09-04',
      reason: 'Fair',
    });
    expect(calls[1].url).toBe('/api/absences/preview');
    // `to` omitted is a range of one day, and the undefined key must not be sent as null.
    expect(calls[1].body).toEqual({
      kind: 'gap',
      from: '2026-09-01',
      startMinutes: 780,
      durationMinutes: 180,
    });
  });

  it('reopens a range of closed days with both bounds in the query', async () => {
    const { calls } = stubFetch({ body: { dates: [] } });
    await reopenDays({ from: '2026-09-01', to: '2026-09-04' });
    await reopenDays({ from: '2026-09-01' });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('/api/absences/closed-days?from=2026-09-01&to=2026-09-04');
    expect(calls[1].url).toBe('/api/absences/closed-days?from=2026-09-01');
  });

  it('drops undefined settings keys — the bug that once wiped period1Start', async () => {
    const { calls } = stubFetch({ body: {} });
    await updateSettings({ period2Enabled: false, period1Start: undefined });
    expect(calls[0].body).toEqual({ period2Enabled: false });
  });
});

describe('failures', () => {
  it('turns the typed error body into an ApiError, keeping code, field and details', async () => {
    stubFetch({
      status: 409,
      body: {
        error: {
          code: 'gap-over-fixed-block',
          messageKey: 'errors.gapOverLockedBlock',
          details: { projectName: 'Railing', date: '2026-08-11', startTime: '08:00', endTime: '12:00' },
        },
      },
    });

    const error = await createGap({ date: '2026-08-11', startMinutes: 480, durationMinutes: 60 }).catch(
      (caught: unknown) => caught,
    );

    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe('gap-over-fixed-block');
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).details.projectName).toBe('Railing');
  });

  it('names the offending input on a 400 so the form can highlight it', async () => {
    stubFetch({
      status: 400,
      body: { error: { code: 'invalid-field', messageKey: 'errors.settingsInvalid', field: 'period1End' } },
    });
    const error = await updateSettings({ period1End: '07:00' }).catch((caught: unknown) => caught);
    expect((error as ApiError).field).toBe('period1End');
  });

  it('reports a dead server as a network failure rather than a crash', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const error = await getWeek().catch((caught: unknown) => caught);
    expect(isNetworkError(error)).toBe(true);
    expect(apiErrorMessageKey(error)).toBe('errors.networkFailed');
  });

  it('falls back to a generic key when the body is not the typed shape', async () => {
    stubFetch({ status: 500, body: { oops: true } });
    const error = await getWeek().catch((caught: unknown) => caught);
    expect(apiErrorMessageKey(error)).toBe('errors.unexpected');
  });

  it('re-throws an abort untouched, so an unmount is not shown as an error', async () => {
    vi.stubGlobal('fetch', () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      return Promise.reject(abort);
    });
    const error = await getWeek().catch((caught: unknown) => caught);
    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('error messages', () => {
  it('picks the horizon key that names the date, and formats that date', () => {
    const error = new ApiError({
      code: 'horizon-exceeded',
      status: 409,
      messageKey: 'errors.horizonExceeded',
      details: { horizonEndDate: '2026-10-04' },
    });

    expect(apiErrorMessageKey(error)).toBe('errors.horizonExceededUntil');
    expect(apiErrorValues(error, 'es').date).toBe('domingo 4 de octubre');
    expect(apiErrorMessage(error, translate, 'es')).toBe(
      'No caben todas las horas antes del domingo 4 de octubre, que es el final del horizonte de planificación. Amplía el horizonte en Configuración o reduce las horas. No se ha guardado nada.',
    );
  });

  it('keeps the plain horizon key when the server sent no date', () => {
    const error = new ApiError({ code: 'horizon-exceeded', status: 409, messageKey: 'errors.horizonExceeded' });
    expect(apiErrorMessageKey(error)).toBe('errors.horizonExceeded');
    expect(apiErrorMessage(error, translate, 'es')).not.toContain('{{');
  });

  it('words a gap conflict with the job, the day and the times', () => {
    const error = new ApiError({
      code: 'gap-over-fixed-block',
      status: 409,
      messageKey: 'errors.gapOverLockedBlock',
      details: { projectName: 'Railing', date: '2026-08-11', startTime: '08:00', endTime: '12:00' },
    });

    expect(apiErrorMessage(error, translate, 'es')).toBe(
      'Ese hueco pisa «Railing», que está bloqueado el martes 11 de agosto de 08:00 a 12:00. Desbloquéalo o muévelo antes de guardar.',
    );
  });

  it('leaves no placeholder unfilled for any keyed failure', () => {
    const error = new ApiError({
      code: 'gap-over-fixed-block',
      status: 409,
      messageKey: 'errors.gapOverWeekendBlock',
      details: { projectName: 'Shutter', date: '2026-08-15', startTime: '09:00', endTime: '11:00' },
    });
    expect(apiErrorMessage(error, translate, 'en')).not.toContain('{{');
  });

  it('gives a non-ApiError the generic key instead of leaking a stack trace', () => {
    expect(apiErrorMessageKey(new Error('boom'))).toBe('errors.unexpected');
    expect(apiErrorValues(new Error('boom'))).toEqual({});
  });
});
