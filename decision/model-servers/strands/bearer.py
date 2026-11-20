"""The Strands server's bearer token: with STRANDS_API_KEY set, every request
but GET /health must carry `Authorization: Bearer <key>`, so another pod
reaching the server's port can't use the model. The decision service sends
it (MODEL_SERVER_TOKEN).

Apart from serve.py, which loads the model when imported, so it can be tested
without torch or a GPU."""

import hmac

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def authorized(header: str | None, key: str) -> bool:
    """Whether an Authorization header carries `key` as a bearer token."""
    scheme, _, given = (header or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(
        given.strip().encode(), key.encode()
    )


def require_bearer(app: FastAPI, key: str | None) -> None:
    """Refuse every request to `app` but GET /health without `key`; with no
    key, leave the app open."""
    if not key:
        return

    @app.middleware("http")
    async def check(request: Request, call_next):
        open_path = request.method == "GET" and request.url.path == "/health"
        if not open_path and not authorized(request.headers.get("authorization"), key):
            return JSONResponse(
                status_code=401,
                content={"detail": "missing or wrong bearer token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)
