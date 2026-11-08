package store

import (
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"

	"videointell/backend/internal/models"
)

var ErrEmailTaken = errors.New("email already registered")

type Store struct {
	db *sqlx.DB
}

func New(db *sqlx.DB) *Store {
	return &Store{db: db}
}

func (s *Store) CreateUser(email, passwordHash string) (models.User, error) {
	u := models.User{ID: uuid.NewString(), Email: email, PasswordHash: passwordHash}
	_, err := s.db.Exec(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, u.ID, u.Email, u.PasswordHash)
	var pqErr *pq.Error
	if errors.As(err, &pqErr) && pqErr.Code == "23505" {
		return u, ErrEmailTaken
	}
	return u, err
}

func (s *Store) GetUserByEmail(email string) (models.User, error) {
	var u models.User
	err := s.db.Get(&u, `SELECT * FROM users WHERE email=$1`, email)
	return u, err
}

func (s *Store) GetUserByID(id string) (models.User, error) {
	var u models.User
	err := s.db.Get(&u, `SELECT * FROM users WHERE id=$1`, id)
	return u, err
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
