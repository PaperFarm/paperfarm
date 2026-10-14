.PHONY: build web run dev-server dev-web test canary

# The web app builds into server/internal/webui/dist, which the Go binary embeds: one binary serves everything.
build: web
	cd server && go build -o ../bin/paperfarm ./cmd/paperfarm

web:
	cd web && npm ci --no-audit --no-fund && npm run build

run: build
	./bin/paperfarm serve

# Development: run both. Vite on :5173 proxies /api and /paper to the server on :8080.
dev-server:
	cd server && go run ./cmd/paperfarm serve

dev-web:
	cd web && npm run dev

test:
	cd server && go vet ./... && go test ./...
	cd web && npx tsc -b && npm run check

# One real pair end to end with a funded wallet (spends cents). ENV is a file holding WALLET_KEY=0x...
canary:
	cd server && go run ./cmd/paperfarm canary -env $(ENV)
