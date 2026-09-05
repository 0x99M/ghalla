import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * `pg` and `drizzle-orm` are server-only and must stay unbundled: both reach for
 * optional native and dynamic requires that a bundler resolves at build time and
 * gets wrong, and neither has any business in a client chunk.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'drizzle-orm'],
  // Without this, Next infers the trace root from the nearest lockfile and in a
  // pnpm workspace that inference lands in the wrong place.
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
};

export default config;
