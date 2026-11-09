package awsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Reply struct {
	Text         string
	InputTokens  int
	OutputTokens int
}

type Converser interface {
	Converse(ctx context.Context, system, user string) (Reply, error)
}

type Bedrock struct {
	Region  string
	ModelID string
	HTTP    *http.Client
}

func NewBedrock(region, modelID string) *Bedrock {
	return &Bedrock{Region: region, ModelID: modelID, HTTP: &http.Client{Timeout: 45 * time.Second}}
}

func modelURL(region, modelID string) *url.URL {
	return &url.URL{
		Scheme:  "https",
		Host:    "bedrock-runtime." + region + ".amazonaws.com",
		Path:    "/model/" + modelID + "/converse",
		RawPath: "/model/" + strings.ReplaceAll(url.PathEscape(modelID), ":", "%3A") + "/converse",
	}
}

func (b *Bedrock) Converse(ctx context.Context, system, user string) (Reply, error) {
	body, _ := json.Marshal(map[string]any{
		"system":          []map[string]string{{"text": system}},
		"messages":        []map[string]any{{"role": "user", "content": []map[string]string{{"text": user}}}},
		"inferenceConfig": map[string]any{"maxTokens": 800, "temperature": 0.2},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "", bytes.NewReader(body))
	if err != nil {
		return Reply{}, err
	}
	req.URL = modelURL(b.Region, b.ModelID)
	req.Host = req.URL.Host
	req.Header.Set("Content-Type", "application/json")
	creds, err := LoadCreds(ctx)
	if err != nil {
		return Reply{}, err
	}
	if err := SignRequest(req, "bedrock", b.Region, body, creds, time.Now()); err != nil {
		return Reply{}, err
	}
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return Reply{}, fmt.Errorf("bedrock: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Reply{}, fmt.Errorf("bedrock: %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Output struct {
			Message struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		} `json:"output"`
		Usage struct {
			InputTokens  int `json:"inputTokens"`
			OutputTokens int `json:"outputTokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return Reply{}, fmt.Errorf("bedrock: %w", err)
	}
	if len(out.Output.Message.Content) == 0 {
		return Reply{}, fmt.Errorf("bedrock: empty reply")
	}
	return Reply{out.Output.Message.Content[0].Text, out.Usage.InputTokens, out.Usage.OutputTokens}, nil
}
