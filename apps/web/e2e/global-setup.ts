import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  API_PORT, API_URL, CP_DIR, CP_LOG, GRPC_PORT, LLM_PORT, LLM_RULES, METRICS_PORT,
  PG_ADMIN_URL, REDIS_DB, REDIS_HOST, REDIS_PORT, RUN_DIR, WEB_PORT, WEB_URL,
} from "./support/env";
import { flushRedis } from "./support/redis";

// Boots a private stack: fresh Postgres DB, control-plane, llm-replay, next dev.
// Returns the teardown (Playwright calls it after the run).
const WEB_DIR = path.resolve(__dirname, "..");

// Extra control-plane env for other packages (e.g. kiosk specs).
const extraEnv: Record<string, string> = {};

const children: ChildProcess[] = [];

function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>, logFile: string) {
  const out = fs.openSync(logFile, "w");
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  p.on("error", (e) => console.error(`[e2e] ${name} failed to start:`, e));
  children.push(p);
  return p;
}

async function waitFor(url: string, what: string, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${what} did not come up at ${url} (see ${RUN_DIR})`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

// next dev compiles a route on first hit (tens of seconds cold). Hit every page the
// specs use once, as a throwaway signed-in user, so no test pays that cost.
async function warmRoutes() {
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "warmup@e2e.lantern.test", password: "e2e-warmup-password", name: "Warmup" }),
  });
  const { token } = (await r.json()) as { token?: string };
  const headers = { cookie: `pal_token=${token ?? ""}` };
  for (const p of ["/login", "/auth/forgot", "/auth/reset?token=x", "/onboarding", "/agents", "/settings"]) {
    await fetch(WEB_URL + p, { headers }).catch(() => {});
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function killAll() {
  for (const p of children) {
    try {
      if (p.pid) process.kill(-p.pid, "SIGTERM"); // whole process group (next dev spawns workers)
    } catch {
      /* already gone */
    }
  }
}

export default async function globalSetup() {
  // Iterating on a spec: boot once (`npx tsx e2e/global-setup.ts`-style) and reuse it.
  if (process.env.E2E_REUSE_STACK) return;
  for (const p of [WEB_PORT, API_PORT, GRPC_PORT, METRICS_PORT, LLM_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use; set E2E_*_PORT (never reuse :8080/:3001)`);
  }
  await flushRedis();
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const dbName = `lantern_e2e_${process.pid}`;
  const dbUrl = new URL(PG_ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  const psql = (sql: string) => execFileSync("psql", [PG_ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-qc", sql], { stdio: "inherit" });
  psql(`CREATE DATABASE ${dbName}`);

  const teardown = async () => {
    killAll();
    await new Promise((r) => setTimeout(r, 1500)); // let the server drop its DB connections
    try {
      psql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } catch (e) {
      console.error("[e2e] could not drop", dbName, e);
    }
    await flushRedis();
  };

  try {
    const cpBin = path.join(RUN_DIR, "control-plane");
    const llmBin = path.join(RUN_DIR, "llm-replay");
    execFileSync("go", ["build", "-o", cpBin, "./cmd/server"], { cwd: CP_DIR, stdio: "inherit" });
    execFileSync("go", ["build", "-o", llmBin, "./cmd/llm-replay"], { cwd: CP_DIR, stdio: "inherit" });

    start("llm-replay", llmBin, ["-addr", `127.0.0.1:${LLM_PORT}`, "-rules", LLM_RULES], CP_DIR, {}, path.join(RUN_DIR, "llm-replay.log"));
    await waitFor(`http://127.0.0.1:${LLM_PORT}/__requests`, "llm-replay", 30_000);

    start("control-plane", cpBin, [], CP_DIR, {
      DATABASE_URL: dbUrl.toString(),
      REDIS_URL: `redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}`,
      HTTP_ADDR: `127.0.0.1:${API_PORT}`,
      LISTEN_ADDR: `127.0.0.1:${GRPC_PORT}`,
      LANTERN_METRICS_ADDR: `127.0.0.1:${METRICS_PORT}`,
      // Without this every API call from the dashboard origin fails CORS.
      LANTERN_CORS_ORIGINS: WEB_URL,
      LANTERN_ENV: "",
      LANTERN_MAILER: "log",
      LANTERN_SIGNUP_MODE: "open",
      LANTERN_LLM_BASEURL_OPENAI: `http://127.0.0.1:${LLM_PORT}`,
      LANTERN_LLM_BASEURL_ANTHROPIC: `http://127.0.0.1:${LLM_PORT}`,
      ...extraEnv,
    }, CP_LOG);
    await waitFor(`${API_URL}/healthz`, "control-plane");

    start("web", "npx", ["next", "dev", "--port", String(WEB_PORT)], WEB_DIR, {
      NEXT_PUBLIC_API_URL: API_URL,
      LANTERN_API_URL: API_URL,
      NEXT_TELEMETRY_DISABLED: "1",
    }, path.join(RUN_DIR, "web.log"));
    await waitFor(`${WEB_URL}/login`, "next dev");
    await warmRoutes();
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
