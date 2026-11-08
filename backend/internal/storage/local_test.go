package storage

import (
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLocalStorageRejectsTraversal(t *testing.T) {
	l := NewLocalStorage(t.TempDir(), "s")

	for _, key := range []string{"../escape.txt", "uploads/../../escape.txt", "..", ""} {
		if err := l.Write(key, strings.NewReader("x")); err == nil {
			t.Errorf("Write(%q) succeeded, want error", key)
		}
		if _, err := l.Path(key); err == nil {
			t.Errorf("Path(%q) succeeded, want error", key)
		}
	}

	if err := l.Write("uploads/u1/1-ok.mp4", strings.NewReader("x")); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	if err := l.Write("uploads/u1/1-ok.mp4", strings.NewReader("y")); err == nil {
		t.Error("second Write to the same key succeeded, want error")
	}
}

func TestSignedURLs(t *testing.T) {
	l := NewLocalStorage(t.TempDir(), "s")
	key := "uploads/u1/1-my video.mp4"

	u, err := url.Parse(l.UploadURL(key))
	if err != nil {
		t.Fatal(err)
	}
	gotKey, _ := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), filesPrefix))
	if gotKey != key {
		t.Fatalf("key round trip: got %q want %q", gotKey, key)
	}
	exp, sig := u.Query().Get("exp"), u.Query().Get("sig")

	if err := l.Verify("PUT", key, exp, sig); err != nil {
		t.Errorf("valid upload signature rejected: %v", err)
	}
	if l.Verify("GET", key, exp, sig) == nil {
		t.Error("upload signature accepted for GET")
	}
	if l.Verify("PUT", "uploads/u2/1-my video.mp4", exp, sig) == nil {
		t.Error("signature accepted for another key")
	}
	if l.Verify("PUT", key, exp+"0", sig) == nil {
		t.Error("signature accepted with changed expiry")
	}
	if NewLocalStorage(t.TempDir(), "other").Verify("PUT", key, exp, sig) == nil {
		t.Error("signature accepted with another secret")
	}

	past := time.Now().Add(-time.Minute).Unix()
	if l.Verify("GET", key, strconv.FormatInt(past, 10), l.sign("GET", key, past)) == nil {
		t.Error("expired signature accepted")
	}
}
