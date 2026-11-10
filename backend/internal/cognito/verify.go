package cognito

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Verifier struct {
	issuer   string
	clientID string
	jwksURL  string

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func NewVerifier(region, poolID, clientID string) *Verifier {
	issuer := fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", region, poolID)
	return &Verifier{issuer: issuer, clientID: clientID, jwksURL: issuer + "/.well-known/jwks.json"}
}

type Identity struct {
	Sub   string
	Email string
}

func (v *Verifier) Verify(token string) (Identity, error) {
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(token, claims, v.key,
		jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.clientID), jwt.WithExpirationRequired())
	if err != nil {
		return Identity{}, err
	}
	if claims["token_use"] != "id" {
		return Identity{}, errors.New("not an id token")
	}
	sub, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	if sub == "" || email == "" {
		return Identity{}, errors.New("token has no sub or email")
	}
	if v, ok := claims["email_verified"]; !ok || (v != true && v != "true") {
		return Identity{}, errors.New("email is not verified")
	}
	return Identity{Sub: sub, Email: email}, nil
}

func (v *Verifier) key(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	v.mu.Lock()
	defer v.mu.Unlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	if time.Since(v.fetched) < time.Minute {
		return nil, fmt.Errorf("unknown key %q", kid)
	}
	keys, err := fetchKeys(v.jwksURL)
	if err != nil {
		return nil, err
	}
	v.keys, v.fetched = keys, time.Now()
	if k, ok := keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("unknown key %q", kid)
}

func fetchKeys(url string) (map[string]*rsa.PublicKey, error) {
	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks: %s", resp.Status)
	}
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	return keys, nil
}
