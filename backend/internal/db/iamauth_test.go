package db

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPresignMatchesAWSExample(t *testing.T) {
	c := awsCreds{AccessKeyID: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
	now := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	got := presign("examplebucket.s3.amazonaws.com", "/test.txt", "s3", "us-east-1", "UNSIGNED-PAYLOAD", url.Values{}, c, now, 24*time.Hour)
	want := "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
	if !strings.HasSuffix(got, want) {
		t.Fatalf("presign = %s\nwant suffix %s", got, want)
	}
}

func TestRDSAuthTokenShape(t *testing.T) {
	c := awsCreds{AccessKeyID: "AK", SecretAccessKey: "SK", Token: "a/b+c="}
	tok := rdsAuthToken("db.example.com", "ap-south-1", "api", c, time.Now())
	for _, part := range []string{"db.example.com:5432/?", "Action=connect", "DBUser=api", "X-Amz-Security-Token=a%2Fb%2Bc%3D", "%2Fap-south-1%2Frds-db%2Faws4_request", "X-Amz-Expires=900"} {
		if !strings.Contains(tok, part) {
			t.Errorf("token missing %q: %s", part, tok)
		}
	}
}
