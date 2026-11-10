package handlers

import (
	"testing"
	"time"
)

func TestExportState(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name          string
		ready, failed bool
		started       time.Time
		want          string
	}{
		{"nothing", false, false, time.Time{}, "none"},
		{"recent marker", false, false, now.Add(-time.Minute), "working"},
		{"stale marker", false, false, now.Add(-exportStaleAfter - time.Minute), "failed"},
		{"error file", false, true, now.Add(-time.Minute), "failed"},
		{"done", true, false, now.Add(-time.Minute), "ready"},
		{"done beats error", true, true, time.Time{}, "ready"},
	}
	for _, c := range cases {
		if got := exportState(c.ready, c.failed, c.started, now); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDownloadName(t *testing.T) {
	for in, want := range map[string]string{
		"Demo video":       "Demo video-hd.mp4",
		"വീഡിയോ ഡെമോ":      "വീഡിയോ ഡെമോ-hd.mp4",
		"../../etc/passwd": "....etcpasswd-hd.mp4",
		"a\"b\r\nc":        "abc-hd.mp4",
		"":                 "video-hd.mp4",
		"<>":               "video-hd.mp4",
	} {
		if got := downloadName(in); got != want {
			t.Errorf("downloadName(%q) = %q, want %q", in, got, want)
		}
	}
}
