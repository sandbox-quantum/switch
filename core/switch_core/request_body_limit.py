"""Answers 413 to a request whose body is longer than this server accepts.

Every request body is held to `REQUEST_BODY_MAX_BYTES`, except the routes that
take attachments, which are held to `ATTACHMENT_UPLOAD_MAX_BYTES`: an agent can
post several files in one multipart request, each up to
`AGENT_MEDIA_MAX_BYTES`.

A declared `Content-Length` over the limit is refused before the app sees the
request. A body with no length, or one longer than it declared, is counted as
it is read; once it runs past the limit the app is told the client went away,
whatever it answers is replaced with the 413, and the error that disconnect
raises in it is not passed on.
"""

from __future__ import annotations

import json
import logging
import re

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

ATTACHMENT_UPLOAD_PATHS = (
    re.compile(r"^/agents/[^/]+/rooms/[^/]+/media$"),
    re.compile(r"^/gateway/chats/[^/]+/attachments$"),
)


class RequestBodyLimit:
    def __init__(self, app: ASGIApp, *, max_bytes: int, upload_max_bytes: int) -> None:
        self.app = app
        self._max_bytes = max_bytes
        self._upload_max_bytes = upload_max_bytes

    def limit_for(self, path: str) -> int:
        if any(pattern.match(path) for pattern in ATTACHMENT_UPLOAD_PATHS):
            return self._upload_max_bytes
        return self._max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = self.limit_for(path)
        declared = _content_length(scope)
        if declared is not None and declared > limit:
            logger.warning(
                "%s %s declared a %d-byte body, over the %d-byte limit; answered 413",
                scope.get("method"),
                path,
                declared,
                limit,
            )
            await _too_large(send, limit)
            return

        received = 0
        exceeded = False
        started = False
        replaced = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started, replaced
            if replaced:
                return
            if exceeded and not started:
                started = replaced = True
                await _too_large(send, limit)
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not exceeded:
                raise
        if exceeded:
            logger.warning(
                "%s %s sent a body over the %d-byte limit; answered 413",
                scope.get("method"),
                path,
                limit,
            )
            if not started:
                await _too_large(send, limit)


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def _too_large(send: Send, limit: int) -> None:
    payload = json.dumps(
        {"detail": f"The request body is over this server's {limit}-byte limit."}
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
