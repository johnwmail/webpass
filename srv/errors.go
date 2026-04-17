package srv

import (
	"errors"
	"fmt"
	"net/http"
)

type ErrorCode string

const (
	ErrCodeBadRequest   ErrorCode = "bad_request"
	ErrCodeUnauthorized ErrorCode = "unauthorized"
	ErrCodeForbidden    ErrorCode = "forbidden"
	ErrCodeNotFound     ErrorCode = "not_found"
	ErrCodeConflict     ErrorCode = "conflict"
	ErrCodeInternal     ErrorCode = "internal"
	ErrCodeTooMany      ErrorCode = "too_many_requests"
)

type APIError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func (e APIError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e APIError) Unwrap() error {
	return errors.New(e.Message)
}

func (e APIError) StatusCode() int {
	switch e.Code {
	case ErrCodeBadRequest:
		return http.StatusBadRequest
	case ErrCodeUnauthorized:
		return http.StatusUnauthorized
	case ErrCodeForbidden:
		return http.StatusForbidden
	case ErrCodeNotFound:
		return http.StatusNotFound
	case ErrCodeConflict:
		return http.StatusConflict
	case ErrCodeInternal:
		return http.StatusInternalServerError
	case ErrCodeTooMany:
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}

var (
	ErrBadRequest   = APIError{Code: ErrCodeBadRequest, Message: "bad request"}
	ErrUnauthorized = APIError{Code: ErrCodeUnauthorized, Message: "unauthorized"}
	ErrForbidden    = APIError{Code: ErrCodeForbidden, Message: "forbidden"}
	ErrNotFound     = APIError{Code: ErrCodeNotFound, Message: "not found"}
	ErrConflict     = APIError{Code: ErrCodeConflict, Message: "conflict"}
	ErrInternal     = APIError{Code: ErrCodeInternal, Message: "internal error"}
	ErrTooMany      = APIError{Code: ErrCodeTooMany, Message: "too many requests"}
)

func NewAPIError(code ErrorCode, message string) APIError {
	return APIError{Code: code, Message: message}
}
