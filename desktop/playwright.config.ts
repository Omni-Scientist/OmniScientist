import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4317",
    colorScheme: "light",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run dev -- --port 4317",
    url: "http://127.0.0.1:4317",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
