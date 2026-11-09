package store

import (
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"

	"videointell/backend/internal/models"
)

type Store struct {
	db *sqlx.DB
}

func New(db *sqlx.DB) *Store {
	return &Store{db: db}
}

func (s *Store) UpsertCognitoUser(sub, email string) (string, error) {
	var id string
	err := s.db.Get(&id, `INSERT INTO users (email, cognito_sub) VALUES ($1, $2)
		ON CONFLICT (email) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
		RETURNING id`, email, sub)
	return id, err
}

func (s *Store) CreateVideo(userID, title, originalKey, contentType string) (models.Video, error) {
	v := models.Video{
		ID:          uuid.NewString(),
		UserID:      userID,
		Title:       title,
		OriginalKey: originalKey,
		ContentType: contentType,
		Status:      "uploading",
	}
	_, err := s.db.Exec(
		`INSERT INTO videos (id, user_id, title, original_key, content_type, status) VALUES ($1,$2,$3,$4,$5,$6)`,
		v.ID, v.UserID, v.Title, v.OriginalKey, v.ContentType, v.Status,
	)
	return v, err
}

func (s *Store) ListVideosForUser(userID string) ([]models.Video, error) {
	videos := []models.Video{}
	err := s.db.Select(&videos, `SELECT * FROM videos WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	return videos, err
}

func (s *Store) DeleteVideo(id string) error {
	_, err := s.db.Exec(`DELETE FROM videos WHERE id=$1`, id)
	return err
}

func (s *Store) GetVideo(id string) (models.Video, error) {
	var v models.Video
	err := s.db.Get(&v, `SELECT * FROM videos WHERE id=$1`, id)
	return v, err
}

func (s *Store) SetVideoStatus(originalKey string, from []string, to string) (bool, error) {
	var changed bool
	err := s.db.Get(&changed, `SELECT set_video_status($1, $2, $3)`, originalKey, pq.Array(from), to)
	return changed, err
}
