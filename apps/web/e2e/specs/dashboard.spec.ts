import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, signUp, uniqueEmail } from "../support/users";

// Dashboard v2: pal / Runtime home spaces, ⌘K Ask PAL, sign-in/out, settings nav.
//
// Sign-up is rate limited per IP (10/hour) and the whole suite shares one IP,
// so only the first-sign-in test signs up through the UI; the rest share one
// account created via the API and start with its session already in place.

let sharedToken = "";

test.beforeAll(async () => {
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("v2shared"), password: PASSWORD, name: "Dash User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`shared sign-up failed: ${r.status}`);
  sharedToken = body.token;
});

async function signedIn(page: Page) {
  await page.context().addCookies([{ name: "pal_token", value: sharedToken, url: WEB_URL }]);
  await page.addInitScript((t) => localStorage.setItem("pal_token", t), sharedToken);
}

async function addDummyProvider(page: Page) {
  // llm-replay stands in for the provider (PAL_LLM_BASEURL_OPENAI), so a
  // dummy key routes every control-plane completion to the fixture rules.
  const status = await page.evaluate(async (api) => {
    const token = localStorage.getItem("pal_token");
    const r = await fetch(`${api}/v1/settings/llm-providers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-e2e-dummy-key" }),
    });
    return r.status;
  }, API_URL);
  expect(status).toBeLessThan(300);
}

test("sign-in page offers only configured methods", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  // The e2e control-plane has no OAuth client configured — no dead buttons.
  await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
});

test("bad credentials say so plainly", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(uniqueEmail("nobody"));
  await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-pass");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: /incorrect email or password/i })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("first sign-in picks a path; sign out ends the session; sign back in", async ({ page }) => {
  const email = uniqueEmail("v2auth");
  await signUp(page, email);
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole("button", { name: /Build on PAL Runtime/ }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  // The remembered mode makes "/" land on the Runtime home from now on.
  await page.goto("/");
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");
  // The cookie is gone: a gated route bounces back to sign-in.
  await page.goto("/overview");
  await expect(page).toHaveURL(/\/login\?from=%2Foverview/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  // ?from= is honored after sign-in.
  await expect(page).toHaveURL(/\/overview/);
});

test("mode switch flips home space, nav and accent", async ({ page }) => {
  await signedIn(page);
  await page.goto("/brief");
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)|Up late/ })).toBeVisible();
  const shell = page.locator("[data-mode]").first();
  await expect(shell).toHaveAttribute("data-mode", "pal");
  await expect(page.getByRole("navigation", { name: "pal navigation" }).getByRole("link", { name: "Holds" })).toBeVisible();

  await page.getByRole("group", { name: "Workspace" }).getByRole("button", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/\/overview/);
  await expect(shell).toHaveAttribute("data-mode", "runtime");
  await expect(shell).toHaveClass(/theme-runtime/);
  await expect(page.getByRole("navigation", { name: "Runtime navigation" }).getByRole("link", { name: "Sandboxes" })).toBeVisible();

  // Shared routes keep the current mode.
  await page.goto("/settings");
  await expect(page.locator("[data-mode]").first()).toHaveAttribute("data-mode", "runtime");

  await page.getByRole("group", { name: "Workspace" }).getByRole("button", { name: "pal" }).click();
  await expect(page).toHaveURL(/\/brief/);
});

test("⌘K opens, filters, and runs a read-only command", async ({ page }) => {
  await signedIn(page);
  await page.goto("/overview");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Ask PAL" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Ask PAL or search").fill("sandbox");
  await dialog.getByRole("option", { name: /^Sandboxes/ }).click();
  await expect(page).toHaveURL(/\/runtime$/);
  await expect(dialog).toHaveCount(0);

  // Escape closes.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("Ask PAL routes natural language through the control-plane", async ({ page }) => {
  await signedIn(page);
  await page.goto("/overview");
  await addDummyProvider(page);
  await page.reload();

  // An answer stays in the bar…
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Ask PAL" });
  await dialog.getByLabel("Ask PAL or search").fill("E2E-QUESTION how many agents do I have?");
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("You have no agents yet.")).toBeVisible({ timeout: 30_000 });

  // …a navigation runs directly (read-only).
  await dialog.getByLabel("Ask PAL or search").fill("E2E-ASK take me to my runs");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs/, { timeout: 30_000 });
});

test("settings nav is URL-driven and extensible", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "API keys" }).click();
  await expect(page).toHaveURL(/tab=api-keys/);
  await expect(nav.getByRole("link", { name: "API keys" })).toHaveAttribute("aria-current", "page");
});
