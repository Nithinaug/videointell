package worker

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanOCR(t *testing.T) {
	got := cleanOCR("  Error:   ECONNREFUSED  \n|| ~ ;\nab\n\n npm run dev \n")
	if got != "Error: ECONNREFUSED npm run dev" {
		t.Fatalf("cleanOCR = %q", got)
	}
}

func TestDedupeScreen(t *testing.T) {
	got := dedupeScreen([]ScreenText{{0, "a b c"}, {3000, "a b c"}, {6000, ""}, {9000, "next"}, {12000, "a b c"}})
	if len(got) != 3 || got[1].Text != "next" || got[2].FromMS != 12000 {
		t.Fatalf("dedupe = %+v", got)
	}
}

func TestReadScreenFindsText(t *testing.T) {
	bin, err := exec.LookPath("tesseract")
	if err != nil {
		t.Skip("tesseract not installed")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "clip.mp4")
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=white:size=1280x720:rate=10:duration=4",
		"-vf", "drawtext=text='ECONNREFUSED on port 5432':fontsize=64:fontcolor=black:x=80:y=300",
		"-c:v", "libx264", "-preset", "ultrafast", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg drawtext unavailable: %v %s", err, out)
	}
	got, err := readScreen(Tools{TesseractBin: bin}, src, dir, Event{Start: 0, Duration: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].FromMS != 0 || !strings.Contains(got[0].Text, "ECONNREFUSED") {
		t.Fatalf("screen = %+v", got)
	}
	os.Remove(src)
}

func TestConfidentText(t *testing.T) {
	tsv := "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
		"5\t1\t1\t1\t1\t1\t0\t0\t0\t0\t95\tRoot\n" +
		"5\t1\t1\t1\t1\t2\t0\t0\t0\t0\t91\tcause\n" +
		"5\t1\t1\t1\t1\t3\t0\t0\t0\t0\t20\tsiavcatae\n" +
		"5\t1\t1\t1\t2\t1\t0\t0\t0\t0\t88\tcheckout.py:42\n"
	if got := confidentText(tsv); got != "Root cause checkout.py:42" {
		t.Fatalf("confidentText = %q", got)
	}
}

func TestSimilarFramesCollapse(t *testing.T) {
	got := dedupeScreen([]ScreenText{
		{0, "DevOps Autopilot Monitor Diagnose Fix Waiting 14.0%"},
		{3000, "DevOps Autopilot Monitor Diagnose Fix Waiting 35.0%"},
		{6000, "Root cause found api/checkout.py:42 DevOps"},
	})
	if len(got) != 2 || got[1].FromMS != 6000 {
		t.Fatalf("dedupe = %+v", got)
	}
}
