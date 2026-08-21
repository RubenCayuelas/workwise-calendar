// The Next server's lifecycle, with NO Electron import — so it can be run and verified from a plain
// Node process on any platform, which is where the things that actually go wrong live. `main.mjs` is
// the thin shell around it.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/** Asked of the OS rather than assumed: 3000 is the first thing any other dev tool takes. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the standalone server and resolves once it answers.
 *
 * `HOSTNAME` is pinned to 127.0.0.1: the standalone server binds 0.0.0.0 by default, which would put
 * the shop's calendar on the whole workshop network.
 */
export async function startServer({ appDir, nodeExe, dbPath, onExit, timeoutMs = 30_000 }) {
  const entry = path.join(appDir, 'server.js');
  if (!fs.existsSync(entry)) throw new Error(`No server to start at ${entry}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const port = await freePort();
  const child = spawn(nodeExe, [entry], {
    cwd: appDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      WORKWISE_DB_PATH: dbPath,
    },
  });

  const output = [];
  const keep = (chunk) => {
    output.push(String(chunk));
    if (output.length > 40) output.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    onExit?.(code, output.join(''));
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The server stopped before it answered:\n${output.join('')}`);
    if (await answers(origin)) return { origin, port, child };
    await new Promise((r) => setTimeout(r, 150));
  }
  stopServer(child);
  throw new Error(`The server did not answer in ${timeoutMs} ms:\n${output.join('')}`);
}

async function answers(origin) {
  try {
    const response = await fetch(`${origin}/api/settings`, { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stops it, and on Windows stops its CHILDREN too: Next starts worker processes, and `kill()` there
 * ends only the one it was given — the workers would keep the database file open with nothing owning
 * them.
 */
export function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      // Fall through to the ordinary signal.
    }
  }
  child.kill();
}
