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

type Lambda struct {
	Region string
	HTTP   *http.Client
}

func NewLambda(region string) *Lambda {
	return &Lambda{Region: region, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (l *Lambda) InvokeAsync(ctx context.Context, function string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	u := &url.URL{Scheme: "https", Host: "lambda." + l.Region + ".amazonaws.com", Path: "/2015-03-31/functions/" + function + "/invocations"}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Amz-Invocation-Type", "Event")
	creds, err := LoadCreds(ctx)
	if err != nil {
		return err
	}
	if err := SignRequest(req, "lambda", l.Region, body, creds, time.Now()); err != nil {
		return err
	}
	resp, err := l.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("lambda: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("lambda: %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	return nil
}
