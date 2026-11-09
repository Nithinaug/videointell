package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"videointell/backend/internal/storage"
)

const maxTranscriptChars = 300_000

type Config struct {
	VideoKey     string
	Storage      *storage.LocalStorage
	ScratchDir   string
	WhisperBin   string
	WhisperModel string
}

type rendition struct {
	Height  int
	Bitrate int
}

var ladder = []rendition{{1080, 5_000_000}, {720, 2_800_000}, {480, 1_400_000}}

type source struct {
	Width, Height int
	HasAudio      bool
}

func OutputPrefix(videoKey string) (string, error) {
	rest, ok := strings.CutPrefix(videoKey, "uploads/")
	if !ok || rest == "" {
		return "", fmt.Errorf("video key %q is not under uploads/", videoKey)
	}
	return "processed/" + rest + "/", nil
}

func Run(cfg Config) error {
	out, err := OutputPrefix(cfg.VideoKey)
	if err != nil {
		return err
	}
	src, err := cfg.Storage.Path(cfg.VideoKey)
	if err != nil {
		return err
	}
	work, err := os.MkdirTemp(cfg.ScratchDir, "video-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	info, err := probe(src)
	if err != nil {
		return err
	}
	log.Printf("source %dx%d audio=%v", info.Width, info.Height, info.HasAudio)

	steps := []struct {
		name string
		fn   func() error
	}{
		{"hls", func() error { return makeHLS(src, work, info) }},
		{"mp4", func() error { return makeMP4(src, work, info) }},
		{"thumbnails", func() error { return makeThumbnails(src, work) }},
		{"transcript", func() error { return makeTranscript(cfg, src, work, info) }},
		{"bedrock request", func() error { return makeBedrockRequest(work) }},
	}
	for _, s := range steps {
		log.Printf("step: %s", s.name)
		if err := s.fn(); err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
	}

	log.Printf("copying results to %s", out)
	return copyTree(cfg.Storage, work, out)
}

func probe(src string) (source, error) {
	raw, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", src).Output()
	if err != nil {
		return source{}, fmt.Errorf("ffprobe: %w", err)
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return source{}, fmt.Errorf("ffprobe output: %w", err)
	}
	var s source
	for _, st := range parsed.Streams {
		switch st.CodecType {
		case "video":
			if s.Height == 0 {
				s.Width, s.Height = st.Width, st.Height
			}
		case "audio":
			s.HasAudio = true
		}
	}
	if s.Height == 0 {
		return source{}, errors.New("no video stream")
	}
	return s, nil
}

func renditionsFor(srcHeight int) []rendition {
	var out []rendition
	for _, r := range ladder {
		if r.Height <= srcHeight {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		h := srcHeight &^ 1
		out = append(out, rendition{h, ladder[len(ladder)-1].Bitrate * h / ladder[len(ladder)-1].Height})
	}
	return out
}

func evenWidth(s source, height int) int {
	w := s.Width * height / s.Height
	return w + w%2
}

func makeHLS(src, work string, s source) error {
	hls := filepath.Join(work, "hls")
	var master strings.Builder
	master.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n")
	for _, r := range renditionsFor(s.Height) {
		name := fmt.Sprintf("%dp", r.Height)
		dir := filepath.Join(hls, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		err := ffmpeg(
			"-i", src, "-map", "0:v:0", "-map", "0:a:0?",
			"-vf", fmt.Sprintf("scale=-2:%d", r.Height),
			"-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
			"-b:v", strconv.Itoa(r.Bitrate), "-maxrate", strconv.Itoa(r.Bitrate*107/100), "-bufsize", strconv.Itoa(r.Bitrate*3/2),
			"-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
			"-c:a", "aac", "-b:a", "128k", "-ac", "2",
			"-hls_time", "6", "-hls_playlist_type", "vod",
			"-hls_segment_filename", filepath.Join(dir, "seg_%04d.ts"),
			filepath.Join(dir, "index.m3u8"),
		)
		if err != nil {
			return err
		}
		fmt.Fprintf(&master, "#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s/index.m3u8\n",
			r.Bitrate+128_000, evenWidth(s, r.Height), r.Height, name)
	}
	return os.WriteFile(filepath.Join(hls, "master.m3u8"), []byte(master.String()), 0o644)
}

func makeMP4(src, work string, s source) error {
	height := min(720, s.Height&^1)
	return ffmpeg(
		"-i", src, "-map", "0:v:0", "-map", "0:a:0?",
		"-vf", fmt.Sprintf("scale=-2:%d", height),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		"-movflags", "+faststart",
		filepath.Join(work, "video.mp4"),
	)
}

func makeThumbnails(src, work string) error {
	dir := filepath.Join(work, "thumbs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return ffmpeg("-i", src,
		"-vf", "select='isnan(prev_selected_t)+gte(t-prev_selected_t,10)',scale=-2:360",
		"-vsync", "vfr", "-frames:v", "10", filepath.Join(dir, "thumb_%02d.jpg"))
}

func makeTranscript(cfg Config, src, work string, s source) error {
	if !s.HasAudio {
		return writeEmptyTranscript(work)
	}
	wav := filepath.Join(work, "audio.wav")
	if err := ffmpeg("-i", src, "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav); err != nil {
		return err
	}
	defer os.Remove(wav)
	cmd := exec.Command(cfg.WhisperBin, "-m", cfg.WhisperModel, "-f", wav, "-t", strconv.Itoa(runtime.GOMAXPROCS(0)), "-l", "auto", "-oj", "-ovtt", "-of", filepath.Join(work, "transcript"))
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", cfg.WhisperBin, err)
	}
	return nil
}

func writeEmptyTranscript(work string) error {
	if err := os.WriteFile(filepath.Join(work, "transcript.json"), []byte(`{"transcription":[]}`), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(work, "transcript.vtt"), []byte("WEBVTT\n"), 0o644)
}

type whisperOutput struct {
	Transcription []struct {
		Timestamps struct {
			From string `json:"from"`
		} `json:"timestamps"`
		Text string `json:"text"`
	} `json:"transcription"`
}

const bedrockPrompt = `Below is the timestamped transcript of a video. Reply with only a JSON object, no other text:
{"summary": "3-5 sentences", "chapters": [{"start": "HH:MM:SS", "title": "short title"}], "tags": ["5-10 lowercase tags"]}
If the transcript is empty, reply {"summary": "", "chapters": [], "tags": []}.

<transcript>
%s
</transcript>`

func makeBedrockRequest(work string) error {
	raw, err := os.ReadFile(filepath.Join(work, "transcript.json"))
	if err != nil {
		return err
	}
	var w whisperOutput
	if err := json.Unmarshal(raw, &w); err != nil {
		return fmt.Errorf("transcript.json: %w", err)
	}
	var b strings.Builder
	for _, seg := range w.Transcription {
		ts, _, _ := strings.Cut(seg.Timestamps.From, ",")
		fmt.Fprintf(&b, "[%s] %s\n", ts, strings.TrimSpace(seg.Text))
	}
	text := b.String()
	if len(text) > maxTranscriptChars {
		text = text[:maxTranscriptChars]
	}

	body := map[string]any{
		"messages": []map[string]any{{
			"role":    "user",
			"content": []map[string]string{{"text": fmt.Sprintf(bedrockPrompt, text)}},
		}},
		"inferenceConfig": map[string]any{"maxTokens": 2000},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(work, "bedrock-request.json"), encoded, 0o644)
}

func ffmpeg(args ...string) error {
	cmd := exec.Command("ffmpeg", append([]string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}, args...)...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	return nil
}

func copyTree(st *storage.LocalStorage, work, out string) error {
	return filepath.WalkDir(work, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(work, path)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		return st.Write(out+filepath.ToSlash(rel), f)
	})
}
