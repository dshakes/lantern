// Per-turn entity binding — keeps a contact's name stable within ONE reply
// so the LLM can't flip "Arun" to "Manasa" mid-answer.
//
// Usage: create a fresh TurnBindings at the start of each reply, call bind()
// as you resolve names from the roster/profile, then gate every name lookup
// through nameFor() before injecting into the prompt.
//
// Rules:
//   - Once a handle is bound, nameFor() returns that name for the whole turn.
//   - explicit:true (owner correction) overrides a prior heuristic binding.
//   - A heuristic (non-explicit) binding NEVER overrides an explicit one.

import { canonicalHandle } from "./canonical-handle.js";

interface Slot {
  name: string;
  explicit: boolean;
}

export class TurnBindings {
  // ponytail: plain Map — one turn, small N, no need for anything fancier.
  private readonly slots = new Map<string, Slot>();

  /**
   * Bind `name` to `handle` for this turn.
   * An explicit binding wins over a prior heuristic; a heuristic never
   * overrides an explicit one.
   */
  bind(handle: string, name: string, opts?: { explicit?: boolean }): void {
    const key = canonicalHandle(handle);
    const explicit = opts?.explicit ?? false;
    const prior = this.slots.get(key);
    // Non-explicit never overrides any prior binding (heuristic or explicit).
    // Explicit overrides only a non-explicit prior.
    if (prior && (!explicit || prior.explicit)) return;
    this.slots.set(key, { name, explicit });
  }

  /**
   * Return the name bound to `handle` this turn, or null if unbound.
   * Both "+16303475128" and "16303475128@s.whatsapp.net" resolve to the same slot.
   */
  nameFor(handle: string): string | null {
    return this.slots.get(canonicalHandle(handle))?.name ?? null;
  }
}
