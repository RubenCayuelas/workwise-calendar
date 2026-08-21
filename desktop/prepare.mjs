// Assembles what the installer ships: the standalone server, the two directories Next leaves out of
// it, and the Windows Node binary that runs it.
//
// Run from `desktop/` after `npm run build` in the repository root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const build = path.join(here, 'build');

/**
 * The Node that is RUNNING this script, not a constant. `npm ci` fetched better-sqlite3's binary for
 * THIS runtime, so bundling any other version would package a database binary the shipped `node.exe`
 * cannot load — and it would only fail on the customer's machine. `scripts/require-node-22.mjs` keeps
 * this to a version better-sqlite3 actually publishes binaries for.
 */
const NODE_VERSION = process.version;

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error(`Missing ${from} — run \`npm run build\` in the repo root first`);
  fs.cpSync(from, to, { recursive: true });
}

async function fetchNodeExe() {
  const target = path.join(build, 'node.exe');
  const stamp = path.join(build, 'node.exe.version');
  const cached = fs.existsSync(target) && fs.existsSync(stamp)
    && fs.readFileSync(stamp, 'utf8').trim() === NODE_VERSION;
  if (cached) return `cached ${NODE_VERSION} win-x64`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  fs.writeFileSync(stamp, NODE_VERSION);
  return `downloaded ${NODE_VERSION} win-x64`;
}

fs.rmSync(path.join(build, 'server'), { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });

copyDir(path.join(root, '.next', 'standalone'), path.join(build, 'server'));
// `output: 'standalone'` deliberately omits both of these; without them the app loads with no CSS.
copyDir(path.join(root, '.next', 'static'), path.join(build, 'server', '.next', 'static'));
copyDir(path.join(root, 'public'), path.join(build, 'server', 'public'));

// `next/image` is never used, and sharp is the largest thing in the bundle.
for (const unused of ['sharp', '@img']) {
  fs.rmSync(path.join(build, 'server', 'node_modules', unused), { recursive: true, force: true });
}

const node = await fetchNodeExe();

const size = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size, 0);

console.log(`  server payload: ${(size(path.join(build, 'server')) / 1_048_576).toFixed(1)} MB`);
console.log(`  node.exe:    ${node}`);
