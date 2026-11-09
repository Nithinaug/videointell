package handlers

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"videointell/backend/internal/models"
)

const maxClipMS = 5 * 60 * 1000

type ClipHandler struct {
	Videos *VideoHandler
}

func validClip(title string, startMS, endMS int64) (string, error) {
	title = strings.TrimSpace(title)
	switch {
	case title == "" || utf8.RuneCountInString(title) > 100:
		return "", errors.New("give the clip a title of 1 to 100 characters")
	case startMS < 0 || endMS <= startMS:
		return "", errors.New("the clip must end after it starts")
	case endMS-startMS < 1000:
		return "", errors.New("a clip must be at least 1 second long")
	case endMS-startMS > maxClipMS:
		return "", errors.New("a clip can be at most 5 minutes long")
	}
	return title, nil
}

func (h *ClipHandler) ownedVideo(c *gin.Context) (models.Video, bool) {
	id := c.Param("id")
	if uuid.Validate(id) != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return models.Video{}, false
	}
	v, err := h.Videos.Store.GetVideo(id)
	if err != nil || v.UserID != c.GetString("user_id") {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return models.Video{}, false
	}
	return v, true
}

func (h *ClipHandler) List(c *gin.Context) {
	v, ok := h.ownedVideo(c)
	if !ok {
		return
	}
	clips, err := h.Videos.Store.ListClips(v.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load clips"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"clips": clips})
}

func (h *ClipHandler) Create(c *gin.Context) {
	v, ok := h.ownedVideo(c)
	if !ok {
		return
	}
	if v.Status != "ready" {
		c.JSON(http.StatusConflict, gin.H{"error": "this video is still processing"})
		return
	}
	var body struct {
		Title   string `json:"title"`
		StartMS int64  `json:"start_ms"`
		EndMS   int64  `json:"end_ms"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "send {title, start_ms, end_ms}"})
		return
	}
	title, err := validClip(body.Title, body.StartMS, body.EndMS)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	clip, err := h.Videos.Store.CreateClip(v.ID, title, body.StartMS, body.EndMS)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save the clip"})
		return
	}
	c.JSON(http.StatusCreated, clip)
}

func (h *ClipHandler) Delete(c *gin.Context) {
	v, ok := h.ownedVideo(c)
	if !ok {
		return
	}
	clipID := c.Param("clip")
	if uuid.Validate(clipID) != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "clip not found"})
		return
	}
	found, err := h.Videos.Store.DeleteClip(v.ID, clipID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete the clip"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "clip not found"})
		return
	}
	c.Status(http.StatusNoContent)
}
