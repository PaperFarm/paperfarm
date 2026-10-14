# paperfarm

Farm $PAPER on [Papertrade](https://docs.papertrade.xyz) with delta-neutral pairs that run around the clock.

Papertrade mints PAPER when a position closes at a loss. paperfarm farms it with pairs: a long and a short of equal
size on the same coin, opened together. When price moves, one leg loses (and mints PAPER) and the other wins back
most of it; your real cost is Papertrade's haircut on the win. A farm keeps that cycle running -- open a pair, close
both legs at your take-profit, open the next -- while tracking what each 1,000 PAPER actually cost.

Pairs are sized against the market's position and open-interest limits before anything is sent. An open that has not
filled in 5 minutes expires, a leg left alone is closed, and a leg still queued when its partner failed is cancelled.

## Trust model

Your funds stay in your Papertrade account; deposits and withdrawals happen on Papertrade itself. To trade while
your browser is closed, the server creates a trading key and your wallet registers it on Papertrade with
`RegisterSessionKey` (valid 7 days). A Papertrade session key can open and close positions, but can never withdraw,
stake or claim. Keys are encrypted at rest (AES-GCM, bound to the wallet) with `PAPERFARM_SECRET`, so the worst a
compromised server can do is trade your balance into losses. Revoke a key any time with `revokeSessionKey`, or let
it expire.

Sign-in is a one-time wallet signature (proves ownership; moves nothing) plus an httpOnly, `SameSite=Strict` session
cookie. The page loads no third-party code (strict CSP, self-hosted font), requests are rate-limited per IP, and
only one server process trades at a time (a Postgres advisory lock), so a redeploy never trades twice.

## Run

Needs Go 1.23+ and Node 20+.

```bash
make build                 # builds the web app into one binary
./bin/paperfarm serve      # http://localhost:8080
```

Without `DATABASE_URL`, data lives in files under `./data` and a secret is generated there on first run. For
development, run `make dev-server` and `make dev-web` together (Vite on :5173 proxies the API).

Configuration is environment variables only; see [.env.example](.env.example):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres. Required in production; files under `PAPERFARM_DATA` otherwise. |
| `PAPERFARM_SECRET` | 32+ random characters; encrypts trading keys and signs sessions. Required with a database. |
| `PAPER_PROXIES` | Proxies for calls to Papertrade, round robin, so users do not share one IP's rate limit. |
| `PAPERFARM_TRUST_PROXY` | `1` behind a reverse proxy setting `X-Forwarded-For` / `X-Forwarded-Proto`. |
| `PAPERFARM_PUBLIC_URL` | Public address (`https://...`) for link previews. |
| `PORT` / `PAPERFARM_ADDR` | Listen address (default `:8080`). |

## Deploy

The `Dockerfile` builds one small image running `paperfarm serve`. Add Postgres, set `DATABASE_URL`,
`PAPERFARM_SECRET` and `PAPERFARM_TRUST_PROXY=1`, use `/healthz` as the health check, and run one instance (extra
instances serve the site but do not trade).

## Layout

`server/` is the Go module producing the single `paperfarm` binary: the farm engine, the Papertrade client and
allow-listed proxy, the HTTP API, auth, and storage. `web/` is the React + TypeScript app (Vite), built into
`server/internal/webui/dist` and embedded in the binary.

## Tests

```bash
make test
```

That runs `go vet`, the Go tests (pair lifecycle, engine, signing, auth, rate limits, economics), `tsc`, and the
web checks (the browser signer reproducing the server's test vector byte for byte, pair and protocol maths). Two
optional extras: `LIVE_WALLET=0x... go test -run TestLiveStream ./server` follows a real account's stream
read-only, and `make canary ENV=path/to/file-with-WALLET_KEY` opens and closes one small real pair (cents), after
asking.

## License

MIT. paperfarm is independent and not affiliated with Papertrade. Not financial advice: leverage can lose your
margin, and a leg that reaches its bust price loses all of it.
