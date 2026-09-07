package handlers

import "testing"

func TestParseSearchWindow(t *testing.T) {
	cases := []struct {
		limit, window string
		wantL, wantW  int
	}{
		{"", "", 6, 7},
		{"4", "14", 4, 14},
		{"0", "0", 6, 7},
		{"999", "99999", 6, 7},
		{"abc", " 30 ", 6, 30},
	}
	for _, c := range cases {
		l, w := parseSearchWindow(c.limit, c.window)
		if l != c.wantL || w != c.wantW {
			t.Errorf("parseSearchWindow(%q,%q) = %d,%d want %d,%d", c.limit, c.window, l, w, c.wantL, c.wantW)
		}
	}
}
