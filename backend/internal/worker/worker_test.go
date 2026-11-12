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
	if bin, err := exec.LookPath("tesseract"); err == nil {
		tools.TesseractBin = bin
	}
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
		"thumbs/thumb_01.jpg", "thumbs/thumb_02.jpg", "progress.json", "transcript.json", "transcript.vtt", "bedrock-request.json", "screen.json",
	} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	if done, _ := filepath.Glob(filepath.Join(data, "work", "u1", "1-test.mp4", "done_*")); len(done) != 3 {
		t.Errorf("done markers = %d, want 3", len(done))
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

func TestSplitRefusesLongVideo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	data, scratch := t.TempDir(), t.TempDir()
	key := "uploads/u1/2-long.mp4"
	src := filepath.Join(data, key)
	os.MkdirAll(filepath.Dir(src), 0o755)
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=90", "-c:v", "libx264", "-preset", "ultrafast", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("make test video: %v\n%s", err, out)
	}
	SetMaxMinutes(1)
	defer func() { maxSeconds = 0 }()
	_, err := Split(context.Background(), dirStore(data), Tools{ScratchDir: scratch}, Event{Op: "split", Bucket: "b", VideoKey: key})
	if err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("Split err = %v, want a length limit error", err)
	}
}

func TestRenditionsForPortrait(t *testing.T) {
	got := renditionsFor(source{Width: 1080, Height: 1920})
	want := [][2]int{{1080, 1920}, {720, 1280}, {480, 854}}
	if len(got) != len(want) {
		t.Fatalf("renditionsFor = %v", got)
	}
	for i, w := range want {
		if got[i].Width != w[0] || got[i].Height != w[1] {
			t.Errorf("rung %d = %dx%d, want %dx%d", i, got[i].Width, got[i].Height, w[0], w[1])
		}
	}
}

func TestProbedStreamRotation(t *testing.T) {
	ccw := 90.0
	cases := []struct {
		name string
		in   probedStream
		want int
	}{
		{"none", probedStream{}, 0},
		{"display matrix", probedStream{SideData: []struct {
			Rotation *float64 `json:"rotation"`
		}{{Rotation: &ccw}}}, 90},
		{"rotate tag", probedStream{Tags: map[string]string{"rotate": "90"}}, 270},
		{"mkv tag", probedStream{Tags: map[string]string{"ROTATE": "270"}}, 90},
		{"upside down", probedStream{Tags: map[string]string{"rotate": "180"}}, 180},
	}
	for _, c := range cases {
		if got := c.in.rotation(); got != c.want {
			t.Errorf("%s: rotation = %d, want %d", c.name, got, c.want)
		}
	}
}

func dims(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	return strings.Fields(string(out))[0]
}

func TestPipelinePortraitRotation(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	chunkSeconds = 5
	data, scratch := t.TempDir(), t.TempDir()
	key := "uploads/u1/3-portrait.mp4"
	src := filepath.Join(data, filepath.FromSlash(key))
	os.MkdirAll(filepath.Dir(src), 0o755)
	plain := filepath.Join(scratch, "plain.mp4")
	for _, args := range [][]string{
		{"-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=15", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", plain},
		{"-display_rotation", "-90", "-i", plain, "-c", "copy", src},
	} {
		if out, err := exec.Command("ffmpeg", append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("make test video: %v\n%s", err, out)
		}
	}

	ctx, st := context.Background(), dirStore(data)
	tools := Tools{ScratchDir: scratch}
	plan, err := Split(ctx, st, tools, Event{Op: "split", Bucket: "b", VideoKey: key})
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	for _, c := range plan.Chunks {
		if err := Chunk(ctx, st, tools, c); err != nil {
			t.Fatalf("Chunk %d: %v", c.Index, err)
		}
	}
	if err := Assemble(ctx, st, tools, plan); err != nil {
		t.Fatalf("Assemble: %v", err)
	}

	out := filepath.Join(data, "processed", "u1", "3-portrait.mp4")
	master, _ := os.ReadFile(filepath.Join(out, "hls/master.m3u8"))
	for _, res := range []string{"RESOLUTION=1080x1920", "RESOLUTION=720x1280", "RESOLUTION=480x854"} {
		if !strings.Contains(string(master), res) {
			t.Errorf("master playlist missing %s:\n%s", res, master)
		}
	}
	for rung, want := range map[string]string{"1080p": "1080x1920", "720p": "720x1280", "480p": "480x854"} {
		for _, c := range []string{"c0000_0000.ts", "c0002_0000.ts"} {
			if got := dims(t, filepath.Join(out, "hls", rung, c)); got != want {
				t.Errorf("%s/%s is %s, want %s", rung, c, got, want)
			}
		}
	}
	if got := dims(t, filepath.Join(out, "thumbs/thumb_01.jpg")); got != "202x360" {
		t.Errorf("thumbnail is %s, want 202x360", got)
	}
}
