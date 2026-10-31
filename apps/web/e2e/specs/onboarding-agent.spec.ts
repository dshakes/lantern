import { expect, test } from "@playwright/test";
import { openConversation, signUp, uniqueEmail } from "../support/users";

// ADR 0051: a new user lands in the conversation. With no model key the turn is
// scripted (no model to ask) and offers the secure key form; the key goes to the
// settings endpoints (test call → llm-replay), never into the chat.
test("conversation: no key → secure form → key tested → agent continues; the key never shows", async ({ page }) => {
  await signUp(page, uniqueEmail("chat"));
  await openConversation(page);

  const form = page.getByRole("region", { name: "Add a model key" });
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("waiting for a model key")).toBeVisible();

  await form.getByLabel("Provider").selectOption("openai");
  await form.getByLabel("API key").fill("sk-e2e-chat-dummy-key-0000000000");
  await form.getByRole("button", { name: "Save and test" }).click();

  // The client's report is recorded, and the agent (llm-replay) takes the next turn.
  await expect(page.getByText(/passed a real test call/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("waiting for a model key")).toHaveCount(0);
  await expect(page.getByText("sk-e2e-chat-dummy-key")).toHaveCount(0);

  // Step by step is always one click away, with the same saved progress.
  await page.getByRole("button", { name: "Step by step" }).click();
  await expect(page.getByText("Step-by-step mode.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What should your agent do?" })).toBeVisible();
});
