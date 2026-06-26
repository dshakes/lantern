package handlers

// templates_test.go — lightweight unit tests for the agent template registry.
//
// These tests run inside package handlers (not handlers_test) so they can
// access the package-level `templates` map directly without a live database.

import (
	"strings"
	"testing"
)

// TestTemplateLanternGuide_Registered verifies that the lantern-guide template
// is present in the registry with the required fields.
func TestTemplateLanternGuide_Registered(t *testing.T) {
	tpl, ok := templates["lantern-guide"]
	if !ok {
		t.Fatal("lantern-guide template is not registered in the templates map")
	}
	if tpl.ID != "lantern-guide" {
		t.Errorf("ID: want %q, got %q", "lantern-guide", tpl.ID)
	}
	if tpl.Name == "" {
		t.Error("Name must not be empty")
	}
	if tpl.Description == "" {
		t.Error("Description must not be empty")
	}
	if tpl.Model == "" {
		t.Error("Model must not be empty")
	}
	if tpl.SystemPrompt == "" {
		t.Error("SystemPrompt must not be empty")
	}
	// The prompt must instruct the agent to respond concisely (≤3 sentences).
	prompt := strings.ToLower(tpl.SystemPrompt)
	if !strings.Contains(prompt, "3 sentence") && !strings.Contains(prompt, "at most 3") {
		t.Error("SystemPrompt should reference the 3-sentence limit")
	}
	// Prompt must mention "next command" so the agent always gives actionable advice.
	if !strings.Contains(prompt, "next command") {
		t.Error("SystemPrompt should instruct the agent to suggest a next command")
	}
}

// TestTemplateLanternGuide_BudgetCaps verifies the spend caps are set and
// are small enough not to surprise-bill.
func TestTemplateLanternGuide_BudgetCaps(t *testing.T) {
	tpl := templates["lantern-guide"]

	const maxDayCap = 1.00 // never more than a dollar a day for an onboarding guide
	const maxRunCap = 0.10 // never more than 10¢ per guide run

	if tpl.MaxCostUsdDay <= 0 || tpl.MaxCostUsdDay > maxDayCap {
		t.Errorf("MaxCostUsdDay: want 0 < x ≤ %.2f, got %.2f", maxDayCap, tpl.MaxCostUsdDay)
	}
	if tpl.MaxCostRun <= 0 || tpl.MaxCostRun > maxRunCap {
		t.Errorf("MaxCostRun: want 0 < x ≤ %.2f, got %.2f", maxRunCap, tpl.MaxCostRun)
	}
	// Per-run cap must not exceed per-day cap.
	if tpl.MaxCostRun > tpl.MaxCostUsdDay {
		t.Errorf("MaxCostRun (%.2f) must not exceed MaxCostUsdDay (%.2f)", tpl.MaxCostRun, tpl.MaxCostUsdDay)
	}
}

// TestTemplateLanternGuide_NoScheduleNoConnectors verifies the guide template
// has no cron schedule (it's invoked on-demand by onboard, not scheduled) and
// requires no external connectors.
func TestTemplateLanternGuide_NoScheduleNoConnectors(t *testing.T) {
	tpl := templates["lantern-guide"]

	if tpl.CronExpr != "" {
		t.Errorf("CronExpr must be empty for lantern-guide (on-demand only), got %q", tpl.CronExpr)
	}
	if len(tpl.Connectors) != 0 {
		t.Errorf("Connectors must be empty for lantern-guide, got %v", tpl.Connectors)
	}
	if len(tpl.Surfaces) != 0 {
		t.Errorf("Surfaces must be empty for lantern-guide (no delivery surface needed), got %v", tpl.Surfaces)
	}
}

// TestTemplateRegistry_AllHaveRequiredFields is a catalog gate: any template
// in the registry must have ID, Name, Description, Model, and SystemPrompt.
func TestTemplateRegistry_AllHaveRequiredFields(t *testing.T) {
	for id, tpl := range templates {
		if tpl.ID != id {
			t.Errorf("template %q: ID field %q does not match map key", id, tpl.ID)
		}
		if tpl.Name == "" {
			t.Errorf("template %q: Name is empty", id)
		}
		if tpl.Description == "" {
			t.Errorf("template %q: Description is empty", id)
		}
		if tpl.Model == "" {
			t.Errorf("template %q: Model is empty", id)
		}
		if tpl.SystemPrompt == "" {
			t.Errorf("template %q: SystemPrompt is empty", id)
		}
	}
}
