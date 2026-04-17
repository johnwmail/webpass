package srv

import (
	"net/http"
	"testing"
)

func TestAPIError(t *testing.T) {
	tests := []struct {
		name     string
		err      APIError
		wantMsg  string
		wantCode ErrorCode
		wantHTTP int
	}{
		{
			name:     "bad request",
			err:      ErrBadRequest,
			wantMsg:  "bad request",
			wantCode: ErrCodeBadRequest,
			wantHTTP: http.StatusBadRequest,
		},
		{
			name:     "unauthorized",
			err:      ErrUnauthorized,
			wantMsg:  "unauthorized",
			wantCode: ErrCodeUnauthorized,
			wantHTTP: http.StatusUnauthorized,
		},
		{
			name:     "forbidden",
			err:      ErrForbidden,
			wantMsg:  "forbidden",
			wantCode: ErrCodeForbidden,
			wantHTTP: http.StatusForbidden,
		},
		{
			name:     "not found",
			err:      ErrNotFound,
			wantMsg:  "not found",
			wantCode: ErrCodeNotFound,
			wantHTTP: http.StatusNotFound,
		},
		{
			name:     "conflict",
			err:      ErrConflict,
			wantMsg:  "conflict",
			wantCode: ErrCodeConflict,
			wantHTTP: http.StatusConflict,
		},
		{
			name:     "internal",
			err:      ErrInternal,
			wantMsg:  "internal error",
			wantCode: ErrCodeInternal,
			wantHTTP: http.StatusInternalServerError,
		},
		{
			name:     "too many",
			err:      ErrTooMany,
			wantMsg:  "too many requests",
			wantCode: ErrCodeTooMany,
			wantHTTP: http.StatusTooManyRequests,
		},
		{
			name:     "custom error",
			err:      NewAPIError(ErrCodeNotFound, "custom message"),
			wantMsg:  "custom message",
			wantCode: ErrCodeNotFound,
			wantHTTP: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err.Message != tt.wantMsg {
				t.Errorf("Message = %q, want %q", tt.err.Message, tt.wantMsg)
			}
			if tt.err.Code != tt.wantCode {
				t.Errorf("Code = %q, want %q", tt.err.Code, tt.wantCode)
			}
			if tt.err.StatusCode() != tt.wantHTTP {
				t.Errorf("StatusCode() = %d, want %d", tt.err.StatusCode(), tt.wantHTTP)
			}
		})
	}
}

func TestAPIError_Error(t *testing.T) {
	err := NewAPIError(ErrCodeBadRequest, "test message")
	want := "bad_request: test message"
	if got := err.Error(); got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestAPIError_Unwrap(t *testing.T) {
	err := NewAPIError(ErrCodeInternal, "internal error")
	got := err.Unwrap()
	if got.Error() != "internal error" {
		t.Errorf("Unwrap() = %v, want 'internal error'", got)
	}
}
