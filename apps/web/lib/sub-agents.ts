// ---------------------------------------------------------------------------
// Sub-agent / Agent Handoff — manage agent-to-agent connections
// ---------------------------------------------------------------------------

export interface SubAgentLink {
  id: string;
  targetAgentName: string;
  description: string;
  handoffCondition: string;
  addedAt: string;
}

const SUBAGENT_KEY_PREFIX = "lantern_sub_agents_";

export function getSubAgents(agentName: string): SubAgentLink[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SUBAGENT_KEY_PREFIX + agentName);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveSubAgents(agentName: string, links: SubAgentLink[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SUBAGENT_KEY_PREFIX + agentName, JSON.stringify(links));
}

export function addSubAgent(agentName: string, link: Omit<SubAgentLink, "id" | "addedAt">): SubAgentLink[] {
  const links = getSubAgents(agentName);
  const newLink: SubAgentLink = {
    ...link,
    id: `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    addedAt: new Date().toISOString(),
  };
  links.push(newLink);
  saveSubAgents(agentName, links);
  return links;
}

export function removeSubAgent(agentName: string, linkId: string): SubAgentLink[] {
  const links = getSubAgents(agentName).filter(l => l.id !== linkId);
  saveSubAgents(agentName, links);
  return links;
}
