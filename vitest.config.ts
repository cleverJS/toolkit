import { resolve } from 'node:url'
import swc from 'unplugin-swc'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    root: './',
    setupFiles: ['dotenv/config'],
  },
  plugins: [
    // This is required to build the test files with SWC
    swc.vite({
      // Explicitly set the module type to avoid inheriting this value from a `.swcrc` config file
      module: { type: 'es6' },
    }),
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      // Ensure Vitest correctly resolves TypeScript path aliases
      src: resolve(__dirname, './src'),
    },
  },
})
