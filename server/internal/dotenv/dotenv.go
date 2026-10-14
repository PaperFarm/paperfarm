// Package dotenv reads KEY=VALUE files: the server's .env, and the canary's wallet file.
package dotenv

import (
	"os"
	"strings"
)

// Load returns the variables in a KEY=VALUE file. For ".env" it also sets them, without overriding the
// environment.
func Load(path string) map[string]string {
	b, err := os.ReadFile(path)
	out := map[string]string{}
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		out[k] = v
		if path == ".env" && os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
	return out
}
