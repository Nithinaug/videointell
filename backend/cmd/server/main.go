package main

import (
	"github.com/jmoiron/sqlx"
	"log"

	"videointell/backend/internal/config"
	"videointell/backend/internal/db"
	"videointell/backend/internal/handlers"
	"videointell/backend/internal/router"
	"videointell/backend/internal/storage"
	"videointell/backend/internal/store"
)

func main() {
	cfg := config.Load()

	var dbx *sqlx.DB
	var err error
	if cfg.DBIAMHost != "" {
		dbx, err = db.ConnectIAM(cfg.DBIAMHost, cfg.AWSRegion, cfg.DBUser, cfg.DBName)
	} else {
		dbx, err = db.Connect(cfg.DatabaseURL)
	}
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	if err := db.RunMigrations(dbx); err != nil {
		log.Fatalf("migrations: %v", err)
	}
	st := store.New(dbx)

	authHandler := &handlers.AuthHandler{Store: st, JWTSecret: cfg.JWTSecret}
	if cfg.RequireMount {
		if err := storage.CheckMount(cfg.LocalDataDir); err != nil {
			log.Fatalf("storage: %v", err)
		}
	}
	local := storage.NewLocalStorage(cfg.LocalDataDir, cfg.JWTSecret)
	videoHandler := &handlers.VideoHandler{Store: st, Storage: local}
	files := &handlers.FilesHandler{Store: st, Storage: local}
	log.Printf("storage: %s", cfg.LocalDataDir)

	r := router.New(router.Deps{
		AuthHandler:  authHandler,
		VideoHandler: videoHandler,
		Files:        files,
		JWTSecret:    cfg.JWTSecret,
	})

	log.Printf("video-intell API listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
