/**
 * Boundary layer L4 — the graph check.
 *
 * Catches what `no-restricted-imports` structurally cannot: dynamic `import()`,
 * and transitive reach. Runs in CI at severity "error" (non-zero exit).
 *
 * Note: dependency-cruiser's `dependencyTypes: ["core"]` means a *Node core
 * module*. It has nothing to do with packages/core.
 */
export default {
  forbidden: [
    {
      name: 'contracts-is-a-leaf',
      comment:
        '@ghalla/contracts depends on nothing. Zero runtime deps is the property that keeps a ' +
        'validator out of the pure engine graph.',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { pathNot: '^packages/contracts/src', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'core-reaches-contracts-only',
      comment: 'packages/core may import @ghalla/contracts and itself. Nothing else, ever.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { pathNot: '^(packages/core/src|packages/contracts)' },
    },
    {
      name: 'ports-reaches-contracts-only',
      severity: 'error',
      from: { path: '^packages/ports/src' },
      to: { pathNot: '^(packages/ports/src|packages/contracts)' },
    },
    {
      name: 'pure-layer-has-no-io',
      comment: 'No Node builtin in contracts / core / ports. The pure layer performs no I/O.',
      severity: 'error',
      from: { path: '^packages/(contracts|core|ports)/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'raw-payload-stays-at-the-edge',
      comment:
        'Ingested<T> carries the raw platform payload, which is exactly where PDPL-forbidden ' +
        'customer data lives. Only the adapter boundary may see it.',
      severity: 'error',
      // Matches both the source file and the built entry point: a dependent
      // package resolves `@ghalla/contracts/ingest` through dist, not src.
      from: { pathNot: '^(packages/ports|apps)/' },
      to: { path: '^packages/contracts/(src|dist)/ingest\\.' },
    },
    {
      name: 'portal-never-reaches-the-write-repositories',
      comment:
        'The operator portal reads every integration database and writes to none of them. It may import ' +
        'the schema, the pool factory and the codecs by subpath; the package barrel also exports the ' +
        'repositories, which write, so the bare specifier is refused. Catches what the lint rule cannot: ' +
        'a dynamic import, and a reach through some other module that imports the barrel.',
      severity: 'error',
      from: { path: '^apps/ghalla-ops/' },
      to: { path: '^packages/persistence/(src|dist)/index\\.' },
    },
    {
      name: 'packages-never-import-apps',
      comment: 'The dependency arrow points one way. A shared package that knows about an app is not shared.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'Error, not warn: depcruise exits 0 on warnings, so a warn-severity rule reads as coverage it ' +
        'does not provide. packages/contracts/src/ingest.ts is an intentional orphan — it is a published ' +
        'entry point that nothing inside the repo imports yet, which is the whole point of putting the ' +
        'raw payload behind its own specifier.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)tsconfig\\.json$',
          '^packages/contracts/src/ingest\\.ts$',
          // Next.js discovers these by convention and nothing imports them, so
          // every one of them is an orphan by construction: route handlers,
          // pages, layouts, middleware, and the app's own config files.
          '^apps/ghalla-ops/src/app/',
          '^apps/ghalla-ops/src/middleware\\.ts$',
          '^apps/ghalla-ops/(next|drizzle|vitest)\\.config\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-deps',
      comment:
        'An import that is not in that package.json is the failure mode pnpm isolated linking ' +
        'exists to prevent. Assert it in CI too, so a hoisting change cannot quietly enable it.',
      severity: 'error',
      from: { path: '^(packages|apps)/' },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    // `dist` is NOT excluded: a workspace import resolves through a package's
    // built entry point, so excluding it made every cross-package edge invisible
    // and silently disarmed the rules above. It is `doNotFollow` instead — the
    // edge into it is recorded, its interior is not walked.
    doNotFollow: { path: '(node_modules|/dist/)' },
    // `.next` is Next.js build output: hundreds of generated chunks that are
    // orphans by nature and import Next's own vendored runtime. Excluded rather
    // than merely `doNotFollow`ed, so the edges into them are not recorded either.
    // `next-env.d.ts` is generated too, and references a types-only specifier
    // that no resolver can follow.
    exclude: { path: '(\\.test\\.ts$|\\.spec\\.ts$|/test/|/\\.next/|/next-env\\.d\\.ts$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
