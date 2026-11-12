package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"

	"videointell/backend/internal/config"
	"videointell/backend/internal/db"
	"videointell/backend/internal/worker"
)

const localBucket = "local"

type dirStore struct{ root string }

func (d dirStore) path(key string) (string, error) {
	p := filepath.Join(d.root, filepath.FromSlash(key))
	rel, err := filepath.Rel(d.root, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid key %q", key)
	}
	return p, nil
}

func (d dirStore) Get(_ context.Context, key, dst string) error {
	src, err := d.path(key)
	if err != nil {
		return err
	}
	return copyFile(src, dst)
}

func (d dirStore) Put(_ context.Context, key, src string) error {
	dst, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	if err := copyFile(src, tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func envFloat(name string) float64 {
	v, _ := strconv.ParseFloat(os.Getenv(name), 64)
	return v
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

type runner struct {
	db      *sqlx.DB
	st      dirStore
	tools   worker.Tools
	workers int
}

func (r *runner) setStatus(key string, from []string, to string) error {
	var changed bool
	return r.db.Get(&changed, `SELECT set_video_status($1, $2, $3)`, key, pq.Array(from), to)
}

func (r *runner) setReady(key, prefix string) error {
	var changed bool
	results := fmt.Sprintf(`{"prefix":%q}`, prefix)
	return r.db.Get(&changed, `SELECT set_video_status($1, ARRAY['processing'], 'ready', $2::jsonb)`, key, results)
}

func (r *runner) claim(ctx context.Context) (string, bool, error) {
	var keys []string
	if err := r.db.SelectContext(ctx, &keys, `SELECT original_key FROM videos WHERE status = 'uploaded' ORDER BY created_at LIMIT 5`); err != nil {
		return "", false, err
	}
	for _, k := range keys {
		var won bool
		if err := r.db.GetContext(ctx, &won, `SELECT set_video_status($1, ARRAY['uploaded'], 'processing')`, k); err != nil {
			return "", false, err
		}
		if won {
			return k, true, nil
		}
	}
	return "", false, nil
}

func (r *runner) process(ctx context.Context, key string) error {
	out, err := worker.OutputPrefix(key)
	if err != nil {
		return err
	}
	plan, err := worker.Split(ctx, r.st, r.tools, worker.Event{Op: "split", Bucket: localBucket, VideoKey: key})
	if err != nil {
		return fmt.Errorf("split: %w", err)
	}
	sem := make(chan struct{}, r.workers)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for _, c := range plan.Chunks {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if err := worker.Chunk(ctx, r.st, r.tools, c); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("chunk %d: %w", c.Index, err)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	if err := worker.Assemble(ctx, r.st, r.tools, plan); err != nil {
		return fmt.Errorf("assemble: %w", err)
	}
	if p, err := r.st.path(worker.WorkPrefix(key)); err == nil {
		os.RemoveAll(p)
	}
	return r.setReady(key, out)
}

func (r *runner) processLoop(ctx context.Context, every time.Duration) {
	for ctx.Err() == nil {
		key, ok, err := r.claim(ctx)
		if err != nil {
			log.Printf("claim: %v", err)
		}
		if !ok {
			sleep(ctx, every)
			continue
		}
		log.Printf("processing %s", key)
		start := time.Now()
		if err := r.process(ctx, key); err != nil {
			log.Printf("failed %s: %v", key, err)
			if err := r.setStatus(key, []string{"uploaded", "processing"}, "failed"); err != nil {
				log.Printf("mark failed %s: %v", key, err)
			}
			continue
		}
		log.Printf("ready %s in %s", key, time.Since(start).Round(time.Second))
	}
}

func (r *runner) exportLoop(ctx context.Context, every time.Duration) {
	for ctx.Err() == nil {
		var keys []string
		if err := r.db.SelectContext(ctx, &keys, `SELECT original_key FROM videos WHERE status = 'ready'`); err != nil {
			log.Printf("export scan: %v", err)
		}
		for _, k := range keys {
			out, err := worker.OutputPrefix(k)
			if err != nil {
				continue
			}
			marker, err1 := r.st.path(out + worker.ExportMarker)
			done, err2 := r.st.path(out + worker.ExportFile)
			failed, err3 := r.st.path(out + worker.ExportErrorFile)
			if err1 != nil || err2 != nil || err3 != nil {
				continue
			}
			if !exists(marker) || exists(done) || exists(failed) {
				continue
			}
			log.Printf("exporting %s", k)
			if err := worker.Export(ctx, r.st, r.tools, worker.Event{Op: "export", Bucket: localBucket, VideoKey: k}); err != nil {
				log.Printf("export failed %s: %v", k, err)
			}
		}
		sleep(ctx, every)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func main() {
	cfg := config.Load()
	dbx, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	if err := db.RunMigrations(dbx); err != nil {
		log.Fatalf("migrations: %v", err)
	}

	worker.SetChunkSeconds(envFloat("CHUNK_SECONDS"))
	worker.SetMaxMinutes(envFloat("MAX_VIDEO_MINUTES"))
	workers := int(envFloat("WORKER_CONCURRENCY"))
	if workers < 1 {
		workers = 2
	}
	r := &runner{
		db:      dbx,
		st:      dirStore{root: cfg.LocalDataDir},
		workers: workers,
		tools: worker.Tools{
			ScratchDir:   os.TempDir(),
			WhisperBin:   "whisper-cli",
			WhisperModel: os.Getenv("WHISPER_MODEL"),
			TesseractBin: os.Getenv("TESSERACT_BIN"),
		},
	}

	if _, err := dbx.Exec(`UPDATE videos SET status = 'uploaded' WHERE status = 'processing'`); err != nil {
		log.Fatalf("requeue: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("local worker watching %s", cfg.LocalDataDir)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); r.processLoop(ctx, 3*time.Second) }()
	go func() { defer wg.Done(); r.exportLoop(ctx, 3*time.Second) }()
	wg.Wait()
}
