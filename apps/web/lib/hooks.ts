"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type RunFilters } from "@/lib/api";
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
    } catch (err) {
      // listAgents already falls back to mock data inside api.ts,
      // so if we get an error here it means even mock data failed.
      setError(err instanceof Error ? err : new Error(String(err)));
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
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
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
