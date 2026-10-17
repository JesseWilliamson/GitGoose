import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'],
    // Each test builds real git repositories; give slow CI disks room.
    testTimeout: 30_000,
  },
})
