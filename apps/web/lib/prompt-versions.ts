// ---------------------------------------------------------------------------
// Prompt Versioning — track prompt changes over time in localStorage
// ---------------------------------------------------------------------------

export interface PromptVersion {
  prompt: string;
  savedAt: string;
  version: number;
}

const KEY_PREFIX = "lantern_prompt_versions_";
const MAX_VERSIONS = 10;

export function getPromptVersions(agentName: string): PromptVersion[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_PREFIX + agentName);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePromptVersion(agentName: string, prompt: string): PromptVersion[] {
  if (typeof window === "undefined") return [];
  const versions = getPromptVersions(agentName);

  // Skip if identical to latest version
  if (versions.length > 0 && versions[0].prompt === prompt) return versions;

  const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1;
  const entry: PromptVersion = {
    prompt,
    savedAt: new Date().toISOString(),
    version: nextVersion,
  };

  const updated = [entry, ...versions].slice(0, MAX_VERSIONS);
  localStorage.setItem(KEY_PREFIX + agentName, JSON.stringify(updated));
  return updated;
}

export function formatVersionDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
