# TODO: needs a fresh stack/tenant with no LLM provider or agents configured (throwaway tenant + a real provider key supplied out-of-band) — not recorded; output must come from a real run.
# Why: the only local stack (:8080) is the owner's live dev tenant. `lantern onboard` creates a real agent and calls an LLM there, and with providers already configured it is not a "first run".
Output docs/media/onboard.gif
Source docs/media/tapes/_settings.tape
Hide
Type "export PATH=$PWD/bin:$PATH HOME=$(mktemp -d) LANTERN_API_URL=localhost:8080 LANTERN_USE_REST=1" Enter
Type "lantern login --email admin@lantern.dev --password lantern >/dev/null && clear" Enter
Show
Type "lantern onboard" Enter
Sleep 30s
