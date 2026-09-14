import { describe, expect, it } from 'vitest';
import type { JsonBody } from './api';
import { DEFAULT_SETTINGS } from './settings';
import { settingsPatchOf } from './settingsPatch';

describe('the settings a PATCH is allowed to carry', () => {
  /*
   * The guard this file exists for. The route used to name its fields by hand and had drifted: six of
   * the sixteen were missing, so the screen saved them, the server echoed the OLD value back, the form
   * put the control where it had been and the owner was told it was saved. Backups and public holidays
   * had been unsettable that way before the current-time mark joined them.
   */
  it('reads EVERY field Settings has, so a new one cannot be forgotten', () => {
    expect(settingsPatchOf(DEFAULT_SETTINGS as unknown as JsonBody)).toEqual(DEFAULT_SETTINGS);
  });

  it('carries only what the body actually names, so a PATCH never blanks a stored value', () => {
    expect(settingsPatchOf({ gapColor: '#AABBCC' })).toEqual({ gapColor: '#AABBCC' });
  });

  it('refuses a field of the wrong type, naming it', () => {
    expect(() => settingsPatchOf({ defaultDayCapacity: 'ten' })).toThrow();
    expect(() => settingsPatchOf({ nowLineEnabled: 'yes' })).toThrow();
  });
});
