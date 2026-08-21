// Refuses to install on the wrong Node, with a message instead of a wall of compiler errors.
//
// `better-sqlite3` 11.x publishes prebuilt binaries for Node ABIs 108, 115, 127 and 131 — Node 18, 20,
// 22 and 23. On anything else `prebuild-install` finds nothing and falls back to `node-gyp`, which needs
// a C++ toolchain and fails with hundreds of lines that do not name the real problem. Today's "LTS" is
// Node 24 (ABI 137), so `winget install OpenJS.NodeJS.LTS` lands exactly there.
//
// It also has to match the `node.exe` the desktop build bundles, or the packaged app loads a database
// binary built for a different runtime. `desktop/prepare.mjs` bundles whatever Node runs it, so pinning
// here pins both.

const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);

if (major !== REQUIRED_MAJOR) {
  process.stderr.write(
    `\nWorkwise needs Node ${REQUIRED_MAJOR}.x — this is ${process.version}.\n\n` +
      `  better-sqlite3 ships no prebuilt binary for this version, so npm would try to COMPILE it\n` +
      `  and fail without a C++ toolchain.\n\n` +
      `  Windows:  https://nodejs.org/dist/latest-v${REQUIRED_MAJOR}.x/  (the x64 .msi)\n` +
      `  nvm:      nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR}\n\n`,
  );
  process.exit(1);
}
