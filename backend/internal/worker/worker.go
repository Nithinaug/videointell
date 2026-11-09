package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	maxTranscriptChars = 300_000
	thumbEverySeconds  = 10
)

var chunkSeconds = 60.0

func SetChunkSeconds(v float64) {
	if v > 0 {
		chunkSeconds = v
	}
}

type Store interface {
	Get(ctx context.Context, key, path string) error
	Put(ctx context.Context, key, path string) error
}

type Tools struct {
	ScratchDir   string
	WhisperBin   string
	WhisperModel string
}

type Rendition struct {
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Bitrate int    `json:"bitrate"`
}

type Event struct {
	Op         string      `json:"op"`
	Bucket     string      `json:"bucket"`
	VideoKey   string      `json:"videoKey"`
	Index      int         `json:"index"`
	Start      float64     `json:"start"`
	Duration   float64     `json:"duration"`
	HasAudio   bool        `json:"hasAudio"`
	Renditions []Rendition `json:"renditions,omitempty"`
	Chunks     []Event     `json:"chunks,omitempty"`
}

var ladder = []Rendition{{Height: 1080, Bitrate: 5_000_000}, {Height: 720, Bitrate: 2_800_000}, {Height: 480, Bitrate: 1_400_000}}

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

func WorkPrefix(videoKey string) string {
	return "work/" + strings.TrimPrefix(videoKey, "uploads/") + "/"
}

