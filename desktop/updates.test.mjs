import { describe, expect, it } from 'vitest';
import { fill, installDownloadedUpdate, watchForUpdates } from './updates.mjs';

describe('putting the version into a sentence from the language files', () => {
  it('fills every placeholder the app would have filled', () => {
    expect(fill('Workwise {{version}} has been downloaded.', { version: '0.26.0' })).toBe(
      'Workwise 0.26.0 has been downloaded.',
    );
  });

  it('leaves a placeholder it was given nothing for, rather than printing "undefined"', () => {
    expect(fill('Workwise {{version}}', {})).toBe('Workwise {{version}}');
  });
});

/** Enough of `autoUpdater` to prove the order of events, with none of Electron behind it. */
function fakeUpdater() {
  const listeners = new Map();
  return {
    listeners,
    installed: [],
    checks: 0,
    checkForUpdates() {
      this.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall(silent, runAfter) {
      this.installed.push({ silent, runAfter });
    },
    on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    emit(event, payload) {
      return listeners.get(event)?.(payload);
    },
  };
}

function recorder() {
  const done = [];
  return {
    done,
    backUp: (version) => {
      done.push(`copy ${version}`);
      return Promise.resolve();
    },
    installNow: () => done.push('install now'),
    installOnQuit: () => done.push('install on quit'),
    log: (message) => done.push(`log ${message}`),
  };
}

describe('what happens once an update has downloaded', () => {
  it('takes the copy BEFORE anything installs', async () => {
    const acts = recorder();

    await installDownloadedUpdate('0.26.0', {
      ...acts,
      ask: () => Promise.resolve('now'),
      warn: () => Promise.resolve(),
    });

    expect(acts.done).toEqual(['copy 0.26.0', 'install now']);
  });

  it('waits for the app to be closed when that is what was chosen', async () => {
    const acts = recorder();

    await installDownloadedUpdate('0.26.0', {
      ...acts,
      ask: () => Promise.resolve('later'),
      warn: () => Promise.resolve(),
    });

    expect(acts.done).toEqual(['copy 0.26.0', 'install on quit']);
  });

  it('installs NOTHING when the copy could not be taken, and says so', async () => {
    // The whole point of the feature: an update that cannot be undone must not install.
    const acts = recorder();
    let warned;

    await installDownloadedUpdate('0.26.0', {
      ...acts,
      backUp: () => Promise.reject(new Error('the disk is full')),
      ask: () => Promise.resolve('now'),
      warn: (version) => {
        warned = version;
        return Promise.resolve();
      },
    });

    expect(acts.done).not.toContain('install now');
    expect(acts.done).not.toContain('install on quit');
    expect(warned).toBe('0.26.0');
  });

  it('never asks whether to install once the copy has failed', async () => {
    const acts = recorder();
    let asked = false;

    await installDownloadedUpdate('0.26.0', {
      ...acts,
      backUp: () => Promise.reject(new Error('the server did not answer')),
      ask: () => {
        asked = true;
        return Promise.resolve('now');
      },
      warn: () => Promise.resolve(),
    });

    expect(asked).toBe(false);
  });

  it('installs nothing when the window cannot be asked, rather than deciding for the owner', async () => {
    const acts = recorder();

    await installDownloadedUpdate('0.26.0', {
      ...acts,
      ask: () => Promise.reject(new Error('no window')),
      warn: () => Promise.resolve(),
    });

    expect(acts.done).toEqual(['copy 0.26.0', 'log could not ask about the update']);
  });
});

describe('watching for updates', () => {
  it('refuses to let the library install on quit by itself', async () => {
    // It defaults to true, and its own installer runs synchronously inside `quit`, where an awaited
    // copy cannot veto anything. Left alone, an update installs with no copy at all.
    const updater = fakeUpdater();

    await watchForUpdates({ updater, backUp: () => Promise.resolve() });

    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.checks).toBe(1);
  });

  it('leaves the app alone when there is no answer from the release', async () => {
    // No network in the shop, or nothing published yet. The calendar still has to open.
    const updater = fakeUpdater();
    updater.checkForUpdates = () => Promise.reject(new Error('ERR_UPDATER_LATEST_VERSION_NOT_FOUND'));
    const said = [];

    await expect(
      watchForUpdates({ updater, backUp: () => Promise.resolve(), log: (m) => said.push(m) }),
    ).resolves.toBeUndefined();

    expect(said).toEqual(['could not check for updates']);
  });

  it('holds on to the download the check started, because it rejects on its own', async () => {
    // `checkForUpdates` resolves as soon as the VERSION check succeeds and hands back the download it
    // has already begun. That promise rethrows, and dropped it reaches the main process as fatal —
    // a lost connection or a checksum that does not match would take the calendar down with it.
    const updater = fakeUpdater();
    updater.checkForUpdates = () =>
      Promise.resolve({ downloadPromise: Promise.reject(new Error('ERR_CHECKSUM_MISMATCH')) });
    const said = [];

    await watchForUpdates({ updater, backUp: () => Promise.resolve(), log: (m) => said.push(m) });
    await new Promise((settle) => setImmediate(settle));

    expect(said).toEqual(['the update could not be downloaded']);
  });

  it('survives a check that answers nothing at all', async () => {
    // It resolves null when the app is not packaged, and carries no download when none was started.
    const updater = fakeUpdater();
    updater.checkForUpdates = () => Promise.resolve(null);

    await expect(
      watchForUpdates({ updater, backUp: () => Promise.resolve() }),
    ).resolves.toBeUndefined();
  });

  it('reports an error raised by the updater without letting it escape', () => {
    const updater = fakeUpdater();
    const said = [];

    void watchForUpdates({ updater, backUp: () => Promise.resolve(), log: (m) => said.push(m) });

    expect(() => updater.emit('error', new Error('boom'))).not.toThrow();
    expect(said).toContain('the updater reported an error');
  });

  it('drives the download to the same copy-first path', async () => {
    const updater = fakeUpdater();
    const taken = [];

    await watchForUpdates({
      updater,
      backUp: (version) => {
        taken.push(version);
        return Promise.resolve();
      },
      ask: () => Promise.resolve('now'),
    });
    await updater.emit('update-downloaded', { version: '0.26.0' });

    expect(taken).toEqual(['0.26.0']);
    expect(updater.installed).toEqual([{ silent: true, runAfter: true }]);
  });
});
