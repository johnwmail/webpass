package srv

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStaticFilesDoNotFallbackToIndex(t *testing.T) {
	staticFS := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte(testIndexHTML)},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log(1)\n")},
	}
	s := &Server{StaticFS: staticFS, Version: "v0.7.1", Commit: "abc1234", BuildTime: "2026-11-09T00:00:00Z", PGPKeyTimeoutSeconds: 30}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	t.Run("root serves index", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("Content-Type = %q, want text/html", ct)
		}
		if !strings.Contains(string(body), `content="v0.7.1"`) {
			t.Fatalf("index missing injected version:\n%s", body)
		}
	})

	t.Run("real asset is served", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/assets/app.js")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if string(body) != "console.log(1)\n" {
			t.Fatalf("body = %q", body)
		}
		if strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
			t.Fatalf("asset served as HTML: %s", resp.Header.Get("Content-Type"))
		}
	})

	for _, path := range []string{"/wp-admin/css", "/assets/missing.js", "/assets", "/assets/", "/index.html/"} {
		t.Run("missing "+path, func(t *testing.T) {
			resp, err := http.Get(ts.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body=%q", resp.StatusCode, body)
			}
			if strings.Contains(string(body), "<html") || strings.Contains(string(body), "build-version") {
				t.Fatalf("missing path served index.html:\n%s", body)
			}
		})
	}

	t.Run("unknown api is json 404", func(t *testing.T) {
		// A single path segment is GET /api/{fingerprint} (user lookup). Use a
		// path that matches no API route.
		resp, err := http.Get(ts.URL + "/api/foo/not-a-route")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body=%q", resp.StatusCode, body)
		}
		if !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
			t.Fatalf("Content-Type = %q, want json", resp.Header.Get("Content-Type"))
		}
		if !strings.Contains(string(body), `"error"`) {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("get api root is json 404", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/api")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("status = %d, want 404; body=%q", resp.StatusCode, body)
		}
	})

	t.Run("health stays available", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/api/health")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})
}
