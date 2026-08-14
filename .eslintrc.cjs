/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2023: true, browser: true },
  ignorePatterns: [
    'dist',
    'build',
    'node_modules',
    '*.tsbuildinfo',
    'apps/web/dist',
    'coverage',
  ],
  rules: {
    // `any` shows up deliberately at provider/SDK seams; those are commented.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    {
      // Both UIs are React; the hook rules catch the stale-closure bugs that
      // an event-driven, subscription-heavy UI is most prone to.
      files: ['apps/**/*.tsx', 'apps/**/*.ts'],
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
  ],
};
