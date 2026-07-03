package lantern

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDo_RetriesOnServiceUnavailableThenSucceeds(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"a1","name":"triage"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	agent, err := c.GetAgent(context.Background(), "a1")
	if err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected 2 calls (1 failure + 1 retry), got %d", calls)
	}
	if agent.ID != "a1" || agent.Name != "triage" {
		t.Fatalf("unexpected agent: %+v", agent)
	}
}

func TestDo_RetriesOnTooManyRequests(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"a1"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	if _, err := c.GetAgent(context.Background(), "a1"); err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestDo_DoesNotRetryOnBadRequest(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad request"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	if _, err := c.GetAgent(context.Background(), "a1"); err == nil {
		t.Fatal("expected error")
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 call (no retry on 400), got %d", calls)
	}
}

func TestDo_ExhaustsRetriesAndReturnsLastError(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL), WithMaxRetries(2))
	_, err := c.GetAgent(context.Background(), "a1")
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected *APIError 503, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected exactly 2 calls (WithMaxRetries(2)), got %d", calls)
	}
}