func Split(ctx context.Context, st Store, t Tools, ev Event) (Event, error) {
	if _, err := OutputPrefix(ev.VideoKey); err != nil {
		return Event{}, err
	}
	dir, err := os.MkdirTemp(t.ScratchDir, "split-")
	if err != nil {
		return Event{}, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source")
	if err := st.Get(ctx, ev.VideoKey, src); err != nil {
		return Event{}, err
	}
	info, err := probe(src)
	if err != nil {
		return Event{}, err
	}
	list := filepath.Join(dir, "chunks.csv")
	err = ffmpeg("-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
		"-f", "segment", "-segment_time", strconv.FormatFloat(chunkSeconds, 'f', -1, 64),
		"-segment_format", "matroska", "-reset_timestamps", "1",
		"-segment_list", list, "-segment_list_type", "csv",
		filepath.Join(dir, "chunk_%04d.mkv"))
	if err != nil {
		return Event{}, err
	}

	f, err := os.Open(list)
	if err != nil {
		return Event{}, err
	}
	defer f.Close()
	out := Event{Op: "assemble", Bucket: ev.Bucket, VideoKey: ev.VideoKey, HasAudio: info.HasAudio, Renditions: renditionsFor(info)}
	sc := bufio.NewScanner(f)
	for i := 0; sc.Scan(); i++ {
		fields := strings.Split(sc.Text(), ",")
		if len(fields) != 3 {
			return Event{}, fmt.Errorf("segment list line %q", sc.Text())
		}
		start, _ := strconv.ParseFloat(fields[1], 64)
		end, _ := strconv.ParseFloat(fields[2], 64)
		if err := st.Put(ctx, WorkPrefix(ev.VideoKey)+fields[0], filepath.Join(dir, fields[0])); err != nil {
			return Event{}, err
		}
		out.Chunks = append(out.Chunks, Event{
			Op: "chunk", Bucket: ev.Bucket, VideoKey: ev.VideoKey, Index: i,
			Start: start, Duration: end - start, HasAudio: info.HasAudio, Renditions: out.Renditions,
		})
	}
	if err := sc.Err(); err != nil {
		return Event{}, err
	}
	if len(out.Chunks) == 0 {
		return Event{}, errors.New("no chunks made")
	}
	progress := fmt.Sprintf(`{"chunks":%d}`, len(out.Chunks))
	outPrefix, _ := OutputPrefix(ev.VideoKey)
	return out, putString(ctx, st, dir, outPrefix+"progress.json", progress)
}

func Chunk(ctx context.Context, st Store, t Tools, ev Event) error {
	outPrefix, err := OutputPrefix(ev.VideoKey)
	if err != nil {
		return err
	}
	work := WorkPrefix(ev.VideoKey)
	dir, err := os.MkdirTemp(t.ScratchDir, "chunk-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "chunk.mkv")
	if err := st.Get(ctx, fmt.Sprintf("%schunk_%04d.mkv", work, ev.Index), src); err != nil {
		return err
	}

	for _, r := range ev.Renditions {
		rdir := filepath.Join(dir, r.Name)
		if err := os.MkdirAll(rdir, 0o755); err != nil {
			return err
		}
		playlist := filepath.Join(rdir, "index.m3u8")
		err := ffmpeg(
			"-i", src, "-map", "0:v:0", "-map", "0:a:0?",
			"-vf", fmt.Sprintf("scale=-2:%d", r.Height),
			"-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
			"-b:v", strconv.Itoa(r.Bitrate), "-maxrate", strconv.Itoa(r.Bitrate*107/100), "-bufsize", strconv.Itoa(r.Bitrate*3/2),
			"-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
			"-c:a", "aac", "-b:a", "128k", "-ac", "2",
			"-hls_time", "6", "-hls_playlist_type", "vod",
			"-hls_segment_filename", filepath.Join(rdir, fmt.Sprintf("c%04d_%%04d.ts", ev.Index)),
			playlist,
		)
		if err != nil {
			return err
		}
		segs, _ := filepath.Glob(filepath.Join(rdir, "*.ts"))
		for _, s := range segs {
			if err := st.Put(ctx, outPrefix+"hls/"+r.Name+"/"+filepath.Base(s), s); err != nil {
				return err
			}
		}
		if err := st.Put(ctx, fmt.Sprintf("%shls_%04d_%s.m3u8", work, ev.Index, r.Name), playlist); err != nil {
			return err
		}
	}

	end := ev.Start + ev.Duration
	for k := int(math.Ceil(ev.Start / thumbEverySeconds)); float64(k*thumbEverySeconds) < end; k++ {
		thumb := filepath.Join(dir, fmt.Sprintf("thumb_%02d.jpg", k+1))
		offset := strconv.FormatFloat(max(0, min(float64(k*thumbEverySeconds)-ev.Start, ev.Duration-0.25)), 'f', 3, 64)
		if err := ffmpeg("-ss", offset, "-i", src, "-frames:v", "1", "-vf", "scale=-2:360", thumb); err != nil {
			return err
		}
		if err := st.Put(ctx, outPrefix+"thumbs/"+filepath.Base(thumb), thumb); err != nil {
			return err
		}
	}

	if ev.HasAudio {
		segments, err := transcribe(t, src, dir)
		if err != nil {
			return err
		}
		shift := int64(math.Round(ev.Start * 1000))
		for i := range segments {
			segments[i].FromMS += shift
			segments[i].ToMS += shift
		}
		path := filepath.Join(dir, "transcript.json")
		if err := writeJSON(path, segments); err != nil {
			return err
		}
		if err := st.Put(ctx, fmt.Sprintf("%stranscript_%04d.json", work, ev.Index), path); err != nil {
			return err
		}
	}
	return putString(ctx, st, dir, fmt.Sprintf("%sdone_%04d", work, ev.Index), "")
}

func Assemble(ctx context.Context, st Store, t Tools, ev Event) error {
	outPrefix, err := OutputPrefix(ev.VideoKey)
	if err != nil {
		return err
	}
	work := WorkPrefix(ev.VideoKey)
	dir, err := os.MkdirTemp(t.ScratchDir, "assemble-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	var master strings.Builder
	master.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n")
	for _, r := range ev.Renditions {
		var body strings.Builder
		target := 1
		for _, c := range ev.Chunks {
			local := filepath.Join(dir, "part.m3u8")
			if err := st.Get(ctx, fmt.Sprintf("%shls_%04d_%s.m3u8", work, c.Index, r.Name), local); err != nil {
				return err
			}
			raw, err := os.ReadFile(local)
			if err != nil {
				return err
			}
			if c.Index > 0 {
				body.WriteString("#EXT-X-DISCONTINUITY\n")
			}
			lines := strings.Split(string(raw), "\n")
			for i := 0; i+1 < len(lines); i++ {
				d, ok := strings.CutPrefix(lines[i], "#EXTINF:")
				if !ok {
					continue
				}
				secs, _ := strconv.ParseFloat(strings.TrimSuffix(d, ","), 64)
				target = max(target, int(math.Ceil(secs)))
				fmt.Fprintf(&body, "%s\n%s\n", lines[i], strings.TrimSpace(lines[i+1]))
				i++
			}
		}
		playlist := fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:0\n%s#EXT-X-ENDLIST\n", target, body.String())
		if err := putString(ctx, st, dir, outPrefix+"hls/"+r.Name+"/index.m3u8", playlist); err != nil {
			return err
		}
		fmt.Fprintf(&master, "#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s/index.m3u8\n", r.Bitrate+128_000, r.Width, r.Height, r.Name)
	}
	if err := putString(ctx, st, dir, outPrefix+"hls/master.m3u8", master.String()); err != nil {
		return err
	}

	var segments []segment
	if ev.HasAudio {
		for _, c := range ev.Chunks {
			local := filepath.Join(dir, "part.json")
			if err := st.Get(ctx, fmt.Sprintf("%stranscript_%04d.json", work, c.Index), local); err != nil {
				return err
			}
			var part []segment
			if err := readJSON(local, &part); err != nil {
				return err
			}
			segments = append(segments, part...)
		}
	}

	transcript := map[string]any{"segments": segments}
	if segments == nil {
		transcript["segments"] = []segment{}
	}
	tj, _ := json.Marshal(transcript)
	if err := putString(ctx, st, dir, outPrefix+"transcript.json", string(tj)); err != nil {
		return err
	}
	if err := putString(ctx, st, dir, outPrefix+"transcript.vtt", vtt(segments)); err != nil {
		return err
	}
	req, err := bedrockRequest(segments)
	if err != nil {
		return err
	}
	return putString(ctx, st, dir, outPrefix+"bedrock-request.json", string(req))
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

func renditionsFor(s source) []Rendition {
	var out []Rendition
	for _, r := range ladder {
		if r.Height <= s.Height {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		h := s.Height &^ 1
		last := ladder[len(ladder)-1]
		out = append(out, Rendition{Height: h, Bitrate: last.Bitrate * h / last.Height})
	}
	for i := range out {
		out[i].Name = fmt.Sprintf("%dp", out[i].Height)
		w := s.Width * out[i].Height / s.Height
		out[i].Width = w + w%2
	}
	return out
}

type segment struct {
	FromMS int64  `json:"from_ms"`
	ToMS   int64  `json:"to_ms"`
	Text   string `json:"text"`
}

func transcribe(t Tools, src, dir string) ([]segment, error) {
	wav := filepath.Join(dir, "audio.wav")
	if err := ffmpeg("-i", src, "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav); err != nil {
		return nil, err
	}
	base := filepath.Join(dir, "whisper")
	cmd := exec.Command(t.WhisperBin, "-m", t.WhisperModel, "-f", wav, "-t", strconv.Itoa(runtime.GOMAXPROCS(0)), "-l", "auto", "-oj", "-of", base)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s: %w", t.WhisperBin, err)
	}
	var w struct {
		Transcription []struct {
			Offsets struct {
				From int64 `json:"from"`
				To   int64 `json:"to"`
			} `json:"offsets"`
			Text string `json:"text"`
		} `json:"transcription"`
	}
	if err := readJSON(base+".json", &w); err != nil {
		return nil, fmt.Errorf("whisper output: %w", err)
	}
	segments := []segment{}
	for _, s := range w.Transcription {
		if text := strings.TrimSpace(s.Text); text != "" {
			segments = append(segments, segment{s.Offsets.From, s.Offsets.To, text})
		}
	}
	return segments, nil
}

func clock(ms int64, sep string) string {
	return fmt.Sprintf("%02d:%02d:%02d%s%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, sep, ms%1000)
}

func vtt(segments []segment) string {
	var b strings.Builder
	b.WriteString("WEBVTT\n")
	for _, s := range segments {
		fmt.Fprintf(&b, "\n%s --> %s\n%s\n", clock(s.FromMS, "."), clock(s.ToMS, "."), s.Text)
	}
	return b.String()
}

const bedrockPrompt = `Below is the timestamped transcript of a video. Reply with only a JSON object, no other text:
{"summary": "3-5 sentences", "chapters": [{"start": "HH:MM:SS", "title": "short title"}], "tags": ["5-10 lowercase tags"]}
If the transcript is empty, reply {"summary": "", "chapters": [], "tags": []}.

<transcript>
%s
</transcript>`

func bedrockRequest(segments []segment) ([]byte, error) {
	var b strings.Builder
	for _, s := range segments {
		fmt.Fprintf(&b, "[%s] %s\n", clock(s.FromMS, ",")[:8], s.Text)
	}
	text := b.String()
	if len(text) > maxTranscriptChars {
		text = text[:maxTranscriptChars]
	}
	return json.Marshal(map[string]any{
		"messages": []map[string]any{{
			"role":    "user",
			"content": []map[string]string{{"text": fmt.Sprintf(bedrockPrompt, text)}},
		}},
		"inferenceConfig": map[string]any{"maxTokens": 2000},
	})
}

func ffmpeg(args ...string) error {
	cmd := exec.Command("ffmpeg", append([]string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}, args...)...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	return nil
}

func putString(ctx context.Context, st Store, dir, key, body string) error {
	path := filepath.Join(dir, filepath.Base(key))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return err
	}
	return st.Put(ctx, key, path)
}

func writeJSON(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}
