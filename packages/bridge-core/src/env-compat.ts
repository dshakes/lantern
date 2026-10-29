// Lantern→PAL env compat (ADR 0032), TS side. Importing this module mirrors
// every PAL_X <-> LANTERN_X pair into process.env, so existing
// process.env.LANTERN_X reads keep working when an operator sets PAL_X, and
// PAL_X reads keep working against an unchanged ~/.lantern/bridge.env.
// PAL_X wins when both are set and differ — except that an EMPTY PAL_X never
// overrides a non-empty LANTERN_X (it counts as unset), so a stray `PAL_X=`
// cannot blank a credential or token. Only key names are logged.
//
// It must be the FIRST import of a bridge entrypoint (ESM evaluates imports in
// order), and bridgeEnv() must run again after any process.loadEnvFile().

const PAL = "PAL_";
const LEGACY = "LANTERN_";

type Env = Record<string, string | undefined>;

// Values this module wrote, per env object. A key still holding the value we
// mirrored into it is OUR copy, not an operator choice: on a re-run (after
// loadEnvFile set a new LANTERN_X) it is refreshed instead of "winning".
const mirrored = new WeakMap<Env, Map<string, string>>();

export function bridgeEnv(
  env: Env = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): void {
  let ours = mirrored.get(env);
  if (!ours) {
    ours = new Map();
    mirrored.set(env, ours);
  }
  const explicit = (k: string): boolean =>
    env[k] !== undefined && ours.get(k) !== env[k];

  const suffixes = new Set<string>();
  for (const k of Object.keys(env)) {
    for (const prefix of [PAL, LEGACY]) {
      if (k.startsWith(prefix) && k.length > prefix.length) suffixes.add(k.slice(prefix.length));
    }
  }
  for (const s of suffixes) {
    const pal = PAL + s;
    const legacy = LEGACY + s;
    let value: string | undefined;
    const palWins = explicit(pal) && !(env[pal] === "" && env[legacy]);
    if (palWins) {
      value = env[pal];
      if (explicit(legacy) && env[legacy] !== value) {
        warn(`env-compat: ${pal} and ${legacy} differ; using ${pal}`);
      }
    } else if (explicit(legacy) || explicit(pal)) {
      // explicit(pal) here means an empty PAL_X beside a non-empty LANTERN_X.
      value = env[legacy];
    } else {
      continue; // both are our own mirrors, already in sync
    }
    for (const k of [pal, legacy]) {
      if (env[k] !== value) {
        env[k] = value;
        ours.set(k, value as string);
      }
    }
  }
}

bridgeEnv();
