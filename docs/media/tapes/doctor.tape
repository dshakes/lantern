# TODO: not recorded. `pal doctor` is NOT read-only: check (d) creates a throwaway agent, fires a
# real run (one LLM call) and deletes the agent, leaving the run row (packages/cli/internal/cli/doctor.go
# checkRun). The only local stack (:8080) is the owner's live dev tenant, so recording waits for a go-ahead
# or a throwaway stack. Output must come from a real run.
Output docs/media/doctor.gif
Source docs/media/tapes/_settings.tape
Hide
Type "export PATH=$PWD/bin:$PATH HOME=$(mktemp -d) PAL_API_URL=localhost:8080 PAL_USE_REST=1 && clear" Enter
Show
Type "pal doctor" Enter
Wait+Screen@120s /doctor: /
Sleep 4s
