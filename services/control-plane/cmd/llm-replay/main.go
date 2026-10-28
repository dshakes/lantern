// Command llm-replay is the deterministic fixture LLM for CI and kiosk mode: run
// it, then start the control-plane with
// LANTERN_LLM_BASEURL_OPENAI=http://127.0.0.1:<port> and/or
// LANTERN_LLM_BASEURL_ANTHROPIC=http://127.0.0.1:<port>. Optional -rules JSON file
// scripts replies and tool calls; recorded calls are at GET /__requests.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/dshakes/lantern/services/control-plane/internal/llmreplay"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9192", "listen address (loopback by default)")
	rulesPath := flag.String("rules", "", "JSON rule file: [{\"match\":\"...\",\"reply\":\"...\"|\"tool\":{\"name\":\"...\",\"args\":{}}}]")
	flag.Parse()
	var rules []llmreplay.Rule
	if *rulesPath != "" {
		var err error
		if rules, err = llmreplay.LoadRules(*rulesPath); err != nil {
			log.Fatal(err)
		}
	}
	srv := &http.Server{Addr: *addr, Handler: llmreplay.New(rules), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("llm-replay listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}
