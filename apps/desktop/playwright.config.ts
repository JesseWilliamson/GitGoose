import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Windows CI starts processes several times slower (Git for Windows' MSYS2 layer, Defender
  // scanning): the app alone can take longer than the default 5 s to show a repository there.
  // Ceilings, not costs: a passing expectation returns at once. Shared CI runners run several
  // times slower some days (a conflict resolution on the dev repository went past 5 s), so CI
  // gets more room; Windows most of all.
  expect: { timeout: process.platform === 'win32' ? 20_000 : process.env.CI ? 15_000 : 5_000 },
  // Every test starts its own app with its own profile and fixture, so they can run side by side.
  // Three at a time on Linux CI (four cores); one on macOS and Windows, where the app is slow to
  // start and the runners are smaller; by hand, Playwright's default (half the cores).
  workers: process.env.CI ? (process.platform === 'linux' ? 3 : 1) : undefined,
  // On CI, also as GitHub annotations: a failure then shows on the pull request itself, with its
  // message and line, for anyone who cannot open the job log.
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' },
})
