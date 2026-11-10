package handlers

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/worker"
)

const exportStaleAfter = 35 * time.Minute

type Invoker interface {
	InvokeAsync(ctx context.Context, function string, payload any) error
}

type ExportHandler struct {
	Clips    *ClipHandler
	Lambda   Invoker
	Function string
	Bucket   string
	PerDay   int
}

func NewExportHandler(clips *ClipHandler, lambda Invoker, function, bucket string, perDay int) *ExportHandler {
	return &ExportHandler{Clips: clips, Lambda: lambda, Function: function, Bucket: bucket, PerDay: perDay}
}

func exportState(ready, failed bool, started, now time.Time) string {
	switch {
	case ready:
		return "ready"
	case failed:
		return "failed"
	case started.IsZero():
		return "none"
	case now.Sub(started) < exportStaleAfter:
		return "working"
	}
	return "failed"
}

func (h *ExportHandler) state(out string) (string, error) {
	var ready, failed bool
	var started time.Time
	for _, f := range []struct {
		name string
		set  func(os.FileInfo)
	}{
		{worker.ExportFile, func(os.FileInfo) { ready = true }},
		{worker.ExportErrorFile, func(os.FileInfo) { failed = true }},
		{worker.ExportMarker, func(i os.FileInfo) { started = i.ModTime() }},
	} {
		p, err := h.Clips.Videos.Storage.Path(out + f.name)
		if err != nil {
			return "", err
		}
		if info, err := os.Stat(p); err == nil {
			f.set(info)
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	if ready && !started.IsZero() {
		if err := h.Clips.Videos.Storage.RemoveAll(out + worker.ExportMarker); err != nil {
			log.Printf("export marker cleanup %s: %v", out, err)
		}
	}
	return exportState(ready, failed, started, time.Now()), nil
}

func (h *ExportHandler) Get(c *gin.Context) {
	v, ok := h.Clips.ownedVideo(c)
	if !ok {
		return
	}
	out, err := worker.OutputPrefix(v.OriginalKey)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	state, err := h.state(out)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check the export"})
		return
	}
	available := h.Function != "" && (state == "ready" || h.originalExists(v.OriginalKey))
	c.JSON(http.StatusOK, gin.H{"state": state, "available": available})
}

func (h *ExportHandler) originalExists(key string) bool {
	p, err := h.Clips.Videos.Storage.Path(key)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func (h *ExportHandler) Start(c *gin.Context) {
	v, ok := h.Clips.ownedVideo(c)
	if !ok {
		return
	}
	if h.Function == "" || h.Bucket == "" {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "HD export needs the Lambda worker, which is not set up here"})
		return
	}
	if v.Status != "ready" {
		c.JSON(http.StatusConflict, gin.H{"error": "this video is still processing"})
		return
	}
	out, err := worker.OutputPrefix(v.OriginalKey)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	state, err := h.state(out)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check the export"})
		return
	}
	if state == "ready" || state == "working" {
		c.JSON(http.StatusOK, gin.H{"state": state})
		return
	}
	if !h.originalExists(v.OriginalKey) {
		c.JSON(http.StatusGone, gin.H{"error": "the original upload has expired, so it cannot be exported"})
		return
	}
	store := h.Clips.Videos.Storage
	if err := store.RemoveAll(out+worker.ExportErrorFile, out+worker.ExportMarker); err != nil {
		log.Printf("export reset %s: %v", out, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start the export"})
		return
	}
	if err := store.Write(out+worker.ExportMarker, strings.NewReader("")); err != nil {
		if errors.Is(err, os.ErrExist) {
			c.JSON(http.StatusOK, gin.H{"state": "working"})
			return
		}
		log.Printf("export marker %s: %v", out, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start the export"})
		return
	}
	slot, err := h.Clips.Videos.Store.ReserveExport(v.UserID, h.PerDay)
	if err != nil || slot == "" {
		store.RemoveAll(out + worker.ExportMarker)
		if err != nil {
			log.Printf("export slot %s: %v", v.ID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start the export"})
			return
		}
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("you can export %d videos a day; try again tomorrow", h.PerDay)})
		return
	}
	payload := worker.Event{Op: "export", Bucket: h.Bucket, VideoKey: v.OriginalKey}
	if err := h.Lambda.InvokeAsync(c.Request.Context(), h.Function, payload); err != nil {
		log.Printf("export invoke %s: %v", v.ID, err)
		store.RemoveAll(out + worker.ExportMarker)
		if err := h.Clips.Videos.Store.ReleaseExport(slot); err != nil {
			log.Printf("export slot release %s: %v", slot, err)
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "could not start the export"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"state": "working"})
}
