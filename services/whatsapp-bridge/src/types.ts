// Shared wire types for the WhatsApp bridge control plane.
//
// Keep this file free of runtime imports so it can be consumed by the
// dashboard (which doesn't want to pull baileys into its bundle) via a
// lightweight copy or a published types package.

/**
 * The state published by the bridge over `/session/:tenantId/bot` and after
 * every mutation endpoint. The dashboard mirrors this shape directly.
 */
export interface BotState {
  /** Global kill switch. When true, no contact gets an auto-reply. */
  muted: boolean;
  /**
   * Per-contact pauses. Keyed by JID, value is the epoch-ms at which the
   * pause expires. The bridge filters out already-expired entries before
   * publishing, so clients can treat every entry here as "still paused".
   */
  paused: Record<string, number>;
  /**
   * Groups the owner has opted into monitoring. An empty list means groups
   * are completely ignored (they are opt-in to avoid noise).
   */
  monitoredGroups: string[];
}

/** Extended shape returned by POST /bot/resume-all, which also reports how
 *  many pauses it cleared in this call. */
export interface BotStateWithCleared extends BotState {
  cleared: number;
}
