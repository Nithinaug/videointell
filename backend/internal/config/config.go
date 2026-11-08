package config

import "os"

type Config struct {
	Port         string
	DatabaseURL  string
	JWTSecret    string
	LocalDataDir string
	RequireMount bool
}

func Load() Config {
	return Config{
		Port:         getEnv("PORT", "8080"),
		DatabaseURL:  getEnv("DATABASE_URL", "postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable"),
		JWTSecret:    getEnv("JWT_SECRET", "dev-secret-change-me"),
		LocalDataDir: getEnv("LOCAL_DATA_DIR", "./data"),
		RequireMount: getEnv("REQUIRE_MOUNT", "") == "true",
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
