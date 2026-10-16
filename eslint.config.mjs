import eslint from '@eslint/js';

export default [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly', process: 'readonly', module: 'readonly', require: 'readonly',
        __dirname: 'readonly', jest: 'readonly', describe: 'readonly', it: 'readonly',
        expect: 'readonly', beforeEach: 'readonly'
      }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'off' }
  }
];
