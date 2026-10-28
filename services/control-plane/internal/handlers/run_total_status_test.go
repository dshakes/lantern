package handlers

import (
	"errors"
	"testing"
)

func TestRunTotalStatus(t *testing.T) {
	cases := []struct {
		err      error
		dbStatus string
		want     string
	}{
		{nil, "succeeded", "succeeded"},
		{nil, "", "succeeded"},
		{nil, "failed", "failed"}, // workflow failure: nil error, DB says failed
		{errors.New("boom"), "running", "failed"},
	}
	for _, c := range cases {
		if got := runTotalStatus(c.err, c.dbStatus); got != c.want {
			t.Errorf("runTotalStatus(%v, %q) = %q, want %q", c.err, c.dbStatus, got, c.want)
		}
	}
}
