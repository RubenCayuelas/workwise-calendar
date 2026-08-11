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
    include: ['src/**/*.test.ts'],
  },
});
