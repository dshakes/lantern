import { expect, test } from "@playwright/test";
import { PASSWORD, signUp, uniqueEmail } from "../support/users";

test("danger zone: deleting the workspace needs the phrase, then signs the owner out for good", async ({ page }) => {
  const email = uniqueEmail("delete");
  await signUp(page, email);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete workspace" }).click();

  const confirm = page.getByRole("button", { name: "Delete forever" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("dialog").getByRole("textbox").fill("delete my workspace");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL("**/login**");

  // The account is gone: the same credentials no longer sign in.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText(/couldn't sign in|invalid|incorrect|failed/i)).toBeVisible();
});
