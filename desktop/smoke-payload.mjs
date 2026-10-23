// Starts an assembled payload the way the installed app does, from a copy OUTSIDE the checkout, and
// writes to its calendar. Takes the directory holding `server/` and `node.exe`: `build` after
// `npm run prepare-payload` (the default), or a packaged `dist/*-unpacked/resources`.
//
// A run in place proves nothing. The server loads its database driver only through
// `.next/node_modules/better-sqlite3-<hash>`, a link the build leaves in the standalone output, and a
// copied link still points into the build machine — the payload then works there and nowhere else.
// Module resolution would also walk up from `desktop/build` into the repository's own `node_modules`
// and find there whatever the payload is missing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, process.argv[2] ?? 'build');
const payload = path.join(resources, 'server');

const problems = [];

for (const name of fs.readdirSync(payload, { recursive: true })) {
  const entry = path.join(payload, name);
  if (fs.lstatSync(entry).isSymbolicLink()) {
    problems.push(`LINK in the payload: ${name} -> ${fs.readlinkSync(entry)}`);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-payload-'));
const appDir = path.join(scratch, 'server');
fs.cpSync(payload, appDir, { recursive: true, verbatimSymlinks: true });

// The runtime the installer ships, where there is one: the gates run on Linux, which has no `node.exe`.
const nodeExe =
  process.platform === 'win32' ? path.join(resources, 'node.exe') : process.execPath;

async function expectOk(what, response) {
  if (!response.ok) problems.push(`${what} answered ${response.status}: ${await response.text()}`);
  return response.ok ? response.json() : null;
}

let server;
try {
  server = await startServer({ appDir, nodeExe, dbPath: path.join(scratch, 'calendar.db') });
  const page = await fetch(server.origin);
  if (!page.ok) problems.push(`the calendar page answered ${page.status}`);

  const created = await expectOk(
    'creating a job',
    await fetch(`${server.origin}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Railing', color: '#1EA42B', totalHours: 6 }),
    }),
  );
  const date = created?.blocks?.[0]?.date;
  if (created && !date) problems.push('a job was created with nothing on the calendar');
  if (date) {
    const week = await expectOk('reading its week', await fetch(`${server.origin}/api/week?date=${date}`));
    if (week && !week.blocks.some((block) => block.project.name === 'Railing')) {
      problems.push(`the week of ${date} does not show the job just created`);
    }
  }
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  if (server) {
    const exited = new Promise((resolve) => server.child.once('exit', resolve));
    stopServer(server.child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
}

if (problems.length > 0) {
  process.stderr.write(`\n${payload} does not run on its own:\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`  payload runs from ${appDir}: the calendar opens and takes a job\n`);
