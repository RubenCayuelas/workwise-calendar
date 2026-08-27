// The Electron shell: a window and a runtime, nothing else. Every decision that can be wrong lives in
// `server.mjs`, which imports no Electron and can therefore be run from a plain Node process.

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer } from './server.mjs';
import { fill, watchForUpdates } from './updates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Below this the seven-column grid stops being readable. The app is desktop only by design. */
const MIN_WIDTH = 1100;
const MIN_HEIGHT = 700;

// Two clicks on the icon would otherwise start two servers on one database file.
if (!app.requestSingleInstanceLock()) app.quit();

let server;

/**
 * Packaged, the payload sits in `resources/`; from a checkout it sits in `desktop/build/`, so the
 * same shell runs both without a flag to remember.
 *
 * It is `server` and NOT `app`: electron-builder puts the application ITSELF in `resources/app`, so a
 * payload aimed there collides with it — the packaged app started and then died on
 * `Cannot find module 'next'`, because its `node_modules` had been overwritten.
 */
function payload() {
  const root = app.isPackaged ? process.resourcesPath : path.join(here, 'build');
  return {
    appDir: path.join(root, 'server'),
    nodeExe: process.platform === 'win32' ? path.join(root, 'node.exe') : process.execPath,
  };
}

/**
 * What is actually on disk, named. Two builds failed on a machine that could not be inspected, and a
 * raw `Cannot find module` from a child process does not say which of the pieces is missing or where it
 * was looked for. This turns any future failure into one line worth reporting.
 */
function describePayload({ appDir, nodeExe }) {
  const checks = [
    ['server', path.join(appDir, 'server.js')],
    ['next', path.join(appDir, 'deps', 'next', 'package.json')],
    ['database driver', path.join(appDir, 'deps', 'better-sqlite3', 'package.json')],
    ['static assets', path.join(appDir, '.next', 'static')],
    ['node runtime', nodeExe],
  ];
  const missing = checks.filter(([, target]) => !fs.existsSync(target));
  if (missing.length === 0) return null;
  return [
    `Workwise ${app.getVersion()} is missing part of its payload.`,
    '',
    `Looked in: ${appDir}`,
    '',
    ...missing.map(([what, target]) => `  MISSING  ${what}: ${target}`),
    '',
    `Present there: ${listing(appDir)}`,
  ].join('\n');
}

function listing(dir) {
  try {
    return fs.readdirSync(dir).slice(0, 12).join(', ') || '(empty)';
  } catch {
    return '(the directory does not exist)';
  }
}

async function open() {
  const { appDir, nodeExe } = payload();

  const problem = describePayload({ appDir, nodeExe });
  if (problem !== null) {
    dialog.showErrorBox('Workwise', problem);
    app.quit();
    return;
  }
  const window = new BrowserWindow({
    show: false,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#F7F6F2',
    title: 'Workwise',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  window.maximize();
  // Shown before the server is up, so the app appears immediately rather than after a blank pause.
  window.show();

  // Anything that is not the calendar opens in the real browser instead of inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    server = await startServer({
      appDir,
      nodeExe,
      dbPath: path.join(app.getPath('userData'), 'calendar.db'),
      onExit: (code, log) => {
        if (app.isPackaged === false) console.error(`server exited (${code})\n${log}`);
      },
    });
    await window.loadURL(server.origin);
  } catch (error) {
    dialog.showErrorBox('Workwise', String(error instanceof Error ? error.message : error));
    app.quit();
    return;
  }

  // Never awaited: whether an update exists is not something the calendar waits on.
  void startUpdates(window, server.origin, appDir);
}

/**
 * The wording comes from the app's OWN language files, in the language last chosen — the shell reads
 * the same bundle the screen does, so a sentence exists in exactly one place.
 *
 * The choice is not in the database: it lives in the window's `localStorage`, under the key
 * `src/lib/i18n.ts` writes. Changing the key there has to be changed here too.
 */
async function readWording(window, appDir) {
  const chosen = await window.webContents
    .executeJavaScript("window.localStorage.getItem('workwise.language')")
    .catch(() => null);
  const language = chosen === 'en' ? 'en' : 'es';
  const bundle = path.join(appDir, 'public', 'locales', language, 'common.json');
  return JSON.parse(fs.readFileSync(bundle, 'utf8')).updates;
}

/**
 * The updater, wired to the four things only Electron can do. Everything it decides is in
 * `updates.mjs`, which imports neither Electron nor the updater and is therefore under `npm test`.
 *
 * `better-sqlite3` is built for the bundled `node.exe`, not for Electron's ABI, so the shell cannot
 * copy the calendar itself: it asks the server that already holds it, and installs nothing unless
 * that answers.
 */
async function startUpdates(window, origin, appDir) {
  if (!app.isPackaged) return;

  let words;
  try {
    words = await readWording(window, appDir);
  } catch (error) {
    // With nothing to say to the owner there is no way to offer an update, so none is offered.
    console.error('the update wording could not be read', error);
    return;
  }

  const box = (type, title, body, version, buttons) =>
    dialog.showMessageBox(window, {
      type,
      title,
      message: title,
      detail: fill(body, { version }),
      ...(buttons === undefined ? {} : { buttons, defaultId: 1, cancelId: 1 }),
    });

  await watchForUpdates({
    // Destructured here rather than at the top of the file: reading it builds a platform updater,
    // which needs Electron and a valid semver version, and dev must not pay for either.
    updater: electronUpdater.autoUpdater,
    backUp: async (version) => {
      const response = await fetch(`${origin}/api/backups/before-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!response.ok) throw new Error(`the calendar was not copied (${response.status})`);
    },
    ask: async (version) => {
      const { response } = await box('info', words.readyTitle, words.readyBody, version, [
        words.restartNow,
        words.onClose,
      ]);
      return response === 0 ? 'now' : 'later';
    },
    warn: (version) =>
      box('warning', words.backupFailedTitle, words.backupFailedBody, version),
    whenQuitting: (install) => app.once('quit', install),
    log: (message, error) => console.error(`[workwise] ${message}`, error),
  });
}

app.whenReady().then(() => {
  // No File/Edit/View menu: this is one screen, and the shortcuts it wants are its own.
  Menu.setApplicationMenu(null);
  void open();
});

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

// Closing the window closes the program, which is what the owner chose. macOS convention is
// deliberately not followed: this is a Windows application.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => stopServer(server?.child));
