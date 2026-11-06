"""A small async client for the parts of the Webex REST API a bot uses.

Webex's own Python SDK is synchronous, and switch-core runs every bridge on one
event loop, so the few calls the adapter makes go through httpx instead. Every
refusal comes back as `WebexAPIError` carrying the HTTP status and Webex's own
explanation, so the adapter can tell a rejected token from a refused operation
without reading words out of a message.
"""

from __future__ import annotations

import email.message
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://webexapis.com/v1"

# Webex answers within a few seconds or not at all; a stuck call would hold up
# the delivery that is waiting on it.
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# Where Webex serves a message's files. The bot's token goes with a download,
# so a link anywhere else is refused rather than followed.
_FILE_HOST = "webexapis.com"


class WebexAPIError(Exception):
    """Webex refused a call. `status` is the HTTP status it answered with, and
    `retry_after` the seconds it asked for, where it asked for any."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        tracking_id: str | None,
        retry_after: float | None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.tracking_id = tracking_id
        self.retry_after = retry_after


@dataclass(frozen=True)
class FileInfo:
    """What Webex says about a file before it is downloaded."""

    filename: str
    mimetype: str
    size: int | None


def _explain(response: httpx.Response) -> str:
    """Webex's own explanation of a refusal, or the status line without one."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        message = body.get("message")
        if isinstance(message, str) and message:
            return message
        errors = body.get("errors")
        if isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict) and isinstance(first.get("description"), str):
                return str(first["description"])
    return f"HTTP {response.status_code} {response.reason_phrase}".strip()


def _refusal(response: httpx.Response, message: str) -> WebexAPIError:
    wait = response.headers.get("retry-after", "")
    return WebexAPIError(
        response.status_code,
        message,
        tracking_id=response.headers.get("trackingid"),
        retry_after=float(wait) if wait.isdecimal() else None,
    )


def _require_file_host(url: str) -> None:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not (
        host == _FILE_HOST or host.endswith(f".{_FILE_HOST}")
    ):
        raise UntrustedFileLink(url)


def _filename_of(response: httpx.Response, fallback: str) -> str:
    disposition = response.headers.get("content-disposition")
    if disposition:
        parsed = email.message.Message()
        parsed["content-disposition"] = disposition
        name = parsed.get_filename()
        if name:
            return name
    return fallback


def _mimetype_of(response: httpx.Response) -> str:
    return (
        response.headers.get("content-type", "application/octet-stream")
        .split(";", 1)[0]
        .strip()
        or "application/octet-stream"
    )


def _size_of(response: httpx.Response) -> int | None:
    length = response.headers.get("content-length")
    if length is None or not length.isdecimal():
        return None
    return int(length)


