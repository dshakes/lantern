import { expect, test } from "@playwright/test";
import { signUp, uniqueEmail } from "../support/users";

const theme = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.dataset.theme);

for (const t of ["dark", "light"] as const) {
  test(`login page renders in ${t}`, async ({ page }) => {
    await page.addInitScript((v) => localStorage.setItem("pal-theme", v), t);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    expect(await theme(page)).toBe(t);
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
}

test("theme toggle flips, persists across reload", async ({ page }) => {
  await signUp(page, uniqueEmail("theme"));
  await page.goto("/agents"); // the toggle lives in the dashboard top bar; sign-up lands on onboarding
  expect(await theme(page)).toBe("dark"); // dark is the default
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  expect(await theme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("pal-theme"))).toBe("light");
  await page.reload();
  expect(await theme(page)).toBe("light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.reload();
  expect(await theme(page)).toBe("dark");
});

test("legacy pal-theme value migrates to pal-theme", async ({ page }) => {
  // Seed only the legacy key (once, so the reload below isn't re-seeded).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("pal-theme", "light");
    }
  });
  await page.goto("/login");
  expect(await theme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("pal-theme"))).toBe("light");
});
