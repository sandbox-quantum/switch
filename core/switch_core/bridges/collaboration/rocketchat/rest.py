"""Rocket.Chat's REST API, as the bridge's bot user calls it.

Every request carries the bot's user id and personal access token as headers,
which is how Rocket.Chat authenticates a REST call. The token never goes into a
URL, so it stays out of access logs on the way.
"""

from __future__ import annotations

from typing import Any

import httpx


class RocketChatApiError(Exception):
    """Rocket.Chat answered a request with an error.

    `status` is the HTTP status. The message is Rocket.Chat's own, carrying
    its error code (`[error-room-not-found]`), and is the part an operator can
    act on.
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _error_of(response: httpx.Response) -> RocketChatApiError:
    try:
        body = response.json()
    except ValueError:
        body = None
    message = f"HTTP {response.status_code}"
    if isinstance(body, dict):
        message = str(body.get("error") or body.get("message") or message)
    return RocketChatApiError(response.status_code, message)


class RocketChatRest:
    def __init__(self, client: httpx.AsyncClient, *, user_id: str, token: str) -> None:
        # `client` carries the server's base URL, so methods name only a path.
        self._client = client
        self._auth = {"X-User-Id": user_id, "X-Auth-Token": token}

    async def get(self, method: str, **params: str | int) -> dict[str, Any]:
        response = await self._client.get(
            f"/api/v1/{method}", params=params, headers=self._auth
        )
        return self._json(response)

    async def post(self, method: str, body: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(
            f"/api/v1/{method}", json=body, headers=self._auth
        )
        return self._json(response)

    async def upload(
        self, room_id: str, filename: str, mimetype: str, data: bytes
    ) -> dict[str, Any]:
        """Stage a file in a room. It is not shown until `rooms.mediaConfirm`
        posts it, which is the only upload Rocket.Chat 8 still has."""
        response = await self._client.post(
            f"/api/v1/rooms.media/{room_id}",
            files={"file": (filename, data, mimetype)},
            headers=self._auth,
        )
        return self._json(response)

    async def download(self, path: str, max_bytes: int) -> bytes:
        """Fetch a file the server hosts, refusing it once it passes `max_bytes`.

        Read as a stream so a file larger than its message said is cut off at
        the limit instead of being held in memory whole.
        """
        async with self._client.stream("GET", path, headers=self._auth) as response:
            if response.status_code != 200:
                await response.aread()
                raise _error_of(response)
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise ValueError(f"over the {max_bytes} byte limit")
            return bytes(data)

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        if response.status_code != 200:
            raise _error_of(response)
        body = response.json()
        if not isinstance(body, dict) or body.get("success") is False:
            raise _error_of(response)
        return body
