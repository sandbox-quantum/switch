"""The slice of the Webex REST API the bridge uses.

Thin on purpose: one method per call, typed failures, and nothing that decides
what Switch does with an answer. The adapter owns that.
"""

from __future__ import annotations

import math
from typing import Any
from urllib.parse import urlsplit

import httpx

API_ORIGIN = "https://webexapis.com"
API_BASE = f"{API_ORIGIN}/v1"

# Every file a message carries is fetched from this host, with the bot's own
# token. A file URL naming any other host is refused rather than fetched: the
# token would go wherever the URL said.
_FILE_HOST = "webexapis.com"


class WebexApiError(Exception):
    """Webex answered a call with an error status.

    `retry_after` is the wait Webex asked for, on a 429 (rate limit) or a 423
    (a file still being scanned for malware), and None otherwise.
    """

    def __init__(
        self, status: int, message: str, *, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

    @property
    def rejected_credentials(self) -> bool:
        return self.status == 401

    @property
    def throttled(self) -> bool:
        return self.status == 429


class FileTooLarge(Exception):
    """A file is over the size the bridge will relay."""

    def __init__(self, size: int | None, limit: int) -> None:
        shown = f"{size} bytes" if size is not None else "larger than that"
        super().__init__(f"{shown}; the limit is {limit} bytes")
        self.size = size
        self.limit = limit


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def _error(response: httpx.Response) -> WebexApiError:
    message = f"Webex answered HTTP {response.status_code}"
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get("message"), str):
        message = f"{message}: {payload['message']}"
    return WebexApiError(
        response.status_code, message, retry_after=_retry_after(response)
    )


def is_webex_file_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "https" and (parts.hostname or "").lower() == _FILE_HOST


def _filename_from_disposition(header: str) -> str | None:
    for part in header.split(";"):
        key, _, value = part.strip().partition("=")
        if key.lower() == "filename" and value:
            return value.strip().strip('"') or None
    return None


class WebexClient:
    """Calls Webex as one bot, with its token."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http

    @classmethod
    def connect(
        cls, token: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> WebexClient:
        """A client of its own. `transport` is for tests."""
        return cls(
            httpx.AsyncClient(
                base_url=API_BASE,
                headers={"Authorization": f"Bearer {token}"},
                timeout=httpx.Timeout(30.0, connect=10.0),
                follow_redirects=False,
                trust_env=False,
                transport=transport,
            )
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> dict[str, Any]:
        response = await self._http.request(
            method, path, json=json, params=params, data=data, files=files
        )
        if response.is_error:
            raise _error(response)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise WebexApiError(
                response.status_code, "Webex answered with a body that is not JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise WebexApiError(
                response.status_code, "Webex answered with a body that is not an object"
            )
        return payload

    # ── People and rooms ─────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        return await self._call("GET", "/people/me")

    async def person(self, person_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/people/{person_id}")

    async def room(self, room_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/rooms/{room_id}")

    async def create_room(self, title: str) -> dict[str, Any]:
        return await self._call("POST", "/rooms", json={"title": title})

    async def add_member(self, room_id: str, person: str) -> None:
        key = "personEmail" if "@" in person else "personId"
        await self._call("POST", "/memberships", json={"roomId": room_id, key: person})

    async def leave_room(self, room_id: str, bot_id: str) -> None:
        found = await self._call(
            "GET", "/memberships", params={"roomId": room_id, "personId": bot_id}
        )
        for membership in found.get("items") or []:
            if isinstance(membership, dict) and membership.get("id"):
                await self._call("DELETE", f"/memberships/{membership['id']}")

    # ── Messages ─────────────────────────────────────────────────────────────

    async def message(self, message_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/messages/{message_id}")

    async def post_message(self, body: dict[str, Any]) -> str:
        sent = await self._call("POST", "/messages", json=body)
        return _message_id(sent)

    async def post_file(
        self,
        room_id: str,
        markdown: str | None,
        parent_id: str | None,
        filename: str,
        mimetype: str,
        data: bytes,
    ) -> str:
        """One file in one message, which is all Webex takes per message."""
        fields = {"roomId": room_id}
        if markdown:
            fields["markdown"] = markdown
        if parent_id:
            fields["parentId"] = parent_id
        sent = await self._call(
            "POST",
            "/messages",
            data=fields,
            files={"files": (filename, data, mimetype)},
        )
        return _message_id(sent)

    async def edit_message(self, message_id: str, body: dict[str, Any]) -> None:
        await self._call("PUT", f"/messages/{message_id}", json=body)

    async def delete_message(self, message_id: str) -> None:
        await self._call("DELETE", f"/messages/{message_id}")

    async def attachment_action(self, action_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/attachment/actions/{action_id}")

    async def download(self, url: str, *, limit: int) -> tuple[str, str, bytes]:
        """A message's file: its name, type and bytes, refused past `limit`.

        The declared length is checked before any of the body is read, and the
        body is counted as it streams, so an oversized file is never held in
        memory whatever the headers claimed.
        """
        if not is_webex_file_url(url):
            raise WebexApiError(0, "the file is not hosted by Webex")
        async with self._http.stream("GET", url) as response:
            if response.is_error:
                await response.aread()
                raise _error(response)
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > limit:
                raise FileTooLarge(int(declared), limit)
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > limit:
                    raise FileTooLarge(None, limit)
                chunks.append(chunk)
            name = _filename_from_disposition(
                response.headers.get("content-disposition", "")
            )
            mimetype = response.headers.get("content-type", "application/octet-stream")
        fallback = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1] or "attachment"
        return name or fallback, mimetype, b"".join(chunks)

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def list_webhooks(self) -> list[dict[str, Any]]:
        listed = await self._call("GET", "/webhooks", params={"max": "100"})
        return [hook for hook in listed.get("items") or [] if isinstance(hook, dict)]

    async def create_webhook(self, body: dict[str, Any]) -> None:
        await self._call("POST", "/webhooks", json=body)

    async def update_webhook(self, webhook_id: str, body: dict[str, Any]) -> None:
        await self._call("PUT", f"/webhooks/{webhook_id}", json=body)

    async def delete_webhook(self, webhook_id: str) -> None:
        try:
            await self._call("DELETE", f"/webhooks/{webhook_id}")
        except WebexApiError as exc:
            if exc.status != 404:
                raise


def _message_id(sent: dict[str, Any]) -> str:
    message_id = sent.get("id")
    if not isinstance(message_id, str) or not message_id:
        raise WebexApiError(502, "Webex accepted the message but returned no id")
    return message_id
