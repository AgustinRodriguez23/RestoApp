// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));


export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'perf/results/**',
      'logs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Reglas comunes a todo el TypeScript.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Prefijo _ para parámetros/variables intencionalmente sin usar.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Reglas que necesitan información de tipos (más lentas, ~20 s en total).
  // Atrapan promesas que nadie espera: un error ahí se pierde en silencio.
  {
    files: ['services/**/*.ts', 'apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: rootDir },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // Servicios NestJS (Node + Jest).
  {
    files: ['services/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },

  // Frontend React.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Scripts .mjs / .js (e2e, perf, k6) y configs.
  {
    files: ['**/*.{mjs,js,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['perf/**/*.js'],
    languageOptions: {
      // k6 expone __ENV, y sus módulos se importan por URL.
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },
);
