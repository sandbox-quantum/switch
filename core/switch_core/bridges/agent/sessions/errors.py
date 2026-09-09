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

**Every failure on a session path wears this envelope, not just the ones a
handler raises.** A host has one decoder per route family, and a rejected token,
a malformed body or a route this server does not have yet reaching it as
`{"detail": ...}` has no `code` to read — it falls through to unknown-error at
exactly the moments the cause is most diagnosable. So `SESSION_PATH_PREFIX` is
checked by the bearer middleware and by the app's `HTTPException` and validation
handlers, and the `HTTPException` one is registered against Starlette's class so
the router's own 404 and 405 reach it too. That is why this module exposes a
renderer taking a status, and a `code_for_status` for failures that arrive with
a status and no code.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

# The contract's own routes for the host side. `/gateway/v1/...`, its other
# half, is served by the gateway app and is not this middleware's business.
SESSION_PATH_PREFIX = "/agent/v1/"


def is_session_path(path: str) -> bool:
    return path.startswith(SESSION_PATH_PREFIX)


# Every code in the contract's own table, plus two it does not name.
#
# `LEASE_HELD`: the contract says the server permits one lease owner and blocks
# the previous one, but gives no code for refusing the second claimant while the
# first is alive, and none of the codes it does give is honest about it.
# `NOT_AUTHORIZED` would say the host may not run this session, which is false
# and would send a correctly configured host away for good.
#
# `INVALID_REQUEST`: the table's codes are all semantic outcomes, and none of
# them covers a body that failed to parse. `INVALID_ANSWER` is 422 too but says
# something specific and untrue about a malformed lease claim.
STATUS_BY_CODE: dict[str, int] = {
    "NOT_AUTHORIZED": 403,
    "NOT_FOUND": 404,
    "HOST_OFFLINE": 503,
    "UNSUPPORTED_CAPABILITY": 422,
    "INVALID_ANSWER": 422,
    "INVALID_REQUEST": 422,
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


def session_error_response(
    code: str, message: str, retryable: bool, status_code: int
) -> JSONResponse:
    """The contract's error body, at a status the caller chooses.

    The status is a parameter because the two doors that use this have already
    been given one. An unauthenticated request is a 401 — HTTP's own answer to a
    missing credential, and not something `STATUS_BY_CODE` should be bent to
    produce, since the contract has only `NOT_AUTHORIZED` at 403 for the
    different fact that the credential was fine and the session was not yours.
    """
    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message, "retryable": retryable},
    )


# The code for a failure nobody chose a code for: a 404 from the router, a 405
# from it, a 401 from the door. These arrive with a status already decided and no
# contract meaning attached, so the code is derived from the status rather than
# the other way round.
#
# `STATUS_BY_CODE` is not the inverse of this and cannot be. It answers "what
# status does the server return when it raises this code", which is a different
# question from "what code names this status" — several codes share 409 and 422,
# and 405 has no contract outcome at all.
_CODE_BY_STATUS: dict[int, str] = {
    401: "NOT_AUTHORIZED",
    403: "NOT_AUTHORIZED",
    404: "NOT_FOUND",
    413: "PAYLOAD_TOO_LARGE",
}


def code_for_status(status_code: int) -> str:
    """The contract code that best names an HTTP failure the server did not raise.

    `INVALID_REQUEST` is the fallback because everything reaching here that is
    not one of the mapped statuses is the server refusing to act on the request
    as sent. It is the least specific honest answer, not a good one.
    """
    return _CODE_BY_STATUS.get(status_code, "INVALID_REQUEST")


async def session_api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Render a `SessionApiError` as the contract's error body."""
    assert isinstance(exc, SessionApiError)
    return session_error_response(exc.code, exc.message, exc.retryable, exc.status_code)
