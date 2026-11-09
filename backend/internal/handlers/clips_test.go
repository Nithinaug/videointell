package handlers

import "testing"

func TestValidClip(t *testing.T) {
	cases := []struct {
		title      string
		start, end int64
		ok         bool
	}{
		{"  Intro  ", 0, 10_000, true},
		{"Max", 0, maxClipMS, true},
		{"", 0, 10_000, false},
		{string(make([]rune, 101)), 0, 10_000, false},
		{"Backwards", 5000, 4000, false},
		{"Negative", -1, 4000, false},
		{"Too short", 0, 999, false},
		{"Too long", 0, maxClipMS + 1, false},
	}
	for _, c := range cases {
		title, err := validClip(c.title, c.start, c.end)
		if (err == nil) != c.ok {
			t.Errorf("validClip(%q, %d, %d) err = %v", c.title, c.start, c.end, err)
		}
		if c.ok && title != "Intro" && title != "Max" {
			t.Errorf("title not trimmed: %q", title)
		}
	}
}
