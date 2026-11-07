from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx


class MatrixApiError(RuntimeError):
    def __init__(self, status: int, errcode: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.errcode = errcode


class MatrixClient:
    """Matrix Client-Server API calls used by the external-room adapter."""

    def __init__(
        self,
        *,
        homeserver_url: str,
        access_token: str,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = homeserver_url.rstrip("/")
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=httpx.Timeout(30, read=None),
            trust_env=False,
        )

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    @staticmethod
    def _part(value: str) -> str:
        return quote(value, safe="")

    async def _json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self._http.request(
            method, f"{self._url}{path}", params=params, json=body
        )
        if response.is_error:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            raise MatrixApiError(
                response.status_code,
                str(payload.get("errcode") or "M_UNKNOWN"),
                str(
                    payload.get("error")
                    or f"Matrix returned HTTP {response.status_code}"
                ),
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise MatrixApiError(
                502, "M_BAD_JSON", "Matrix returned a non-object response"
            )
        return payload

    async def whoami(self) -> dict[str, Any]:
        return await self._json("GET", "/_matrix/client/v3/account/whoami")

    async def sync(self, *, since: str | None, timeout_ms: int) -> dict[str, Any]:
        sync_filter = {
            "presence": {"types": []},
            "room": {
                "ephemeral": {"types": []},
                "account_data": {"types": []},
                "state": {
                    "lazy_load_members": True,
                    "include_redundant_members": True,
                },
                "timeline": {"limit": 100},
            },
        }
        params: dict[str, Any] = {
            "timeout": timeout_ms,
            "filter": json.dumps(sync_filter, separators=(",", ":")),
        }
        if since:
            params["since"] = since
        return await self._json("GET", "/_matrix/client/v3/sync", params=params)

    async def join(self, room_id: str) -> None:
        await self._json(
            "POST", f"/_matrix/client/v3/join/{self._part(room_id)}", body={}
        )

    async def send_message(self, room_id: str, content: dict[str, Any]) -> str:
        result = await self._json(
            "PUT",
            "/_matrix/client/v3/rooms/"
            f"{self._part(room_id)}/send/m.room.message/{uuid4().hex}",
            body=content,
        )
        event_id = result.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise MatrixApiError(502, "M_BAD_JSON", "Matrix returned no event_id")
        return event_id

    async def redact(self, room_id: str, event_id: str) -> None:
        await self._json(
            "PUT",
            "/_matrix/client/v3/rooms/"
            f"{self._part(room_id)}/redact/{self._part(event_id)}/{uuid4().hex}",
            body={},
        )

    async def typing(self, room_id: str, user_id: str, *, typing: bool) -> None:
        await self._json(
            "PUT",
            "/_matrix/client/v3/rooms/"
            f"{self._part(room_id)}/typing/{self._part(user_id)}",
            body={"typing": typing, "timeout": 30_000 if typing else 0},
        )

    async def create_room(self, *, name: str, topic: str, public: bool) -> str:
        body: dict[str, Any] = {
            "name": name,
            "topic": topic,
            "visibility": "public" if public else "private",
            "preset": "public_chat" if public else "private_chat",
        }
        result = await self._json("POST", "/_matrix/client/v3/createRoom", body=body)
        room_id = result.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            raise MatrixApiError(502, "M_BAD_JSON", "Matrix returned no room_id")
        return room_id

    async def invite(self, room_id: str, user_id: str) -> None:
        await self._json(
            "POST",
            f"/_matrix/client/v3/rooms/{self._part(room_id)}/invite",
            body={"user_id": user_id},
        )

    async def leave(self, room_id: str) -> None:
        await self._json(
            "POST", f"/_matrix/client/v3/rooms/{self._part(room_id)}/leave", body={}
        )

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        return await self._json(
            "GET", f"/_matrix/client/v3/rooms/{self._part(room_id)}/joined_members"
        )

    async def search_users(self, query: str) -> list[dict[str, Any]]:
        result = await self._json(
            "POST",
            "/_matrix/client/v3/user_directory/search",
            body={"search_term": query, "limit": 20},
        )
        return [item for item in result.get("results", []) if isinstance(item, dict)]

    async def room_state(self, room_id: str) -> list[dict[str, Any]]:
        response = await self._http.get(
            f"{self._url}/_matrix/client/v3/rooms/{self._part(room_id)}/state"
        )
        if response.is_error:
            raise MatrixApiError(response.status_code, "M_UNKNOWN", response.text)
        payload = response.json()
        if not isinstance(payload, list):
            raise MatrixApiError(
                502, "M_BAD_JSON", "Matrix returned invalid room state"
            )
        return [item for item in payload if isinstance(item, dict)]

    async def upload(self, data: bytes, *, filename: str, mimetype: str) -> str:
        response = await self._http.post(
            f"{self._url}/_matrix/media/v3/upload",
            params={"filename": filename},
            headers={"Content-Type": mimetype},
            content=data,
        )
        if response.is_error:
            raise MatrixApiError(response.status_code, "M_UNKNOWN", response.text)
        payload = response.json()
        uri = payload.get("content_uri") if isinstance(payload, dict) else None
        if not isinstance(uri, str) or not uri.startswith("mxc://"):
            raise MatrixApiError(502, "M_BAD_JSON", "Matrix returned no content_uri")
        return uri

    async def download(self, mxc_uri: str) -> bytes:
        if not mxc_uri.startswith("mxc://"):
            raise MatrixApiError(400, "M_BAD_MXC", "Matrix media URI is invalid")
        server_and_media = mxc_uri.removeprefix("mxc://").split("/", 1)
        if len(server_and_media) != 2 or not all(server_and_media):
            raise MatrixApiError(400, "M_BAD_MXC", "Matrix media URI is invalid")
        server, media_id = server_and_media
        response = await self._http.get(
            f"{self._url}/_matrix/client/v1/media/download/"
            f"{self._part(server)}/{self._part(media_id)}"
        )
        if response.is_error:
            raise MatrixApiError(response.status_code, "M_UNKNOWN", response.text)
        return response.content
