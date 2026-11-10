package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestUserCache(t *testing.T) {
	u := &userCache{items: map[string]cachedUser{}}
	now := time.Now()
	if _, ok := u.get("sub", now); ok {
		t.Fatal("empty cache hit")
	}
	u.put("sub", "user-1", now)
	if id, ok := u.get("sub", now.Add(time.Minute)); !ok || id != "user-1" {
		t.Fatalf("get = %q %v", id, ok)
	}
	if _, ok := u.get("sub", now.Add(userCacheTTL+time.Second)); ok {
		t.Fatal("expired entry hit")
	}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			u.put("sub", "user-1", now)
			u.get("sub", now)
		}()
	}
	wg.Wait()
}

func TestRateLimiter(t *testing.T) {
	r := newRateLimiter(2, time.Hour)
	now := time.Now()
	if !r.allow("u", now) || !r.allow("u", now) {
		t.Fatal("first two should pass")
	}
	if r.allow("u", now) {
		t.Fatal("third should be refused")
	}
	if !r.allow("other", now) {
		t.Fatal("other user is separate")
	}
	if !r.allow("u", now.Add(time.Hour+time.Second)) {
		t.Fatal("window should reset")
	}
}

func TestCORSAllowsPatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORSMiddleware())
	r.PATCH("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Header.Set("Access-Control-Request-Method", "PATCH")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent || !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatalf("preflight = %d, methods %q", w.Code, w.Header().Get("Access-Control-Allow-Methods"))
	}
}
