"use client";

// pal first-run: a conversation with pal's setup agent (ADR 0051), with the
// step wizard (wizard.tsx, ADR 0048) as the labelled fallback.

import { ChatOrWizard } from "@/app/onboarding/chat-or-wizard";
import PalOnboardingWizard from "./wizard";

export default function PalOnboardingPage() {
  return <ChatOrWizard product="pal" wizard={<PalOnboardingWizard />} />;
}
