package models

import (
	"time"

	"github.com/jmoiron/sqlx/types"
)

type User struct {
	ID           string    `db:"id" json:"id"`
	Email        string    `db:"email" json:"email"`
	PasswordHash string    `db:"password_hash" json:"-"`
	CreatedAt    time.Time `db:"created_at" json:"created_at"`
}

type Video struct {
	ID          string             `db:"id" json:"id"`
	UserID      string             `db:"user_id" json:"user_id"`
	Title       string             `db:"title" json:"title"`
	OriginalKey string             `db:"original_key" json:"-"`
	ContentType string             `db:"content_type" json:"content_type"`
	Status      string             `db:"status" json:"status"`
	Results     types.NullJSONText `db:"results" json:"-"`
	CreatedAt   time.Time          `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time          `db:"updated_at" json:"updated_at"`
}

type VideoDetail struct {
	Video      Video  `json:"video"`
	URL        string `json:"url,omitempty"`
	ResultsURL string `json:"results_url,omitempty"`
}
