package worker

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type dirStore string

func (d dirStore) Get(_ context.Context, key, path string) error {
	in, err := os.Open(filepath.Join(string(d), filepath.FromSlash(key)))
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func (d dirStore) Put(ctx context.Context, key, path string) error {
	dst := filepath.Join(string(d), filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return dirStore("/").Get(ctx, strings.TrimPrefix(path, "/"), dst)
}

func TestRenditionsFor(t *testing.T) {
	cases := map[int][]string{2160: {"1080p", "720p", "480p"}, 1080: {"1080p", "720p", "480p"}, 720: {"720p", "480p"}, 481: {"480p"}, 361: {"360p"}}
	for h, want := range cases {
		got := renditionsFor(source{Width: h * 16 / 9, Height: h})
		if len(got) != len(want) {
			t.Fatalf("renditionsFor(%d) = %v, want %v", h, got, want)
		}
		for i := range want {
			if got[i].Name != want[i] || got[i].Width%2 != 0 {
				t.Fatalf("renditionsFor(%d) = %v, want %v", h, got, want)
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
printf '{"transcription":[{"offsets":{"from":1000,"to":2000},"text":" hello from the test"}]}' > "$out.json"
`

func TestPipelineEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	chunkSeconds = 5
	data, scratch := t.TempDir(), t.TempDir()
	key := "uploads/u1/1-test.mp4"
	src := filepath.Join(data, filepath.FromSlash(key))
	os.MkdirAll(filepath.Dir(src), 0o755)
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=12",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=12",
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-c:a", "aac", "-shortest", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("make test video: %v\n%s", err, out)
	}
	whisper := filepath.Join(scratch, "fake-whisper")
	os.WriteFile(whisper, []byte(fakeWhisper), 0o755)

	ctx, st := context.Background(), dirStore(data)
	tools := Tools{ScratchDir: scratch, WhisperBin: whisper, WhisperModel: "unused"}
	plan, err := Split(ctx, st, tools, Event{Op: "split", Bucket: "b", VideoKey: key})
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if len(plan.Chunks) != 3 || plan.Chunks[1].Start < 4.9 || plan.Chunks[1].Start > 5.1 {
		t.Fatalf("chunks = %+v", plan.Chunks)
	}
	for _, c := range plan.Chunks {
		if err := Chunk(ctx, st, tools, c); err != nil {
			t.Fatalf("Chunk %d: %v", c.Index, err)
		}
	}
	if err := Assemble(ctx, st, tools, plan); err != nil {
		t.Fatalf("Assemble: %v", err)
	}

	out := filepath.Join(data, "processed", "u1", "1-test.mp4")
	for _, f := range []string{
		"hls/master.m3u8", "hls/720p/index.m3u8", "hls/480p/index.m3u8", "hls/720p/c0000_0000.ts", "hls/720p/c0002_0000.ts",
		"thumbs/thumb_01.jpg", "thumbs/thumb_02.jpg", "transcript.json", "transcript.vtt", "bedrock-request.json",
	} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "hls/1080p")); err == nil {
		t.Error("1080p made from a 720p source")
	}

	master, _ := os.ReadFile(filepath.Join(out, "hls/master.m3u8"))
	if !strings.Contains(string(master), "RESOLUTION=1280x720") || !strings.Contains(string(master), "RESOLUTION=854x480") {
		t.Errorf("master playlist:\n%s", master)
	}
	variant, _ := os.ReadFile(filepath.Join(out, "hls/720p/index.m3u8"))
	if strings.Count(string(variant), "#EXT-X-DISCONTINUITY") != 2 || !strings.HasSuffix(string(variant), "#EXT-X-ENDLIST\n") {
		t.Errorf("720p playlist:\n%s", variant)
	}

	raw, _ := os.ReadFile(filepath.Join(out, "bedrock-request.json"))
	var body struct {
		Config   struct{ MaxTokens int } `json:"inferenceConfig"`
		Messages []struct {
			Content []struct{ Text string } `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("bedrock-request.json: %v", err)
	}
	text := body.Messages[0].Content[0].Text
	for _, line := range []string{"[00:00:01] hello from the test", "[00:00:06] hello from the test", "[00:00:11] hello from the test"} {
		if body.Config.MaxTokens == 0 || !strings.Contains(text, line) {
			t.Errorf("bedrock request missing %q: %s", line, raw)
		}
	}
	vttRaw, _ := os.ReadFile(filepath.Join(out, "transcript.vtt"))
	if !strings.Contains(string(vttRaw), "00:00:06.0") {
		t.Errorf("transcript.vtt:\n%s", vttRaw)
	}
}
