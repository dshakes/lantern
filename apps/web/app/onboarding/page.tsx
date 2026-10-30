"use client";

// PAL Runtime onboarding: a conversation with the onboarding agent (ADR 0051),
// with the step wizard (wizard.tsx) as the labelled fallback.

import { ChatOrWizard } from "./chat-or-wizard";
import OnboardingWizard from "./wizard";

export default function OnboardingPage() {
  return <ChatOrWizard product="runtime" wizard={<OnboardingWizard />} />;
}
