// Every decision an update makes, with no Electron and no updater behind it. `main.mjs` is the only
// file that imports either, so this one runs — and is tested — from a plain Node process.

/**
 * The `{{name}}` interpolation i18next does inside the app, for the sentences the shell reads out of
 * the same language files. An unknown placeholder is left standing: a gap says less than `undefined`.
 */
export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) =>
    name in values ? String(values[name]) : placeholder,
  );
}

/** The order that IS the feature: the copy is taken first, and nothing installs unless it was. */
export async function installDownloadedUpdate(version, acts) {
  const {
    backUp,
    ask = () => Promise.resolve('later'),
    warn = () => Promise.resolve(),
    installNow = () => {},
    installOnQuit = () => {},
    log = () => {},
  } = acts;

  try {
    await backUp(version);
  } catch (error) {
    // An installed update cannot be undone, so with no way back there is nothing to weigh up.
    log('the calendar could not be copied, so nothing was installed', error);
    await warn(version).catch((failure) => log('could not report the failed copy', failure));
    return;
  }

  let choice;
  try {
    choice = await ask(version);
  } catch (error) {
    log('could not ask about the update', error);
    return;
  }

  if (choice === 'now') installNow();
  else installOnQuit();
}

/**
 * Wires the updater up and starts one check. It resolves whatever the check did: a shop with no
 * network, or a release that is still a draft, must open the calendar exactly as it always does.
 */
export async function watchForUpdates({ updater, whenQuitting = () => {}, log = () => {}, ...acts }) {
  updater.autoDownload = true;
  // It defaults to TRUE, and its own installer runs synchronously inside `quit`, where an awaited
  // copy cannot veto anything. Left alone, an update installs with no copy at all.
  updater.autoInstallOnAppQuit = false;
  // The target is plain NSIS, never the web installer; false only earns a warning on every download.
  updater.disableWebInstaller = true;

  updater.on('error', (error) => log('the updater reported an error', error));

  updater.on('update-downloaded', (event) =>
    installDownloadedUpdate(event.version, {
      ...acts,
      log,
      installNow: () => updater.quitAndInstall(true, true),
      installOnQuit: () => whenQuitting(() => updater.quitAndInstall(true, false)),
    }),
  );

  // It BOTH emits `error` and rejects, so a missing catch here is an unhandled rejection as well.
  let started;
  try {
    started = await updater.checkForUpdates();
  } catch (error) {
    log('could not check for updates', error);
    return;
  }

  // The check resolves as soon as the VERSION comparison succeeds and hands back the download it has
  // already begun. That promise rethrows on a lost connection or a checksum that does not match, and
  // nothing else is holding it: dropped, it reaches the main process as a fatal unhandled rejection.
  started?.downloadPromise?.catch((error) => log('the update could not be downloaded', error));
}
