// The Electron shell: a window and a runtime, nothing else. Every decision that can be wrong lives in
// `server.mjs`, which imports no Electron and can therefore be run from a plain Node process.

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer } from './server.mjs';

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

async function open() {
  const { appDir, nodeExe } = payload();
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
  }
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
