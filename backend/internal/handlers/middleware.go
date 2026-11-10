package handlers

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/cognito"
	"videointell/backend/internal/store"
)

const userCacheTTL = 10 * time.Minute

type cachedUser struct {
	id string
	at time.Time
}

type userCache struct {
	mu    sync.Mutex
	items map[string]cachedUser
}

func (u *userCache) get(sub string, now time.Time) (string, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	e, ok := u.items[sub]
	if !ok || now.Sub(e.at) > userCacheTTL {
		return "", false
	}
	return e.id, true
}

func (u *userCache) put(sub, id string, now time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.items[sub] = cachedUser{id, now}
}

type rateLimiter struct {
	mu    sync.Mutex
	limit int
	every time.Duration
	hits  map[string][]time.Time
}

func newRateLimiter(limit int, every time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, every: every, hits: map[string][]time.Time{}}
}

func (r *rateLimiter) allow(key string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.hits[key][:0]
	for _, t := range r.hits[key] {
		if now.Sub(t) < r.every {
			kept = append(kept, t)
		}
	}
	if len(kept) >= r.limit {
		r.hits[key] = kept
		return false
	}
	r.hits[key] = append(kept, now)
	return true
}

func AuthMiddleware(v *cognito.Verifier, st *store.Store, maxUsers int) gin.HandlerFunc {
	cache := &userCache{items: map[string]cachedUser{}}
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}
		id, err := v.Verify(strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		userID, ok := cache.get(id.Sub, time.Now())
		if !ok {
			userID, err = st.UpsertCognitoUser(id.Sub, id.Email, maxUsers)
			if errors.Is(err, store.ErrSignupsFull) {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "sign-ups are full right now"})
				return
			}
			if err != nil {
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "user lookup failed"})
				return
			}
			cache.put(id.Sub, userID, time.Now())
		}
		c.Set("user_id", userID)
		c.Next()
	}
}

func CORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Share-Token")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
