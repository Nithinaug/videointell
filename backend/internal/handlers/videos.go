package handlers

import (
	"errors"
	"fmt"
	"io/fs"
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
	if strings.HasSuffix(key, storage.DoneSuffix) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "filename must not end in " + storage.DoneSuffix})
		return
	}
	video, err := h.Store.CreateVideo(userID, req.Title, key, req.ContentType)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"video": video, "upload_url": h.Storage.UploadURL(key)})
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
	if video.Status != "uploading" {
		detail.URL = h.Storage.PlaybackURL(video.OriginalKey)
	}

	c.JSON(http.StatusOK, detail)
}

const maxUploadBytes = 5 << 30

type FilesHandler struct {
	Store   *store.Store
	Storage *storage.LocalStorage
}

func (h *FilesHandler) verifiedKey(c *gin.Context) (string, bool) {
	key := strings.TrimPrefix(c.Param("key"), "/")
	if err := h.Storage.Verify(c.Request.Method, key, c.Query("exp"), c.Query("sig")); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return "", false
	}
	return key, true
}

func (h *FilesHandler) Upload(c *gin.Context) {
	key, ok := h.verifiedKey(c)
	if !ok {
		return
	}
	body := http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBytes)
	err := h.Storage.Write(key, body)
	var tooBig *http.MaxBytesError
	switch {
	case err == nil:
		h.finishUpload(c, key)
	case errors.Is(err, fs.ErrExist):
		c.JSON(http.StatusConflict, gin.H{"error": "file already uploaded"})
	case errors.As(err, &tooBig):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file too large"})
	default:
		log.Printf("upload %s: %v", key, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
	}
}

func (h *FilesHandler) finishUpload(c *gin.Context, key string) {
	if _, err := h.Store.SetVideoStatus(key, []string{"uploading"}, "uploaded"); err != nil {
		log.Printf("set uploaded %s: %v", key, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}
	if err := h.Storage.MarkDone(key); err != nil {
		log.Printf("mark done %s: %v", key, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}
	c.Status(http.StatusOK)
}

func (h *FilesHandler) File(c *gin.Context) {
	key, ok := h.verifiedKey(c)
	if !ok {
		return
	}
	path, err := h.Storage.Path(key)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.File(path)
}
