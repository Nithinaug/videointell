package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/models"
	"videointell/backend/internal/storage"
	"videointell/backend/internal/store"
	"videointell/backend/internal/worker"
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

	key := fmt.Sprintf("uploads/%s/%d-%s", userID, time.Now().UnixNano(), safeFilename(req.Filename))
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
	type item struct {
		models.Video
		ResultsURL string `json:"results_url,omitempty"`
	}
	items := make([]item, 0, len(videos))
	for _, v := range videos {
		it := item{Video: v}
		if prefix, err := worker.OutputPrefix(v.OriginalKey); err == nil && v.Status != "uploading" {
			it.ResultsURL = h.Storage.DirURL(prefix)
		}
		items = append(items, it)
	}
	c.JSON(http.StatusOK, gin.H{"videos": items})
}

type searchHit struct {
	VideoID string `json:"video_id"`
	Title   string `json:"title"`
	FromMS  int64  `json:"from_ms"`
	Text    string `json:"text"`
	Kind    string `json:"kind"`
	Results string `json:"results_url,omitempty"`
}

const maxSearchHits = 50

func screenMatches(frames []worker.ScreenText, terms []string) []int {
	var out []int
	prev := false
	for i, f := range frames {
		hit := containsAll(f.Text, terms)
		if hit && !prev {
			out = append(out, i)
		}
		prev = hit
	}
	return out
}

func containsAll(text string, terms []string) bool {
	text = strings.ToLower(text)
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}

func (h *VideoHandler) Search(c *gin.Context) {
	terms := strings.Fields(strings.ToLower(c.Query("q")))
	if len(terms) == 0 || len(strings.Join(terms, "")) < 2 {
		c.JSON(http.StatusOK, gin.H{"results": []searchHit{}, "searched": 0, "skipped": []string{}})
		return
	}
	videos, err := h.Store.ListVideosForUser(c.GetString("user_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	hits := []searchHit{}
	searched, skipped := 0, []string{}
	for _, v := range videos {
		if v.Status != "ready" {
			skipped = append(skipped, v.Title)
			continue
		}
		searched++
		if len(hits) == maxSearchHits {
			continue
		}
		out, err := worker.OutputPrefix(v.OriginalKey)
		if err != nil {
			continue
		}
		segments, err := h.loadTranscript(out)
		if err != nil {
			log.Printf("search: skip transcript of %s: %v", v.ID, err)
		}
		screen, err := h.loadScreen(out)
		if err != nil {
			log.Printf("search: skip screen text of %s: %v", v.ID, err)
		}
		results := h.Storage.DirURL(out)
		for _, s := range segments {
			if len(hits) < maxSearchHits && containsAll(s.Text, terms) {
				hits = append(hits, searchHit{VideoID: v.ID, Title: v.Title, FromMS: s.FromMS, Text: s.Text, Kind: "speech", Results: results})
			}
		}
		for _, i := range screenMatches(screen, terms) {
			if len(hits) < maxSearchHits {
				s := screen[i]
				hits = append(hits, searchHit{VideoID: v.ID, Title: v.Title, FromMS: s.FromMS, Text: s.Text, Kind: "screen", Results: results})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"results": hits, "searched": searched, "skipped": skipped})
}

func (h *VideoHandler) Delete(c *gin.Context) {
	video, err := h.Store.GetVideo(c.Param("id"))
	if err != nil || video.UserID != c.GetString("user_id") {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	if video.Status == "uploaded" || video.Status == "processing" {
		c.JSON(http.StatusConflict, gin.H{"error": "this video is still processing; delete it once it is ready"})
		return
	}
	keys := []string{video.OriginalKey, video.OriginalKey + storage.DoneSuffix}
	if out, err := worker.OutputPrefix(video.OriginalKey); err == nil {
		keys = append(keys, out, worker.WorkPrefix(video.OriginalKey))
	}
	if err := h.Storage.RemoveAll(keys...); err != nil {
		log.Printf("delete files %s: %v", video.OriginalKey, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete the video files"})
		return
	}
	if err := h.Store.DeleteVideo(video.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete the video"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *VideoHandler) Progress(c *gin.Context) {
	video, err := h.Store.GetVideo(c.Param("id"))
	if err != nil || video.UserID != c.GetString("user_id") {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	out, err := worker.OutputPrefix(video.OriginalKey)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	exists := func(key string) bool {
		p, err := h.Storage.Path(key)
		if err != nil {
			return false
		}
		_, err = os.Stat(p)
		return err == nil
	}
	var plan struct {
		Chunks int `json:"chunks"`
	}
	if p, err := h.Storage.Path(out + "progress.json"); err == nil {
		if raw, err := os.ReadFile(p); err == nil {
			json.Unmarshal(raw, &plan)
		}
	}
	done := 0
	if dir, err := h.Storage.Path(worker.WorkPrefix(video.OriginalKey)); err == nil {
		marks, _ := filepath.Glob(filepath.Join(dir, "done_*"))
		done = len(marks)
	}
	c.JSON(http.StatusOK, gin.H{
		"status":      video.Status,
		"split":       plan.Chunks > 0,
		"chunks":      plan.Chunks,
		"chunks_done": min(done, plan.Chunks),
		"assembled":   exists(out + "bedrock-request.json"),
		"summary":     exists(out + "summary.json"),
	})
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
		if prefix, err := worker.OutputPrefix(video.OriginalKey); err == nil {
			detail.ResultsURL = h.Storage.DirURL(prefix)
		}
	}

	c.JSON(http.StatusOK, detail)
}

const maxUploadBytes = 5 << 30

var unsafeFilenameChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safeFilename(name string) string {
	return unsafeFilenameChars.ReplaceAllString(path.Base(name), "-")
}

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

func (h *FilesHandler) Result(c *gin.Context) {
	key := path.Clean(strings.TrimPrefix(c.Param("key"), "/"))
	parts := strings.SplitN(key, "/", 4)
	if len(parts) < 4 || parts[0] != "processed" {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	prefix := strings.Join(parts[:3], "/") + "/"
	if err := h.Storage.Verify("DIR", prefix, c.Param("exp"), c.Param("sig")); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}
	file, err := h.Storage.Path(key)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.File(file)
}
