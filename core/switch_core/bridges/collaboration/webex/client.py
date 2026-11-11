"""A small client for the Webex REST API, as one bot.

Only the calls the adapter makes are here. The bot token is sent in the
`Authorization` header and is never part of a URL, a log line or an error.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

logger = logging.getLogger(__name__)

API = "https://webexapis.com/v1"
# Longest we wait out one rate limit before giving up on the request.
_MAX_RETRY_AFTER_SECONDS = 30.0
_RATE_LIMIT_RETRIES = 3


class WebexAPIError(Exception):
    """Webex answered with an error. `message` is Webex's own explanation."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"Webex answered {status}: {message}")
        self.status = status
        self.message = message


def _error_from(response: httpx.Response) -> WebexAPIError:
    try:
        body = response.json()
    except ValueError:
        body = None
    message = ""
    if isinstance(body, dict):
        message = str(body.get("message") or "")
        errors = body.get("errors")
        if not message and isinstance(errors, list) and errors:
            message = str(errors[0].get("description", ""))
    return WebexAPIError(response.status_code, message or "no explanation given")


def _retry_after(response: httpx.Response) -> float:
    try:
        seconds = float(response.headers.get("retry-after", "1"))
    except ValueError:
        seconds = 1.0
    return min(seconds, _MAX_RETRY_AFTER_SECONDS)


class WebexClient:
    def __init__(self, bot_token: str, http: httpx.AsyncClient) -> None:
        self._headers = {"Authorization": f"Bearer {bot_token}"}
        self._http = http

    async def aclose(self) -> None:
        await self._http.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> Any:
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            response = await self._http.request(
                method,
                API + path,
                params=params,
                json=body if files is None else None,
                data=data,
                files=files,
                headers=self._headers,
                timeout=60.0,
            )
            if response.is_success:
                return response.json() if response.content else {}
            if response.status_code == 429 and attempt < _RATE_LIMIT_RETRIES:
                await asyncio.sleep(_retry_after(response))
                continue
            raise _error_from(response)
        raise AssertionError("unreachable")

    # ── Identity ─────────────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        result: dict[str, Any] = await self.request("GET", "/people/me")
        return result

    # ── Messages ─────────────────────────────────────────────────────────────

    async def message(self, message_id: str) -> dict[str, Any]:
        result: dict[str, Any] = await self.request("GET", f"/messages/{message_id}")
        return result

    async def create_message(self, body: dict[str, Any]) -> str:
        result = await self.request("POST", "/messages", body=body)
        return str(result["id"])

    async def create_message_with_file(
        self, fields: dict[str, str], filename: str, mimetype: str, data: bytes
    ) -> str:
        result = await self.request(
            "POST",
            "/messages",
            data=fields,
            files={"files": (filename, data, mimetype)},
        )
        return str(result["id"])

    async def update_message(self, message_id: str, body: dict[str, Any]) -> None:
        await self.request("PUT", f"/messages/{message_id}", body=body)

    async def delete_message(self, message_id: str) -> None:
        await self.request("DELETE", f"/messages/{message_id}")

    @asynccontextmanager
    async def download(self, url: str) -> AsyncIterator[httpx.Response]:
        """A streaming response for a file attached to a message. The caller
        reads at most as many bytes as it is willing to keep."""
        request = self._http.build_request(
            "GET", url, headers=self._headers, timeout=120.0
        )
        response = await self._http.send(request, stream=True)
        try:
            if not response.is_success:
                await response.aread()
                raise _error_from(response)
            yield response
        finally:
            await response.aclose()

    # ── Spaces and people ────────────────────────────────────────────────────

    async def room(self, room_id: str) -> dict[str, Any]:
        result: dict[str, Any] = await self.request("GET", f"/rooms/{room_id}")
        return result

    async def create_room(self, title: str) -> str:
        result = await self.request("POST", "/rooms", body={"title": title})
        return str(result["id"])

    async def add_member(self, room_id: str, person_id: str) -> None:
        await self.request(
            "POST", "/memberships", body={"roomId": room_id, "personId": person_id}
        )

    async def memberships(self, room_id: str, person_id: str) -> list[dict[str, Any]]:
        result = await self.request(
            "GET", "/memberships", params={"roomId": room_id, "personId": person_id}
        )
        items: list[dict[str, Any]] = result.get("items", [])
        return items

    async def delete_membership(self, membership_id: str) -> None:
        await self.request("DELETE", f"/memberships/{membership_id}")

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def webhooks(self) -> list[dict[str, Any]]:
        result = await self.request("GET", "/webhooks", params={"max": 100})
        items: list[dict[str, Any]] = result.get("items", [])
        return items

    async def create_webhook(self, body: dict[str, Any]) -> None:
        await self.request("POST", "/webhooks", body=body)

    async def update_webhook(self, webhook_id: str, body: dict[str, Any]) -> None:
        await self.request("PUT", f"/webhooks/{webhook_id}", body=body)

    async def delete_webhook(self, webhook_id: str) -> None:
        await self.request("DELETE", f"/webhooks/{webhook_id}")
