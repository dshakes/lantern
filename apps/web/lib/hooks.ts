"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type RunFilters } from "@/lib/api";
import {
  agents as mockAgents,
  runs as mockRuns,
} from "@/lib/mock-data";
import type { Agent, Run, StreamEvent, ApiKey, AgentVersion } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// useSafeData pattern — every hook returns { data, loading, error, isDemo }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useAgents
// ---------------------------------------------------------------------------

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAgents();
      setAgents(data);
      setIsDemo(false);
    } catch {
      // API unavailable — fall back to mock data so the UI isn't empty
      console.warn("[lantern] API unavailable for listAgents, using mock data");
      setAgents([...mockAgents]);
      setIsDemo(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agents, setAgents, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgent
// ---------------------------------------------------------------------------

export function useAgent(name: string) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAgent(name);
      setAgent(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agent, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgentVersions
// ---------------------------------------------------------------------------

export function useAgentVersions(agentName: string) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAgentVersions(agentName);
      setVersions(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { versions, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgentRuns
// ---------------------------------------------------------------------------

export function useAgentRuns(agentName: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRunsForAgent(agentName);
      setRuns(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRuns
// ---------------------------------------------------------------------------

export function useRuns(filters?: RunFilters) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listRuns(filters);
      setRuns(data);
      setIsDemo(false);
    } catch {
      // API unavailable — fall back to mock data
      console.warn("[lantern] API unavailable for listRuns, using mock data");
      let result = [...mockRuns];
      if (filters?.agentName && filters.agentName !== "all") {
        result = result.filter((r) => r.agentName === filters.agentName);
      }
      if (filters?.status && filters.status !== "all") {
        result = result.filter((r) => r.status === filters.status);
      }
      if (filters?.search) {
        const q = filters.search.toLowerCase();
        result = result.filter(
          (r) =>
            r.id.toLowerCase().includes(q) ||
            r.agentName.toLowerCase().includes(q),
        );
      }
      setRuns(result);
      setIsDemo(true);
    } finally {
      setLoading(false);
    }
  }, [filters?.agentName, filters?.status, filters?.search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRun
// ---------------------------------------------------------------------------

export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRun(id);
      setRun(data);
      setIsDemo(false);
    } catch (err) {
      // getRun already falls back to mock data inside api.ts,
      // so if we get here the run truly doesn't exist
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { run, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRunEvents — live SSE streaming with mock fallback
// ---------------------------------------------------------------------------

export function useRunEvents(runId: string) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const streamRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    setEvents([]);
    setConnected(false);

    const stream = api.streamRunEvents(runId);
    streamRef.current = stream;

    stream.subscribe((event) => {
      setConnected(true);
      setEvents((prev) => [...prev, event]);
    });

    return () => {
      stream.close();
      streamRef.current = null;
    };
  }, [runId]);

  return { events, connected };
}

// ---------------------------------------------------------------------------
// useApiKeys
// ---------------------------------------------------------------------------

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listApiKeys();
      setKeys(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { keys, setKeys, loading, error, isDemo, refresh };
}
