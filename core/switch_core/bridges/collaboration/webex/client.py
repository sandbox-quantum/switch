"""Webex's REST API, as much of it as a Switch bridge uses.

Everything here speaks to Webex with the bot's own token, so where a request
may go is checked before it is sent: a token is a bot's whole identity, and a
URL read out of an event (a file to download, a device to register) is not
trusted to name a Webex host just because it arrived from Webex.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from dataclasses import dataclass
from email.message import Message
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://webexapis.com/v1"

# Hosts the bot's token may be sent to. `webexapis.com` is the public API; the
# `wbx2.com` services are where Webex's own clients register a device and open
# the event socket, and are what the device registration answers with.
_TRUSTED_HOSTS = ("webexapis.com", "wbx2.com", "webex.com", "ciscospark.com")

# How long a throttled call is waited out in place before the throttle is
# handed to the caller instead. Webex names short waits for ordinary bursts;
# anything longer is the caller's to schedule, not something to sit inside.
_MAX_INLINE_WAIT = 10.0

# How many times a file still being scanned is asked for again. Webex answers
# 423 until its malware scan has passed, and names how long to wait.
_SCAN_ATTEMPTS = 4
_SCAN_WAIT_CAP = 5.0


class WebexApiError(Exception):
    """Webex refused a request, or answered one in a way this cannot use.

    `status` is the HTTP status and the whole of how a caller tells refusals
    apart; the message is Webex's own explanation, kept because it is the
    part an operator can act on, and never matched against.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        tracking_id: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.tracking_id = tracking_id
        self.retry_after = retry_after

    @property
    def throttled(self) -> bool:
        return self.status == 429

    @property
    def unauthorized(self) -> bool:
        return self.status == 401

    @property
    def gone(self) -> bool:
        return self.status in (404, 410)


class WebexFileTooLarge(Exception):
    """A file is larger than this bridge will take in."""

    def __init__(self, filename: str, limit: int) -> None:
        super().__init__(
            f"{filename} is larger than the {limit // (1024 * 1024)} MB this "
            "bridge accepts"
        )
        self.filename = filename
        self.limit = limit


@dataclass(frozen=True)
class WebexId:
    """A Webex id taken apart: `ciscospark://<cluster>/<kind>/<uuid>`.

    Webex's public ids are that URI in base64. The event socket names things
    by the bare uuid, and the REST API by the encoded id, so the two meet
    here. The cluster is part of the id rather than a constant: an
    organisation hosted outside the US has ids in a cluster of its own.
    """

    cluster: str
    kind: str
    uuid: str

    def encode(self) -> str:
        raw = f"ciscospark://{self.cluster}/{self.kind}/{self.uuid}".encode()
        return base64.b64encode(raw).decode("ascii").rstrip("=")


