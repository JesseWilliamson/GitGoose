import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Windows CI starts processes several times slower (Git for Windows' MSYS2 layer, Defender
  // scanning): the app alone can take longer than the default 5 s to show a repository there.
  expect: { timeout: process.platform === 'win32' ? 20_000 : 5_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
