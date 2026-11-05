"""What a refused request is told, without what it sent.

A pydantic error's `input` is what was sent: the refused value, or for a
missing field or a check across fields the entire object around it. FastAPI's
default 422 repeats each error whole, and `str()` of a `ValidationError` quotes
every `input`, cut to its first and last few characters, so a short secret
whole. Either way a password, or a bridge's bot token, came back in the
response and into anything that records error bodies. Only what says what is
wrong goes back: `type`, `loc` and `msg`. `ctx` stays out too, since some error
types carry part of the input there (a union tag, the character a UUID failed
on), and no client reads it.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

_PUBLIC_FIELDS = ("type", "loc", "msg")


def public_errors(
    exc: ValidationError | RequestValidationError,
) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = [dict(error) for error in exc.errors()]
    return [
        {field: error[field] for field in _PUBLIC_FIELDS if field in error}
        for error in errors
    ]


def describe_errors(exc: ValidationError) -> str:
    """The errors as one sentence, for a route whose `detail` is text."""
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
        if error["loc"]
        else error["msg"]
        for error in public_errors(exc)
    )


async def validation_error_response(request: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, RequestValidationError):
        raise error
    return JSONResponse(status_code=422, content={"detail": public_errors(error)})
