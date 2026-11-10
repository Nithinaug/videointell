package main

import (
	"github.com/jmoiron/sqlx"
	"log"

	"videointell/backend/internal/awsapi"
	"videointell/backend/internal/cognito"
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

	if cfg.CognitoPool == "" || cfg.CognitoApp == "" {
		log.Fatal("COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required")
	}
	verifier := cognito.NewVerifier(cfg.AWSRegion, cfg.CognitoPool, cfg.CognitoApp)
	if cfg.RequireMount {
		if err := storage.CheckMount(cfg.LocalDataDir); err != nil {
			log.Fatalf("storage: %v", err)
		}
		if cfg.JWTSecret == "dev-secret-change-me" || len(cfg.JWTSecret) < 32 {
			log.Fatalf("JWT_SECRET must be set to at least 32 random characters when REQUIRE_MOUNT=true")
		}
	}
	local := storage.NewLocalStorage(cfg.LocalDataDir, cfg.JWTSecret)
	maxBytes := cfg.MaxUploadMB << 20
	videoHandler := &handlers.VideoHandler{Store: st, Storage: local, MaxBytes: maxBytes, MaxPerDay: cfg.MaxUploadsPerDay, MaxTotalPerDay: cfg.MaxUploadsTotal}
	files := &handlers.FilesHandler{Store: st, Storage: local, MaxBytes: maxBytes}
	clips := &handlers.ClipHandler{Videos: videoHandler}
	log.Printf("storage: %s", cfg.LocalDataDir)

	r := router.New(router.Deps{
		VideoHandler: videoHandler,
		Files:        files,
		Clips:        clips,
		Shares:       &handlers.ShareHandler{Clips: clips},
		Exports:      handlers.NewExportHandler(clips, awsapi.NewLambda(cfg.AWSRegion), cfg.WorkerFunction, cfg.VideoBucket, cfg.ExportsPerDay, cfg.ExportsTotal),
		Ask:          handlers.NewAskHandler(videoHandler, awsapi.NewBedrock(cfg.AWSRegion, cfg.BedrockModel), cfg.AskPerHour),
		Auth:         handlers.AuthMiddleware(verifier, st, cfg.MaxUsers),
	})

	log.Printf("video-intell API listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
