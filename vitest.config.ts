import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The suite runs in plain Node, so `electron` is aliased to a stub. Everything
 * under test is Akansha's own logic -- permissions, path guarding, command
 * classification, the tool registry, settings and the IPC surface -- none of
 * which needs a live Electron process.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The services log to stdout through Akansha's own logger; that noise would
    // bury the assertions. Failures are still printed in full.
    silent: true,
    reporters: ['default']
  },
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/stubs/electron.ts'),
      '@shared': resolve(__dirname, 'shared'),
      '@main': resolve(__dirname, 'electron')
    }
  }
})
