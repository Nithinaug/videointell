package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"videointell/backend/internal/models"
	"videointell/backend/internal/store"
	"videointell/backend/internal/worker"
)

type ShareHandler struct {
	Clips *ClipHandler
}

var shareKey = regexp.MustCompile(`^(summary\.json|transcript\.json|transcript\.vtt|screen\.json|thumbs/thumb_\d+\.jpg|hls/master\.m3u8|hls/[a-z0-9]+/index\.m3u8|hls/[a-z0-9]+/c\d+_\d+\.ts)$`)

func allowShareKey(rel string) bool {
	return shareKey.MatchString(rel)
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func shareState(l models.ShareLink, now time.Time) string {
	switch {
	case l.RevokedAt != nil:
		return "revoked"
	case !l.ExpiresAt.After(now):
		return "expired"
	}
	return "active"
}

func (h *ShareHandler) Create(c *gin.Context) {
	v, ok := h.Clips.ownedVideo(c)
	if !ok {
		return
	}
	if v.Status != "ready" {
		c.JSON(http.StatusConflict, gin.H{"error": "this video is still processing"})
		return
	}
	var body struct {
		Days int `json:"days"`
	}
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "send {days}"})
			return
		}
	}
	if body.Days == 0 {
		body.Days = 7
	}
	if body.Days != 1 && body.Days != 7 && body.Days != 30 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a link can last 1, 7 or 30 days"})
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create the link"})
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	link, err := h.Clips.Videos.Store.CreateShare(v.ID, hashToken(token), time.Now().Add(time.Duration(body.Days)*24*time.Hour))
	if errors.Is(err, store.ErrTooManyShares) {
		c.JSON(http.StatusConflict, gin.H{"error": "this video already has 50 active links"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create the link"})
		return
	}
	link.State = "active"
	c.JSON(http.StatusCreated, gin.H{"share": link, "token": token})
}

func (h *ShareHandler) List(c *gin.Context) {
	v, ok := h.Clips.ownedVideo(c)
	if !ok {
		return
	}
	links, err := h.Clips.Videos.Store.ListShares(v.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load links"})
		return
	}
	now := time.Now()
	for i := range links {
		links[i].State = shareState(links[i], now)
	}
	c.JSON(http.StatusOK, gin.H{"shares": links})
}

func (h *ShareHandler) Revoke(c *gin.Context) {
	v, ok := h.Clips.ownedVideo(c)
	if !ok {
		return
	}
	shareID := c.Param("share")
	if uuid.Validate(shareID) != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return
	}
	found, err := h.Clips.Videos.Store.RevokeShare(v.ID, shareID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not cancel the link"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *ShareHandler) View(c *gin.Context) {
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "no-store")
	notFound := func() { c.JSON(http.StatusNotFound, gin.H{"error": "link not available"}) }
	token := c.GetHeader("X-Share-Token")
	if len(token) != 43 {
		notFound()
		return
	}
	v, err := h.Clips.Videos.Store.ShareByHash(hashToken(token))
	if err != nil {
		notFound()
		return
	}
	out, err := worker.OutputPrefix(v.OriginalKey)
	if err != nil {
		notFound()
		return
	}
	clips, err := h.Clips.Videos.Store.ListClips(v.ID)
	if err != nil {
		clips = []models.Clip{}
	}
	base, exp := h.Clips.Videos.Storage.ShareDirURL(out)
	c.JSON(http.StatusOK, gin.H{"title": v.Title, "base": base, "base_expires_at": exp, "clips": clips})
}
