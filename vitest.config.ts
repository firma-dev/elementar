import { defineConfig } from 'vitest/config'

export default defineConfig({
  // JSX нужен тестам вёрстки: они рисуют настоящие компоненты, а не строки.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    // Вычисления считаются в node, вёрстка — в DOM (Д-021). Окружение задаётся
    // директивой `@vitest-environment` в шапке самого теста: так видно из файла,
    // где он выполняется, и не нужно держать список путей в конфиге.
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20000,
  },
})
