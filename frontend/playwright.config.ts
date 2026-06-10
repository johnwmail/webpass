import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.TEST_SKIP_WEBSERVER === 'true' ? undefined : {
    command: 'go run ../cmd/srv',
    url: 'http://localhost:8080',
    timeout: 120 * 1000,
    reuseExistingServer: true,
    env: {
      JWT_SECRET: process.env.JWT_SECRET || 'test-secret-key-32-bytes-long!!!',
      DB_PATH: process.env.DB_PATH || ':memory:',
      DISABLE_FRONTEND: 'false',
      STATIC_DIR: 'dist',
      GIT_REPO_ROOT: '/tmp/git-repos',
      COOKIE_AUTH_ENABLED: process.env.COOKIE_AUTH_ENABLED || 'true',
      REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED || 'true',
      REGISTRATION_TOTP_SECRET: process.env.REGISTRATION_TOTP_SECRET || '',
      // Explicitly pass rate limit vars (empty string = use Go defaults)
      RATE_LIMIT_ATTEMPTS: process.env.RATE_LIMIT_ATTEMPTS || '',
      RATE_LIMIT_WINDOW_MINUTES: process.env.RATE_LIMIT_WINDOW_MINUTES || '',
    },
  },
});
