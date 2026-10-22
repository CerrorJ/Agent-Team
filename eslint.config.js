import babelParser from '@babel/eslint-parser'
import stylistic from '@stylistic/eslint-plugin'

export default [
  {
    files: [
      'src/kernel/**/*.ts',
      'src/domain/**/*.ts',
      'src/cli/windows-command.ts',
      'src/cli/controlled-codex.ts',
      'src/cli/controlled-claude.ts',
      'src/cli/bounded-lines.ts',
      'src/cli/process-stop.ts',
      'src/cli/execution-environment.ts',
      'tests/helpers/**/*.ts',
      'scripts/**/*.mjs',
    ],
    rules: {
      'max-lines': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true },
      ],
      'max-depth': ['error', 3],
      complexity: ['error', 10],
      'max-params': ['error', 4],
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 600, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    ignores: [
      'dist/**',
      'dist-kernel/**',
      '.tmp/**',
      'data/**',
      'node_modules/**',
      'ao-31-deploy/**',
      'demo-server/**',
    ],
  },
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        sourceType: 'module',
        babelOptions: {
          plugins: ['@babel/plugin-syntax-typescript'],
        },
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      // 统一箭头函数，禁止 function 声明
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration',
          message: '不用 function 声明，统一箭头函数：const fn = (...) => {}',
        },
      ],

      // 相邻声明之间恰好空一行：函数/类声明、多行 const 前后必须有空行；
      // 连续空行由 prettier 折叠
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['class', 'function'] },
        { blankLine: 'always', prev: ['class', 'function'], next: '*' },
        { blankLine: 'always', prev: '*', next: 'multiline-const' },
        { blankLine: 'always', prev: 'multiline-const', next: '*' },
      ],
    },
  },
]
