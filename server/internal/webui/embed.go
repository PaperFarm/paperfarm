// Package webui embeds the built web app, so one binary serves everything.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// App is the web app's files: empty until web/ is built into dist/app (make build).
func App() fs.FS {
	site, _ := fs.Sub(dist, "dist/app")
	return site
}
