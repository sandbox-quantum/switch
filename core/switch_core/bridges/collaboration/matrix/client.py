"""A small client for the Matrix client-server API of the user's own homeserver.

This talks to a homeserver the operator chose, as a bot account the operator
created. It has nothing to do with Switch's message bus, which is PostgreSQL;
names like `matrix_room_id` elsewhere in Switch are only kept identifiers.

Only the calls the adapter makes are here. The access token is sent in the
`Authorization` header and is never part of a URL, a log line or an error.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# Longest we wait out one rate limit before giving up on the request.
_MAX_RETRY_AFTER_SECONDS = 30.0
_RATE_LIMIT_RETRIES = 3

_CLIENT = "/_matrix/client/v3"


class MatrixAPIError(Exception):
    """The homeserver answered with an error.

    `errcode` is Matrix's own code (`M_UNKNOWN_TOKEN`, `M_FORBIDDEN`, ...), which
    is what failures are classified by; `message` is the server's explanation.
    """

    def __init__(self, status: int, errcode: str, message: str) -> None:
        super().__init__(f"{errcode} ({status}): {message}")
        self.status = status
        self.errcode = errcode
        self.message = message


def quoted(value: str) -> str:
    """A room id, event id or user id as one path segment."""
    return quote(value, safe="")


def _error_from(response: httpx.Response) -> MatrixAPIError:
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        return MatrixAPIError(
            response.status_code,
            str(body.get("errcode", "M_UNKNOWN")),
            str(body.get("error", "")),
        )
    return MatrixAPIError(response.status_code, "M_UNKNOWN", "not a Matrix response")


def _retry_after(error: MatrixAPIError, response: httpx.Response) -> float:
    try:
        milliseconds = float(response.json().get("retry_after_ms", 1000))
    except (ValueError, AttributeError):
        milliseconds = 1000.0
    return min(milliseconds / 1000.0, _MAX_RETRY_AFTER_SECONDS)


class MatrixClient:
    def __init__(
        self, base_url: str, access_token: str, http: httpx.AsyncClient
    ) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {access_token}"}
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
        content: bytes | None = None,
        content_type: str | None = None,
        timeout: float = 30.0,
    ) -> Any:
        headers = dict(self._headers)
        if content_type is not None:
            headers["Content-Type"] = content_type
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            response = await self._http.request(
                method,
                self._base + path,
                params=params,
                json=body if content is None else None,
                content=content,
                headers=headers,
                timeout=timeout,
            )
            if response.is_success:
                return response.json() if response.content else {}
            error = _error_from(response)
            if error.errcode == "M_LIMIT_EXCEEDED" and attempt < _RATE_LIMIT_RETRIES:
                await asyncio.sleep(_retry_after(error, response))
                continue
            raise error
        raise AssertionError("unreachable")

    # ── Account and rooms ────────────────────────────────────────────────────

    async def whoami(self) -> dict[str, Any]:
        result: dict[str, Any] = await self.request("GET", f"{_CLIENT}/account/whoami")
        return result

    async def sync(
        self, since: str | None, timeout_ms: int, sync_filter: dict[str, Any]
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "timeout": timeout_ms,
            "filter": json.dumps(sync_filter),
        }
        if since is not None:
            params["since"] = since
        result: dict[str, Any] = await self.request(
            "GET",
            f"{_CLIENT}/sync",
            params=params,
            # The server holds the request for `timeout_ms` before answering.
            timeout=timeout_ms / 1000.0 + 30.0,
        )
        return result

    async def room_messages_before(
        self, room_id: str, from_token: str, limit: int
    ) -> dict[str, Any]:
        result: dict[str, Any] = await self.request(
            "GET",
            f"{_CLIENT}/rooms/{quoted(room_id)}/messages",
            params={"dir": "b", "from": from_token, "limit": limit},
        )
        return result

    async def state_event(self, room_id: str, event_type: str) -> dict[str, Any] | None:
        """The room's current state event of this type, or None if it has none."""
        try:
            result: dict[str, Any] = await self.request(
                "GET", f"{_CLIENT}/rooms/{quoted(room_id)}/state/{quoted(event_type)}"
            )
        except MatrixAPIError as error:
            if error.status == 404:
                return None
            raise
        return result

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        result: dict[str, Any] = await self.request(
            "GET", f"{_CLIENT}/rooms/{quoted(room_id)}/joined_members"
        )
        joined: dict[str, Any] = result.get("joined", {})
        return joined

    async def display_name(self, user_id: str) -> str | None:
        try:
            result = await self.request("GET", f"{_CLIENT}/profile/{quoted(user_id)}")
        except MatrixAPIError as error:
            if error.status == 404:
                return None
            raise
        name = result.get("displayname")
        return str(name) if name else None

    async def join(self, room_id: str) -> None:
        await self.request("POST", f"{_CLIENT}/join/{quoted(room_id)}", body={})

    async def leave(self, room_id: str) -> None:
        await self.request("POST", f"{_CLIENT}/rooms/{quoted(room_id)}/leave", body={})

    async def forget(self, room_id: str) -> None:
        await self.request("POST", f"{_CLIENT}/rooms/{quoted(room_id)}/forget", body={})

    async def invite(self, room_id: str, user_id: str) -> None:
        await self.request(
            "POST",
            f"{_CLIENT}/rooms/{quoted(room_id)}/invite",
            body={"user_id": user_id},
        )

    async def create_room(self, body: dict[str, Any]) -> str:
        result = await self.request("POST", f"{_CLIENT}/createRoom", body=body)
        return str(result["room_id"])

    async def search_users(self, query: str, limit: int) -> list[dict[str, Any]]:
        result = await self.request(
            "POST",
            f"{_CLIENT}/user_directory/search",
            body={"search_term": query, "limit": limit},
        )
        results: list[dict[str, Any]] = result.get("results", [])
        return results

    async def fully_read(self, user_id: str, room_id: str) -> str | None:
        """The last event of the room the account has marked as read, or None."""
        try:
            result = await self.request(
                "GET",
                f"{_CLIENT}/user/{quoted(user_id)}/rooms/{quoted(room_id)}"
                "/account_data/m.fully_read",
            )
        except MatrixAPIError as error:
            if error.status == 404:
                return None
            raise
        event_id = result.get("event_id")
        return str(event_id) if event_id else None

    async def set_fully_read(self, room_id: str, event_id: str) -> None:
        await self.request(
            "POST",
            f"{_CLIENT}/rooms/{quoted(room_id)}/read_markers",
            body={"m.fully_read": event_id},
        )

    async def set_typing(
        self, room_id: str, user_id: str, typing: bool, timeout_ms: int
    ) -> None:
        body: dict[str, Any] = {"typing": typing}
        if typing:
            body["timeout"] = timeout_ms
        await self.request(
            "PUT",
            f"{_CLIENT}/rooms/{quoted(room_id)}/typing/{quoted(user_id)}",
            body=body,
        )

    # ── Events ───────────────────────────────────────────────────────────────

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, Any],
        txn_id: str | None = None,
    ) -> str:
        """Send one event and return its id. The transaction id makes a retry of
        the same send the same event instead of a second one."""
        txn = txn_id or uuid.uuid4().hex
        result = await self.request(
            "PUT",
            f"{_CLIENT}/rooms/{quoted(room_id)}/send/{quoted(event_type)}/{txn}",
            body=content,
        )
        return str(result["event_id"])

    async def redact(self, room_id: str, event_id: str) -> None:
        await self.request(
            "PUT",
            f"{_CLIENT}/rooms/{quoted(room_id)}/redact/{quoted(event_id)}/{uuid.uuid4().hex}",
            body={},
        )

    async def annotations(self, room_id: str, event_id: str) -> list[dict[str, Any]]:
        """The reactions on an event."""
        result = await self.request(
            "GET",
            f"/_matrix/client/v1/rooms/{quoted(room_id)}/relations/"
            f"{quoted(event_id)}/m.annotation/m.reaction",
            params={"limit": 100},
        )
        chunk: list[dict[str, Any]] = result.get("chunk", [])
        return chunk

    # ── Media ────────────────────────────────────────────────────────────────

    async def upload_limit(self) -> int | None:
        """The largest upload the homeserver takes, or None if it states none."""
        result = await self.request("GET", "/_matrix/media/v3/config")
        size = result.get("m.upload.size")
        return int(size) if isinstance(size, int) else None

    async def upload(self, filename: str, mimetype: str, data: bytes) -> str:
        result = await self.request(
            "POST",
            "/_matrix/media/v3/upload",
            params={"filename": filename},
            content=data,
            content_type=mimetype,
            timeout=120.0,
        )
        return str(result["content_uri"])

    @asynccontextmanager
    async def download(self, mxc_uri: str) -> AsyncIterator[httpx.Response]:
        """A streaming response for an `mxc://` file.

        Uses the authenticated media endpoint, falling back to the older one
        for a homeserver that does not have it. A caller reads at most as many
        bytes as it is willing to keep.
        """
        server, _, media_id = mxc_uri.removeprefix("mxc://").partition("/")
        if not server or not media_id:
            raise MatrixAPIError(400, "M_INVALID_PARAM", "not an mxc:// address")
        for path in (
            f"/_matrix/client/v1/media/download/{quoted(server)}/{quoted(media_id)}",
            f"/_matrix/media/v3/download/{quoted(server)}/{quoted(media_id)}",
        ):
            request = self._http.build_request(
                "GET", self._base + path, headers=self._headers, timeout=120.0
            )
            response = await self._http.send(request, stream=True)
            if response.status_code in (404, 405) and path.startswith(
                "/_matrix/client/v1"
            ):
                await response.aclose()
                continue
            try:
                if not response.is_success:
                    await response.aread()
                    raise _error_from(response)
                yield response
            finally:
                await response.aclose()
            return
        raise MatrixAPIError(404, "M_NOT_FOUND", "the file is not on the homeserver")
