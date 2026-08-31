// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Flat config (ESLint 10). Type-aware linting is deliberately not enabled: the
 * two tsconfig projects already run in `npm run typecheck`, and duplicating that
 * work here would only make `npm run lint` slower without catching anything new.
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'assets/**', '.whisper/**', '*.d.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    rules: {
      // `_`-prefixed arguments are how the codebase marks a deliberately unused
      // parameter (IPC handlers receive an event they do not need).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // The service layer talks to the OS and to model APIs, where a value is
      // genuinely unknown until validated; `any` is still reported.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // The logger is the one place allowed to write to stdout, and the build
    // scripts are Node console programs, so they get the Node globals they use.
    files: ['electron/core/logger.ts', 'scripts/**/*.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        // Node 22 globals the verification harness drives Chromium with.
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: { 'no-console': 'off' }
  }
)
