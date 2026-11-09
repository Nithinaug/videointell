package config

import "os"

type Config struct {
	Port         string
	DatabaseURL  string
	DBIAMHost    string
	DBUser       string
	DBName       string
	AWSRegion    string
	CognitoPool  string
	CognitoApp   string
	JWTSecret    string
	LocalDataDir string
	RequireMount bool
	BedrockModel string
}

func Load() Config {
	return Config{
		Port:         getEnv("PORT", "8080"),
		DatabaseURL:  getEnv("DATABASE_URL", "postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable"),
		DBIAMHost:    os.Getenv("DB_IAM_HOST"),
		DBUser:       getEnv("DB_USER", "api"),
		DBName:       getEnv("DB_NAME", "videointell"),
		AWSRegion:    getEnv("AWS_REGION", "ap-south-1"),
		CognitoPool:  os.Getenv("COGNITO_USER_POOL_ID"),
		CognitoApp:   os.Getenv("COGNITO_CLIENT_ID"),
		JWTSecret:    getEnv("JWT_SECRET", "dev-secret-change-me"),
		LocalDataDir: getEnv("LOCAL_DATA_DIR", "./data"),
		RequireMount: getEnv("REQUIRE_MOUNT", "") == "true",
		BedrockModel: getEnv("BEDROCK_MODEL_ID", "apac.amazon.nova-lite-v1:0"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
