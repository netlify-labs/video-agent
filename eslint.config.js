import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'ui/dist',
      'ui/dist-mock',
      '.taste-skill',
      'video',
      '.netlify',
      '.beads',
      '.nax',
      '.render',
      'netlify/database/migrations',
      'netlify/edge-functions',
      'spikes',
      'ui/src/api/schema.d.ts',
      'packages/sdk/src/generated/schema.d.ts',
      '**/*.cjs',
      'packages/*/dist',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // In-memory fakes implement async ports without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests read untyped JSON responses on purpose.
    files: ['test/**/*.ts', '**/*.test.ts', 'ui/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
)
