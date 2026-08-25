import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_SOURCE, JUNTA_URL, festivosIoUrl } from './fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init: RequestInit) => Promise.resolve(handler(String(input), init))),
  );
}

describe('the holiday source', () => {
  it('asks the Junta for the whole dataset, FOLLOWING REDIRECTS', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return new Response('[{"date":20260101}]', { status: 200 });
    });

    await expect(HTTP_SOURCE.dates()).resolves.toEqual([{ date: 20260101 }]);
    expect(seen[0].url).toBe(JUNTA_URL);
    // Without this the 302 lands on an nginx page and every date disappears.
    expect(seen[0].init.redirect).toBe('follow');
  });

  it('builds the festivos.io URL from the INE code and the year', () => {
    expect(festivosIoUrl('14055', 2026)).toBe('https://festivos.io/v1/2026/municipio/14055.json');
  });

  it('asks festivos.io for the municipality it was given', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return new Response('{"holidays":[]}', { status: 200 });
    });

    await HTTP_SOURCE.names('04003', 2027);
    expect(seen[0]).toBe('https://festivos.io/v1/2027/municipio/04003.json');
  });

  it('answers null on a non-2xx, and never throws', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));
    await expect(HTTP_SOURCE.names('14055', 2027)).resolves.toBeNull();
  });

  it('answers null on a body that is not JSON', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    await expect(HTTP_SOURCE.dates()).resolves.toBeNull();
  });

  it('answers null when the request itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));
    await expect(HTTP_SOURCE.dates()).resolves.toBeNull();
  });

  it('names the official endpoint, which is the one that carries the furthest year', () => {
    expect(JUNTA_URL).toContain('datos.juntadeandalucia.es');
  });
});
