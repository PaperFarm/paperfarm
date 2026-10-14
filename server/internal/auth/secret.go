package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
)

// Sealer encrypts trading keys at rest and signs session cookies, both from PAPERFARM_SECRET (32+ chars,
// kept in the settings vault). Lose the secret and the stored keys are unreadable: users set up a new key.
type Sealer struct {
	aead   cipher.AEAD
	macKey []byte
}

func NewSealer(secret string) (*Sealer, error) {
	if len(secret) < 32 {
		return nil, errors.New("PAPERFARM_SECRET must be at least 32 characters")
	}
	k := sha256.Sum256([]byte("paperfarm/keys\x00" + secret))
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	m := sha256.Sum256([]byte("paperfarm/cookies\x00" + secret))
	return &Sealer{aead: aead, macKey: m[:]}, nil
}

// Seal binds the ciphertext to `aad` (the wallet), so a key cannot be moved to another account's record.
func (s *Sealer) Seal(plain []byte, aad string) string {
	nonce := make([]byte, s.aead.NonceSize())
	rand.Read(nonce)
	return base64.StdEncoding.EncodeToString(s.aead.Seal(nonce, nonce, plain, []byte(aad)))
}

func (s *Sealer) Open(sealed, aad string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil || len(b) < s.aead.NonceSize() {
		return nil, errors.New("sealed value is malformed")
	}
	return s.aead.Open(nil, b[:s.aead.NonceSize()], b[s.aead.NonceSize():], []byte(aad))
}

func (s *Sealer) mac(msg string) []byte {
	h := hmac.New(sha256.New, s.macKey)
	h.Write([]byte(msg))
	return h.Sum(nil)
}
