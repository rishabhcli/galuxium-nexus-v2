/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      comment: 'Cycles make ownership and initialization order ambiguous.',
      severity: 'error',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-unresolved-dependencies',
      comment: 'Every import must resolve through a declared, reviewable boundary.',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'production-imports-require-a-workspace-manifest-declaration',
      comment:
        'Production workspace source cannot consume an undeclared or merely root-hoisted package.',
      severity: 'error',
      from: {
        path: '^(apps|packages|services)/[^/]+/src/',
      },
      to: {
        dependencyTypes: ['npm-no-pkg'],
      },
    },
    {
      name: 'packages-do-not-depend-on-applications',
      comment: 'Domain and shared packages must not import service or UI state.',
      severity: 'error',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^(apps|services)/',
      },
    },
    {
      name: 'services-do-not-depend-on-admin-ui',
      comment: 'Service ownership cannot flow toward the admin application.',
      severity: 'error',
      from: {
        path: '^services/',
      },
      to: {
        path: '^apps/',
      },
    },
    {
      name: 'ledger-domain-only-uses-admitted-database-driver',
      comment:
        'The authoritative ledger package may use the admitted pg persistence driver and no other framework or SDK.',
      severity: 'error',
      from: {
        path: '^packages/ledger/src/',
      },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg'],
        pathNot: '^node_modules/pg(?:/|$)',
      },
    },
    {
      name: 'production-source-does-not-import-tests',
      comment: 'Shipped code cannot depend on test-only behavior.',
      severity: 'error',
      from: {
        path: '^(apps|packages|services)/[^/]+/src/',
      },
      to: {
        path: '(^|/)(test|tests)/',
      },
    },
    ...[
      'packages/observability',
      'packages/ledger',
      'services/gateway',
      'services/reconciler',
      'services/fake-provider',
      'services/metrics',
      'apps/admin',
    ].map((workspacePath) => ({
      name: `no-private-cross-workspace-imports-from-${workspacePath.replaceAll('/', '-')}`,
      comment:
        'Workspace dependencies must use declared package exports, never private relative paths.',
      severity: 'error',
      from: {
        path: `^${workspacePath}/`,
      },
      to: {
        dependencyTypes: ['local', 'localmodule'],
        path: `^(?!${workspacePath}/)(apps|packages|services)/`,
      },
    })),
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    enhancedResolveOptions: {
      conditionNames: ['types', 'import', 'node', 'default'],
      exportsFields: ['exports'],
    },
    exclude: {
      path: '(^|/)(coverage|dist|playwright-report|test-results)/',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
  },
};

export default config;
