package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"videointell/backend/internal/worker"
)

func (h *VideoHandler) loadTranscript(prefix string) ([]worker.Segment, error) {
	p, err := h.Storage.Path(prefix + "transcript.json")
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var t struct {
		Segments *[]worker.Segment `json:"segments"`
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("transcript.json: %w", err)
	}
	if t.Segments == nil {
		return nil, fmt.Errorf("transcript.json has no segments field (old format?)")
	}
	return *t.Segments, nil
}

func (h *VideoHandler) loadScreen(prefix string) ([]worker.ScreenText, error) {
	p, err := h.Storage.Path(prefix + "screen.json")
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var t struct {
		Frames []worker.ScreenText `json:"frames"`
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("screen.json: %w", err)
	}
	return t.Frames, nil
}
