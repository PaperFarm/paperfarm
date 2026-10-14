// Package store keeps wallet documents and the trading lease, in Postgres or files.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/sys/unix"
)

// Store keeps each wallet's document (its encrypted trading key, farms and pairs). Postgres when
// DATABASE_URL is set (Railway), files in PAPERFARM_DATA otherwise.
//
// The trading lease is held by the one process allowed to sign. A redeploy starts the new process
// before the old one stops; the new one waits in Acquire until the lease frees, so no two engines
// ever trade the same account.
type Store interface {
	Load(key string) ([]byte, error) // (nil, nil) when missing
	Save(key string, b []byte) error
	Keys(prefix string) ([]string, error)
	Acquire(ctx context.Context) error
	Check(ctx context.Context) error
}

func Open(dir string) (Store, error) {
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		db, err := sql.Open("pgx", dsn)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v bytea NOT NULL, t timestamptz NOT NULL DEFAULT now())`); err != nil {
			return nil, fmt.Errorf("db schema: %w", err)
		}
		db.SetMaxOpenConns(8)
		return &pgStore{db: db}, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &fileStore{dir: dir}, nil
}

// ---- Postgres ----

type pgStore struct {
	db    *sql.DB
	mu    sync.Mutex
	lease *sql.Conn
	lost  bool
}

const leaseID = 7014

func dbCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

func (s *pgStore) Load(key string) ([]byte, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	var v []byte
	err := s.db.QueryRowContext(ctx, `SELECT v FROM kv WHERE k=$1`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return v, err
}

func (s *pgStore) Save(key string, b []byte) error {
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := s.db.ExecContext(ctx, `INSERT INTO kv (k, v, t) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v=$2, t=now()`, key, b)
	return err
}

func (s *pgStore) Keys(prefix string) ([]string, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	rows, err := s.db.QueryContext(ctx, `SELECT k FROM kv WHERE starts_with(k, $1) ORDER BY k`, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *pgStore) Acquire(ctx context.Context) error {
	conn, err := s.db.Conn(ctx) // the advisory lock lives on this connection for the life of the process
	if err != nil {
		return err
	}
	for {
		var got bool
		if err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, leaseID).Scan(&got); err != nil {
			conn.Close()
			return err
		}
		if got {
			s.mu.Lock()
			s.lease, s.lost = conn, false
			s.mu.Unlock()
			return nil
		}
		select {
		case <-ctx.Done():
			conn.Close()
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

func (s *pgStore) Check(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lost || s.lease == nil {
		return errors.New("trading lease unavailable")
	}
	var held bool
	err := s.lease.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=$1 AND granted)`, leaseID).Scan(&held)
	if err != nil || !held {
		s.lost = true
		return fmt.Errorf("trading lease lost: %v", err)
	}
	return nil
}

// ---- files ----

type fileStore struct {
	dir  string
	mu   sync.Mutex
	lock *os.File
}

func (s *fileStore) path(key string) string {
	return filepath.Join(s.dir, strings.NewReplacer("/", "_", ":", "_", "..", "_").Replace(key)+".json")
}

func (s *fileStore) Load(key string) ([]byte, error) {
	b, err := os.ReadFile(s.path(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func (s *fileStore) Save(key string, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := s.path(key) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(key))
}

func (s *fileStore) Keys(prefix string) ([]string, error) {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	want := strings.NewReplacer("/", "_", ":", "_").Replace(prefix)
	var out []string
	for _, e := range ents {
		n := strings.TrimSuffix(e.Name(), ".json")
		if strings.HasPrefix(n, want) && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, prefix+strings.TrimPrefix(n, want))
		}
	}
	sort.Strings(out)
	return out, nil
}

func (s *fileStore) Acquire(ctx context.Context) error {
	f, err := os.OpenFile(filepath.Join(s.dir, ".trading.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	for {
		if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
			s.lock = f
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			f.Close()
			return err
		}
		select {
		case <-ctx.Done():
			f.Close()
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (s *fileStore) Check(ctx context.Context) error {
	if s.lock == nil {
		return errors.New("trading lock not acquired")
	}
	return ctx.Err()
}
