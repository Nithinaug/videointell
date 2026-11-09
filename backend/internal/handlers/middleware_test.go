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
