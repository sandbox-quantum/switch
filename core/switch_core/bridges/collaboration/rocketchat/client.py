"""Rocket.Chat's REST API, as the adapter needs it.

Credentials go on each request rather than on the HTTP client, because a file
can answer with a redirect to object storage and that request must not carry
them. Nothing follows a redirect by itself for the same reason.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urljoin

import httpx

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)

# How long to wait after a rate limit that names no reset time.
_THROTTLE_FALLBACK_SECONDS = 30.0


class RocketChatAuthError(BridgeCredentialError):
    """The server rejected the bot's user id or personal access token."""


class RocketChatRefused(BridgeOperationError):
    """The server read the request and refused it.

    Sending it again unchanged would be refused again, and nothing was done.
    `error_type` is Rocket.Chat's own code, such as `error-action-not-allowed`.
    """

    def __init__(self, message: str, *, status: int, error_type: str | None) -> None:
        super().__init__(message)
        self.status = status
        self.error_type = error_type


class RocketChatThrottled(BridgeOperationError):
    """The server asked for a wait before the next call."""

    def __init__(self, message: str, *, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class RocketChatUnavailable(BridgeOperationError):
    """The server failed in a way that leaves the outcome unknown.

    A 5xx or an answer that is not the API's own. Unlike `RocketChatRefused`,
    what was asked may have happened.
    """


class AttachmentTooLarge(Exception):
    """A file turned out to be larger than the size it may be downloaded at."""


class RocketChatClient:
    def __init__(self, http: httpx.AsyncClient, *, url: str, user_id: str, token: str):
        self._http = http
        self._origin = url.rstrip("/") + "/"
        self._credentials = {"X-User-Id": user_id, "X-Auth-Token": token}
        #: Whether the last answer was the server refusing the token, which is
        #: how a token revoked while the bridge runs comes to light.
        self.rejected = False

    async def get(
        self, endpoint: str, params: dict[str, str | int] | None = None
    ) -> dict[str, Any]:
        response = await self._http.get(
            self._api(endpoint), params=params, headers=self._credentials
        )
        return self._read(endpoint, response)

    async def post(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        response = await self._http.post(
            self._api(endpoint), json=body, headers=self._credentials
        )
        return self._read(endpoint, response)

    async def upload(
        self, room_id: str, filename: str, mimetype: str, data: bytes
    ) -> str:
        """Store a file against a room and return its id. It shows in the room
        once `rooms.mediaConfirm` is called with that id."""
        endpoint = f"rooms.media/{room_id}"
        response = await self._http.post(
            self._api(endpoint),
            files={"file": (filename, data, mimetype)},
            headers=self._credentials,
        )
        return str(self._read(endpoint, response)["file"]["_id"])

    async def download(self, path: str, *, limit: int) -> bytes:
        """The file at a path on this server, refused past `limit` bytes.

        Object storage answers with a redirect to a signed address of its own,
        which is followed once and without the bot's credentials.
        """
        url = urljoin(self._origin, path.lstrip("/"))
        async with self._http.stream("GET", url, headers=self._credentials) as response:
            if not response.is_redirect:
                return await _read_within(response, limit)
            location = urljoin(url, response.headers["location"])
        async with self._http.stream("GET", location) as response:
            return await _read_within(response, limit)

    def _api(self, endpoint: str) -> str:
        return f"{self._origin}api/v1/{endpoint}"

    def _read(self, endpoint: str, response: httpx.Response) -> dict[str, Any]:
        status = response.status_code
        self.rejected = status == 401
        if status == 401:
            raise RocketChatAuthError(
                "Rocket.Chat rejected the bot's user id or personal access token."
            )
        if status == 429:
            raise RocketChatThrottled(
                f"Rocket.Chat is rate limiting {endpoint}.",
                retry_after=_retry_after(response),
            )
        if status >= 500:
            raise RocketChatUnavailable(
                f"Rocket.Chat answered {endpoint} with HTTP {status}."
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise RocketChatUnavailable(
                f"The server answered {endpoint} with HTTP {status} and a body that "
                "is not Rocket.Chat's API. Check the server URL, including whether "
                "it should be https."
            ) from exc
        if not isinstance(body, dict):
            raise RocketChatUnavailable(
                f"The server answered {endpoint} with something other than an object."
            )
        if status >= 400 or body.get("success") is False:
            reason = body.get("error") or body.get("message") or f"HTTP {status}"
            raise RocketChatRefused(
                f"Rocket.Chat refused {endpoint}: {reason}",
                status=status,
                error_type=body.get("errorType") or body.get("error"),
            )
        if status >= 300:
            raise RocketChatUnavailable(
                f"The server answered {endpoint} with a redirect. Check the server "
                "URL, including whether it should be https."
            )
        return body


def _retry_after(response: httpx.Response) -> float:
    """Seconds until the limit resets. `x-ratelimit-reset` is a time in
    milliseconds since the epoch, not an interval."""
    try:
        reset = float(response.headers["x-ratelimit-reset"]) / 1000
    except (KeyError, ValueError):
        return _THROTTLE_FALLBACK_SECONDS
    return max(0.0, reset - time.time())


async def _read_within(response: httpx.Response, limit: int) -> bytes:
    response.raise_for_status()
    received = bytearray()
    async for chunk in response.aiter_bytes():
        received.extend(chunk)
        if len(received) > limit:
            raise AttachmentTooLarge
    return bytes(received)
