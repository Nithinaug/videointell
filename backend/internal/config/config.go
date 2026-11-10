package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port             string
	DatabaseURL      string
	DBIAMHost        string
	DBUser           string
	DBName           string
	AWSRegion        string
	CognitoPool      string
	CognitoApp       string
	JWTSecret        string
	LocalDataDir     string
	RequireMount     bool
	BedrockModel     string
	MaxUploadMB      int64
	MaxUploadsPerDay int
	MaxUploadsTotal  int
	AskPerHour       int
	MaxUsers         int
}

func Load() Config {
	return Config{
		Port:             getEnv("PORT", "8080"),
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable"),
		DBIAMHost:        os.Getenv("DB_IAM_HOST"),
		DBUser:           getEnv("DB_USER", "api"),
		DBName:           getEnv("DB_NAME", "videointell"),
		AWSRegion:        getEnv("AWS_REGION", "ap-south-1"),
		CognitoPool:      os.Getenv("COGNITO_USER_POOL_ID"),
		CognitoApp:       os.Getenv("COGNITO_CLIENT_ID"),
		JWTSecret:        getEnv("JWT_SECRET", "dev-secret-change-me"),
		LocalDataDir:     getEnv("LOCAL_DATA_DIR", "./data"),
		RequireMount:     getEnv("REQUIRE_MOUNT", "") == "true",
		BedrockModel:     getEnv("BEDROCK_MODEL_ID", "apac.amazon.nova-lite-v1:0"),
		MaxUploadMB:      int64(getInt("MAX_UPLOAD_MB", 1024)),
		MaxUploadsPerDay: getInt("MAX_UPLOADS_PER_DAY", 3),
		MaxUploadsTotal:  getInt("MAX_UPLOADS_PER_DAY_TOTAL", 30),
		AskPerHour:       getInt("ASK_PER_HOUR", 30),
		MaxUsers:         getInt("MAX_USERS", 100),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil && n > 0 {
		return n
	}
	return fallback
}
