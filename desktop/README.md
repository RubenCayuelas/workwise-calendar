# Workwise as a Windows application

An Electron window around the app's own server. **The app is not rewritten**: nothing under `src/` or
`app/` knows this package exists.

```
Workwise.exe  (Electron 43)
│
├─ starts, on a free port, bound to 127.0.0.1 only
│     resources/node.exe  →  resources/app/server.js     ← the app, unchanged
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

Requires **Node 22 on Windows** (`winget install OpenJS.NodeJS.LTS`) and a clone on the Windows
filesystem — not `\\wsl$`, where npm and native modules are slow and permission-flaky.

```
npm ci                        # in the repository root
npm run build                 # emits .next/standalone
cd desktop
npm ci
npm run prepare-payload       # assembles build/app and downloads node.exe
npm run dist                  # produces dist/Workwise Setup <version>.exe
```

`npm start` in this folder runs the shell against `build/` without packaging, which is the fast loop.

## What the installer does

One-click, **per user**: installs into `%LOCALAPPDATA%`, never asks for administrator, and adds a
desktop and Start Menu shortcut. Windows registers an uninstaller in *Apps & features* on its own.

**Uninstalling keeps the data.** `deleteAppDataOnUninstall` is off, so `%APPDATA%\Workwise` — the
database *and* the backups folder — survives both an uninstall and an update. That one file is the
workshop's calendar; removing it has to be a deliberate act.

It is **not code-signed**, so Windows shows "Windows protected your PC" the first time. Handing the
installer over on a USB stick avoids it entirely: the warning comes from the mark Windows puts on files
downloaded from the internet, and a file copied from removable media does not carry one.

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
