import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { RUN_DIR, WEB_URL } from "./e2e/support/env";

// Headless chromium only. The whole stack (own Postgres DB, control-plane,
// llm-replay, next dev) is booted by e2e/global-setup.ts on spare ports.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One shared DB + one rate-limited IP: run specs serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: path.join(RUN_DIR, "report") }]] : "list",
  outputDir: path.join(RUN_DIR, "test-results"),
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
