// paperfarm: farm PAPER on Papertrade with delta-neutral pairs that run on the server.
//
//	paperfarm [serve]   the web app, its JSON API and the Papertrade proxy
//	paperfarm canary    one real hedged pair, end to end, from a key in an env file
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"paperfarm/internal/auth"
	"paperfarm/internal/canary"
	"paperfarm/internal/dotenv"
	"paperfarm/internal/farm"
	"paperfarm/internal/httpapi"
	"paperfarm/internal/paper"
	"paperfarm/internal/stats"
	"paperfarm/internal/store"
	"paperfarm/internal/webui"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetOutput(os.Stdout) // hosts read stderr as errors
	dotenv.Load(".env")
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		serve()
	case "canary":
		canary.Run(os.Args[2:])
	default:
		log.Fatalf("unknown command %q (serve, canary)", cmd)
	}
}

// secret is PAPERFARM_SECRET. Locally, without a database, one is generated once into the data dir so
// development needs no setup; with a database (production) it must be set.
func secret(data string) string {
	if s := os.Getenv("PAPERFARM_SECRET"); s != "" {
		return s
	}
	if os.Getenv("DATABASE_URL") != "" {
		log.Fatal("PAPERFARM_SECRET is required (32+ random characters); it encrypts the stored trading keys")
	}
	f := filepath.Join(data, ".secret")
	if b, err := os.ReadFile(f); err == nil && len(b) >= 32 {
		return string(b)
	}
	b := make([]byte, 32)
	rand.Read(b)
	s := hex.EncodeToString(b)
	if err := os.WriteFile(f, []byte(s), 0o600); err != nil {
		log.Fatal(err)
	}
	return s
}

func serve() {
	addr, data := env("PORT", ""), env("PAPERFARM_DATA", "data")
	if addr == "" {
		addr = env("PAPERFARM_ADDR", ":8080")
	} else {
		addr = ":" + addr // Railway and friends set PORT
	}
	if err := os.MkdirAll(data, 0o700); err != nil {
		log.Fatal(err)
	}
	pc := paper.New()
	hist := stats.NewHistory(pc)
	st, err := store.Open(data)
	if err != nil {
		log.Fatal(err)
	}
	seal, err := auth.NewSealer(secret(data))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	engine := farm.NewEngine(ctx, st, pc, seal)
	go engine.Run()
	h := httpapi.Handler(engine, pc, hist, seal, webui.App())

	storeKind := "files in " + data
	if os.Getenv("DATABASE_URL") != "" {
		storeKind = "Postgres"
	}
	log.Printf("paperfarm on %s, %s, Papertrade via %s", addr, storeKind, paper.Proxies())
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan struct{})
	go func() {
		<-ctx.Done() // SIGTERM on a redeploy: stop taking requests and starting trades; the next process takes the trading lease
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
		engine.Shutdown(15 * time.Second) // within the host's 30 s grace: finish trades in flight, save every account
		close(done)
	}()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
}
