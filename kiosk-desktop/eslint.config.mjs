import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The main process must never reach the network from the customer's path by accident:
    // only the sync engine, the media store, the updater and the pinpad transport may fetch.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'The kiosk screens never use the network: everything comes from the main process (local data).' }],
    },
  },
  {
    // The one app bundle's floor (S0-12, P:/specs/web-till-spec-v2.md §13.3): Chromium 108
    // (Windows 7 / Electron 22, Chrome 109) and Safari 16.4. There is no core-js in this package,
    // so what came after 108 is refused here — feature-detect it behind a fallback instead.
    files: ['src/renderer/roles/till/**/*.{ts,tsx}', 'src/renderer/host/**/*.{ts,tsx}', 'src/renderer/app/**/*.{ts,tsx}', 'src/shared/till/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Object', property: 'groupBy', message: 'Object.groupBy is Chrome 117 — above the Chromium 108 floor (S0-12).' },
        { object: 'Map', property: 'groupBy', message: 'Map.groupBy is Chrome 117 — above the Chromium 108 floor (S0-12).' },
        { object: 'Promise', property: 'withResolvers', message: 'Promise.withResolvers is Chrome 119 — above the Chromium 108 floor (S0-12).' },
        { object: 'URL', property: 'canParse', message: 'URL.canParse is Chrome 120 — above the Chromium 108 floor (S0-12).' },
        { object: 'AbortSignal', property: 'any', message: 'AbortSignal.any is Chrome 116 — above the Chromium 108 floor (S0-12).' },
        { object: 'Array', property: 'fromAsync', message: 'Array.fromAsync is Chrome 121 — above the Chromium 108 floor (S0-12).' },
        { object: 'document', property: 'startViewTransition', message: 'View Transitions are Chrome 111 — only as an extra, feature-detected (S0-12).' },
        { object: 'crypto', property: 'randomUUID', message: 'crypto.randomUUID needs a secure context — a LAN page on http has none (host/engineLink.ts newClientOpId).' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name=/^(toSorted|toReversed|toSpliced|with)$/]", message: 'Array change-by-copy methods are Chrome 110 — above the Chromium 108 floor (S0-12).' },
        { selector: "CallExpression[callee.property.name=/^(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)$/]", message: 'The new Set methods are Chrome 122 — above the Chromium 108 floor (S0-12).' },
        { selector: "CallExpression[callee.property.name=/^(showPopover|hidePopover|togglePopover)$/]", message: 'The Popover API is Chrome 114 — above the Chromium 108 floor (S0-12).' },
        { selector: "JSXAttribute[name.name='popover']", message: 'The Popover API is Chrome 114 — above the Chromium 108 floor (S0-12).' },
      ],
    },
  },
);
