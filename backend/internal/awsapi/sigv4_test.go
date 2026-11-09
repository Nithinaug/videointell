package awsapi

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSignRequestMatchesAWSGetVanilla(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	c := Creds{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}
	if err := SignRequest(req, "service", "us-east-1", nil, c, time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization =\n%s\nwant\n%s", got, want)
	}
}

func TestModelIDPathEncoding(t *testing.T) {
	u := &url.URL{Scheme: "https", Host: "bedrock-runtime.ap-south-1.amazonaws.com", Path: "/model/apac.amazon.nova-lite-v1:0/converse", RawPath: "/model/apac.amazon.nova-lite-v1%3A0/converse"}
	if got := u.RequestURI(); got != "/model/apac.amazon.nova-lite-v1%3A0/converse" {
		t.Fatalf("wire path = %s", got)
	}
	if got := canonicalPath(u.EscapedPath()); got != "/model/apac.amazon.nova-lite-v1%253A0/converse" {
		t.Fatalf("canonical path = %s", got)
	}
}

func TestSignRequestAddsSessionToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://bedrock-runtime.ap-south-1.amazonaws.com/x", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	if err := SignRequest(req, "bedrock", "ap-south-1", []byte("{}"), Creds{AccessKeyID: "AK", SecretAccessKey: "SK", Token: "tok"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Amz-Security-Token") != "tok" || !strings.Contains(req.Header.Get("Authorization"), "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,") {
		t.Fatalf("headers = %v", req.Header)
	}
}
