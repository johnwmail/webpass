package srv

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const testIndexHTML = `<!doctype html>
<html>
  <head>
    <meta name="build-version" content="vdev" />
    <meta name="build-time" content="unknown" />
    <meta name="build-commit" content="unknown" />
    <meta name="pgp-key-timeout-seconds" content="30" />
  </head>
  <body></body>
</html>`

func TestInjectBuildMeta(t *testing.T) {
	out := string(injectBuildMeta([]byte(testIndexHTML), "v0.7.1", "abc1234", "2026-11-09T00:00:00Z"))
	for _, want := range []string{
		`<meta name="build-version" content="v0.7.1" />`,
		`<meta name="build-time" content="2026-11-09T00:00:00Z" />`,
		`<meta name="build-commit" content="abc1234" />`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in output:\n%s", want, out)
		}
	}
}

func TestInjectBuildMetaLeavesEmptyValues(t *testing.T) {
	out := string(injectBuildMeta([]byte(testIndexHTML), "", "", ""))
	if out != testIndexHTML {
		t.Errorf("expected index unchanged for empty metadata, got:\n%s", out)
	}
}

func TestInjectPGPKeyTimeout(t *testing.T) {
	for _, seconds := range []int{45, 0} {
		out := string(injectPGPKeyTimeout([]byte(testIndexHTML), seconds))
		want := fmt.Sprintf(`<meta name="pgp-key-timeout-seconds" content="%d" />`, seconds)
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in output:\n%s", want, out)
		}
	}

	unchanged := string(injectPGPKeyTimeout([]byte(testIndexHTML), -1))
	if unchanged != testIndexHTML {
		t.Errorf("expected no change for an unset timeout, got:\n%s", unchanged)
	}
}

func TestPGPKeyTimeoutConfig(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"", 30},
		{"0", 0},
		{"45", 45},
		{"5", 5},
		{"3600", 3600},
		{"4", 30},
		{"3601", 30},
		{"nope", 30},
	}
	for _, tc := range cases {
		t.Run("env="+tc.env, func(t *testing.T) {
			t.Setenv("PGP_KEY_TIMEOUT_SECONDS", tc.env)
			s := newTestServer(t)
			if s.PGPKeyTimeoutSeconds != tc.want {
				t.Fatalf("PGPKeyTimeoutSeconds = %d, want %d", s.PGPKeyTimeoutSeconds, tc.want)
			}
		})
	}
}

func TestServeIndexHTMLInjectsVersion(t *testing.T) {
	s := &Server{Version: "v0.7.1", Commit: "abc1234", BuildTime: "2026-11-09T00:00:00Z", PGPKeyTimeoutSeconds: 45}
	staticFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(testIndexHTML), ModTime: time.Unix(0, 0)},
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	s.serveIndexHTML(rec, req, staticFS)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `content="v0.7.1"`) {
		t.Errorf("served index missing injected version:\n%s", body)
	}
	if !strings.Contains(body, `content="45"`) {
		t.Errorf("served index missing injected PGP key timeout:\n%s", body)
	}
}
