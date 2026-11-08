package main

import (
	"log"
	"os"

	"videointell/backend/internal/storage"
	"videointell/backend/internal/worker"
)

func main() {
	dataDir := getEnv("LOCAL_DATA_DIR", "./data")
	if os.Getenv("REQUIRE_MOUNT") == "true" {
		if err := storage.CheckMount(dataDir); err != nil {
			log.Fatalf("storage: %v", err)
		}
	}

	cfg := worker.Config{
		VideoKey:     os.Getenv("VIDEO_KEY"),
		Storage:      storage.NewLocalStorage(dataDir, ""),
		ScratchDir:   getEnv("SCRATCH_DIR", os.TempDir()),
		WhisperBin:   getEnv("WHISPER_BIN", "whisper-cli"),
		WhisperModel: os.Getenv("WHISPER_MODEL"),
	}
	if cfg.VideoKey == "" || cfg.WhisperModel == "" {
		log.Fatal("VIDEO_KEY and WHISPER_MODEL are required")
	}

	log.Printf("processing %s", cfg.VideoKey)
	if err := worker.Run(cfg); err != nil {
		log.Fatalf("worker: %v", err)
	}
	log.Printf("done %s", cfg.VideoKey)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
