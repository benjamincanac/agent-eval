import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // In-sandbox agent runners: plain ESM JS that runs on Node, so the Node
    // globals (process) are available. Everything else they use is imported
    // from node:* builtins.
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
