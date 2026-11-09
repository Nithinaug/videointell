package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
	"videointell/backend/internal/awsapi"
)

func presign(host, path, service, region, payloadHash string, params url.Values, c awsapi.Creds, now time.Time, expires time.Duration) string {
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
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, awsapi.Sha256Hex(canonical)}, "\n")

	sig := hex.EncodeToString(awsapi.HMACSHA256(awsapi.SigningKey(c.SecretAccessKey, day, region, service), toSign))

	return host + path + "?" + query + "&X-Amz-Signature=" + sig
}

func awsEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func rdsAuthToken(host, region, user string, c awsapi.Creds, now time.Time) string {
	return presign(host+":5432", "/", "rds-db", region, awsapi.Sha256Hex(""), url.Values{"Action": {"connect"}, "DBUser": {user}}, c, now, 15*time.Minute)
}

type iamConnector struct {
	host, region, user, dbname string
}

func (c iamConnector) Connect(ctx context.Context) (driver.Conn, error) {
	creds, err := awsapi.LoadCreds(ctx)
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
