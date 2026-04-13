// ---------------------------------------------------------------------------
// MCP Server Integration — manage MCP server connections per agent
// ---------------------------------------------------------------------------

export interface McpServer {
  id: string;
  name: string;
  url: string;
  authType: "none" | "bearer" | "api-key";
  authToken?: string;
  status: "connected" | "disconnected" | "error";
  tools?: string[];
  addedAt: string;
}

const MCP_KEY_PREFIX = "lantern_mcp_servers_";

export function getMcpServers(agentName: string): McpServer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MCP_KEY_PREFIX + agentName);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveMcpServers(agentName: string, servers: McpServer[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(MCP_KEY_PREFIX + agentName, JSON.stringify(servers));
}

export function addMcpServer(agentName: string, server: Omit<McpServer, "id" | "addedAt" | "status">): McpServer[] {
  const servers = getMcpServers(agentName);
  const newServer: McpServer = {
    ...server,
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: "disconnected",
    addedAt: new Date().toISOString(),
  };
  servers.push(newServer);
  saveMcpServers(agentName, servers);
  return servers;
}

export function removeMcpServer(agentName: string, serverId: string): McpServer[] {
  const servers = getMcpServers(agentName).filter(s => s.id !== serverId);
  saveMcpServers(agentName, servers);
  return servers;
}

export function updateMcpServerStatus(agentName: string, serverId: string, status: McpServer["status"], tools?: string[]): McpServer[] {
  const servers = getMcpServers(agentName).map(s =>
    s.id === serverId ? { ...s, status, ...(tools ? { tools } : {}) } : s
  );
  saveMcpServers(agentName, servers);
  return servers;
}
