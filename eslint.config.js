// Flat ESLint config (ESLint 10). Minimal Phase 0 setup — no preset/type-aware rules yet.
// Kept dependency-light on purpose; the red-test gate is vitest + tsc, not lint.
export default [
  {
    ignores: ['node_modules/', 'dist/', 'store/', '**/*.db'],
  },
  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {},
  },
];
