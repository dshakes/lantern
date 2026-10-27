// Package connectorreplay serves recorded vendor API responses (Slack, GitHub,
// Sentry, PagerDuty, Google Calendar) so connector actions and examples run
// without a real SaaS account. Point a connector at it with
// LANTERN_CONNECTOR_BASEURL_<NAME> (dev/test only; see handlers/connector_baseurl.go).
//
// Every request is recorded so tests can assert the outbound call shape. The
// Authorization header is never stored (invariant #10) — only whether it was set.
package connectorreplay

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
)

//go:embed fixtures.json
var fixturesJSON []byte

type fixture struct {
	Method   string          `json:"method"`
	Path     string          `json:"path"`
	Status   int             `json:"status"`
	Response json.RawMessage `json:"response"`
}

// Request is one recorded inbound call.
type Request struct {
	Method     string      `json:"method"`
	Path       string      `json:"path"`
	Query      string      `json:"query"`
	Header     http.Header `json:"header"` // Authorization removed
	Body       string      `json:"body"`
	HasAuth    bool        `json:"hasAuth"`
	Matched    bool        `json:"matched"`
	StatusSent int         `json:"status"`
}

// Server is an http.Handler serving the embedded fixtures.
type Server struct {
	fixtures map[string]fixture
	mu       sync.Mutex
	reqs     []Request
}

// New loads the embedded fixtures.
func New() (*Server, error) {
	var list []fixture
	if err := json.Unmarshal(fixturesJSON, &list); err != nil {
		return nil, fmt.Errorf("parse connector replay fixtures: %w", err)
	}
	s := &Server{fixtures: make(map[string]fixture, len(list))}
	for _, f := range list {
		s.fixtures[f.Method+" "+f.Path] = f
	}
	return s, nil
}

// Requests returns a copy of the recorded calls, oldest first.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.reqs...)
}

// ServeHTTP serves a fixture by exact method+path, or 404 when none is recorded.
// GET /__requests returns the recorded calls as JSON (for out-of-process e2e tests).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/__requests" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Requests())
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	hdr := r.Header.Clone()
	hdr.Del("Authorization")
	rec := Request{
		Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: hdr,
		Body: string(body), HasAuth: r.Header.Get("Authorization") != "",
	}
	f, ok := s.fixtures[r.Method+" "+r.URL.Path]
	rec.Matched = ok
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		rec.StatusSent = http.StatusNotFound
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, `{"error":"no recorded fixture for %s %s"}`, r.Method, r.URL.Path)
	} else {
		rec.StatusSent = f.Status
		w.WriteHeader(f.Status)
		_, _ = w.Write(f.Response)
	}
	s.mu.Lock()
	s.reqs = append(s.reqs, rec)
	s.mu.Unlock()
}
