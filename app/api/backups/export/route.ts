/**
 * GET -> the database as a file download, `workwise-YYYY-MM-DD-HHmm.db`
 *
 * A fresh copy every time, taken with `VACUUM INTO`: one consistent file with no WAL sidecar, which a
 * copy of `calendar.db` would not be. Written to a temporary file, streamed, and deleted — where the
 * owner keeps it is decided in the browser, not here.
 *
 * The only route in the app that does not answer JSON, so it does not use `route()`.
 */

import fs from 'fs';
import path from 'path';
import { failure } from '@/src/lib/api';
import { exportBackup } from '@/src/lib/operations/backups';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let filePath: string | undefined;
  try {
    const created = exportBackup();
    filePath = created.filePath;
    const body = fs.readFileSync(filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `attachment; filename="${created.fileName}"`,
        // The copy is taken per request; a cached one would hand back an older calendar.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return failure(error);
  } finally {
    if (filePath !== undefined) fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
}
