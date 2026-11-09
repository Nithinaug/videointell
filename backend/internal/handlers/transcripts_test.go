package handlers

import (
	"os"
	"path/filepath"
	"testing"

	"videointell/backend/internal/storage"
	"videointell/backend/internal/worker"
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

func TestLoadScreen(t *testing.T) {
	dir := t.TempDir()
	h := &VideoHandler{Storage: storage.NewLocalStorage(dir, "secret")}
	p := filepath.Join(dir, "processed", "v", "screen.json")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(`{"frames":[{"from_ms":3000,"text":"ECONNREFUSED"}]}`), 0o644)
	if s, err := h.loadScreen("processed/v/"); err != nil || len(s) != 1 || s[0].FromMS != 3000 {
		t.Fatalf("screen = %v %v", s, err)
	}
	if s, err := h.loadScreen("processed/none/"); err != nil || s != nil {
		t.Fatalf("missing screen.json = %v %v", s, err)
	}
}

func TestScreenMatchesFirstAppearanceOnly(t *testing.T) {
	frames := []worker.ScreenText{{FromMS: 0, Text: "Diagnose tab"}, {FromMS: 3000, Text: "Diagnose tab 2"}, {FromMS: 6000, Text: "Fix"}, {FromMS: 9000, Text: "Diagnose again"}}
	got := screenMatches(frames, []string{"diagnose"})
	if len(got) != 2 || got[0] != 0 || got[1] != 3 {
		t.Fatalf("screenMatches = %v", got)
	}
}
