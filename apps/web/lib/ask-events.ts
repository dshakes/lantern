// Cross-component "Ask PAL" trigger: any inline command bar (Brief, Overview,
// empty states) hands its query to the one ⌘K engine instead of duplicating it.
export const ASK_EVENT = "pal:ask";

export interface AskEventDetail {
  query?: string;
  /** Run the query immediately instead of just opening the bar. */
  submit?: boolean;
}

export function openAsk(detail: AskEventDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AskEventDetail>(ASK_EVENT, { detail }));
}
