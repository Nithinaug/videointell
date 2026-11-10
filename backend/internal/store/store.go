package store

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"

	"videointell/backend/internal/models"
)

const videoColumns = "id, user_id, title, original_key, content_type, status, results, created_at, updated_at"

type Store struct {
	db *sqlx.DB
}

func New(db *sqlx.DB) *Store {
	return &Store{db: db}
}

var ErrSignupsFull = errors.New("sign-ups are full")

func (s *Store) UpsertCognitoUser(sub, email string, maxUsers int) (string, error) {
	var id string
	err := s.db.Get(&id, `UPDATE users SET cognito_sub = $2 WHERE email = $1 RETURNING id`, email, sub)
	if !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	err = s.db.Get(&id, `INSERT INTO users (email, cognito_sub)
		SELECT $1, $2 WHERE (SELECT count(*) FROM users) < $3
		ON CONFLICT (email) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
		RETURNING id`, email, sub, maxUsers)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrSignupsFull
	}
	return id, err
}

func (s *Store) CountVideosSince(userID string, since time.Time) (int, error) {
	var n int
	err := s.db.Get(&n, `SELECT count(*) FROM videos WHERE ($1 = '' OR user_id::text = $1) AND created_at > $2`, userID, since)
	return n, err
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
	err := s.db.Select(&videos, `SELECT `+videoColumns+` FROM videos WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	return videos, err
}

func (s *Store) DeleteVideo(id string) error {
	_, err := s.db.Exec(`DELETE FROM videos WHERE id=$1`, id)
	return err
}

func (s *Store) GetVideo(id string) (models.Video, error) {
	var v models.Video
	err := s.db.Get(&v, `SELECT `+videoColumns+` FROM videos WHERE id=$1`, id)
	return v, err
}

func (s *Store) SetVideoStatus(originalKey string, from []string, to string) (bool, error) {
	var changed bool
	err := s.db.Get(&changed, `SELECT set_video_status($1, $2, $3)`, originalKey, pq.Array(from), to)
	return changed, err
}

const (
	shareColumns   = "id, video_id, created_at, expires_at, revoked_at"
	maxActiveShare = 50
)

var ErrTooManyShares = errors.New("too many active share links")

func (s *Store) CreateShare(videoID, tokenHash string, expiresAt time.Time) (models.ShareLink, error) {
	var l models.ShareLink
	err := s.db.Get(&l, `INSERT INTO share_links (video_id, token_hash, expires_at)
		SELECT $1, $2, $3
		WHERE (SELECT count(*) FROM share_links WHERE video_id = $1 AND revoked_at IS NULL AND expires_at > now()) < $4
		RETURNING `+shareColumns, videoID, tokenHash, expiresAt, maxActiveShare)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrTooManyShares
	}
	return l, err
}

func (s *Store) ListShares(videoID string) ([]models.ShareLink, error) {
	links := []models.ShareLink{}
	err := s.db.Select(&links, `SELECT `+shareColumns+` FROM share_links WHERE video_id=$1 ORDER BY created_at DESC`, videoID)
	return links, err
}

func (s *Store) RevokeShare(videoID, shareID string) (bool, error) {
	res, err := s.db.Exec(`UPDATE share_links SET revoked_at = now() WHERE id=$1 AND video_id=$2 AND revoked_at IS NULL`, shareID, videoID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *Store) ShareByHash(tokenHash string) (models.Video, error) {
	var v models.Video
	err := s.db.Get(&v, `SELECT `+prefixed("v.", videoColumns)+` FROM share_links l JOIN videos v ON v.id = l.video_id
		WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now() AND v.status = 'ready'`, tokenHash)
	return v, err
}

func prefixed(p, cols string) string {
	parts := strings.Split(cols, ", ")
	for i := range parts {
		parts[i] = p + parts[i]
	}
	return strings.Join(parts, ", ")
}

const clipColumns = "id, video_id, title, start_ms, end_ms, created_at"

func (s *Store) CreateClip(videoID, title string, startMS, endMS int64) (models.Clip, error) {
	var c models.Clip
	err := s.db.Get(&c, `INSERT INTO clips (video_id, title, start_ms, end_ms) VALUES ($1, $2, $3, $4) RETURNING `+clipColumns, videoID, title, startMS, endMS)
	return c, err
}

func (s *Store) ListClips(videoID string) ([]models.Clip, error) {
	clips := []models.Clip{}
	err := s.db.Select(&clips, `SELECT `+clipColumns+` FROM clips WHERE video_id=$1 ORDER BY start_ms`, videoID)
	return clips, err
}

func (s *Store) DeleteClip(videoID, clipID string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM clips WHERE id=$1 AND video_id=$2`, clipID, videoID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
