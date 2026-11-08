package handlers

import (
	"fmt"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/models"
	"videointell/backend/internal/storage"
	"videointell/backend/internal/store"
)

type VideoHandler struct {
	Store   *store.Store
	Storage *storage.LocalStorage
}

type createVideoRequest struct {
	Title       string `json:"title" binding:"required"`
	Filename    string `json:"filename" binding:"required"`
	ContentType string `json:"content_type" binding:"required"`
}

func (h *VideoHandler) Create(c *gin.Context) {
	userID := c.GetString("user_id")

	var req createVideoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !strings.HasPrefix(req.ContentType, "video/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content_type must be a video type"})
		return
	}

	key := fmt.Sprintf("uploads/%s/%d-%s", userID, time.Now().UnixNano(), path.Base(req.Filename))
	uploadURL, err := h.Storage.PresignUpload(c.Request.Context(), key, req.ContentType)
	if err != nil {
		log.Printf("presign upload: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create upload url"})
		return
	}

	video, err := h.Store.CreateVideo(userID, req.Title, key, req.ContentType)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"video": video, "upload_url": uploadURL})
}

func (h *VideoHandler) CompleteUpload(c *gin.Context) {
	userID := c.GetString("user_id")
	videoID := c.Param("id")

	video, err := h.Store.GetVideo(videoID)
	if err != nil || video.UserID != userID {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}

	if err := h.Store.UpdateVideoStatus(videoID, "uploaded"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "uploaded"})
}

func (h *VideoHandler) List(c *gin.Context) {
	userID := c.GetString("user_id")
	videos, err := h.Store.ListVideosForUser(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos})
}

func (h *VideoHandler) Detail(c *gin.Context) {
	userID := c.GetString("user_id")
	videoID := c.Param("id")

	video, err := h.Store.GetVideo(videoID)
	if err != nil || video.UserID != userID {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}

	detail := models.VideoDetail{Video: video}
	if video.Status == "uploaded" {
		url, err := h.Storage.PublicURL(c.Request.Context(), video.OriginalKey)
		if err != nil {
			log.Printf("presign download: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create playback url"})
			return
		}
		detail.URL = url
	}

	c.JSON(http.StatusOK, detail)
}

type LocalFilesHandler struct {
	Storage *storage.LocalStorage
}

func (h *LocalFilesHandler) Upload(c *gin.Context) {
	key := c.Param("key")[1:]
	body, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	contentType := c.ContentType()
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if err := h.Storage.PutObject(key, contentType, body); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusOK)
}

func (h *LocalFilesHandler) File(c *gin.Context) {
	key := c.Param("key")[1:]
	body, err := h.Storage.GetObject(key)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Data(http.StatusOK, "application/octet-stream", body)
}
