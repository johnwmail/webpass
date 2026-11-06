package srv

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/johnwmail/webpass/db/dbgen"
)

const (
	auditUserAgentMax = 255
	auditDetailMax    = 200
	auditListLimit    = 100
)

// audit records a security-relevant event. Failures are logged but never
// prevent the operation that triggered them.
func (s *Server) audit(r *http.Request, fingerprint, event, detail string) {
	if s == nil || s.Q == nil || r == nil {
		return
	}
	ua := r.UserAgent()
	if len(ua) > auditUserAgentMax {
		ua = ua[:auditUserAgentMax]
	}
	if len(detail) > auditDetailMax {
		detail = detail[:auditDetailMax]
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := s.Q.InsertAuditLog(ctx, dbgen.InsertAuditLogParams{
		Fingerprint: fingerprint,
		Event:       event,
		Ip:          getClientIP(r),
		UserAgent:   ua,
		Detail:      detail,
	}); err != nil {
		slog.Warn("audit log insert failed", "event", event, "error", err)
	}
}

// GET /api/{fingerprint}/audit — recent security events for the account
func (s *Server) handleAuditLog(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	logs, err := s.Q.ListAuditLog(r.Context(), dbgen.ListAuditLogParams{
		Fingerprint: fp,
		Limit:       auditListLimit,
	})
	if err != nil {
		slog.Error("list audit log", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	type entry struct {
		ID        int64     `json:"id"`
		Event     string    `json:"event"`
		IP        string    `json:"ip"`
		UserAgent string    `json:"user_agent"`
		Detail    string    `json:"detail"`
		CreatedAt time.Time `json:"created_at"`
	}
	entries := make([]entry, len(logs))
	for i, l := range logs {
		entries[i] = entry{
			ID:        l.ID,
			Event:     l.Event,
			IP:        l.Ip,
			UserAgent: l.UserAgent,
			Detail:    l.Detail,
			CreatedAt: l.CreatedAt,
		}
	}
	jsonOK(w, map[string]any{"logs": entries})
}
