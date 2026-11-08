package worker

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"videointell/backend/internal/storage"
)

func TestRenditionsFor(t *testing.T) {
	heights := func(rs []rendition) (hs []int) {
		for _, r := range rs {
			hs = append(hs, r.Height)
		}
		return hs
	}
	cases := map[int][]int{2160: {1080, 720, 480}, 1080: {1080, 720, 480}, 720: {720, 480}, 481: {480}, 361: {360}}
	for src, want := range cases {
		got := heights(renditionsFor(src))
		if len(got) != len(want) {
			t.Fatalf("renditionsFor(%d) = %v, want %v", src, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("renditionsFor(%d) = %v, want %v", src, got, want)
			}
		}
	}
}

func TestOutputPrefix(t *testing.T) {
	if got, _ := OutputPrefix("uploads/u1/1-a.mp4"); got != "processed/u1/1-a.mp4/" {
		t.Errorf("got %q", got)
	}
	if _, err := OutputPrefix("processed/x"); err == nil {
		t.Error("key outside uploads/ accepted")
	}
}

const fakeWhisper = `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "-of" ] && out="$2"; shift; done
printf '{"transcription":[{"timestamps":{"from":"00:00:01,000"},"text":" hello from the test"}]}' > "$out.json"
printf 'WEBVTT\n' > "$out.vtt"
`

func TestRunEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	data, scratch := t.TempDir(), t.TempDir()
	key := "uploads/u1/1-test.mp4"
	src := filepath.Join(data, filepath.FromSlash(key))
	os.MkdirAll(filepath.Dir(src), 0o755)
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=12",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=12",
		"-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("make test video: %v\n%s", err, out)
	}
	whisper := filepath.Join(scratch, "fake-whisper")
	os.WriteFile(whisper, []byte(fakeWhisper), 0o755)

	cfg := Config{
		VideoKey:     key,
		Storage:      storage.NewLocalStorage(data, ""),
		ScratchDir:   scratch,
		WhisperBin:   whisper,
		WhisperModel: "unused",
	}
	if err := Run(cfg); err != nil {
		t.Fatalf("Run: %v", err)
	}

	out := filepath.Join(data, "processed", "u1", "1-test.mp4")
	for _, f := range []string{
		"hls/master.m3u8", "hls/720p/index.m3u8", "hls/480p/index.m3u8", "hls/720p/seg_0000.ts",
		"video.mp4", "thumbs/thumb_01.jpg", "thumbs/thumb_02.jpg", "transcript.json", "transcript.vtt", "bedrock-request.json",
	} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "hls/1080p")); err == nil {
		t.Error("1080p made from a 720p source")
	}
	if _, err := os.Stat(filepath.Join(out, "audio.wav")); err == nil {
		t.Error("audio.wav copied to output")
	}

	master, _ := os.ReadFile(filepath.Join(out, "hls/master.m3u8"))
	if !strings.Contains(string(master), "RESOLUTION=1280x720") || !strings.Contains(string(master), "RESOLUTION=854x480") {
		t.Errorf("master playlist:\n%s", master)
	}

	raw, _ := os.ReadFile(filepath.Join(out, "bedrock-request.json"))
	var body struct {
		Version  string `json:"anthropic_version"`
		Messages []struct {
			Content []struct{ Text string } `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("bedrock-request.json: %v", err)
	}
	if body.Version != "bedrock-2023-05-31" || !strings.Contains(body.Messages[0].Content[0].Text, "[00:00:01] hello from the test") {
		t.Errorf("bedrock request: %s", raw)
	}

	if err := Run(cfg); err == nil {
		t.Error("second Run overwrote existing results")
	}
}
