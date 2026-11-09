package handlers

import (
	"os"
	"path/filepath"
	"testing"

	"videointell/backend/internal/storage"
)

func TestLoadTranscript(t *testing.T) {
	dir := t.TempDir()
	h := &VideoHandler{Storage: storage.NewLocalStorage(dir, "secret")}
	write := func(name, body string) {
		p := filepath.Join(dir, "processed", name, "transcript.json")
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	write("new", `{"segments":[{"from_ms":1000,"to_ms":2000,"text":"under the hood"}]}`)
	write("empty", `{"segments":[]}`)
	write("old", `{"transcription":[{"offsets":{"from":0},"text":"hi"}]}`)
	write("bad", `{not json`)

	if s, err := h.loadTranscript("processed/new/"); err != nil || len(s) != 1 || s[0].FromMS != 1000 {
		t.Fatalf("new = %v %v", s, err)
	}
	if s, err := h.loadTranscript("processed/empty/"); err != nil || len(s) != 0 {
		t.Fatalf("empty = %v %v", s, err)
	}
	for _, name := range []string{"old", "bad", "missing"} {
		if _, err := h.loadTranscript("processed/" + name + "/"); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}
