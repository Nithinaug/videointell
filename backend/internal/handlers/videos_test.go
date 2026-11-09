package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/storage"
)

func TestSafeFilename(t *testing.T) {
	cases := map[string]string{
		"my clip.mp4":         "my-clip.mp4",
		"../../etc/passwd":    "passwd",
		"vidéo (final)#1.mov": "vid-o-final-1.mov",
		"ok_name-1.mp4":       "ok_name-1.mp4",
	}
	for in, want := range cases {
		if got := safeFilename(in); got != want {
			t.Errorf("safeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResultScopedToVideoFolder(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"processed/u1/a.mp4/summary.json", "processed/u1/b.mp4/summary.json"} {
		os.MkdirAll(filepath.Join(dir, filepath.Dir(f)), 0o755)
		os.WriteFile(filepath.Join(dir, f), []byte("{}"), 0o644)
	}
	st := storage.NewLocalStorage(dir, "secret")
	h := &FilesHandler{Storage: st}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/results/:exp/:sig/*key", h.Result)

	base := st.DirURL("processed/u1/a.mp4/")
	other := strings.Replace(base, "a.mp4", "b.mp4", 1)
	cases := map[string]int{
		base + "summary.json":           http.StatusOK,
		other + "summary.json":          http.StatusForbidden,
		base + "../b.mp4/summary.json":  http.StatusForbidden,
		base + "../../../../etc/passwd": http.StatusNotFound,
		base + "missing.json":           http.StatusNotFound,
	}
	for url, want := range cases {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
		if w.Code != want {
			t.Errorf("GET %s = %d, want %d", url, w.Code, want)
		}
	}
}
