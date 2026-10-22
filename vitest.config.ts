import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'],
    // Each test builds real git repositories. The timeout is a guard against a hang, not a
    // budget: hosted CI runners (macOS above all) run several times slower some days, so they
    // get room that costs nothing when a test passes.
    testTimeout: process.env.CI ? 120_000 : 30_000,
    hookTimeout: process.env.CI ? 120_000 : 10_000,
  },
})
