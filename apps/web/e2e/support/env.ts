import os from "node:os";
import path from "node:path";

// Spare ports, never :8080/:3001. Override with E2E_*_PORT if they collide.
const port = (name: string, dflt: number) => Number(process.env[name] ?? dflt);

export const WEB_PORT = port("E2E_WEB_PORT", 3411);
export const API_PORT = port("E2E_API_PORT", 8411);
export const GRPC_PORT = port("E2E_GRPC_PORT", 50411);
export const METRICS_PORT = port("E2E_METRICS_PORT", 9411);
export const LLM_PORT = port("E2E_LLM_PORT", 9412);

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

// Logs, binaries and test artifacts live OUTSIDE apps/web: `next dev` watches the
// whole project dir, and a log file growing under it triggers endless rebuilds.
export const RUN_DIR = process.env.E2E_RUN_DIR ?? path.join(os.tmpdir(), "lantern-e2e-run");
export const CP_LOG = path.join(RUN_DIR, "control-plane.log");
export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const CP_DIR = path.join(REPO_ROOT, "services/control-plane");
export const LLM_RULES = path.resolve(__dirname, "../fixtures/llm-rules.json");

// Postgres admin URL used to create/drop the throwaway DB; Redis db index for rate limits.
export const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? "postgres://lantern:lantern@localhost:5432/postgres?sslmode=disable";
export const REDIS_HOST = process.env.E2E_REDIS_HOST ?? "127.0.0.1";
export const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6379);
export const REDIS_DB = Number(process.env.E2E_REDIS_DB ?? 13);