def decode_id(value: str) -> WebexId | None:
    """`value` taken apart, or None when it is not a Webex id at all."""
    if not value:
        return None
    padded = value + "=" * (-len(value) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(padded).decode("ascii")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        if not raw.startswith("ciscospark://"):
            continue
        parts = raw[len("ciscospark://") :].rsplit("/", 2)
        if len(parts) == 3 and all(parts):
            return WebexId(cluster=parts[0], kind=parts[1], uuid=parts[2])
    return None


def same_entity(a: str | None, b: str | None) -> bool:
    """Whether two ids name the same thing, however each was written.

    Compared by uuid because Webex does not write one id one way: a mention
    in a message's HTML carries the person's id padded, the REST API returns
    it unpadded, and the event socket names the bare uuid.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    left = decode_id(a)
    right = decode_id(b)
    left_uuid = left.uuid if left else a
    right_uuid = right.uuid if right else b
    return left_uuid.lower() == right_uuid.lower()


def is_webex_url(url: str) -> bool:
    """Whether the bot's token may be sent to `url`: https, on a Webex host."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return False
    host = parts.hostname.lower()
    return any(
        host == trusted or host.endswith(f".{trusted}") for trusted in _TRUSTED_HOSTS
    )


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _error(operation: str, response: httpx.Response) -> WebexApiError:
    """A `WebexApiError` leading with Webex's own explanation."""
    tracking_id = response.headers.get("trackingid")
    explanation = ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        tracking_id = str(body.get("trackingId") or tracking_id or "") or None
        details = [
            str(error.get("description"))
            for error in body.get("errors") or []
            if isinstance(error, dict) and error.get("description")
        ]
        explanation = str(body.get("message") or "; ".join(details) or "")
    if not explanation:
        explanation = response.reason_phrase or "no explanation given"
    message = f"{operation}: Webex answered {response.status_code}: {explanation}"
    if tracking_id:
        message += f" (tracking id {tracking_id})"
    return WebexApiError(
        message,
        status=response.status_code,
        tracking_id=tracking_id,
        retry_after=_retry_after(response),
    )


def _filename(response: httpx.Response, fallback: str) -> str:
    disposition = response.headers.get("content-disposition")
    if disposition:
        header = Message()
        header["content-disposition"] = disposition
        name = header.get_filename()
        if name:
            return name.replace("/", "_").replace("\\", "_").strip() or fallback
    return fallback


class WebexClient:
    """The bot's REST client. One per adapter; the http client is borrowed."""

    def __init__(
        self, token: str, http: httpx.AsyncClient, *, base_url: str = API_BASE
    ) -> None:
        self._token = token
        self._http = http
        self._base = base_url.rstrip("/")

    def _url(self, path: str) -> str:
        return path if path.startswith("https://") else f"{self._base}{path}"

    async def _call(
        self,
        operation: str,
        method: str,
        path: str,
        *,
        wait_out_throttle: bool = True,
        **kwargs: Any,
    ) -> httpx.Response:
        url = self._url(path)
        if not is_webex_url(url):
            raise WebexApiError(
                f"{operation}: refusing to send the bot token to {urlsplit(url).hostname!r}, "
                "which is not a Webex host",
                status=0,
            )
        headers = {"Authorization": f"Bearer {self._token}"}
        attempts = 2 if wait_out_throttle else 1
        for attempt in range(1, attempts + 1):
            response = await self._http.request(method, url, headers=headers, **kwargs)
            if response.status_code < 400:
                return response
            error = _error(operation, response)
            wait = error.retry_after
            if (
                error.throttled
                and attempt < attempts
                and wait is not None
                and wait <= _MAX_INLINE_WAIT
            ):
                logger.info("%s was throttled by Webex; waiting %.1fs", operation, wait)
                await asyncio.sleep(wait)
                continue
            raise error
        raise AssertionError("unreachable")

    async def _json(
        self, operation: str, method: str, path: str, **kwargs: Any
    ) -> dict[str, Any]:
        response = await self._call(operation, method, path, **kwargs)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            body = response.json()
        except ValueError as exc:
            raise WebexApiError(
                f"{operation}: Webex answered with something that is not JSON",
                status=response.status_code,
            ) from exc
        if not isinstance(body, dict):
            raise WebexApiError(
                f"{operation}: Webex answered with JSON that is not an object",
                status=response.status_code,
            )
        return body

    async def _items(
        self, operation: str, path: str, params: dict[str, Any]
    ) -> list[dict[str, Any]]:
        body = await self._json(operation, "GET", path, params=params)
        items = body.get("items")
        return (
            [item for item in items if isinstance(item, dict)]
            if isinstance(items, list)
            else []
        )

    # ── People ──────────────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        return await self._json("Reading the bot's own account", "GET", "/people/me")

    async def person(self, person_id: str) -> dict[str, Any]:
        return await self._json("Reading a person", "GET", f"/people/{person_id}")

    async def people(
        self,
        *,
        email: str | None = None,
        display_name: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"max": limit}
        if email:
            params["email"] = email
        if display_name:
            params["displayName"] = display_name
        return await self._items("Searching people", "/people", params)

    # ── Rooms and memberships ───────────────────────────────────────────────

    async def room(self, room_id: str) -> dict[str, Any]:
        return await self._json("Reading a space", "GET", f"/rooms/{room_id}")

    async def rooms(self, *, limit: int = 100) -> list[dict[str, Any]]:
        return await self._items(
            "Listing spaces", "/rooms", {"sortBy": "lastactivity", "max": limit}
        )

    async def create_room(self, title: str) -> dict[str, Any]:
        return await self._json(
            "Creating a space", "POST", "/rooms", json={"title": title}
        )

    async def memberships(
        self, room_id: str, *, limit: int = 1000
    ) -> list[dict[str, Any]]:
        return await self._items(
            "Listing a space's members",
            "/memberships",
            {"roomId": room_id, "max": limit},
        )

    async def my_membership(
        self, room_id: str, person_id: str
    ) -> dict[str, Any] | None:
        found = await self._items(
            "Finding the bot's membership",
            "/memberships",
            {"roomId": room_id, "personId": person_id},
        )
        return found[0] if found else None

    async def add_membership(self, room_id: str, person_id: str) -> dict[str, Any]:
        return await self._json(
            "Adding a person to a space",
            "POST",
            "/memberships",
            json={"roomId": room_id, "personId": person_id},
        )

    async def delete_membership(self, membership_id: str) -> None:
        await self._call("Leaving a space", "DELETE", f"/memberships/{membership_id}")

    # ── Messages ────────────────────────────────────────────────────────────

    async def message(self, message_id: str) -> dict[str, Any]:
        return await self._json("Reading a message", "GET", f"/messages/{message_id}")

    async def messages(
        self, room_id: str, *, mentioned_me: bool, limit: int = 50
    ) -> list[dict[str, Any]]:
        """A space's latest messages, newest first.

        `mentioned_me` because a bot may list a group space's messages only
        as far as they mention it; Webex refuses the list without the filter.
        """
        params: dict[str, Any] = {"roomId": room_id, "max": limit}
        if mentioned_me:
            params["mentionedPeople"] = "me"
        return await self._items("Listing a space's messages", "/messages", params)

    async def post_message(
        self, body: dict[str, Any], *, wait_out_throttle: bool = True
    ) -> dict[str, Any]:
        return await self._json(
            "Posting a message",
            "POST",
            "/messages",
            json=body,
            wait_out_throttle=wait_out_throttle,
        )

    async def post_file(
        self, fields: dict[str, str], filename: str, mimetype: str, data: bytes
    ) -> dict[str, Any]:
        return await self._json(
            "Posting a file",
            "POST",
            "/messages",
            data=fields,
            files={"files": (filename, data, mimetype)},
        )

    async def edit_message(
        self, message_id: str, body: dict[str, Any], *, wait_out_throttle: bool = True
    ) -> dict[str, Any]:
        return await self._json(
            "Editing a message",
            "PUT",
            f"/messages/{message_id}",
            json=body,
            wait_out_throttle=wait_out_throttle,
        )

    async def delete_message(self, message_id: str) -> None:
        await self._call("Deleting a message", "DELETE", f"/messages/{message_id}")

    async def attachment_action(self, action_id: str) -> dict[str, Any]:
        return await self._json(
            "Reading a card press", "GET", f"/attachment/actions/{action_id}"
        )

    async def download(self, url: str, *, max_bytes: int) -> tuple[str, str, bytes]:
        """A file a message carries: its name, its type and its bytes.

        Only from the public API's own hosts — a message names its files by
        URL, and the bot's token goes with the request. Waits out Webex's
        malware scan, which answers 423 with a wait until the file is cleared,
        and stops reading the moment the file passes `max_bytes`.
        """
        host = (urlsplit(url).hostname or "").lower()
        if urlsplit(url).scheme != "https" or not (
            host == "webexapis.com" or host.endswith(".webexapis.com")
        ):
            raise WebexApiError(
                f"Downloading a file: {host!r} is not Webex's file host", status=0
            )
        headers = {"Authorization": f"Bearer {self._token}"}
        for attempt in range(1, _SCAN_ATTEMPTS + 1):
            async with self._http.stream("GET", url, headers=headers) as response:
                if response.status_code == 423 and attempt < _SCAN_ATTEMPTS:
                    wait = min(_retry_after(response) or 1.0, _SCAN_WAIT_CAP)
                    await asyncio.sleep(wait)
                    continue
                if response.status_code >= 400:
                    await response.aread()
                    raise _error("Downloading a file", response)
                filename = _filename(response, "file")
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise WebexFileTooLarge(filename, max_bytes)
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise WebexFileTooLarge(filename, max_bytes)
                    chunks.append(chunk)
                mimetype = (
                    response.headers.get("content-type") or "application/octet-stream"
                )
                return filename, mimetype, b"".join(chunks)
        raise WebexApiError(
            "Downloading a file: Webex is still scanning it", status=423
        )

    # ── Devices (the event socket's registration) ───────────────────────────

    async def devices(self, wdm_url: str) -> list[dict[str, Any]]:
        body = await self._json(
            "Listing the bot's devices", "GET", f"{wdm_url}/devices"
        )
        devices = body.get("devices")
        return (
            [d for d in devices if isinstance(d, dict)]
            if isinstance(devices, list)
            else []
        )

    async def register_device(
        self, wdm_url: str, device: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._json(
            "Registering the bot's device", "POST", f"{wdm_url}/devices", json=device
        )

    async def delete_device(self, device_url: str) -> None:
        await self._call("Removing the bot's device", "DELETE", device_url)
