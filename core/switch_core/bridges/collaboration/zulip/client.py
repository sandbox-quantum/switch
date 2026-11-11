"""A thin async wrapper over Zulip's REST API: HTTP Basic auth (bot email +
API key), the event-queue register/long-poll pair, sending, editing, deleting,
reacting, uploading, and the `GET /messages` catch-up call this adapter uses
to make a restart lose nothing.

httpx only — Zulip's whole API is REST plus one long-polling GET, so there is
nothing here a vendor SDK would buy over the project's own `httpx` convention
(`teams/adapter.py` uses the same client for Microsoft Graph).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.outbound import OutboundPolicy, guarded_async_client

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 15.0
# Long-poll requests wait on the server for new events; the client timeout
# must be comfortably longer than the server's own long-poll window (a few
# minutes) or every idle poll times out and looks like a network failure.
EVENT_POLL_TIMEOUT_SECONDS = 90.0


class ZulipSiteInvalid(ValueError):
    """The configured site is not a usable https URL."""


def normalize_site_url(value: str) -> str:
    """Validate and normalise a Zulip `site` URL.

    Required: `https`, a plain hostname (no userinfo — `user:pass@host` is
    accepted by `urlsplit` but is a credential-smuggling and SSRF-adjacent
    shape no legitimate Zulip organisation URL needs), and no path/query/
    fragment, since every API call builds its own path onto this.
    """
    stripped = value.strip().rstrip("/")
    parts = urlsplit(stripped)
    if parts.scheme.lower() != "https":
        raise ZulipSiteInvalid(
            "site must be an https URL, e.g. https://your-org.zulipchat.com"
        )
    if not parts.hostname:
        raise ZulipSiteInvalid("site must name a host")
    if parts.username or parts.password:
        raise ZulipSiteInvalid("site must not contain a username or password")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ZulipSiteInvalid("site must be the organisation's base URL, with no path")
    return f"https://{parts.hostname}{f':{parts.port}' if parts.port else ''}"


class ZulipApiError(RuntimeError):
    """Zulip answered with `result: error`. Carries its machine-readable `code`."""

    def __init__(self, code: str, msg: str, *, status_code: int) -> None:
        super().__init__(msg)
        self.code = code
        self.status_code = status_code


class ZulipRateLimited(ZulipApiError):
    def __init__(self, msg: str, *, retry_after: float, status_code: int) -> None:
        super().__init__("RATE_LIMIT_HIT", msg, status_code=status_code)
        self.retry_after = retry_after


class BadEventQueueId(ZulipApiError):
    """The event queue expired or was never valid; register a new one."""


@dataclass(frozen=True)
class RegisteredQueue:
    queue_id: str
    last_event_id: int
    max_message_length: int
    max_file_upload_size_mib: float


class ZulipClient:
    """One bot's connection to one Zulip organisation."""

    def __init__(
        self,
        *,
        site: str,
        bot_email: str,
        api_key: str,
        outbound_policy: OutboundPolicy | None,
    ) -> None:
        # None only for `verify_credentials`, a classmethod with no adapter
        # instance and so no policy yet — safe because the lifecycle always
        # runs `check_outbound_urls` (which validates this same site) before
        # it calls `verify_credentials`.
        self._site = site
        self._bot_email = bot_email
        self._api_key = api_key
        self._client = (
            guarded_async_client(
                outbound_policy,
                follow_redirects=False,
                timeout=REQUEST_TIMEOUT_SECONDS,
                auth=(bot_email, api_key),
            )
            if outbound_policy is not None
            else httpx.AsyncClient(
                follow_redirects=False,
                timeout=REQUEST_TIMEOUT_SECONDS,
                auth=(bot_email, api_key),
            )
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _url(self, path: str) -> str:
        return f"{self._site}/api/v1/{path}"

    async def _request(
        self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any
    ) -> dict[str, Any]:
        response = await self._client.request(
            method, self._url(path), timeout=timeout, **kwargs
        )
        body: dict[str, Any]
        try:
            body = response.json()
        except ValueError as exc:
            response.raise_for_status()
            raise ZulipApiError(
                "UNKNOWN",
                f"Zulip returned a non-JSON response: {exc}",
                status_code=response.status_code,
            ) from exc
        if body.get("result") == "success":
            return body
        code = str(body.get("code", "BAD_REQUEST"))
        msg = str(body.get("msg", "Zulip refused the request"))
        if code == "RATE_LIMIT_HIT":
            raise ZulipRateLimited(
                msg,
                retry_after=float(body.get("retry-after", 1.0)),
                status_code=response.status_code,
            )
        if code == "BAD_EVENT_QUEUE_ID":
            raise BadEventQueueId(code, msg, status_code=response.status_code)
        raise ZulipApiError(code, msg, status_code=response.status_code)

    # ── Identity ─────────────────────────────────────────────────────────

    async def get_own_user(self) -> dict[str, Any]:
        return await self._request("GET", "users/me")

    # ── Event queue ──────────────────────────────────────────────────────

    async def register_queue(self) -> RegisteredQueue:
        body = await self._request(
            "POST",
            "register",
            data={
                "event_types": '["message", "update_message", "delete_message", "reaction"]',
                "apply_markdown": "false",
                "client_gravatar": "true",
                "slim_presence": "true",
            },
        )
        return RegisteredQueue(
            queue_id=body["queue_id"],
            last_event_id=body["last_event_id"],
            max_message_length=body.get("max_message_length", 10000),
            max_file_upload_size_mib=body.get("max_file_upload_size_mib", 25),
        )

    async def get_events(
        self, *, queue_id: str, last_event_id: int
    ) -> list[dict[str, Any]]:
        body = await self._request(
            "GET",
            "events",
            params={"queue_id": queue_id, "last_event_id": last_event_id},
            timeout=EVENT_POLL_TIMEOUT_SECONDS,
        )
        events: list[dict[str, Any]] = body["events"]
        return events

    # ── Catch-up (restart recovery) ──────────────────────────────────────

    async def get_unread_messages(
        self, *, anchor: str | int = "oldest", num_after: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        """Up to `num_after` unread messages at or after `anchor`, oldest
        first, and whether the newest unread message was included."""
        body = await self._request(
            "GET",
            "messages",
            params={
                "anchor": anchor,
                "num_before": 0,
                "num_after": num_after,
                "apply_markdown": "false",
                "client_gravatar": "true",
                "narrow": '[{"operator": "is", "operand": "unread"}]',
            },
        )
        return body["messages"], body.get("found_newest", True)

    async def mark_read(self, message_ids: list[int]) -> None:
        if not message_ids:
            return
        await self._request(
            "POST",
            "messages/flags",
            data={"messages": _json_list(message_ids), "op": "add", "flag": "read"},
        )

    # ── Sending ──────────────────────────────────────────────────────────

    async def send_stream_message(
        self, *, stream_id: int, topic: str, content: str
    ) -> int:
        body = await self._request(
            "POST",
            "messages",
            data={
                "type": "stream",
                "to": str(stream_id),
                "topic": topic,
                "content": content,
            },
        )
        message_id: int = body["id"]
        return message_id

    async def send_direct_message(self, *, user_ids: list[int], content: str) -> int:
        body = await self._request(
            "POST",
            "messages",
            data={"type": "direct", "to": _json_list(user_ids), "content": content},
        )
        message_id: int = body["id"]
        return message_id

    async def update_message(self, message_id: int, *, content: str) -> None:
        await self._request(
            "PATCH", f"messages/{message_id}", data={"content": content}
        )

    async def delete_message(self, message_id: int) -> None:
        await self._request("DELETE", f"messages/{message_id}")

    # ── Reactions (the working indicator) ───────────────────────────────

    async def add_reaction(self, message_id: int, *, emoji_name: str) -> None:
        try:
            await self._request(
                "POST",
                f"messages/{message_id}/reactions",
                data={"emoji_name": emoji_name},
            )
        except ZulipApiError as exc:
            if exc.code != "REACTION_ALREADY_EXISTS":
                raise

    async def remove_reaction(self, message_id: int, *, emoji_name: str) -> None:
        try:
            await self._request(
                "DELETE",
                f"messages/{message_id}/reactions",
                params={"emoji_name": emoji_name},
            )
        except ZulipApiError as exc:
            if exc.code != "REACTION_DOES_NOT_EXIST":
                raise

    # ── Typing ───────────────────────────────────────────────────────────

    async def set_typing(self, *, stream_id: int, topic: str, started: bool) -> None:
        await self._request(
            "POST",
            "typing",
            data={
                "op": "start" if started else "stop",
                "type": "stream",
                "stream_id": str(stream_id),
                "topic": topic,
            },
        )

    # ── Files ────────────────────────────────────────────────────────────

    async def upload_file(self, *, filename: str, mimetype: str, data: bytes) -> str:
        body = await self._request(
            "POST", "user_uploads", files={"file": (filename, data, mimetype)}
        )
        url: str = body["url"]
        return url

    async def download_file(self, path: str, *, max_bytes: int) -> bytes:
        """Download a `/user_uploads/...` path on this same site. Refuses
        anything not shaped like one of our own upload paths, so this is
        never turned into a fetch of an arbitrary URL."""
        if not path.startswith("/user_uploads/"):
            raise BridgeOperationError(f"Refusing to fetch a non-upload path: {path!r}")
        async with self._client.stream("GET", f"{self._site}{path}") as response:
            response.raise_for_status()
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise BridgeOperationError(
                        f"Attachment exceeds {max_bytes} bytes; refusing to download the rest"
                    )
                chunks.append(chunk)
            return b"".join(chunks)

    # ── Streams / channels ───────────────────────────────────────────────

    async def create_stream(
        self, name: str, *, description: str, invite_only: bool, principals: list[int]
    ) -> None:
        subscriptions = _json_list([{"name": name, "description": description}])
        try:
            await self._request(
                "POST",
                "users/me/subscriptions",
                data={
                    "subscriptions": subscriptions,
                    "invite_only": "true" if invite_only else "false",
                    "principals": _json_list(principals) if principals else "[]",
                },
            )
        except ZulipApiError as exc:
            raise BridgeOperationError(
                f"Zulip refused to create the channel: {exc}"
            ) from exc

    async def add_users_to_stream(
        self, stream_name: str, user_ids: list[int]
    ) -> list[int]:
        """Subscribe `user_ids` to `stream_name`; return the ids Zulip refused."""
        try:
            body = await self._request(
                "POST",
                "users/me/subscriptions",
                data={
                    "subscriptions": _json_list([{"name": stream_name}]),
                    "principals": _json_list(user_ids),
                },
            )
        except ZulipApiError:
            return list(user_ids)
        # Both are keyed by stream name -> the user ids subscribed for it.
        subscribed = {int(u) for u in body.get("subscribed", {}).get(stream_name, [])}
        already = {
            int(u) for u in body.get("already_subscribed", {}).get(stream_name, [])
        }
        return [uid for uid in user_ids if uid not in subscribed and uid not in already]

    async def get_users(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "users")
        members: list[dict[str, Any]] = body["members"]
        return members

    async def get_streams(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "streams")
        streams: list[dict[str, Any]] = body["streams"]
        return streams

    async def stream_id_by_name(self, name: str) -> int | None:
        for stream in await self.get_streams():
            if stream.get("name") == name:
                return int(stream["stream_id"])
        return None

    async def stream_name_by_id(self, stream_id: int) -> str | None:
        for stream in await self.get_streams():
            if int(stream["stream_id"]) == stream_id:
                return str(stream["name"])
        return None

    async def unsubscribe(self, stream_name: str) -> None:
        await self._request(
            "PATCH",
            "users/me/subscriptions",
            data={"delete": _json_list([stream_name])},
        )


def _json_list(value: Any) -> str:
    return json.dumps(value)


def classify_zulip_exception(exc: BaseException) -> str | None:
    """`FailureReason` as a plain string (the adapter maps it to the real
    `Literal`), kept here so the client's own exception shapes are
    classified beside where they're raised."""
    if isinstance(exc, BridgeCredentialError):
        return "auth_failed"
    if isinstance(exc, ZulipSiteInvalid):
        return "config_invalid"
    if isinstance(exc, ZulipApiError):
        if exc.code in ("INVALID_API_KEY", "UNAUTHORIZED", "UNAUTHORIZED_PRINCIPAL"):
            return "auth_failed"
        return "platform_error"
    if isinstance(exc, httpx.TransportError | httpx.TimeoutException):
        return "network"
    return None
