"""A small Matrix client-server API client.

Switch talks to the homeserver the operator names. This is deliberately
separate from Switch's own transport: the homeserver here belongs to whoever
connected the bridge, and nothing in this module is used for Switch's internal
message bus.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from urllib.parse import quote

import httpx

from switch_core.bridges.collaboration.matrix.config import MatrixConnectionConfig


class MatrixApiError(Exception):
    """The homeserver refused a request, with what it said."""

    def __init__(self, status: int, errcode: str | None, message: str | None) -> None:
        self.status = status
        self.errcode = errcode
        self.message = message or errcode or f"Matrix returned HTTP {status}"
        super().__init__(self.message)


def _quote(value: str) -> str:
    return quote(value, safe="")


class MatrixClient:
    """The parts of the Matrix client-server API this bridge needs."""

    def __init__(
        self,
        config: MatrixConnectionConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=config.homeserver_url,
            headers={"Authorization": f"Bearer {config.access_token}"},
            timeout=httpx.Timeout(30.0, read=90.0),
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        timeout: float | None = None,
        **kwargs: Any,
    ) -> Any:
        response = await self._client.request(method, path, timeout=timeout, **kwargs)
        if response.status_code >= 400:
            raise self._error(response)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: float | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        body = await self._request_json(method, path, timeout=timeout, **kwargs)
        return body if isinstance(body, dict) else {}

    async def _request_list(
        self,
        method: str,
        path: str,
        *,
        timeout: float | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        body = await self._request_json(method, path, timeout=timeout, **kwargs)
        return body if isinstance(body, list) else []

    async def _bytes(self, path: str, *, timeout: float | None = None) -> bytes:
        response = await self._client.get(path, timeout=timeout, follow_redirects=True)
        if response.status_code >= 400:
            raise self._error(response)
        return response.content

    @staticmethod
    def _error(response: httpx.Response) -> MatrixApiError:
        errcode: str | None = None
        message: str | None = None
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            raw_code = body.get("errcode")
            raw_message = body.get("error")
            errcode = raw_code if isinstance(raw_code, str) else None
            message = raw_message if isinstance(raw_message, str) else None
        return MatrixApiError(response.status_code, errcode, message)

    async def whoami(self) -> str:
        body = await self._request("GET", "/_matrix/client/v3/account/whoami")
        user_id = body.get("user_id")
        if not isinstance(user_id, str) or not user_id:
            raise MatrixApiError(200, None, "Matrix did not name the account")
        return user_id

    async def sync(
        self, since: str | None, *, timeout_ms: int = 30000
    ) -> dict[str, Any]:
        params: dict[str, str] = {
            "timeout": str(timeout_ms),
            "filter": json.dumps(
                {
                    "room": {
                        "timeline": {"limit": 200},
                        "state": {"lazy_load_members": True},
                    }
                }
            ),
        }
        if since:
            params["since"] = since
        return await self._request(
            "GET",
            "/_matrix/client/v3/sync",
            params=params,
            timeout=timeout_ms / 1000 + 30,
        )

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, Any],
        *,
        txn_id: str | None = None,
    ) -> str:
        transaction = txn_id or uuid.uuid4().hex
        body = await self._request(
            "PUT",
            (
                f"/_matrix/client/v3/rooms/{_quote(room_id)}/send/"
                f"{_quote(event_type)}/{_quote(transaction)}"
            ),
            json=content,
        )
        event_id = body.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise MatrixApiError(200, None, "Matrix did not return an event id")
        return event_id

    async def redact(self, room_id: str, event_id: str, reason: str) -> str:
        body = await self._request(
            "PUT",
            (
                f"/_matrix/client/v3/rooms/{_quote(room_id)}/redact/"
                f"{_quote(event_id)}/{uuid.uuid4().hex}"
            ),
            json={"reason": reason},
        )
        redacted = body.get("event_id")
        return redacted if isinstance(redacted, str) else event_id

    async def upload_media(self, data: bytes, filename: str, content_type: str) -> str:
        body = await self._request(
            "POST",
            "/_matrix/media/v3/upload",
            params={"filename": filename},
            content=data,
            headers={"Content-Type": content_type},
            timeout=90,
        )
        uri = body.get("content_uri")
        if not isinstance(uri, str) or not uri:
            raise MatrixApiError(200, None, "Matrix did not return a media URI")
        return uri

    async def download_media(self, mxc_uri: str) -> bytes:
        if not mxc_uri.startswith("mxc://"):
            raise MatrixApiError(400, None, "not a Matrix media URI")
        server, _, media_id = mxc_uri[len("mxc://") :].partition("/")
        if not server or not media_id:
            raise MatrixApiError(400, None, "not a Matrix media URI")
        return await self._bytes(
            (f"/_matrix/media/v3/download/{_quote(server)}/{_quote(media_id)}"),
            timeout=90,
        )

    async def create_room(
        self,
        name: str,
        topic: str,
        *,
        public: bool,
        invite: list[str],
        is_direct: bool,
    ) -> str:
        content: dict[str, Any] = {
            "name": name,
            "topic": topic,
            "preset": "public_chat" if public else "private_chat",
            "visibility": "public" if public else "private",
            "invite": invite,
        }
        if is_direct:
            content["is_direct"] = True
            content["preset"] = "trusted_private_chat"
        body = await self._request(
            "POST", "/_matrix/client/v3/createRoom", json=content
        )
        room_id = body.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            raise MatrixApiError(200, None, "Matrix did not return a room id")
        return room_id

    async def invite(self, room_id: str, user_id: str) -> None:
        await self._request(
            "POST",
            f"/_matrix/client/v3/rooms/{_quote(room_id)}/invite",
            json={"user_id": user_id},
        )

    async def join(self, room_id: str) -> str:
        body = await self._request(
            "POST", f"/_matrix/client/v3/rooms/{_quote(room_id)}/join", json={}
        )
        joined = body.get("room_id")
        return joined if isinstance(joined, str) else room_id

    async def leave(self, room_id: str) -> None:
        await self._request(
            "POST", f"/_matrix/client/v3/rooms/{_quote(room_id)}/leave", json={}
        )

    async def room_state(self, room_id: str) -> list[dict[str, Any]]:
        return await self._request_list(
            "GET", f"/_matrix/client/v3/rooms/{_quote(room_id)}/state"
        )

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        body = await self._request(
            "GET",
            f"/_matrix/client/v3/rooms/{_quote(room_id)}/joined_members",
        )
        joined = body.get("joined")
        return joined if isinstance(joined, dict) else {}

    async def relations(
        self, room_id: str, event_id: str, rel_type: str, *, limit: int = 10
    ) -> list[dict[str, Any]]:
        body = await self._request(
            "GET",
            (
                f"/_matrix/client/v3/rooms/{_quote(room_id)}/relations/"
                f"{_quote(event_id)}/{_quote(rel_type)}"
            ),
            params={"dir": "f", "limit": str(limit)},
        )
        chunk = body.get("chunk")
        return chunk if isinstance(chunk, list) else []

    async def typing(
        self, room_id: str, user_id: str, *, typing: bool, timeout_ms: int = 30000
    ) -> None:
        await self._request(
            "PUT",
            (f"/_matrix/client/v3/rooms/{_quote(room_id)}/typing/{_quote(user_id)}"),
            json={"typing": typing, "timeout": timeout_ms},
        )

    async def search_users(self, term: str, *, limit: int = 20) -> list[dict[str, Any]]:
        body = await self._request(
            "POST",
            "/_matrix/client/v3/user_directory/search",
            json={"search_term": term, "limit": limit},
        )
        results = body.get("results")
        return results if isinstance(results, list) else []

    async def profile(self, user_id: str) -> dict[str, Any]:
        return await self._request(
            "GET", f"/_matrix/client/v3/profile/{_quote(user_id)}"
        )
