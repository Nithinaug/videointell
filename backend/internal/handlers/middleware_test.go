package handlers

import (
	"sync"
	"testing"
	"time"
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
