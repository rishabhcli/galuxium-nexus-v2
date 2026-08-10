import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import playwright from 'eslint-plugin-playwright';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{ts,tsx,mts,cts}'];
const testFiles = [
  '**/test/**/*.{ts,tsx,mts,cts}',
  '**/*.{test,spec}.{ts,tsx,mts,cts}',
  'tests/**/*.{ts,tsx,mts,cts}',
];

export default defineConfig(
  globalIgnores([
    '.dev/**',
    '**/dist/**',
    'coverage/**',
    'node_modules/**',
    'playwright-report/**',
    'test-results/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-warning-comments': [
        'error',
        {
          location: 'anywhere',
          terms: ['fixme', 'todo'],
        },
      ],
    },
  },
  {
    files: sourceFiles,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        onUnsupportedTypeScriptVersion: 'error',
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-useless-default-assignment': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-warning-comments': [
        'error',
        {
          location: 'anywhere',
          terms: ['fixme', 'todo'],
        },
      ],
    },
  },
  {
    files: testFiles,
    extends: [vitest.configs.recommended],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'vitest/consistent-test-filename': [
        'error',
        {
          pattern: '.*\\.(test|spec)\\.[cm]?[jt]sx?$',
        },
      ],
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-standalone-expect': 'error',
      'vitest/prefer-expect-assertions': 'off',
      'vitest/require-top-level-describe': 'off',
    },
  },
  {
    files: ['tests/e2e/**/*.{ts,tsx,mts,cts}'],
    extends: [playwright.configs['flat/recommended']],
    rules: {
      'playwright/no-skipped-test': 'error',
      'playwright/no-focused-test': 'error',
    },
  },
);
