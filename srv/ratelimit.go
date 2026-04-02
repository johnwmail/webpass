package srv

import (
	"log/slog"
	"os"
	"strconv"
	"sync"
	"time"
)

// RateLimiter implements a sliding window rate limiter.
// It tracks request timestamps per key (fingerprint or IP) and limits
// the number of requests within a configurable time window.
type RateLimiter struct {
	mu       sync.Mutex
	requests map[string][]time.Time // key → timestamps
	limit    int                    // max requests per window
	window   time.Duration          // window duration
	stopChan chan struct{}          // channel to stop cleanup goroutine
}

// Default configuration values
const (
	defaultLimit     = 5
	defaultWindowMin = 15
)

// NewRateLimiter creates a new rate limiter with configurable limits.
// Values are read from environment variables with sensible defaults.
func NewRateLimiter() *RateLimiter {
	// Parse configuration from environment
	limit := defaultLimit
	windowMin := defaultWindowMin

	if envLimit := os.Getenv("RATE_LIMIT_ATTEMPTS"); envLimit != "" {
		if parsed, err := strconv.Atoi(envLimit); err == nil && parsed > 0 {
			limit = parsed
		} else {
			slog.Warn("invalid RATE_LIMIT_ATTEMPTS, using default", "value", envLimit, "default", defaultLimit)
		}
	}

	if envWindow := os.Getenv("RATE_LIMIT_WINDOW_MINUTES"); envWindow != "" {
		if parsed, err := strconv.Atoi(envWindow); err == nil && parsed > 0 {
			windowMin = parsed
		} else {
			slog.Warn("invalid RATE_LIMIT_WINDOW_MINUTES, using default", "value", envWindow, "default", defaultWindowMin)
		}
	}

	window := time.Duration(windowMin) * time.Minute

	rl := &RateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
		stopChan: make(chan struct{}),
	}

	// Start background cleanup goroutine
	go rl.cleanupLoop()

	return rl
}

// cleanupLoop runs periodically to remove expired timestamps.
// It runs every window/2 minutes to prevent memory growth.
func (rl *RateLimiter) cleanupLoop() {
	// Run cleanup every window/2 (minimum 1 minute)
	interval := rl.window / 2
	if interval < time.Minute {
		interval = time.Minute
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stopChan:
			return
		}
	}
}

// cleanup removes expired timestamps and empty entries.
func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	for key, timestamps := range rl.requests {
		// Filter out expired timestamps
		valid := make([]time.Time, 0, len(timestamps))
		for _, ts := range timestamps {
			if ts.After(cutoff) {
				valid = append(valid, ts)
			}
		}

		if len(valid) == 0 {
			// Remove user entry if no valid timestamps
			delete(rl.requests, key)
		} else {
			// Update with filtered timestamps
			rl.requests[key] = valid
		}
	}
}

// Stop stops the background cleanup goroutine.
func (rl *RateLimiter) Stop() {
	close(rl.stopChan)
}

// Allow checks if a request from the given key should be allowed.
// It returns true if the request is within the limit, false otherwise.
// If allowed, it also records the current timestamp.
// Logs a warning when a request is blocked.
func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	// Get existing timestamps for this key
	timestamps := rl.requests[key]

	// Filter out expired timestamps
	valid := make([]time.Time, 0, len(timestamps))
	for _, ts := range timestamps {
		if ts.After(cutoff) {
			valid = append(valid, ts)
		}
	}

	// Check if limit exceeded
	if len(valid) >= rl.limit {
		// Update the stored timestamps even if rejected (to keep fresh data)
		rl.requests[key] = valid

		// Log rate limit rejection
		slog.Warn("rate limit exceeded",
			"key", key,
			"attempts", len(valid),
			"limit", rl.limit,
			"window_minutes", int(rl.window.Minutes()))

		return false
	}

	// Add current timestamp and allow
	valid = append(valid, now)
	rl.requests[key] = valid
	return true
}

// IsAllowed checks if a request would be allowed without recording it.
// This is useful for checking rate limit status without side effects.
func (rl *RateLimiter) IsAllowed(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	timestamps := rl.requests[key]

	// Count valid timestamps
	count := 0
	for _, ts := range timestamps {
		if ts.After(cutoff) {
			count++
		}
	}

	return count < rl.limit
}

// Remaining returns the number of requests remaining in the current window.
func (rl *RateLimiter) Remaining(key string) int {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	timestamps := rl.requests[key]

	// Count valid timestamps
	count := 0
	for _, ts := range timestamps {
		if ts.After(cutoff) {
			count++
		}
	}

	remaining := rl.limit - count
	if remaining < 0 {
		remaining = 0
	}
	return remaining
}
