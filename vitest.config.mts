import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// .mts rather than .ts so Vite loads it as ESM, which is what it is.
export default defineConfig({
  resolve: {
    // Mirrors the "@/*" -> "./*" mapping in tsconfig.json.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // The engine and the repositories are plain Node code; no DOM needed.
    environment: 'node',
    // A single star for `desktop`: no `exclude` is set, so vitest only skips `node_modules`, and
    // `desktop/build/server/deps` is a RENAMED node_modules — `**` would walk the whole payload.
    include: ['src/**/*.test.ts', 'desktop/*.test.mjs'],
    // The engine's specification is largely PROPERTY tests — several run the whole
    // placement, editing, drop and shrink logic over 2000 generated calendars each. Alone
    // they take about a second; run together they compete for cores, and on a loaded
    // machine the shrink property crossed the 5 s default and failed as a timeout while
    // proving exactly what it was written to prove. The seed counts are the guard (the
    // tests assert on them), so the timeout must not be what decides how many run.
    testTimeout: 30_000,
  },
});
