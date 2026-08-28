import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // *.unit.test.ts 是 bun:test 的单测（bun run test:unit 跑）；Playwright 跑在
  // Node 上，捞进来会因为不认识 bun: 协议直接炸掉整个 e2e。
  testIgnore: ["**/*.unit.test.ts"],
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
