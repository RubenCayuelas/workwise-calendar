/**
 * POST { name }                      restore one of the copies in the backups folder
 * POST <the file's bytes>            restore a copy from anywhere on the owner's disk
 *      -> { previousSavedAs }
 *
 * One implementation behind both, so neither way in can be the less tested one. The incoming file is
 * recognised and migrated before anything is replaced, and the calendar it replaces is kept as
 * `workwise-before-restore.db`.
 *
 * A JSON body means the first form; any other content type is the file itself, sent raw rather than
 * as multipart — there is one field and it is the whole body.
 */

import type { NextRequest } from 'next/server';
import { AppError, ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { readJsonBody, requireText, route } from '@/src/lib/api';
import { restoreBackup } from '@/src/lib/operations/backups';

export const dynamic = 'force-dynamic';

/** Far above any real calendar; here so a mis-picked file cannot be read into memory whole. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    if (request.headers.get('content-type')?.includes('application/json')) {
      const body = await readJsonBody(request);
      return restoreBackup({ name: requireText(body, 'name', { maxLength: 200 }) });
    }

    const uploaded = Buffer.from(await request.arrayBuffer());
    if (uploaded.byteLength === 0 || uploaded.byteLength > MAX_UPLOAD_BYTES) {
      throw new AppError({
        code: 'backup-not-a-database',
        messageKey: ERROR_MESSAGE_KEYS.backupNotADatabase,
        status: 400,
      });
    }
    return restoreBackup({ uploaded });
  });
}
