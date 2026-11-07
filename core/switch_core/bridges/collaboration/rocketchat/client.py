"""A small async client for the parts of Rocket.Chat's REST API a bot uses.

Every refusal comes back as `RocketChatAPIError` carrying the HTTP status and
the server's own error type, so the adapter can tell a rejected token from a
refused operation without reading words out of a message.
"""

from __future__ import annotations

import email.message
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_API = "/api/v1"


class RocketChatAPIError(Exception):
    """The server refused a call. `status` is its HTTP status, `error_type` its
    own name for the refusal where it gave one, and `retry_after` the seconds it
    asked for, where it asked for any."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        error_type: str | None,
        retry_after: float | None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.error_type = error_type
        self.retry_after = retry_after


class FileTooLarge(Exception):
    """A file grew past the bridge's ceiling while it was being downloaded."""

    def __init__(self, filename: str, max_bytes: int) -> None:
        super().__init__(f"{filename} is larger than {max_bytes} bytes")
        self.filename = filename
        self.max_bytes = max_bytes


class UntrustedFileLink(Exception):
    """A message named a file somewhere other than this server's file route."""

    def __init__(self, link: str) -> None:
        super().__init__(f"{link} is not a file on this Rocket.Chat server")


@dataclass(frozen=True)
class FileInfo:
    filename: str
    mimetype: str


def _refusal(response: httpx.Response) -> RocketChatAPIError:
    try:
        body = response.json()
    except ValueError:
        body = None
    message = f"HTTP {response.status_code} {response.reason_phrase}".strip()
    error_type: str | None = None
    if isinstance(body, dict):
        given = body.get("error") or body.get("message")
        if isinstance(given, str) and given:
            message = given
        kind = body.get("errorType")
        if isinstance(kind, str):
            error_type = kind
    wait = response.headers.get("retry-after", "")
    return RocketChatAPIError(
        response.status_code,
        message,
        error_type=error_type,
        retry_after=float(wait) if wait.isdecimal() else None,
    )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _filename_of(response: httpx.Response, fallback: str) -> str:
    disposition = response.headers.get("content-disposition")
    if disposition:
        parsed = email.message.Message()
        parsed["content-disposition"] = disposition
        name = parsed.get_filename()
        if name:
            return name
    return fallback


