"""The session API's error envelope, as the contract specifies it.

The rest of the agent bridge answers a failure with `{"detail": ...}` and a
status code. The session routes cannot: the contract gives the host a code
vocabulary to branch on — a host retries `EXPECTED_SEQUENCE` from its outbox and
must not retry `REQUEST_CLOSED` — and a status code alone does not distinguish
the four different 409s. So these routes carry a second, narrower shape, and it
lives here rather than in each handler so the mapping from code to status is
stated once.

`retryable` is about this same request. A stale epoch is not retryable as sent,
because the host has to acquire a lease before it can send anything the server
will take; a lease held by a live incumbent is, because the incumbent may let go
or time out.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

# Every code in the contract's own table, plus one it does not name.
#
# `LEASE_HELD` is the addition: the contract says the server permits one lease
# owner and blocks the previous one, but gives no code for refusing the second
# claimant while the first is alive, and none of the codes it does give is
# honest about it. `NOT_AUTHORIZED` would say the host may not run this session,
# which is false and would send a correctly configured host away for good.
STATUS_BY_CODE: dict[str, int] = {
    "NOT_AUTHORIZED": 403,
    "NOT_FOUND": 404,
    "HOST_OFFLINE": 503,
    "UNSUPPORTED_CAPABILITY": 422,
    "INVALID_ANSWER": 422,
    "PAYLOAD_TOO_LARGE": 413,
    "STALE_EPOCH": 409,
    "STALE_REVISION": 409,
    "REQUEST_BUSY": 409,
    "REQUEST_CLOSED": 409,
    "IDEMPOTENCY_CONFLICT": 409,
    "EXPECTED_SEQUENCE": 409,
    "LEASE_HELD": 409,
    "CURSOR_EXPIRED": 410,
}


class SessionApiError(Exception):
    """A failure the host is meant to read the code of and act on."""

    def __init__(self, code: str, message: str, retryable: bool) -> None:
        if code not in STATUS_BY_CODE:
            raise ValueError(f"{code!r} is not a session API error code.")
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    @property
    def status_code(self) -> int:
        return STATUS_BY_CODE[self.code]


async def session_api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Render a `SessionApiError` as the contract's error body."""
    assert isinstance(exc, SessionApiError)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
        },
    )
