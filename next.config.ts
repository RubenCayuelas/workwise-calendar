import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 loads a native .node binary, which cannot be bundled.
  // Leaving it external keeps the server build from trying.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