class RocketChatClient:
    """One bot's view of a server, authenticated with its access token.

    `http` is built by the caller because that is where the deployment's
    outbound policy is applied; this client owns it from then on."""

    def __init__(
        self, http: httpx.AsyncClient, *, server_url: str, user_id: str, token: str
    ) -> None:
        self._http = http
        self._base = server_url.rstrip("/")
        self._path = urlsplit(self._base).path
        self._headers = {"X-User-Id": user_id, "X-Auth-Token": token}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self._http.request(
            method,
            f"{self._base}{_API}/{path}",
            headers=self._headers,
            timeout=_TIMEOUT,
            **kwargs,
        )
        if response.status_code >= 400:
            raise _refusal(response)
        body = response.json()
        if not isinstance(body, dict):
            raise RocketChatAPIError(
                response.status_code,
                f"{path} answered with something other than an object",
                error_type=None,
                retry_after=None,
            )
        return body

    # ── People ───────────────────────────────────────────────────────────────

    async def me(self) -> dict[str, Any]:
        return await self._call("GET", "me")

    async def user(self, user_id: str) -> dict[str, Any]:
        body = await self._call("GET", "users.info", params={"userId": user_id})
        user = body.get("user")
        return user if isinstance(user, dict) else {}

    async def user_by_name(self, username: str) -> dict[str, Any]:
        body = await self._call("GET", "users.info", params={"username": username})
        user = body.get("user")
        return user if isinstance(user, dict) else {}

    async def search_users(
        self, term: str, *, exclude: list[str]
    ) -> list[dict[str, Any]]:
        selector = json.dumps({"term": term, "exceptions": exclude})
        body = await self._call(
            "GET", "users.autocomplete", params={"selector": selector}
        )
        items = body.get("items")
        return (
            [u for u in items if isinstance(u, dict)] if isinstance(items, list) else []
        )

    # ── Messages ─────────────────────────────────────────────────────────────

    async def send_message(self, message: dict[str, Any]) -> dict[str, Any]:
        body = await self._call("POST", "chat.sendMessage", json={"message": message})
        sent = body.get("message")
        return sent if isinstance(sent, dict) else {}

    async def update_text(self, room_id: str, message_id: str, text: str) -> None:
        """Replace a message's text, leaving what is attached to it."""
        await self._call(
            "POST",
            "chat.update",
            json={"roomId": room_id, "msgId": message_id, "text": text},
        )

    async def rewrite_message(
        self,
        room_id: str,
        message_id: str,
        *,
        text: str,
        attachments: list[dict[str, Any]],
    ) -> None:
        """Replace a message's text and its attachments, so `attachments` is
        what it shows afterwards.

        `chat.update` will not touch attachments, so this calls the method the
        web client edits with. It answers 200 either way, with any refusal
        inside the result."""
        call = {
            "msg": "method",
            "id": "1",
            "method": "updateMessage",
            "params": [
                {
                    "_id": message_id,
                    "rid": room_id,
                    "msg": text,
                    "attachments": attachments,
                }
            ],
        }
        body = await self._call(
            "POST", "method.call/updateMessage", json={"message": json.dumps(call)}
        )
        result = json.loads(str(body.get("message") or "{}"))
        error = result.get("error") if isinstance(result, dict) else None
        if isinstance(error, dict):
            raise RocketChatAPIError(
                int(error.get("error", 400))
                if str(error.get("error", "")).isdecimal()
                else 400,
                str(error.get("message") or error.get("reason") or error),
                error_type=_optional_str(error.get("error")),
                retry_after=None,
            )

    async def delete_message(self, room_id: str, message_id: str) -> None:
        await self._call(
            "POST", "chat.delete", json={"roomId": room_id, "msgId": message_id}
        )

    async def message(self, message_id: str) -> dict[str, Any]:
        body = await self._call("GET", "chat.getMessage", params={"msgId": message_id})
        found = body.get("message")
        return found if isinstance(found, dict) else {}

    async def react(self, message_id: str, emoji: str, *, on: bool) -> None:
        await self._call(
            "POST",
            "chat.react",
            json={"messageId": message_id, "emoji": emoji, "shouldReact": on},
        )

    async def thread_messages(
        self, root_id: str, *, limit: int
    ) -> list[dict[str, Any]]:
        """A thread's replies, oldest first."""
        body = await self._call(
            "GET",
            "chat.getThreadMessages",
            params={"tmid": root_id, "count": limit, "sort": '{"ts": 1}'},
        )
        items = body.get("messages")
        return (
            [m for m in items if isinstance(m, dict)] if isinstance(items, list) else []
        )

    async def messages_since(self, room_id: str, since: str) -> list[dict[str, Any]]:
        """What was posted or changed in a room after `since`, an ISO time."""
        body = await self._call(
            "GET",
            "chat.syncMessages",
            params={"roomId": room_id, "lastUpdate": since},
        )
        result = body.get("result")
        updated = result.get("updated") if isinstance(result, dict) else None
        return (
            [m for m in updated if isinstance(m, dict)]
            if isinstance(updated, list)
            else []
        )

    # ── Files ────────────────────────────────────────────────────────────────

    async def upload(
        self,
        room_id: str,
        *,
        filename: str,
        mimetype: str,
        data: bytes,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        """Upload a file and post it to a room as one message."""
        staged = await self._call(
            "POST",
            f"rooms.media/{quote(room_id, safe='')}",
            files={"file": (filename, data, mimetype)},
        )
        file = staged.get("file")
        file_id = file.get("_id") if isinstance(file, dict) else None
        if not isinstance(file_id, str):
            raise RocketChatAPIError(
                200,
                "The server staged the file but gave no id for it.",
                error_type=None,
                retry_after=None,
            )
        body = await self._call(
            "POST",
            f"rooms.mediaConfirm/{quote(room_id, safe='')}/{quote(file_id, safe='')}",
            json=fields,
        )
        sent = body.get("message")
        return sent if isinstance(sent, dict) else {}

    async def download(self, link: str, *, max_bytes: int) -> tuple[FileInfo, bytes]:
        """The file at a message's `title_link`, refused once past `max_bytes`.

        `link` comes from a message anyone could have crafted and the bot's
        token goes with the request, so only this server's own file route is
        fetched."""
        path = urlsplit(link).path
        if (
            urlsplit(link).netloc
            or not path.startswith(f"{self._path}/file-upload/")
            or ".." in path
        ):
            raise UntrustedFileLink(link)
        fallback = path.rsplit("/", 1)[-1] or "file"
        async with self._http.stream(
            "GET",
            f"{self._base}{path[len(self._path) :]}",
            headers=self._headers,
            timeout=_TIMEOUT,
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                raise _refusal(response)
            info = FileInfo(
                filename=_filename_of(response, fallback),
                mimetype=response.headers.get(
                    "content-type", "application/octet-stream"
                )
                .split(";", 1)[0]
                .strip(),
            )
            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > max_bytes:
                    raise FileTooLarge(info.filename, max_bytes)
                chunks.append(chunk)
        return info, b"".join(chunks)

    # ── Rooms ────────────────────────────────────────────────────────────────

    async def room(self, room_id: str) -> dict[str, Any]:
        body = await self._call("GET", "rooms.info", params={"roomId": room_id})
        room = body.get("room")
        return room if isinstance(room, dict) else {}

    async def subscriptions(self) -> list[dict[str, Any]]:
        body = await self._call("GET", "subscriptions.get")
        items = body.get("update")
        return (
            [s for s in items if isinstance(s, dict)] if isinstance(items, list) else []
        )

    async def mark_read(self, room_id: str) -> None:
        await self._call("POST", "subscriptions.read", json={"rid": room_id})

    async def create_room(self, name: str, *, private: bool) -> dict[str, Any]:
        path, key = (
            ("groups.create", "group") if private else ("channels.create", "channel")
        )
        body = await self._call("POST", path, json={"name": name})
        room = body.get(key)
        return room if isinstance(room, dict) else {}

    async def set_topic(self, room_id: str, topic: str, *, private: bool) -> None:
        prefix = "groups" if private else "channels"
        await self._call(
            "POST", f"{prefix}.setTopic", json={"roomId": room_id, "topic": topic}
        )

    async def invite(self, room_id: str, user_id: str, *, private: bool) -> None:
        prefix = "groups" if private else "channels"
        await self._call(
            "POST", f"{prefix}.invite", json={"roomId": room_id, "userId": user_id}
        )

    async def archive(self, room_id: str, *, private: bool) -> None:
        prefix = "groups" if private else "channels"
        await self._call("POST", f"{prefix}.archive", json={"roomId": room_id})

    async def open_direct(self, username: str) -> dict[str, Any]:
        body = await self._call("POST", "im.create", json={"username": username})
        room = body.get("room")
        return room if isinstance(room, dict) else {}
