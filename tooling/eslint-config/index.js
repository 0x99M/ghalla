import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
  'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'process', 'readline',
  'stream', 'timers', 'tls', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
];

const TS = '**/*.{ts,mts,cts}';
const PURE_GLOBS = [
  'packages/contracts/**/*.{ts,mts,cts}',
  'packages/core/**/*.{ts,mts,cts}',
  'packages/ports/**/*.{ts,mts,cts}',
];

const NO_IO = 'The pure layer has no I/O. If you need a Node builtin, you are in the wrong package.';

/**
 * Purity leaks that no import rule can see.
 *
 * These are written against MemberExpression rather than CallExpression on
 * purpose: `const now = Date.now; now()` and `const { round } = Math` are
 * refactors a reviewer waves through, and a call-shaped selector misses both.
 */
const IMPURE_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'core is pure: no ambient clock. Take the instant as an explicit input.',
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'core is pure: no ambient clock. Take the instant as an explicit input.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'core is pure: no randomness.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='round']",
    message:
      'Math.round is half-UP, not half-away-from-zero: Math.round(-1.5) === -1 leaks a halala on every ' +
      'reversal. Use the rounding helper in packages/core/src/money.ts.',
  },
  {
    selector: "MemberExpression[property.name='toFixed']",
    message: 'No floats for money. Format at the presentation edge, never in the engine.',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'No floats for money. Parse decimal strings digit-wise via toMinorFromDecimal.',
  },
  {
    // Aliasing the namespace defeats every selector above.
    selector: "VariableDeclarator[init.name=/^(Math|Date)$/]",
    message: 'Aliasing Math or Date hides the purity rules from the linter. Reference them directly, or not at all.',
  },
  {
    selector: "MemberExpression[computed=true][property.value=/^(random|round|now|toFixed)$/]",
    message: 'A computed member access hides the purity rules from the linter.',
  },
  {
    selector: "MemberExpression[object.name='process']",
    message: 'core is pure: no process, no environment.',
  },
  {
    // `types: []` does not help here: the cast supplies the types.
    selector: "Identifier[name='globalThis']",
    message:
      'globalThis is the one escape that defeats every other rule here — a single cast reaches process, ' +
      'fetch and require. The pure layer has no use for it.',
  },
  { selector: "Identifier[name='eval']", message: 'The pure layer has no use for eval.' },
  {
    // Needs no module resolution, so it survives a broken resolver — and it is
    // the only lint-side rule that sees a dynamic specifier at all.
    selector: 'ImportExpression',
    message:
      'No dynamic import in the pure layer. A dynamic specifier is invisible to every import rule, so it ' +
      'is the documented way around them. Use a static import, which the boundary rules can see.',
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
    { group: ['node:*'], message: NO_IO },
    {
      // The second pattern closes the route `rootDir` cannot: TypeScript redirects a
      // relative import into a DECLARED project reference, so reaching into
      // ../../contracts/src never raises TS6059.
      group: ['**/apps/**', '../../apps/**', '../../../apps/**', '../../*/src/**', '../../../*/src/**'],
      message:
        'Reach another package by its package name, never by a relative path. packages/* may never ' +
        'import from apps/* at all.',
    },
    {
      group: FORBIDDEN_IN_PURE,
      message:
        'Forbidden in the pure layer. Platform SDKs, persistence, frameworks and ambient time stay in ' +
        'apps/* and packages/{persistence,ingestion}.',
    },
  ],
  paths: NODE_BUILTINS.map((name) => ({ name, message: NO_IO })),
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: [TS],
    rules: {
      // A leading underscore marks a parameter kept for signature shape — which is
      // most of packages/core until the engine is implemented.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // ------------------------------------------------------------------------
  // The architectural boundary.
  //
  // These rules need NO module resolution, so they still hold on a fresh clone
  // before install, and they cannot be silently disarmed by a resolver upgrade.
  // They are one of three layers; the other two are the pnpm dependency graph
  // (which fails at resolve time and no eslint-disable reaches) and
  // dependency-cruiser (which sees dynamic imports and transitive reach).
  // ------------------------------------------------------------------------
  {
    files: PURE_GLOBS,
    rules: { 'no-restricted-syntax': ['error', ...IMPURE_SYNTAX] },
  },
  {
    files: ['packages/contracts/**/*.{ts,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({
          allowWorkspace: [],
          message: '@ghalla/contracts is a leaf package. It depends on nothing.',
        }),
      ],
      'no-restricted-syntax': [
        'error',
        ...IMPURE_SYNTAX,
        {
          // `| null` is the only optionality in the canonical types. The drift audit
          // in @ghalla/schemas compares by mutual assignability, and an extra
          // OPTIONAL property is assignability-neutral in both directions — so a
          // field added to the interface and forgotten in the schema would compile
          // clean. Forbidding `?` here is what makes that audit's promise true.
          selector: 'TSPropertySignature[optional=true]',
          message:
            'Absence is `| null`, never `?`. An optional property is invisible to the schema drift audit, ' +
            'and exactOptionalPropertyTypes does not close that gap.',
        },
      ],
    },
  },
  {
    files: ['packages/core/**/*.{ts,mts,cts}'],
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
    files: ['packages/ports/**/*.{ts,mts,cts}'],
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
    files: ['packages/schemas/**/*.{ts,mts,cts}'],
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
              group: ['**/apps/**', '../../apps/**', '../../*/src/**'],
              message: 'Reach another package by its package name. packages/* may never import from apps/*.',
            },
          ],
        },
      ],
    },
  },

  // Tests and config files are not architectural elements. Note that the pure
  // packages type-check their test directories via tsconfig.test.json, so a
  // float assigned to a money field in a fixture is still a build error.
  {
    files: [
      '**/*.test.{ts,mts,cts}',
      '**/*.spec.{ts,mts,cts}',
      '**/test/**/*.{ts,mts,cts}',
      '*.js',
      '*.mjs',
      'tooling/**/*.js',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
