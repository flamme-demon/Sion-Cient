import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build outputs — src-tauri/target holds CMake/codegen artifacts that
  // happen to end in .ts/.js and must never be linted.
  globalIgnores(['dist', 'dist-appimage', 'src-tauri/target', 'src-tauri/gen']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // A leading underscore is this codebase's convention for intentionally
      // unused parameters/bindings (callback signatures we must match).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // React-Compiler-era rules introduced by react-hooks v7. The flagged
      // patterns (state reset in effects, Date.now in render paths, refs
      // read during render) predate the rules and work in production;
      // fixing them for real is a refactor per component, tracked as debt.
      // Kept visible as warnings — new code should not add more.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
])
