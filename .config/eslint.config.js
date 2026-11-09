import { join } from 'node:path'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Lives in .config/ to keep the repo root short. npm run lint passes -c, which makes the patterns below relative to
// the directory ESLint runs in (the repo root), not this folder.
export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'app/web/dist',
      'app/web/dist-mock',
      '.taste-skill',
      'video',
      // The Remotion template is linted by its own tsc (Remotion's types aren't installed at the root).
      'app/engines/remotion',
      '.netlify',
      '.beads',
      '.nax',
      '.render',
      'netlify/database/migrations',
      'netlify/edge-functions',
      'docs/spikes',
      'app/web/src/api/schema.d.ts',
      'packages/sdk/src/generated/schema.d.ts',
      '**/*.cjs',
      'packages/*/dist',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: join(import.meta.dirname, '..') } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // In-memory fakes implement async ports without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests read untyped JSON responses on purpose.
    files: ['app/test/**/*.ts', '**/*.test.ts', 'app/web/e2e/**/*.ts'],
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
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
)
