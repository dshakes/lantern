import { expect, test } from "@playwright/test";
import { mailLink } from "../support/mail";
import { PASSWORD, openOnboarding, signUp, uniqueEmail } from "../support/users";

test("sign-up lands logged in (dev mode: auto-verified, no email gate)", async ({ page }) => {
  await signUp(page, uniqueEmail("signup"));
  // A brand-new user picks a path on /welcome (redirect race, fixed).
  await expect(page).toHaveURL(/\/welcome/);
  // Logged in: the cookie-gated dashboard is reachable, and survives a reload.
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  await page.reload();
  await expect(page).toHaveURL(/\/settings/);
  await openOnboarding(page);
});

test("forgot -> reset password via the log mailer, then sign in with the new password", async ({ page }) => {
  const email = uniqueEmail("reset");
  await signUp(page, email);
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());

  await page.goto("/auth/forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();

  const link = await mailLink(email, "eset");
  expect(link).toContain("/auth/reset?token=");
  await page.goto(link);
  const next = `${PASSWORD}-v2`;
  await page.getByLabel("New password").fill(next);
  await page.getByLabel("Confirm password").fill(next);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("You can sign in with your new password.")).toBeVisible();

  // The reset link is single-use.
  await page.goto(link);
  await page.getByLabel("New password").fill(`${next}-x`);
  await page.getByLabel("Confirm password").fill(`${next}-x`);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Password updated")).toHaveCount(0);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(next);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
});
