package cognito

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestVerify(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "RSA",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer srv.Close()

	v := NewVerifier("ap-south-1", "pool", "client")
	v.jwksURL = srv.URL

	sign := func(k *rsa.PrivateKey, mod func(jwt.MapClaims)) string {
		c := jwt.MapClaims{"iss": v.issuer, "aud": "client", "token_use": "id", "sub": "s1", "email": "a@b.c", "email_verified": true, "exp": time.Now().Add(time.Hour).Unix()}
		if mod != nil {
			mod(c)
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
		tok.Header["kid"] = "k1"
		s, _ := tok.SignedString(k)
		return s
	}

	if id, err := v.Verify(sign(key, nil)); err != nil || id.Sub != "s1" || id.Email != "a@b.c" {
		t.Fatalf("valid token: %+v %v", id, err)
	}
	bad := map[string]string{
		"wrong audience": sign(key, func(c jwt.MapClaims) { c["aud"] = "other" }),
		"access token":   sign(key, func(c jwt.MapClaims) { c["token_use"] = "access" }),
		"expired":        sign(key, func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() }),
		"wrong issuer":   sign(key, func(c jwt.MapClaims) { c["iss"] = "https://evil" }),
		"other key":      sign(other, nil),
		"unverified":     sign(key, func(c jwt.MapClaims) { c["email_verified"] = false }),
		"no verified":    sign(key, func(c jwt.MapClaims) { delete(c, "email_verified") }),
	}
	for name, tok := range bad {
		if _, err := v.Verify(tok); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}