class WebexClient:
    """One bot's view of the Webex API, authenticated with its access token."""

    def __init__(
        self, token: str, *, transport: httpx.AsyncBaseTransport | None
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=API_BASE,
            headers={"Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        response = await self._http.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise _refusal(response, _explain(response))
        return response

    async def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self._request(method, path, **kwargs)
        if not response.content:
            return {}
        body = response.json()
        if not isinstance(body, dict):
            raise _refusal(
                response,
                f"Webex answered {method} {path} with something other than an object",
            )
        return body

    async def _items(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        body = await self._json("GET", path, params=params)
        items = body.get("items")
        return (
            [item for item in items if isinstance(item, dict)]
            if isinstance(items, list)
            else []
        )

    # ── People ───────────────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        return await self._json("GET", "/people/me")

    async def person(self, person_id: str) -> dict[str, Any]:
        return await self._json("GET", f"/people/{person_id}")

    async def search_people(self, query: str, *, limit: int) -> list[dict[str, Any]]:
        key = "email" if "@" in query else "displayName"
        return await self._items("/people", {key: query, "max": limit})

    # ── Messages ─────────────────────────────────────────────────────────────

    async def message(self, message_id: str) -> dict[str, Any]:
        return await self._json("GET", f"/messages/{message_id}")

    async def recent_messages(
        self, room_id: str, *, mentioning_me: bool, limit: int
    ) -> list[dict[str, Any]]:
        """The newest messages in a space, newest first.

        A bot may list a group space's messages only where they mention it,
        which is also all it is ever sent there; `mentioning_me` asks for
        exactly that."""
        params: dict[str, Any] = {"roomId": room_id, "max": limit}
        if mentioning_me:
            params["mentionedPeople"] = "me"
        return await self._items("/messages", params)

    async def thread_replies(
        self, room_id: str, parent_id: str, *, limit: int
    ) -> list[dict[str, Any]]:
        """The replies under a message, newest first."""
        return await self._items(
            "/messages", {"roomId": room_id, "parentId": parent_id, "max": limit}
        )

    async def post_message(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._json("POST", "/messages", json=body)

    async def post_file(
        self,
        fields: dict[str, str],
        *,
        filename: str,
        mimetype: str,
        data: bytes,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            "/messages",
            data=fields,
            files={"files": (filename, data, mimetype)},
        )

    async def edit_message(
        self,
        message_id: str,
        *,
        room_id: str,
        markdown: str,
        attachments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Replace a message's text and its cards.

        An edit that names no attachments takes away the ones the message had,
        so `attachments` is what the message shows afterwards, not an addition."""
        body: dict[str, Any] = {"roomId": room_id, "markdown": markdown}
        if attachments:
            body["attachments"] = attachments
        return await self._json("PUT", f"/messages/{message_id}", json=body)

    async def delete_message(self, message_id: str) -> None:
        await self._request("DELETE", f"/messages/{message_id}")

    async def file_info(self, url: str) -> FileInfo:
        _require_file_host(url)
        response = await self._request("HEAD", url)
        return FileInfo(
            filename=_filename_of(response, "file"),
            mimetype=_mimetype_of(response),
            size=_size_of(response),
        )

    async def download(self, url: str, *, max_bytes: int) -> tuple[FileInfo, bytes]:
        """The file at `url`, refusing it as soon as it passes `max_bytes`."""
        _require_file_host(url)
        async with self._http.stream("GET", url) as response:
            if response.status_code >= 400:
                await response.aread()
                raise _refusal(response, _explain(response))
            info = FileInfo(
                filename=_filename_of(response, "file"),
                mimetype=_mimetype_of(response),
                size=_size_of(response),
            )
            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > max_bytes:
                    raise FileTooLarge(info.filename, max_bytes)
                chunks.append(chunk)
        return info, b"".join(chunks)

    # ── Card presses ─────────────────────────────────────────────────────────

    async def attachment_action(self, action_id: str) -> dict[str, Any]:
        return await self._json("GET", f"/attachment/actions/{action_id}")

    # ── Spaces and memberships ───────────────────────────────────────────────

    async def room(self, room_id: str) -> dict[str, Any]:
        return await self._json("GET", f"/rooms/{room_id}")

    async def create_room(self, title: str) -> dict[str, Any]:
        return await self._json("POST", "/rooms", json={"title": title})

    async def delete_room(self, room_id: str) -> None:
        await self._request("DELETE", f"/rooms/{room_id}")

    async def add_member(self, room_id: str, person_id: str) -> dict[str, Any]:
        return await self._json(
            "POST", "/memberships", json={"roomId": room_id, "personId": person_id}
        )

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def webhooks(self) -> list[dict[str, Any]]:
        return await self._items("/webhooks", {"max": 100})

    async def create_webhook(
        self, *, name: str, target_url: str, resource: str, event: str, secret: str
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            "/webhooks",
            json={
                "name": name,
                "targetUrl": target_url,
                "resource": resource,
                "event": event,
                "secret": secret,
            },
        )

    async def delete_webhook(self, webhook_id: str) -> None:
        await self._request("DELETE", f"/webhooks/{webhook_id}")


class FileTooLarge(Exception):
    """A file grew past the bridge's ceiling while it was being downloaded."""

    def __init__(self, filename: str, max_bytes: int) -> None:
        super().__init__(f"{filename} is larger than {max_bytes} bytes")
        self.filename = filename
        self.max_bytes = max_bytes


class UntrustedFileLink(Exception):
    """A message named a file somewhere other than Webex's own file host."""

    def __init__(self, url: str) -> None:
        super().__init__(f"{urlsplit(url).hostname or url} is not a Webex file host")
