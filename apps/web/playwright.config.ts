import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the running app (`pnpm dev` from the repo root,
 * or `docker compose up` with E2E_BASE_URL=http://localhost:8080).
 * Uses the locally installed Chrome and Edge, so no browser download is needed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  ],
})
