// Refuses to publish a package that repeats a failure this one has already had. Run after
// `electron-builder`, against whichever `dist/*-unpacked` it produced.
//
// Every check here is a bug that shipped, or nearly did:
//   * the payload aimed at `resources/app`, which is electron-builder's own — the installed app died
//     on `Cannot find module 'next'`;
//   * `node_modules` dropped silently from extraResources, with the same symptom;
//   * the file tracer following `getDbPath()` into `data/`, so the installer carried the shop's own
//     calendar and its backups to every customer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');

function unpackedDir() {
  const candidates = fs.existsSync(dist)
    ? fs.readdirSync(dist).filter((name) => name.endsWith('-unpacked'))
    : [];
  if (candidates.length !== 1) {
    fail(`Expected exactly one dist/*-unpacked directory, found ${candidates.length}: ${candidates}`);
  }
  return path.join(dist, candidates[0]);
}

const problems = [];
function fail(message) {
  problems.push(message);
}

const unpacked = unpackedDir();
const resources = path.join(unpacked, 'resources');
const server = path.join(resources, 'server');

for (const [what, target] of [
  ['the server', path.join(server, 'server.js')],
  ['next', path.join(server, 'deps', 'next', 'package.json')],
  ['the database driver', path.join(server, 'deps', 'better-sqlite3', 'package.json')],
  ['the native database binary', path.join(server, 'deps', 'better-sqlite3', 'build', 'Release')],
  ['the static assets', path.join(server, '.next', 'static')],
  ['the brand assets', path.join(server, 'public', 'brand')],
  ['the node runtime', path.join(resources, 'node.exe')],
]) {
  if (!fs.existsSync(target)) fail(`MISSING ${what}: ${path.relative(unpacked, target)}`);
}

/** Anything of the owner's that must never leave this machine inside an installer. */
const shipped = fs
  .readdirSync(unpacked, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

for (const file of shipped) {
  if (/\.(db|db-wal|db-shm|sqlite3?)$/i.test(file)) {
    fail(`SHIPS A DATABASE: ${path.relative(unpacked, file)}`);
  }
}

const megabytes = (
  shipped.reduce((total, file) => total + fs.statSync(file).size, 0) / 1_048_576
).toFixed(0);

if (problems.length > 0) {
  process.stderr.write(`\n${unpacked} is not fit to publish:\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`  package verified: ${shipped.length} files, ${megabytes} MB, no database inside\n`);
