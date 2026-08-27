// Refuses to publish a package that repeats a failure this one has already had. Run after
// `electron-builder`, against whichever `dist/*-unpacked` it produced.
//
// Every check here is a bug that shipped, or nearly did:
//   * the payload aimed at `resources/app`, which is electron-builder's own — the installed app died
//     on `Cannot find module 'next'`;
//   * `node_modules` dropped silently from extraResources, with the same symptom;
//   * the file tracer following `getDbPath()` into `data/`, so the installer carried the shop's own
//     calendar and its backups to every customer.
//
// The updater's two are the same shape, and neither is visible from outside the archive: a package
// whose `app-update.yml` names no provider can never find a release, and one whose `dependencies`
// were not collected dies on `Cannot find module 'electron-updater'` at first launch.

import { extractFile, listPackage } from '@electron/asar';
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

// The updater reads this at runtime; without a provider in it there is no release to look at, and
// electron-builder writes one only when a `publish` config resolved at build time.
const updateConfig = path.join(resources, 'app-update.yml');
if (!fs.existsSync(updateConfig)) {
  fail('MISSING the update configuration: resources/app-update.yml');
} else if (!/^provider:/m.test(fs.readFileSync(updateConfig, 'utf8'))) {
  fail('resources/app-update.yml names no provider, so the app can never find a release');
}

// `fs` cannot see inside an asar from plain Node — Electron patches that in, and this is not Electron.
const archive = path.join(resources, 'app.asar');
if (!fs.existsSync(archive)) {
  fail('MISSING the application archive: resources/app.asar');
} else {
  const inside = new Set(listPackage(archive));
  for (const [what, entry] of [
    ['the shell', '/main.mjs'],
    ['the update decisions', '/updates.mjs'],
    ['the updater', '/node_modules/electron-updater/out/main.js'],
  ]) {
    if (!inside.has(entry)) fail(`MISSING ${what} from app.asar: ${entry}`);
  }

  // The updater's own dependencies are collected by a mechanism `files` does not gate, so one going
  // missing is silent until the shop PC launches it. `semver` nests rather than hoisting.
  const manifest = '/node_modules/electron-updater/package.json';
  if (inside.has(manifest)) {
    for (const name of Object.keys(JSON.parse(extractFile(archive, manifest.slice(1))).dependencies)) {
      if (
        !inside.has(`/node_modules/${name}/package.json`) &&
        !inside.has(`/node_modules/electron-updater/node_modules/${name}/package.json`)
      ) {
        fail(`MISSING a dependency of the updater from app.asar: ${name}`);
      }
    }
  }

  for (const entry of inside) {
    if (/\.(db|db-wal|db-shm|sqlite3?)$/i.test(entry)) fail(`SHIPS A DATABASE in app.asar: ${entry}`);
  }
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
