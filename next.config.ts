import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 loads a native .node binary, which cannot be bundled.
  // Leaving it external keeps the server build from trying.
  serverExternalPackages: ['better-sqlite3'],
  // `next dev` otherwise appends a self-rewriting block to CLAUDE.md on every run. That file
  // states its own contract in its header and is the authority on the business rules; a
  // framework editing it produces a dirty tree on every start and buries the rules it holds.
  agentRules: false,
};

export default nextConfig;
