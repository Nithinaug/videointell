package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/models"
	"videointell/backend/internal/storage"
)

func TestAllowShareKey(t *testing.T) {
	for _, ok := range []string{"summary.json", "transcript.json", "transcript.vtt", "screen.json", "thumbs/thumb_03.jpg", "hls/master.m3u8", "hls/720p/index.m3u8", "hls/720p/c0001_0002.ts"} {
		if !allowShareKey(ok) {
			t.Errorf("%s should be allowed", ok)
		}
	}
	for _, bad := range []string{"bedrock-request.json", "progress.json", "labels.json", "hls", "hls/", "hls/720p/", "thumbs/", "../x", "hls/720p/../../bedrock-request.json", "video.mp4"} {
		if allowShareKey(bad) {
			t.Errorf("%s should be refused", bad)
		}
	}
}

func TestShareState(t *testing.T) {
	now := time.Now()
	gone := now.Add(-time.Hour)
	if s := shareState(models.ShareLink{ExpiresAt: now.Add(time.Hour)}, now); s != "active" {
		t.Errorf("active = %s", s)
	}
	if s := shareState(models.ShareLink{ExpiresAt: gone}, now); s != "expired" {
		t.Errorf("expired = %s", s)
	}
	if s := shareState(models.ShareLink{ExpiresAt: now.Add(time.Hour), RevokedAt: &gone}, now); s != "revoked" {
		t.Errorf("revoked = %s", s)
	}
}

func TestShareFileScopeAndAllowlist(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	st := storage.NewLocalStorage(dir, "secret")
	prefix := "processed/u1/v1/"
	for _, f := range []string{"summary.json", "bedrock-request.json", "progress.json", "hls/720p/c0000_0000.ts"} {
		p := filepath.Join(dir, prefix, f)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("x"), 0o644)
	}
	os.MkdirAll(filepath.Join(dir, prefix, "hls", "720p", "c9_9.ts"), 0o755)
	h := &FilesHandler{Storage: st}
	r := gin.New()
	r.GET("/api/share-files/:exp/:sig/*key", h.ShareFile)
	r.GET("/api/results/:exp/:sig/*key", h.Result)

	share, _ := st.ShareDirURL(prefix)
	owner := st.DirURL(prefix)
	get := func(u string) int {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, u, nil))
		return w.Code
	}
	if c := get(share + "summary.json"); c != http.StatusOK {
		t.Errorf("summary = %d", c)
	}
	if c := get(share + "hls/720p/c0000_0000.ts"); c != http.StatusOK {
		t.Errorf("segment = %d", c)
	}
	for _, f := range []string{"bedrock-request.json", "progress.json", "hls/720p/c9_9.ts"} {
		if c := get(share + f); c != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", f, c)
		}
	}
	if c := get(strings.Replace(owner, "/api/results/", "/api/share-files/", 1) + "summary.json"); c != http.StatusForbidden {
		t.Errorf("owner URL on share route = %d, want 403", c)
	}
	if c := get(strings.Replace(share, "/api/share-files/", "/api/results/", 1) + "summary.json"); c != http.StatusForbidden {
		t.Errorf("share URL on owner route = %d, want 403", c)
	}
	if c := get(owner + "bedrock-request.json"); c != http.StatusOK {
		t.Errorf("owner can still read bedrock-request.json: %d", c)
	}
	if hashToken("abc") == hashToken("abd") || len(hashToken("abc")) != 64 {
		t.Error("hashToken")
	}
}
