package main

import (
	"context"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strconv"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"videointell/backend/internal/worker"
)

var contentTypes = map[string]string{
	".m3u8": "application/vnd.apple.mpegurl",
	".ts":   "video/mp2t",
	".vtt":  "text/vtt",
	".mkv":  "video/x-matroska",
}

type s3Store struct {
	client *s3.Client
	bucket string
}

func (s s3Store) Get(ctx context.Context, key, path string) error {
	obj, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return fmt.Errorf("get s3://%s/%s: %w", s.bucket, key, err)
	}
	defer obj.Body.Close()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, obj.Body)
	return err
}

func (s s3Store) Put(ctx context.Context, key, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	ext := filepath.Ext(path)
	ct, ok := contentTypes[ext]
	if !ok {
		ct = mime.TypeByExtension(ext)
	}
	if _, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: f, ContentType: aws.String(ct)}); err != nil {
		return fmt.Errorf("put s3://%s/%s: %w", s.bucket, key, err)
	}
	return nil
}

func main() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		panic(err)
	}
	client := s3.NewFromConfig(cfg)
	secs, _ := strconv.ParseFloat(os.Getenv("CHUNK_SECONDS"), 64)
	worker.SetChunkSeconds(secs)
	tools := worker.Tools{
		ScratchDir:   os.TempDir(),
		WhisperBin:   "whisper-cli",
		WhisperModel: os.Getenv("WHISPER_MODEL"),
	}

	lambda.Start(func(ctx context.Context, ev worker.Event) (any, error) {
		st := s3Store{client: client, bucket: ev.Bucket}
		switch ev.Op {
		case "split":
			return worker.Split(ctx, st, tools, ev)
		case "chunk":
			return map[string]int{"index": ev.Index}, worker.Chunk(ctx, st, tools, ev)
		case "assemble":
			return map[string]bool{"ok": true}, worker.Assemble(ctx, st, tools, ev)
		}
		return nil, fmt.Errorf("unknown op %q", ev.Op)
	})
}
