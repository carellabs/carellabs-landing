import { defineConfig, devices } from "@playwright/test";

// 4322 y no 4321: 4321 es el puerto de `astro dev`. Con `reuseExistingServer`, tener el
// servidor de desarrollo abierto haría que los tests corrieran contra él (sin build ni
// `dist/`) en lugar de contra `astro preview`, y darían resultados distintos a los del CI.
const port = 4322;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    // Permite usar un Chromium ya instalado (CI o entornos sin descarga).
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : undefined,
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
