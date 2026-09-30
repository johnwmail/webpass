// Package frontend embeds the built single-page application (SPA) so the
// server can ship as a single self-contained binary.
//
// The Vite build output lives in ./dist. On a fresh checkout the directory
// only contains a committed .gitkeep placeholder, which keeps `go test ./...`
// compiling before the frontend has been built. Run `npm run build` before
// `go build` to embed the real assets.
package frontend

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Dist returns the embedded SPA files rooted at the dist directory.
func Dist() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
