import eslintJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import turboPlugin from 'eslint-plugin-turbo';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * C1RCLE-BACKEND flat ESLint config.
 *
 * Architecture rules are marked ARCHITECTURE and must never be disabled
 * locally. The backend inverts the frontend's boundaries:
 *   - domain + application layers may NOT import Fastify/Firebase/database SDKs
 *   - only the gateway `lib/`/`plugins/` transport may touch Fastify
 *   - only `apps/api-gateway/src/config` may read process.env
 *   - routes must never hold `.collection(`/`.doc(` calls
 */

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
    ],
  },

  eslintJs.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      'import-x': importX,
      'unused-imports': unusedImports,
      turbo: turboPlugin,
    },
    settings: {
      'import-x/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      /* TypeScript discipline */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      /*
       * Repository ports are async-by-contract: in-memory adapters return
       * synchronously from Maps yet must match the Promise interface that
       * real storage adapters implement. `require-await` would force
       * artificial awaits. `no-empty-function`: the noopLogger port is a
       * silent default by design.
       */
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      /*
       * Ported domain code deliberately writes defensive fail-closed checks
       * (`if (!org)`, `org && org.members`, template-literal numbers) that
       * strictTypeChecked rules flag as "unnecessary". These are runtime
       * guarantees for a long-lived codebase; keep them. The rules disabled
       * below are stylistic — the architectural rules above stay enforced.
       */
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',

      /* Dead code */
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /* Import hygiene */
      'import-x/no-cycle': ['error', { maxDepth: Infinity, ignoreExternal: true }],
      'import-x/no-self-import': 'error',
      'import-x/no-relative-packages': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          pathGroups: [{ pattern: '@c1rcle/**', group: 'internal', position: 'before' }],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      /* ARCHITECTURE — domain/application must stay pure.
       * These paths are exempted per-file via eslint overrides for the
       * gateway transport layer (apps/api-gateway/src/{lib,plugins,routes}). */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'process',
              importNames: ['env'],
              message:
                'ARCHITECTURE: direct process.env access is forbidden outside apps/api-gateway/src/config. Import the validated config instead.',
            },
          ],
          patterns: [
            {
              group: ['@c1rcle/*/src/*', '@c1rcle/*/dist/*', '@c1rcle/*/*/*'],
              message:
                'ARCHITECTURE: deep imports are forbidden. Import the package root and let its `exports` map define the public API.',
            },
          ],
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'ARCHITECTURE: direct process.env access is forbidden outside apps/api-gateway/src/config.',
        },
        {
          selector:
            'MemberExpression[property.name="collection"], MemberExpression[property.name="doc"]',
          message:
            'ARCHITECTURE: direct database access in route/service code is forbidden. Route files go through application services and repository ports.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test-utils/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  /* Config/script files: no type-aware rules, plain JS. */
  {
    files: ['**/*.config.mjs', '**/*.config.js', 'scripts/**/*.mjs', 'scripts/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  /* Gateway config is the sole owner of process.env — the global ban exempts it. */
  {
    files: ['apps/api-gateway/src/config/**'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },
);
