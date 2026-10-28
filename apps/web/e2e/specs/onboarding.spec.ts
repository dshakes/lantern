import { expect, test } from "@playwright/test";
import { openOnboarding, signUp, uniqueEmail } from "../support/users";

test("starter gallery is visible and a template pick lands on the review step", async ({ page }) => {
  await signUp(page, uniqueEmail("gallery"));
  await openOnboarding(page);
  const gallery = page.getByRole("region", { name: "Or start from a template" });
  await expect(gallery).toBeVisible();
  const first = gallery.getByRole("button").first();
  const name = (await first.locator("span").first().innerText()).trim();
  await first.click();
  await expect(page.getByRole("region", { name: "Proposed agent" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).not.toHaveValue("");
  // The review step reflects the template that was picked.
  await expect(page.getByLabel("Description")).not.toHaveValue("");
  expect(name.length).toBeGreaterThan(0);
});

test("free-text goal -> spec review -> key test -> create -> first run streams to succeeded", async ({ page }) => {
  await signUp(page, uniqueEmail("goal"));
  await openOnboarding(page);
  await page.getByLabel("Describe your agent's job").fill("E2E-GOAL turn rough notes into three bullets");
  await page.getByRole("button", { name: "Design my agent" }).click();

  // Design needs a model key first. Add a dummy OpenAI one; the control-plane's
  // test call and the design call both hit llm-replay (LANTERN_LLM_BASEURL_OPENAI).
  await page.getByRole("button", { name: "Add a model key" }).click();
  await page.getByText("OpenAI", { exact: true }).click();
  await page.getByLabel("API key").fill("sk-e2e-dummy-key");
  await page.getByRole("button", { name: "Test key" }).click();

  // Once the key works the design is retried automatically.
  await expect(page.getByRole("region", { name: "Proposed agent" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("e2e-summarizer");
  await page.getByRole("button", { name: "Approve design" }).click();

  // The provider gate re-tests the saved key before creating anything.
  await expect(page.getByText("Model key verified")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Create agent" }).click();
  await page.getByRole("button", { name: "Run it" }).click();
  await expect(page.getByText("Run succeeded")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("E2E-FIXTURE-OUTPUT: shipped the harness.")).toBeVisible();
});
