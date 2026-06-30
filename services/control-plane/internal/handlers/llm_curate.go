package handlers

// llm_curate.go — REUSABLE intelligence primitive for agents.
//
// The pattern every "smart" agent needs: given the owner's natural-language
// request and a list of candidate items, have the LLM REASON about intent and
// return a ranked/grouped selection — picking items BY INDEX so it can never
// hallucinate content (the caller hydrates real data from its own list).
//
// This is deliberately agent-agnostic: news, commitments, life-events, inbox
// triage, domain trackers — anything with "here are N candidates, which matter
// for this request and why" — reuses LLMCurate instead of re-implementing an
// LLM call + JSON parse + fallback. (See news_ask.go for the first consumer.)
//
// Best-effort by contract: returns (result, true) on a clean parse, (zero,
// false) on ANY llm/parse failure, so the caller always has a deterministic
// fallback path.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// CuratePick is one LLM selection: the candidate index, an optional grouping
// label (e.g. company/category), and a one-line rationale.
type CuratePick struct {
	I     int    `json:"i"`
	Group string `json:"group"`
	Why   string `json:"why"`
}

// CurateResult is the LLM's structured curation over the candidate list.
type CurateResult struct {
	Interpretation string       `json:"interpretation"`
	Note           string       `json:"note"`
	Picks          []CuratePick `json:"picks"`
}

// CurateOpts configures one curation pass.
type CurateOpts struct {
	// SystemRole is the agent-specific analyst persona (e.g. "You are a
	// world-class AI-news analyst …"). The shared output-format contract is
	// appended automatically.
	SystemRole string
	// Request is the owner's natural-language ask.
	Request string
	// ItemLines are the compact candidate lines, one per index, e.g.
	// "[0] OpenAI | score:90 | 2026-06-29 | GPT-5.5 launches".
	ItemLines []string
	// MaxPicks caps how many items the LLM may return (default 5).
	MaxPicks int
	// GroupNoun labels the grouping dimension in the prompt ("company",
	// "category", "person"); default "group".
	GroupNoun string
	// ExtraGuidance is appended to the user prompt for agent-specific rules
	// (e.g. "exclude minor version bumps"). Optional.
	ExtraGuidance string
}

// LLMCurate runs one intelligent selection pass. Returns (result, ok).
func LLMCurate(ctx context.Context, complete researchCompleteFn, tenantID string, opts CurateOpts) (CurateResult, bool) {
	if complete == nil || len(opts.ItemLines) == 0 {
		return CurateResult{}, false
	}
	maxPicks := opts.MaxPicks
	if maxPicks <= 0 || maxPicks > 30 {
		maxPicks = 5
	}
	groupNoun := opts.GroupNoun
	if groupNoun == "" {
		groupNoun = "group"
	}

	system := opts.SystemRole + " You never invent items; you only pick from the candidate list by index."

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Owner request: %q\n\nCandidates:\n", opts.Request))
	for _, line := range opts.ItemLines {
		sb.WriteString(line)
		sb.WriteString("\n")
	}
	sb.WriteString(fmt.Sprintf("\nPick at most %d candidates that best answer the request, most important first, and GROUP them by %s. ", maxPicks, groupNoun))
	if opts.ExtraGuidance != "" {
		sb.WriteString(opts.ExtraGuidance + " ")
	}
	sb.WriteString("If the request names something NOT present, set \"note\" to say so plainly and pick the top relevant items instead — never a generic 'try again'. ")
	sb.WriteString("Return ONLY JSON, no prose:\n")
	sb.WriteString("{\"interpretation\":\"<what the request means>\",\"note\":\"<optional caveat or empty>\",\"picks\":[{\"i\":<candidate index int>,\"group\":\"<" + groupNoun + ">\",\"why\":\"<one short sentence>\"}]}")

	raw, err := complete(ctx, tenantID, system, sb.String())
	if err != nil {
		return CurateResult{}, false
	}
	var out CurateResult
	if err := json.Unmarshal([]byte(extractJSONObject(raw)), &out); err != nil {
		return CurateResult{}, false
	}
	// Drop out-of-range / duplicate indices defensively.
	seen := map[int]bool{}
	clean := out.Picks[:0]
	for _, p := range out.Picks {
		if p.I < 0 || p.I >= len(opts.ItemLines) || seen[p.I] {
			continue
		}
		seen[p.I] = true
		clean = append(clean, p)
	}
	out.Picks = clean
	return out, len(out.Picks) > 0 || out.Note != ""
}

// extractJSONObject pulls the first {...} object out of a possibly fenced /
// prose-wrapped LLM response. Reused by curation/ranking parsers.
func extractJSONObject(raw string) string {
	s := strings.TrimSpace(raw)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		s = strings.TrimPrefix(s, "json")
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
	}
	if start := strings.Index(s, "{"); start != -1 {
		s = s[start:]
	}
	if end := strings.LastIndex(s, "}"); end != -1 {
		s = s[:end+1]
	}
	return strings.TrimSpace(s)
}
