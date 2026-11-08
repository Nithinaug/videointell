package storage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	uploadURLTTL   = 15 * time.Minute
	playbackURLTTL = time.Hour
	filesPrefix    = "/api/files/"
)

var ErrBadSignature = errors.New("invalid or expired signature")

type LocalStorage struct {
	DataDir string
	secret  []byte
}

func NewLocalStorage(dataDir, secret string) *LocalStorage {
	os.MkdirAll(dataDir, 0o755)
	return &LocalStorage{DataDir: dataDir, secret: []byte("files:" + secret)}
}

func (l *LocalStorage) UploadURL(key string) string {
	return l.signedURL("PUT", key, time.Now().Add(uploadURLTTL))
}

func (l *LocalStorage) PlaybackURL(key string) string {
	return l.signedURL("GET", key, time.Now().Add(playbackURLTTL))
}

func (l *LocalStorage) Verify(method, key, exp, sig string) error {
	expUnix, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || time.Now().Unix() > expUnix {
		return ErrBadSignature
	}
	want := l.sign(method, key, expUnix)
	if !hmac.Equal([]byte(sig), []byte(want)) {
		return ErrBadSignature
	}
	return nil
}

func (l *LocalStorage) Write(key string, body io.Reader) error {
	path, err := l.Path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, body); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return err
	}
	return nil
}

func (l *LocalStorage) Path(key string) (string, error) {
	path := filepath.Join(l.DataDir, filepath.FromSlash(key))
	rel, err := filepath.Rel(l.DataDir, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid key %q", key)
	}
	return path, nil
}

func (l *LocalStorage) signedURL(method, key string, exp time.Time) string {
	q := url.Values{}
	q.Set("exp", strconv.FormatInt(exp.Unix(), 10))
	q.Set("sig", l.sign(method, key, exp.Unix()))
	return filesPrefix + (&url.URL{Path: key}).EscapedPath() + "?" + q.Encode()
}

func (l *LocalStorage) sign(method, key string, exp int64) string {
	m := hmac.New(sha256.New, l.secret)
	fmt.Fprintf(m, "%s\n%s\n%d", method, key, exp)
	return hex.EncodeToString(m.Sum(nil))
}
