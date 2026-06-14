// Flat ESLint config (ESLint 10). Dependency-light: we wire ONLY the TypeScript parser so eslint
// can actually parse the project's own language (.ts type annotations). No type-aware preset/rules
// yet — the correctness gate is vitest + tsc; eslint here is a syntax/hygiene backstop.
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'store/', '**/*.db'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {},
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {},
  },
];
