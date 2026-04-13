// ---------------------------------------------------------------------------
// Conversation Memory — persistent key-value memory for agents across runs
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  source: "manual" | "auto";
  updatedAt: string;
  createdAt: string;
}

const MEMORY_KEY_PREFIX = "lantern_agent_memory_";

export function getAgentMemory(agentName: string): MemoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MEMORY_KEY_PREFIX + agentName);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveAgentMemory(agentName: string, entries: MemoryEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(MEMORY_KEY_PREFIX + agentName, JSON.stringify(entries));
}

export function addMemoryEntry(agentName: string, key: string, value: string, source: "manual" | "auto" = "manual"): MemoryEntry[] {
  const entries = getAgentMemory(agentName);
  const existing = entries.findIndex(e => e.key === key);
  const now = new Date().toISOString();

  if (existing >= 0) {
    entries[existing] = { ...entries[existing], value, source, updatedAt: now };
  } else {
    entries.push({
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key,
      value,
      source,
      updatedAt: now,
      createdAt: now,
    });
  }

  saveAgentMemory(agentName, entries);
  return entries;
}

export function removeMemoryEntry(agentName: string, entryId: string): MemoryEntry[] {
  const entries = getAgentMemory(agentName).filter(e => e.id !== entryId);
  saveAgentMemory(agentName, entries);
  return entries;
}

export function clearAgentMemory(agentName: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(MEMORY_KEY_PREFIX + agentName);
}

export function memoryToContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(e => `- ${e.key}: ${e.value}`);
  return `\n\n<agent-memory>\nThe following facts are remembered from previous interactions:\n${lines.join("\n")}\n</agent-memory>`;
}
