import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4175', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview -- --port 4175', url: 'http://127.0.0.1:4175', reuseExistingServer: false },
});
