package srv

import (
	"encoding/hex"
	"sync"
	"time"
)

// keyTransferStore keeps temporary, client-encrypted key transfers in memory
// only. Nothing is written to the database: a server restart invalidates any
// in-flight transfer, which is the intended trade-off for this feature.
type keyTransferStore struct {
	mu            sync.Mutex
	byToken       map[string]*keyTransfer
	byFingerprint map[string]*keyTransfer
	ttl           time.Duration
	stop          chan struct{}
	done          chan struct{}
	closeOnce     sync.Once
}

type keyTransfer struct {
	Fingerprint string
	TokenHash   []byte
	Envelope    []byte
	Challenge   string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	CreatedIP   string
	UserAgent   string

	RequestedAt        *time.Time
	RequestedIP        string
	RequestedUserAgent string
	RequestedProof     string

	ApprovedAt *time.Time
	DeniedAt   *time.Time
	UsedAt     *time.Time
}

// NewKeyTransferStore starts an in-memory transfer store with a background
// cleanup loop.
func NewKeyTransferStore() *keyTransferStore {
	st := &keyTransferStore{
		byToken:       make(map[string]*keyTransfer),
		byFingerprint: make(map[string]*keyTransfer),
		ttl:           keyTransferTTL,
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	go st.cleanupLoop()
	return st
}

// Close stops the cleanup goroutine. Safe to call more than once.
func (st *keyTransferStore) Close() {
	if st == nil {
		return
	}
	st.closeOnce.Do(func() {
		close(st.stop)
		<-st.done
	})
}

func (st *keyTransferStore) cleanupLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			st.cleanup()
		case <-st.stop:
			close(st.done)
			return
		}
	}
}

func (st *keyTransferStore) cleanup() {
	st.mu.Lock()
	defer st.mu.Unlock()
	now := time.Now()
	for key, t := range st.byToken {
		if now.After(t.ExpiresAt) || (t.UsedAt != nil && now.Sub(*t.UsedAt) > time.Hour) {
			delete(st.byToken, key)
			if st.byFingerprint[t.Fingerprint] == t {
				delete(st.byFingerprint, t.Fingerprint)
			}
		}
	}
}

func tokenKey(tokenHash []byte) string {
	return hex.EncodeToString(tokenHash)
}

func (st *keyTransferStore) deleteForUserLocked(fp string) {
	if t, ok := st.byFingerprint[fp]; ok {
		delete(st.byToken, tokenKey(t.TokenHash))
		delete(st.byFingerprint, fp)
	}
}

// Create stores a new transfer, replacing any previous one for the account.
func (st *keyTransferStore) Create(fp string, tokenHash, envelope []byte, challenge, ip, ua string) *keyTransfer {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.deleteForUserLocked(fp)
	now := time.Now()
	t := &keyTransfer{
		Fingerprint: fp,
		TokenHash:   append([]byte(nil), tokenHash...),
		Envelope:    append([]byte(nil), envelope...),
		Challenge:   challenge,
		CreatedAt:   now,
		ExpiresAt:   now.Add(st.ttl),
		CreatedIP:   ip,
		UserAgent:   ua,
	}
	st.byToken[tokenKey(t.TokenHash)] = t
	st.byFingerprint[fp] = t
	return t
}

func (st *keyTransferStore) activeLocked(t *keyTransfer, now time.Time) bool {
	return t.UsedAt == nil && t.DeniedAt == nil && now.Before(t.ExpiresAt)
}

// Request records the target device's proof and request metadata.
func (st *keyTransferStore) Request(fp string, tokenHash []byte, ip, ua, proof string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byToken[tokenKey(tokenHash)]
	if t == nil || t.Fingerprint != fp || !st.activeLocked(t, time.Now()) {
		return false
	}
	if t.ApprovedAt != nil || t.DeniedAt != nil || t.UsedAt != nil {
		return false
	}
	now := time.Now()
	t.RequestedAt = &now
	t.RequestedIP = ip
	t.RequestedUserAgent = ua
	t.RequestedProof = proof
	return true
}

// Approve marks the transfer approved. The source device verifies the proof
// locally before calling this.
func (st *keyTransferStore) Approve(fp string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byFingerprint[fp]
	if t == nil || !st.activeLocked(t, time.Now()) || t.DeniedAt != nil || t.UsedAt != nil {
		return false
	}
	if t.ApprovedAt != nil {
		return true
	}
	if t.RequestedAt == nil || t.RequestedProof == "" {
		return false
	}
	now := time.Now()
	t.ApprovedAt = &now
	return true
}

// Deny rejects the transfer and clears the ciphertext.
func (st *keyTransferStore) Deny(fp string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byFingerprint[fp]
	if t == nil || !st.activeLocked(t, time.Now()) {
		return false
	}
	if t.DeniedAt != nil {
		return true
	}
	now := time.Now()
	t.DeniedAt = &now
	t.Envelope = nil
	return true
}

// Claim atomically returns and clears the envelope after approval.
func (st *keyTransferStore) Claim(fp string, tokenHash []byte) ([]byte, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byToken[tokenKey(tokenHash)]
	if t == nil || t.Fingerprint != fp || !st.activeLocked(t, time.Now()) {
		return nil, false
	}
	if t.ApprovedAt == nil || t.DeniedAt != nil || t.UsedAt != nil || len(t.Envelope) == 0 {
		return nil, false
	}
	now := time.Now()
	t.UsedAt = &now
	envelope := append([]byte(nil), t.Envelope...)
	t.Envelope = nil
	return envelope, true
}

// Fetch returns a copy of the ciphertext for local pairing-code verification.
func (st *keyTransferStore) Fetch(fp string) ([]byte, string, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byFingerprint[fp]
	if t == nil || !st.activeLocked(t, time.Now()) || len(t.Envelope) == 0 {
		return nil, "", false
	}
	return append([]byte(nil), t.Envelope...), t.Challenge, true
}

// Status returns a snapshot for the source/target device.
func (st *keyTransferStore) Status(fp string) (keyTransfer, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.byFingerprint[fp]
	if t == nil {
		return keyTransfer{}, false
	}
	return *t, true
}

// DeleteForUser removes any transfer for the account (revoke / account delete).
func (st *keyTransferStore) DeleteForUser(fp string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.deleteForUserLocked(fp)
}

// Test helpers (same package only).

func (st *keyTransferStore) expireForTest(fp string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if t := st.byFingerprint[fp]; t != nil {
		t.ExpiresAt = time.Now().Add(-time.Minute)
	}
}

func (st *keyTransferStore) HasForUser(fp string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	_, ok := st.byFingerprint[fp]
	return ok
}
