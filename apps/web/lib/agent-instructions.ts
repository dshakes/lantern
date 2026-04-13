// ---------------------------------------------------------------------------
// Agent Instructions — separated from System Prompt
//
// Claude's managed agents distinguish between:
//   - "Instructions" — what the agent does (task description, goals, constraints)
//   - "System Prompt" — how the agent behaves (personality, tone, format)
//
// We store instructions separately and merge them at runtime.
// ---------------------------------------------------------------------------

const INSTRUCTIONS_KEY_PREFIX = "lantern_agent_instructions_";

export function getAgentInstructions(agentName: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(INSTRUCTIONS_KEY_PREFIX + agentName) || "";
  } catch {
    return "";
  }
}

export function saveAgentInstructions(agentName: string, instructions: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(INSTRUCTIONS_KEY_PREFIX + agentName, instructions);
}

/**
 * Merge instructions and system prompt into a single effective prompt.
 * Instructions define WHAT the agent does; system prompt defines HOW it behaves.
 */
export function mergeInstructionsAndPrompt(instructions: string, systemPrompt: string): string {
  const parts: string[] = [];

  if (instructions.trim()) {
    parts.push(`<instructions>\n${instructions.trim()}\n</instructions>`);
  }

  if (systemPrompt.trim()) {
    parts.push(systemPrompt.trim());
  }

  return parts.join("\n\n");
}
