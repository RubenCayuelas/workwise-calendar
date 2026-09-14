import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

const root = path.resolve(__dirname, '..', '..');

function packageVersion(file: string): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as {
    version: string;
  };
  return version;
}

describe('the version the Settings screen prints', () => {
  it('is the one in package.json, so a release cannot ship the previous number', () => {
    expect(nextConfig.env?.APP_VERSION).toBe(packageVersion('package.json'));
  });
});
