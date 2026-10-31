import net from "node:net";
import { REDIS_DB, REDIS_HOST, REDIS_PORT } from "./env";

// Minimal RESP: FLUSHDB on the dedicated db index so rate-limit counters never leak between runs.
export function flushRedis() {
  return new Promise<void>((resolve) => {
    const s = net.connect(REDIS_PORT, REDIS_HOST);
    s.setTimeout(2000, () => s.destroy());
    s.on("error", () => resolve());
    s.on("close", () => resolve());
    s.resume(); // drain replies, or "close" never fires
    s.write(`*2\r\n$6\r\nSELECT\r\n$${String(REDIS_DB).length}\r\n${REDIS_DB}\r\n*1\r\n$7\r\nFLUSHDB\r\n*1\r\n$4\r\nQUIT\r\n`);
  });
}
