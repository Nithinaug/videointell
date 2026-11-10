package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"videointell/backend/internal/awsapi"
	"videointell/backend/internal/models"
	"videointell/backend/internal/worker"
)

type AskHandler struct {
	Videos  *VideoHandler
	AI      awsapi.Converser
	limiter *rateLimiter
}

func NewAskHandler(videos *VideoHandler, ai awsapi.Converser, perHour int) *AskHandler {
	return &AskHandler{Videos: videos, AI: ai, limiter: newRateLimiter(perHour, time.Hour)}
}

const (
	maxAskLines      = 30
	maxAskChars      = 12_000
	maxVideoAskChars = 40_000
	askSystem        = `Answer only from the numbered lines. Lines marked "on screen" are text read from the video frames; the others are speech. If the input is a keyword or topic rather than a question, briefly explain what the lines say about it. Reply with JSON only: {"answer": string, "sources": [line numbers]}. If the lines say nothing useful about it, reply {"answer": "", "sources": []}.`
)

var stopWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields("a an and are did do does for how i in is it of on or that the this to was we what when where who why you") {
		stopWords[w] = true
	}
}

type askLine struct {
	VideoID string
	Title   string
	Results string
	FromMS  int64
	Text    string
	Kind    string
}

type askItem struct {
	FromMS int64
	Text   string
	Kind   string
}

type askVideo struct {
	video   models.Video
	results string
	items   []askItem
}

func mergeItems(segments []worker.Segment, screen []worker.ScreenText) []askItem {
	items := make([]askItem, 0, len(segments)+len(screen))
	for _, s := range segments {
		items = append(items, askItem{s.FromMS, s.Text, "speech"})
	}
	for _, s := range screen {
		items = append(items, askItem{s.FromMS, s.Text, "screen"})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].FromMS < items[j].FromMS })
	return items
}

func keywords(q string) []string {
	var out []string
	for _, w := range strings.Fields(strings.ToLower(q)) {
		w = strings.Trim(w, `?.,!"'`)
		if len(w) > 1 && !stopWords[w] {
			out = append(out, w)
		}
	}
	return out
}

func itemChars(items []askItem) int {
	n := 0
	for _, it := range items {
		n += len(it.Text)
	}
	return n
}

func pickContext(videos []askVideo, q string, whole bool) ([]askLine, bool) {
	var lines []askLine
	chars, truncated := 0, false
	add := func(v askVideo, s askItem) bool {
		if len(lines) == maxAskLines && !whole || chars+len(s.Text) > maxAskChars && !whole || chars+len(s.Text) > maxVideoAskChars {
			truncated = true
			return false
		}
		lines = append(lines, askLine{v.video.ID, v.video.Title, v.results, s.FromMS, s.Text, s.Kind})
		chars += len(s.Text)
		return true
	}
	if whole {
		for _, s := range videos[0].items {
			if !add(videos[0], s) {
				break
			}
		}
		return lines, truncated
	}
	words := keywords(q)
	for _, v := range videos {
		keep := map[int]bool{}
		for i, s := range v.items {
			text := strings.ToLower(s.Text)
			for _, w := range words {
				if strings.Contains(text, w) {
					keep[i-1], keep[i], keep[i+1] = true, true, true
					break
				}
			}
		}
		for i, s := range v.items {
			if keep[i] && !add(v, s) {
				return lines, true
			}
		}
	}
	return lines, truncated
}

var fences = regexp.MustCompile("^```(?:json)?\\s*|\\s*```$")

func parseAnswer(text string, n int) (string, []int) {
	var out struct {
		Answer  string `json:"answer"`
		Sources []int  `json:"sources"`
	}
	if json.Unmarshal([]byte(fences.ReplaceAllString(strings.TrimSpace(text), "")), &out) != nil {
		return "", nil
	}
	seen := map[int]bool{}
	var idx []int
	for _, s := range out.Sources {
		if s >= 1 && s <= n && !seen[s] {
			seen[s] = true
			idx = append(idx, s-1)
		}
	}
	if len(idx) == 0 || strings.TrimSpace(out.Answer) == "" {
		return "", nil
	}
	return strings.TrimSpace(out.Answer), idx
}

