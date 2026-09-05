import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Packages that may never appear in the pure layer (contracts / core / ports).
 * To ban a new SDK, add one string. This list deliberately lives in `tooling/`,
 * outside `packages/`, so scripts/no-platform-vocab.sh can forbid these names
 * everywhere else without tripping over the rule that forbids them.
 */
export const FORBIDDEN_IN_PURE = [
  // platform SDKs — the whole point
  '@salla/*', 'salla', 'salla*', '@zid/*', 'zid', 'zid*',
  // persistence
  '@prisma/client', 'prisma', 'pg', 'kysely', 'drizzle-orm', 'typeorm',
  // frameworks & transport
  '@nestjs/*', 'express', 'fastify', 'axios', 'got', 'undici', 'node-fetch', 'ky',
  // queues & caches
  'bullmq', 'ioredis', 'redis',
  // ambient time — core takes every input explicitly
  'dayjs', 'moment', 'luxon', 'date-fns',
  // runtime validation belongs to @ghalla/schemas, never to the engine
  'zod', '@ghalla/schemas',
];

const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events', 'fs',
  'http', 'http2', 'https', 'net', 'os', 'path', 'process', 'readline', 'stream',
  'timers', 'tls', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
];

const PURE_GLOBS = ['packages/contracts/**/*.ts', 'packages/core/**/*.ts', 'packages/ports/**/*.ts'];

/** Purity leaks that no import rule can see: ambient time, randomness, float math. */
const IMPURE_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'core is pure: no ambient clock. Take the instant as an explicit input.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'core is pure: no ambient clock. Take the instant as an explicit input.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'core is pure: no randomness.',
  },
  {
    selector: "MemberExpression[object.name='process']",
    message: 'core is pure: no process, no environment.',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'No floats for money. Parse decimal strings digit-wise via toMinorFromDecimal.',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: 'No floats for money. Format at the presentation edge, never in the engine.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
    message:
      'Math.round is half-UP, not half-away-from-zero: Math.round(-1.5) === -1 leaks a halala on every ' +
      'reversal. Use the rounding helper in packages/core/src/money.ts.',
  },
];

const restrictedImports = ({ allowWorkspace, message }) => ({
  patterns: [
    {
      // `@ghalla/**`, not `@ghalla/*`: a single star does not cross a slash, so the
      // subpath `@ghalla/contracts/ingest` — the one specifier that must NOT reach
      // core — would slip straight through. Negations go last; later patterns win.
      group: ['@ghalla/**', ...allowWorkspace.map((p) => `!${p}`)],
      message,
    },
    {
      group: ['node:*'],
      message: 'The pure layer has no I/O. If you need a Node builtin, you are in the wrong package.',
    },
    {
      group: ['**/apps/**', '../../apps/**', '../../../apps/**'],
      message: 'packages/* may never import from apps/*. The dependency arrow points one way.',
    },
    {
      group: FORBIDDEN_IN_PURE,
      message:
        'Forbidden in the pure layer. Platform SDKs, persistence, frameworks and ambient time stay in ' +
        'apps/* and packages/{persistence,ingestion}.',
    },
  ],
  paths: NODE_BUILTINS.map((name) => ({
    name,
    message: 'The pure layer has no I/O. If you need a Node builtin, you are in the wrong package.',
  })),
});

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      // A leading underscore marks a parameter kept for signature shape — which is
      // most of packages/core until the engine is implemented.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // ---------------------------------------------------------------- L4a ----
  // Architectural elements + policies. Sees type-only imports, and gives the
  // in-editor message that names the rule being broken.
  {
    files: ['**/*.ts', '**/*.js'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/**', partialMatch: false },
        { type: 'ports', pattern: 'packages/ports/**', partialMatch: false },
        { type: 'core', pattern: 'packages/core/**', partialMatch: false },
        { type: 'schemas', pattern: 'packages/schemas/**', partialMatch: false },
        { type: 'persistence', pattern: 'packages/persistence/**', partialMatch: false },
        { type: 'ingestion', pattern: 'packages/ingestion/**', partialMatch: false },
        { type: 'app', pattern: 'apps/**', partialMatch: false },
        { type: 'tooling', pattern: 'tooling/**', partialMatch: false },
      ],
      'boundaries/include': ['packages/**/*.ts', 'apps/**/*.ts'],
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts', '**/test/**'],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // contracts is a leaf: it may reach nothing but itself.
            { from: { element: { type: 'contracts' } }, allow: { to: { element: { type: 'contracts' } } } },

            // ports and core reach contracts and nothing else in the workspace.
            {
              from: { element: { types: { anyOf: ['ports', 'core'] } } },
              allow: { to: { element: { types: { anyOf: ['contracts', 'ports', 'core'] } } } },
            },
            { from: { element: { type: 'schemas' } }, allow: { to: { element: { types: { anyOf: ['contracts', 'schemas'] } } } } },
            {
              from: { element: { types: { anyOf: ['persistence', 'ingestion'] } } },
              allow: { to: { element: { types: { anyOf: ['contracts', 'ports', 'core', 'schemas', 'persistence', 'ingestion'] } } } },
            },

            // Applications may reach anything. They are the only layer that may.
            {
              from: { element: { type: 'app' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: ['contracts', 'ports', 'core', 'schemas', 'persistence', 'ingestion', 'app', 'tooling'],
                    },
                  },
                },
              },
            },

            // Everything may reach third-party packages by default...
            { allow: { to: { module: { origin: 'external' } } } },

            // ...and then the hard stops go LAST, because the last match wins.
            {
              from: { element: { type: '!app' } },
              disallow: { to: { element: { type: 'app' } } },
            },
            {
              from: { element: { types: { anyOf: ['contracts', 'core', 'ports'] } } },
              disallow: { to: { module: { origin: 'builtin' } } },
            },
            {
              from: { element: { types: { anyOf: ['contracts', 'core', 'ports'] } } },
              disallow: { to: { module: { origin: 'external', source: FORBIDDEN_IN_PURE } } },
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------- L4b ----
  // Needs NO module resolution, so it still holds on a fresh clone before
  // install, or when a resolver upgrade breaks the layer above.
  {
    files: PURE_GLOBS,
    rules: {
      'no-restricted-syntax': ['error', ...IMPURE_SYNTAX],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({
          allowWorkspace: [],
          message: '@ghalla/contracts is a leaf package. It depends on nothing.',
        }),
      ],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({
          allowWorkspace: ['@ghalla/contracts'],
          message:
            'packages/core depends on @ghalla/contracts and nothing else. Note that ' +
            '@ghalla/contracts/ingest is NOT allowed: the raw payload must never reach the engine.',
        }),
      ],
    },
  },
  {
    files: ['packages/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({
          // ports is the ingestion boundary, so it — and only it — sees Ingested<T>.
          allowWorkspace: ['@ghalla/contracts', '@ghalla/contracts/ingest'],
          message: 'packages/ports depends on @ghalla/contracts and nothing else.',
        }),
      ],
    },
  },
  {
    files: ['packages/schemas/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ghalla/**', '!@ghalla/contracts'],
              message: '@ghalla/schemas validates the canonical types. It reaches contracts and zod only.',
            },
            {
              group: ['**/apps/**', '../../apps/**'],
              message: 'packages/* may never import from apps/*.',
            },
          ],
        },
      ],
    },
  },

  // Config files and test files are not architectural elements.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts', '*.js', '*.mjs', 'tooling/**/*.js'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
