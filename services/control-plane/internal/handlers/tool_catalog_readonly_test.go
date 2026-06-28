package handlers

import "testing"

// filterReadOnlyTools is a trust-boundary filter: on the contact reply path it
// must keep ONLY read actions so a contact's message can never drive a
// connector write. Verify reads pass and writes are dropped.
func TestFilterReadOnlyTools(t *testing.T) {
	mk := func(name string) map[string]any {
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	}
	in := []map[string]any{
		mk("google-calendar__list_events"),
		mk("gmail__search_messages"),
		mk("gmail__get_message"),
		mk("search_personal_files"), // built-in read
		mk("read_personal_file"),    // built-in read
		mk("gmail__send_message"),   // WRITE — must be dropped
		mk("google-calendar__create_event"),
		mk("slack__post_message"),
		mk("github__delete_repo"),
		mk(""), // junk
	}
	out := filterReadOnlyTools(in)

	got := map[string]bool{}
	for _, t := range out {
		fn := t["function"].(map[string]any)
		got[fn["name"].(string)] = true
	}

	wantKeep := []string{
		"google-calendar__list_events", "gmail__search_messages",
		"gmail__get_message", "search_personal_files", "read_personal_file",
	}
	for _, n := range wantKeep {
		if !got[n] {
			t.Errorf("read tool %q should have been kept", n)
		}
	}
	wantDrop := []string{
		"gmail__send_message", "google-calendar__create_event",
		"slack__post_message", "github__delete_repo", "",
	}
	for _, n := range wantDrop {
		if got[n] {
			t.Errorf("write/junk tool %q should have been dropped", n)
		}
	}
}
