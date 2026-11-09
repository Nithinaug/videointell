package awsapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

type Creds struct {
	AccessKeyID     string `json:"AccessKeyId"`
	SecretAccessKey string `json:"SecretAccessKey"`
	Token           string `json:"Token"`
}

func LoadCreds(ctx context.Context) (Creds, error) {
	if uri := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"); uri != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://169.254.170.2"+uri, nil)
		if err != nil {
			return Creds{}, err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return Creds{}, fmt.Errorf("task credentials: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return Creds{}, fmt.Errorf("task credentials: %s", resp.Status)
		}
		var c Creds
		if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
			return Creds{}, fmt.Errorf("task credentials: %w", err)
		}
		return c, nil
	}
	c := Creds{os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"), os.Getenv("AWS_SESSION_TOKEN")}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return Creds{}, fmt.Errorf("no AWS credentials: set AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or AWS_ACCESS_KEY_ID")
	}
	return c, nil
}

func Sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func HMACSHA256(key []byte, s string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return m.Sum(nil)
}

func SigningKey(secret, day, region, service string) []byte {
	key := HMACSHA256([]byte("AWS4"+secret), day)
	key = HMACSHA256(key, region)
	key = HMACSHA256(key, service)
	return HMACSHA256(key, "aws4_request")
}

func SignRequest(req *http.Request, service, region string, body []byte, c Creds, now time.Time) error {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	scope := day + "/" + region + "/" + service + "/aws4_request"

	req.Header.Set("X-Amz-Date", amzDate)
	if c.Token != "" {
		req.Header.Set("X-Amz-Security-Token", c.Token)
	}
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}

	headers := map[string]string{"host": host}
	for k, v := range req.Header {
		headers[strings.ToLower(k)] = strings.TrimSpace(strings.Join(v, ","))
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + headers[k] + "\n")
	}
	signed := strings.Join(names, ";")

	if req.URL.RawQuery != "" {
		return fmt.Errorf("sign request: query strings are not supported")
	}
	canonical := strings.Join([]string{
		req.Method,
		canonicalPath(req.URL.EscapedPath()),
		"",
		canonHeaders.String(),
		signed,
		Sha256Hex(string(body)),
	}, "\n")
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, Sha256Hex(canonical)}, "\n")
	sig := hex.EncodeToString(HMACSHA256(SigningKey(c.SecretAccessKey, day, region, service), toSign))

	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.AccessKeyID+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)
	return nil
}

func canonicalPath(escaped string) string {
	if escaped == "" {
		return "/"
	}
	segs := strings.Split(escaped, "/")
	for i, s := range segs {
		segs[i] = uriEncode(s)
	}
	return strings.Join(segs, "/")
}

func uriEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '.' || ch == '_' || ch == '~' {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}
