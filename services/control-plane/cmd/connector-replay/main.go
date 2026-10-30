// Command connector-replay serves recorded vendor API fixtures for local
// examples/e2e: run it, then point the control-plane at it with
// LANTERN_CONNECTOR_BASEURL_<SLACK|GITHUB|SENTRY|GOOGLE|PAGERDUTY>=http://127.0.0.1:<port>.
// Recorded calls are readable at GET /__requests.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/dshakes/lantern/services/control-plane/internal/connectorreplay"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9191", "listen address (loopback by default)")
	flag.Parse()
	s, err := connectorreplay.New()
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: *addr, Handler: s, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("connector-replay listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}
