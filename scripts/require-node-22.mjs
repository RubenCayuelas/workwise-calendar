// Refuses to install on the wrong Node, with a message instead of a failure much further down.
//
// `better-sqlite3` needs Node 22 or newer and ships Node-API binaries, which load on any of them. What
// makes the pin EXACT is the desktop build: `desktop/prepare.mjs` bundles a `node.exe` of whatever Node
// runs it, so without a pin the shop's runtime is whichever version the build machine happened to have.
// Today's "LTS" is Node 24, so `winget install OpenJS.NodeJS.LTS` lands exactly there.

const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);

if (major !== REQUIRED_MAJOR) {
  process.stderr.write(
    `\nWorkwise needs Node ${REQUIRED_MAJOR}.x — this is ${process.version}.\n\n` +
      `  The Windows installer bundles whichever Node builds it, so the shop would end up running\n` +
      `  a version nothing here was tested on.\n\n` +
      `  Windows:  https://nodejs.org/dist/latest-v${REQUIRED_MAJOR}.x/  (the x64 .msi)\n` +
      `  nvm:      nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR}\n\n`,
  );
  process.exit(1);
}
