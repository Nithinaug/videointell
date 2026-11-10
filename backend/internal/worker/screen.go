package worker

import (
	"context"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

const screenEverySeconds = 3

type ScreenText struct {
	FromMS int64  `json:"from_ms"`
	Text   string `json:"text"`
}

const minWordConfidence = 70

func cleanOCR(raw string) string {
	var keep []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		n := 0
		for _, r := range line {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				n++
			}
		}
		if n >= 3 && n*2 >= len([]rune(line)) {
			keep = append(keep, line)
		}
	}
	return strings.Join(keep, " ")
}

func confidentText(tsv string) string {
	var lines []string
	var cur []string
	lastLine := ""
	for i, row := range strings.Split(tsv, "\n") {
		f := strings.Split(row, "\t")
		if i == 0 || len(f) < 12 {
			continue
		}
		key := f[2] + "/" + f[3] + "/" + f[4]
		if key != lastLine && len(cur) > 0 {
			lines = append(lines, strings.Join(cur, " "))
			cur = nil
		}
		lastLine = key
		conf, err := strconv.ParseFloat(f[10], 64)
		if word := strings.TrimSpace(f[11]); err == nil && conf >= minWordConfidence && word != "" {
			cur = append(cur, word)
		}
	}
	if len(cur) > 0 {
		lines = append(lines, strings.Join(cur, " "))
	}
	return cleanOCR(strings.Join(lines, "\n"))
}

func wordSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(strings.ToLower(s)) {
		m[w] = true
	}
	return m
}

func similar(a, b string) bool {
	x, y := wordSet(a), wordSet(b)
	if len(x) == 0 || len(y) == 0 {
		return len(x) == len(y)
	}
	shared := 0
	for w := range x {
		if y[w] {
			shared++
		}
	}
	return float64(shared) >= 0.7*float64(len(x)+len(y)-shared)
}

func dedupeScreen(in []ScreenText) []ScreenText {
	out := []ScreenText{}
	for _, s := range in {
		if s.Text == "" || len(out) > 0 && similar(out[len(out)-1].Text, s.Text) {
			continue
		}
		out = append(out, s)
	}
	return out
}

func readScreen(t Tools, src, dir string, ev Event) ([]ScreenText, error) {
	var out []ScreenText
	end := ev.Start + ev.Duration
	for k := int(math.Ceil(ev.Start / screenEverySeconds)); float64(k*screenEverySeconds) < end; k++ {
		at := float64(k * screenEverySeconds)
		frame := filepath.Join(dir, "screen.png")
		offset := strconv.FormatFloat(max(0, min(at-ev.Start, ev.Duration-0.25)), 'f', 3, 64)
		if err := ffmpeg("-noautorotate", "-ss", offset, "-i", src, "-frames:v", "1", "-vf", rotateFilter(ev.Rotation)+"scale='min(1600,iw)':-2,format=gray", frame); err != nil {
			return nil, err
		}
		raw, err := exec.Command(t.TesseractBin, frame, "stdout", "-l", "eng", "--psm", "3", "tsv").Output()
		if err != nil {
			return nil, fmt.Errorf("tesseract: %w", err)
		}
		out = append(out, ScreenText{int64(math.Round(at * 1000)), confidentText(string(raw))})
	}
	return dedupeScreen(out), nil
}

func screenWork(work string, index int) string {
	return fmt.Sprintf("%sscreen_%04d.json", work, index)
}

func collectScreen(ctx context.Context, st Store, dir, work string, chunks []Event) []ScreenText {
	var all []ScreenText
	for _, c := range chunks {
		local := filepath.Join(dir, "screen-part.json")
		var part []ScreenText
		if st.Get(ctx, screenWork(work, c.Index), local) != nil || readJSON(local, &part) != nil {
			continue
		}
		all = append(all, part...)
	}
	return dedupeScreen(all)
}