func (h *AskHandler) Ask(c *gin.Context) {
	var body struct {
		Q       string `json:"q"`
		VideoID string `json:"video_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "send {q, video_id?}"})
		return
	}
	q := strings.TrimSpace(body.Q)
	if len(q) < 2 || len(q) > 300 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ask with 2 to 300 characters"})
		return
	}
	userID := c.GetString("user_id")
	if h.limiter != nil && !h.limiter.allow(userID, time.Now()) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("you can ask %d questions an hour; try again later", h.limiter.limit)})
		return
	}
	var candidates []models.Video
	if body.VideoID != "" {
		v, err := h.Videos.Store.GetVideo(body.VideoID)
		if err != nil || v.UserID != userID {
			c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
			return
		}
		if v.Status != "ready" {
			c.JSON(http.StatusConflict, gin.H{"error": "this video is still processing"})
			return
		}
		candidates = []models.Video{v}
	} else {
		all, err := h.Videos.Store.ListVideosForUser(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, v := range all {
			if v.Status == "ready" {
				candidates = append(candidates, v)
			}
		}
	}

	var videos []askVideo
	for _, v := range candidates {
		out, err := worker.OutputPrefix(v.OriginalKey)
		if err != nil {
			continue
		}
		segments, err := h.Videos.loadTranscript(out)
		if err != nil {
			log.Printf("ask: skip transcript of %s: %v", v.ID, err)
		}
		screen, err := h.Videos.loadScreen(out)
		if err != nil {
			log.Printf("ask: skip screen text of %s: %v", v.ID, err)
		}
		if items := mergeItems(segments, screen); len(items) > 0 {
			videos = append(videos, askVideo{v, h.Videos.Storage.DirURL(out), items})
		}
	}

	scope := "all"
	if body.VideoID != "" {
		scope = "video"
	}
	empty := gin.H{"answer": "", "sources": []searchHit{}, "truncated": false, "scope": scope}
	if len(videos) == 0 {
		c.JSON(http.StatusOK, empty)
		return
	}
	whole := body.VideoID != "" && itemChars(videos[0].items) <= maxVideoAskChars
	lines, truncated := pickContext(videos, q, whole)
	empty["truncated"] = truncated
	if len(lines) == 0 {
		c.JSON(http.StatusOK, empty)
		return
	}

	var prompt strings.Builder
	fmt.Fprintf(&prompt, "Question: %s\n\nTranscript lines:\n", q)
	for i, l := range lines {
		where := ""
		if l.Kind == "screen" {
			where = ", on screen"
		}
		fmt.Fprintf(&prompt, "[%d] (%s, %s%s) %s\n", i+1, l.Title, time.Duration(l.FromMS)*time.Millisecond, where, l.Text)
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 50*time.Second)
	defer cancel()
	reply, err := h.AI.Converse(ctx, askSystem, prompt.String())
	if err != nil {
		log.Printf("ask: %v", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "the AI could not answer right now; the matches below still work"})
		return
	}
	log.Printf("ask: %d lines, tokens in=%d out=%d", len(lines), reply.InputTokens, reply.OutputTokens)

	answer, idx := parseAnswer(reply.Text, len(lines))
	sources := []searchHit{}
	for _, i := range idx {
		l := lines[i]
		sources = append(sources, searchHit{VideoID: l.VideoID, Title: l.Title, FromMS: l.FromMS, Text: l.Text, Kind: l.Kind, Results: l.Results})
	}
	c.JSON(http.StatusOK, gin.H{"answer": answer, "sources": sources, "truncated": truncated, "scope": scope})
}
