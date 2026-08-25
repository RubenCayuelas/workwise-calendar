/**
 * The only module here that touches the network. Everything else takes a payload, so the whole
 * feature is testable without one.
 *
 * `JUNTA_URL` answers 302 to juntadeandalucia.es/ssdigitales/…; a fetch that does not follow the
 * redirect gets a 145-byte nginx page and every date silently disappears.
 */

/** Official, CC BY 4.0, no key. Ignores every query parameter and always returns the whole file. */
export const JUNTA_URL = 'https://datos.juntadeandalucia.es/api/v0/work-calendar/all?format=json';

/** The shop PC must not hang on a dead host while the app is starting. */
const TIMEOUT_MS = 20_000;

export function festivosIoUrl(ine: string, year: number): string {
  return `https://festivos.io/v1/${year}/municipio/${ine}.json`;
}

export interface HolidaySource {
  /** The whole Junta dataset as parsed JSON, or `null` if it could not be had. */
  dates(): Promise<unknown | null>;
  /** festivos.io for one municipality and year, or `null`. */
  names(ine: string, year: number): Promise<unknown | null>;
}

export const HTTP_SOURCE: HolidaySource = {
  dates: () => getJson(JUNTA_URL),
  names: (ine, year) => getJson(festivosIoUrl(ine, year)),
};

/** Every failure is `null`: a timeout, a 404, a redirect to an error page, a body that is not JSON. */
async function getJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
