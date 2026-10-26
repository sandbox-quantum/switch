"""The 422 a request that fails validation is answered with.

FastAPI's default answer repeats each pydantic error whole, and an error's
`input` is what was sent: the refused value, or for a missing field the entire
object around it. So a refused password, or a good one beside a missing email,
came back in the response body and into anything that records 4xx bodies. Only
what says what is wrong goes back: `type`, `loc` and `msg`. `ctx` stays out
too, since some error types carry part of the input there (a union tag, the
character a UUID failed on), and no client reads it.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

_PUBLIC_FIELDS = ("type", "loc", "msg")


def public_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    return [
        {field: error[field] for field in _PUBLIC_FIELDS if field in error}
        for error in exc.errors()
    ]


async def validation_error_response(request: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, RequestValidationError):
        raise error
    return JSONResponse(status_code=422, content={"detail": public_errors(error)})
