package handlers

import "testing"

func TestSafeFilename(t *testing.T) {
	cases := map[string]string{
		"my clip.mp4":         "my-clip.mp4",
		"../../etc/passwd":    "passwd",
		"vidéo (final)#1.mov": "vid-o-final-1.mov",
		"ok_name-1.mp4":       "ok_name-1.mp4",
	}
	for in, want := range cases {
		if got := safeFilename(in); got != want {
			t.Errorf("safeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
