package db

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

type awsCreds struct {
	AccessKeyID     string `json:"AccessKeyId"`
	SecretAccessKey string `json:"SecretAccessKey"`
	Token           string `json:"Token"`
}

func loadCreds(ctx context.Context) (awsCreds, error) {
	if uri := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"); uri != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://169.254.170.2"+uri, nil)
		if err != nil {
			return awsCreds{}, err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return awsCreds{}, fmt.Errorf("task credentials: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return awsCreds{}, fmt.Errorf("task credentials: %s", resp.Status)
		}
		var c awsCreds
		if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
			return awsCreds{}, fmt.Errorf("task credentials: %w", err)
		}
		return c, nil
	}
	c := awsCreds{os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"), os.Getenv("AWS_SESSION_TOKEN")}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return awsCreds{}, fmt.Errorf("no AWS credentials: set AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or AWS_ACCESS_KEY_ID")
	}
	return c, nil
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key []byte, s string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return m.Sum(nil)
}

func presign(host, path, service, region, payloadHash string, params url.Values, c awsCreds, now time.Time, expires time.Duration) string {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	scope := day + "/" + region + "/" + service + "/aws4_request"

	q := url.Values{}
	for k, v := range params {
		q[k] = v
	}
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", c.AccessKeyID+"/"+scope)
	q.Set("X-Amz-Date", amzDate)
	q.Set("X-Amz-Expires", fmt.Sprint(int(expires.Seconds())))
	q.Set("X-Amz-SignedHeaders", "host")
	if c.Token != "" {
		q.Set("X-Amz-Security-Token", c.Token)
	}

	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, awsEscape(k)+"="+awsEscape(q.Get(k)))
	}
	query := strings.Join(parts, "&")

	canonical := strings.Join([]string{"GET", path, query, "host:" + host + "\n", "host", payloadHash}, "\n")
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)}, "\n")

	key := hmacSHA256([]byte("AWS4"+c.SecretAccessKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(key, toSign))

	return host + path + "?" + query + "&X-Amz-Signature=" + sig
}

func awsEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func rdsAuthToken(host, region, user string, c awsCreds, now time.Time) string {
	return presign(host+":5432", "/", "rds-db", region, sha256Hex(""), url.Values{"Action": {"connect"}, "DBUser": {user}}, c, now, 15*time.Minute)
}

type iamConnector struct {
	host, region, user, dbname string
}

func (c iamConnector) Connect(ctx context.Context) (driver.Conn, error) {
	creds, err := loadCreds(ctx)
	if err != nil {
		return nil, err
	}
	token := rdsAuthToken(c.host, c.region, c.user, creds, time.Now())
	dsn := fmt.Sprintf("host=%s port=5432 user=%s dbname=%s sslmode=verify-full password='%s'", c.host, c.user, c.dbname, token)
	conn, err := pq.NewConnector(dsn)
	if err != nil {
		return nil, err
	}
	return conn.Connect(ctx)
}

func (iamConnector) Driver() driver.Driver { return &pq.Driver{} }

func ConnectIAM(host, region, user, dbname string) (*sqlx.DB, error) {
	dbx := sqlx.NewDb(sql.OpenDB(iamConnector{host, region, user, dbname}), "postgres")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := dbx.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("connect aurora: %w", err)
	}
	return dbx, nil
}
