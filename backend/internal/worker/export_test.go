package worker

import (
	"slices"
	"testing"
)

func TestExportSize(t *testing.T) {
	for _, c := range []struct{ w, h, want int }{
		{426, 240, 720}, {1280, 720, 720}, {1600, 900, 720}, {1920, 1080, 1080}, {3840, 2160, 1080},
		{1080, 1920, 1080}, {720, 1280, 720}, {1080, 1080, 1080},
	} {
		if got := ExportSize(c.w, c.h); got != c.want {
			t.Errorf("ExportSize(%d, %d) = %d, want %d", c.w, c.h, got, c.want)
		}
	}
}

func TestExportArgs(t *testing.T) {
	args := exportArgs("in", "out.mp4", 720)
	for _, want := range []string{"scale=w='if(gt(iw,ih),-2,720)':h='if(gt(iw,ih),720,-2)'", "libx264", "+faststart", "0:a:0?"} {
		if !slices.Contains(args, want) {
			t.Errorf("args missing %q: %v", want, args)
		}
	}
	if args[len(args)-1] != "out.mp4" {
		t.Errorf("last arg = %q", args[len(args)-1])
	}
}
