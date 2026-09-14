import type { NextConfig } from 'next';
import packageJson from './package.json';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Inlined into the client bundle at build time, which is the whole point: the Settings screen is a
  // client component, so without this the version needs an API route to state a fact that is already
  // fixed when the build runs. No `NEXT_PUBLIC_` prefix — that only applies to `.env` files.
  env: { APP_VERSION: packageJson.version },
  // better-sqlite3 loads a native .node binary, which cannot be bundled.
  // Leaving it external keeps the server build from trying.
  serverExternalPackages: ['better-sqlite3'],
  // `next dev` otherwise appends a self-rewriting block to CLAUDE.md on every run. That file
  // states its own contract in its header and is the authority on the business rules; a
  // framework editing it produces a dirty tree on every start and buries the rules it holds.
  agentRules: false,
  // What the Windows application ships: a `.next/standalone` folder holding the server and only the
  // dependencies it traces, `better-sqlite3` and its native binary among them. `next start` is
  // unaffected; the desktop build would otherwise have nothing to package.
  output: 'standalone',
  // The file tracer resolves `path.join(process.cwd(), 'data', ...)` in `getDbPath()` and pulls the
  // whole directory in, so the standalone output arrived carrying THE SHOP'S OWN calendar.db and its
  // backups — which the installer would then ship to every customer. `desktop/` comes in the same way
  // and would nest a copy of the payload inside itself.
  outputFileTracingExcludes: {
    '*': ['data/**', 'desktop/**', 'documents/**', '.claude/**'],
  },
};

export default nextConfig;
