# Workwise as a Windows application

An Electron window around the app's own server. **The app is not rewritten**: nothing under `src/` or
`app/` knows this package exists.

```
Workwise.exe  (Electron 43)
│
├─ starts, on a free port, bound to 127.0.0.1 only
│     resources/node.exe  →  resources/server/server.js  ← the app, unchanged
│        └─ better-sqlite3 → %APPDATA%\Workwise\calendar.db
│
└─ shows one maximised window, no address bar, no menu
```

## Why a bundled `node.exe` and not Electron's own

`better-sqlite3` is compiled, so its binary has to match the runtime's ABI. There is **no supported
Electron version with a ready-made `better-sqlite3` binary**: the prebuilds stop at Electron 39/40
while the supported majors are 41-43, and `better-sqlite3` 13.x publishes none at all. Running the
server on a bundled Node instead uses the *Node* ABI prebuild, which does exist — so Electron stays
current and **nothing has to be compiled, ever**. That is worth 87 MB: a C++ toolchain in the build
path is the thing most likely to stop a fix from shipping months later.

## Building it

**Node 22 exactly**, and a clone on the Windows filesystem — not `\\wsl$`, where npm and native
modules are slow and permission-flaky.

> `winget install OpenJS.NodeJS.LTS` is the WRONG command: today's LTS is Node 24, and
> `better-sqlite3` 11.x publishes no binary for its ABI, so npm falls through to `node-gyp` and fails
> with hundreds of lines that never name the real problem. `scripts/require-node-22.mjs` now refuses
> the install up front instead. Take the x64 `.msi` from
> <https://nodejs.org/dist/latest-v22.x/>, or `nvm install 22`.

```
npm ci                        # in the repository root
npm run build                 # emits .next/standalone
cd desktop
npm ci
npm run prepare-payload       # assembles build/app and downloads node.exe
npm run dist                  # produces dist/Workwise Setup <version>.exe
```

`npm start` in this folder runs the shell against `build/` without packaging, which is the fast loop.

> The payload goes to `resources/server`, never `resources/app`: **electron-builder puts the
> application itself in `resources/app`** (`platformPackager.js:218`). Aiming the payload there
> overwrites its `node_modules`, and the installed app dies on `Cannot find module 'next'` — which is
> exactly what the first build did.

## Two things the packager does that cost three builds to find

**It silently drops any directory named `node_modules`** from `extraResources`. Measured: with that
name it does not arrive, renamed it arrives, and an explicit `**/node_modules/**` filter cannot
override it. So `prepare.mjs` copies it straight to `deps` and `server.mjs` sets
`NODE_PATH` — CJS `require` reads that, which is how `server.js` finds `next` and `better-sqlite3`
again. **Copied to the final name rather than renamed afterwards**: renaming a directory on Windows
moments after writing thousands of files into it fails with `EPERM`, the handles not being released
yet.

**`resources/app` is where it puts the application itself** (`platformPackager.js:218`), so the payload
goes to `resources/server`. Aiming it at `app` overwrote the app's own files.

Neither failure says anything useful at the time. `main.mjs` therefore checks the five pieces of the
payload before opening a window and names the ones that are missing, with the path it looked in.

## What the installer does

One-click, **per user**: installs into `%LOCALAPPDATA%`, never asks for administrator, and adds a
desktop and Start Menu shortcut. Windows registers an uninstaller in *Apps & features* on its own.

**Uninstalling keeps the data.** `deleteAppDataOnUninstall` is off, so `%APPDATA%\Workwise` — the
database *and* the backups folder — survives both an uninstall and an update. That one file is the
workshop's calendar; removing it has to be a deliberate act.

It is **not code-signed**, so Windows shows "Windows protected your PC" the first time. Handing the
installer over on a USB stick avoids it entirely: the warning comes from the mark Windows puts on files
downloaded from the internet, and a file copied from removable media does not carry one.

## The tracer had to be told to leave the data alone

`output: 'standalone'` traces the files the server needs, and `getDbPath()` builds
`path.join(process.cwd(), 'data', ...)`. The tracer resolved it and pulled the **whole directory in**,
so the standalone output — and therefore the installer — carried the shop's own `calendar.db` and its
backups. `outputFileTracingExcludes` in `next.config.ts` stops it, and `prepare.mjs`'s output is worth
a glance after a Next upgrade: a payload that grows by the size of a database is this coming back.

## Moving an existing calendar onto a new machine

No extra tooling: *Guardar copia* in Settings, then *Cargar copia desde mi PC* on the new install.

## What is verified, and what only Windows can prove

`server.mjs` imports no Electron, so its whole job is testable from a plain Node process. Verified on
Linux against the real assembled payload: two calls for a free port give two different ports; the
server answers and serves `/`, `/settings` and the API; the database is created at the path it was
given; the port is **not** reachable from the machine's network address, only from `127.0.0.1`; and
`stopServer` leaves nothing answering.

Only a Windows run can prove the three remaining pieces fit: Electron opening the window, the bundled
`node.exe` running the server, and the win32 `better-sqlite3` binary loading. Build that before the
icon or anything cosmetic.
