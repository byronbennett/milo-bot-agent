import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', '__tests__/', 'jest.config.ts'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars with underscore prefix
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow explicit any in an agent codebase that integrates with many libraries
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow require() for dynamic imports
      '@typescript-eslint/no-require-imports': 'off',
      'no-constant-condition': 'warn',
      'no-debugger': 'warn',
      'prefer-const': 'warn',
    },
  },
);
