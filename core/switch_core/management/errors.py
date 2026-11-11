"""The error envelope every management route answers with.

`{"error": {"code", "message", "retryable"}}`, with `code` from
`reason_codes`. Routes raise `ManagementError`; `ManagementRoute` turns it,
and a request that fails validation, into that envelope, so neither the agent
bridge's nor the gateway's own `{"detail": ...}` handlers are involved.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from switch_core.management import reason_codes
from switch_core.observability.hosted import record_credential_refusal, route_kind


class ManagementError(Exception):
    def __init__(
        self, status_code: int, code: str, message: str, *, retryable: bool = False
    ) -> None:
        super().__init__(message)
        if code not in reason_codes.ALL_REASON_CODES:
            raise ValueError(f"Unknown reason code: {code!r}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable

    def body(self) -> dict[str, Any]:
        return error_body(self.code, self.message, retryable=self.retryable)


def error_body(code: str, message: str, *, retryable: bool) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


def not_found(what: str) -> ManagementError:
    return ManagementError(404, reason_codes.NOT_FOUND, f"{what} not found")


def _describe_validation(exc: RequestValidationError) -> str:
    parts = []
    for error in exc.errors():
        location = ".".join(str(part) for part in error.get("loc", ()))
        parts.append(f"{location}: {error.get('msg', 'invalid')}")
    return "; ".join(parts) or "invalid request"


class ManagementRoute(APIRoute):
    """An APIRoute that answers failures in the management error envelope."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def envelope(request: Request) -> Response:
            try:
                return await handler(request)
            except ManagementError as exc:
                if exc.status_code == 401:
                    # A refused credential, counted by its code and kind of
                    # route only: `controller` on the controller routes (a
                    # bearer token, as the agent routes count it), else
                    # `management` (token exchange, enrolment, the gateway's).
                    kind = route_kind(request.url.path)
                    record_credential_refusal(
                        exc.code, "controller" if kind == "controller" else "management"
                    )
                return JSONResponse(exc.body(), status_code=exc.status_code)
            except RequestValidationError as exc:
                return JSONResponse(
                    error_body(
                        reason_codes.VALIDATION_ERROR,
                        _describe_validation(exc),
                        retryable=False,
                    ),
                    status_code=422,
                )

        return envelope
