import { defineConfig } from '@playwright/test';

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
