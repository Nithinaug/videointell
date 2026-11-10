package worker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

const (
	ExportFile      = "hd.mp4"
	ExportErrorFile = "hd.error"
	ExportMarker    = "hd.working"
)

func ExportSize(width, height int) int {
	if min(width, height) >= 1080 {
		return 1080
	}
	return 720
}

func exportArgs(src, dst string, size int) []string {
	return []string{
		"-i", src,
		"-map", "0:v:0", "-map", "0:a:0?",
		"-vf", fmt.Sprintf("scale=w='if(gt(iw,ih),-2,%d)':h='if(gt(iw,ih),%d,-2)'", size, size),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "160k",
		"-movflags", "+faststart",
		dst,
	}
}

func Export(ctx context.Context, st Store, t Tools, ev Event) error {
	out, err := OutputPrefix(ev.VideoKey)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp(t.ScratchDir, "export-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	if err := export(ctx, st, dir, ev.VideoKey, out); err != nil {
		putString(ctx, st, dir, out+ExportErrorFile, "export failed")
		return err
	}
	return nil
}

func export(ctx context.Context, st Store, dir, videoKey, out string) error {
	src := filepath.Join(dir, "source")
	if err := st.Get(ctx, videoKey, src); err != nil {
		return err
	}
	info, err := probe(src)
	if err != nil {
		return err
	}
	if maxSeconds > 0 && info.Seconds > maxSeconds {
		return fmt.Errorf("video is %.0f minutes; the limit is %.0f", info.Seconds/60, maxSeconds/60)
	}
	dst := filepath.Join(dir, ExportFile)
	if err := ffmpeg(exportArgs(src, dst, ExportSize(info.Width, info.Height))...); err != nil {
		return err
	}
	return st.Put(ctx, out+ExportFile, dst)
}
