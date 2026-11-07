"""Matrix collaboration bridge adapter.

Connects Switch to rooms on a Matrix homeserver the operator already has, as a
bot account the operator created and gave Switch the access token of. It is
the only Matrix code in Switch: Switch's own message bus is PostgreSQL, and
names like `matrix_room_id` elsewhere are kept identifiers, not a homeserver.

Single-bot identity model, as on Telegram. A Matrix message has no per-message
sender, so every agent posts through the one bot account and is told apart by
its name at the head of the message.

Inbound arrives over `/sync`, which only the process holding the bridge runs
(`keeps_quiet_unless_listening`). Nothing a second process would need is kept
in this one: where the holder left off is the bot's own `m.fully_read` marker
in each room, stored on the homeserver, and a post delivered twice is the same
event id, which core recognises. See `_catch_up`.

End-to-end encrypted rooms are refused. The bot has no device keys it could
keep across restarts and pods, so it says so in the room and leaves.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RichContentFailed,
)
from switch_core.bridges.collaboration.matrix.client import (
    MatrixAPIError,
    MatrixClient,
)
from switch_core.bridges.collaboration.matrix.markup import chunk_message, text_content
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.outbound import OutboundPolicy, guarded_async_client

logger = logging.getLogger(__name__)

_WORKING_REACTION = "👀"
_QUEUED_REACTION = "⏳"
_REACTIONS: dict[str, str] = {"working": _WORKING_REACTION, "queued": _QUEUED_REACTION}

_SYNC_TIMEOUT_MS = 30_000
_SYNC_FILTER: dict[str, Any] = {
    "room": {
        "timeline": {
            "limit": 50,
            "types": [
                "m.room.message",
                "m.room.encrypted",
                "m.room.encryption",
                "m.room.member",
            ],
        },
        "state": {"lazy_load_members": True, "types": ["m.room.encryption"]},
        "ephemeral": {"types": []},
        "account_data": {"types": []},
    },
    "presence": {"types": []},
    "account_data": {"types": []},
}
# How far back one catch-up looks for where it left off. A gap longer than
# this is logged and the newest events are the ones relayed.
_MAX_BACKFILL_EVENTS = 500
_BACKFILL_PAGE = 100
_BACKOFF_CEILING_SECONDS = 30.0
_SEEN_EVENTS_MAX = 1000
# The largest file taken from a room, whatever the deployment allows.
_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

_MXID = re.compile(r"^@[^:\s]+:[^\s]+$")
_REPLY_FALLBACK = re.compile(r"\A(?:> .*\n)+\n?")
_MEDIA_TYPES = {"m.image", "m.file", "m.audio", "m.video"}
_ENCRYPTION_NOTICE = (
    "This room is end-to-end encrypted. Switch cannot read or send messages in "
    "encrypted rooms, so it is not connected to this one and has left. Create a "
    "room without encryption and invite this account to it."
)


def _homeserver(value: str) -> str:
    """`value` as a homeserver base URL: http(s), a host, no credentials."""
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("homeserver_url must be an http(s) URL naming the server")
    if parts.username or parts.password:
        raise ValueError("homeserver_url must not carry a username or password")
    if parts.query or parts.fragment:
        raise ValueError("homeserver_url must not carry a query or fragment")
    try:
        parts.port
    except ValueError as exc:
        raise ValueError(f"homeserver_url has an invalid port: {exc}") from exc
    return value.rstrip("/")


class MatrixConnectionConfig(BridgeConnectionConfig):
    homeserver_url: str = Field(
        title="Homeserver URL",
        description=(
            "The address Switch connects to, such as https://matrix.example.org. "
            "The client-server API must be reachable there."
        ),
    )
    user_id: str = Field(
        title="Bot user ID",
        description="The bot account's Matrix ID, such as @switch-bot:example.org.",
    )
    access_token: str = Field(
        title="Bot access token",
        description=(
            "An access token for the bot account. Do not log the bot in again "
            "elsewhere afterwards: that can end this session."
        ),
    )

    @field_validator("homeserver_url")
    @classmethod
    def _url_names_a_server(cls, value: str) -> str:
        return _homeserver(value)

    @field_validator("user_id")
    @classmethod
    def _id_is_a_matrix_id(cls, value: str) -> str:
        value = value.strip()
        if not _MXID.match(value):
            raise ValueError(
                "user_id must be a Matrix ID of the form @name:server, "
                "such as @switch-bot:example.org"
            )
        return value

    @field_validator("access_token")
    @classmethod
    def _token_is_given(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("access_token is required")
        return value


def _new_http(policy: OutboundPolicy | None) -> httpx.AsyncClient:
    """The HTTP client for one homeserver: no redirects, and the deployment's
    outbound policy where there is one. The URL is the operator's, so a
    redirect from it could point anywhere."""
    if policy is None:
        return httpx.AsyncClient(follow_redirects=False, trust_env=False)
    return guarded_async_client(policy, follow_redirects=False)


def handle_of(user_id: str, own_server: str) -> str:
    """The name Switch addresses a Matrix user by: their local part, with their
    server added when it is not the bot's, so two people called `alice` on
    different servers stay two people."""
    local, _, server = user_id.removeprefix("@").partition(":")
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", local) or "user"
    if server == own_server:
        return clean
    return f"{clean}_{re.sub(r'[^A-Za-z0-9.-]', '_', server)}"


def strip_reply_fallback(text: str) -> str:
    """Take the quoted `> <@user> ...` lines older clients put at the head of a
    reply off its text."""
    if text.startswith("> <@"):
        return _REPLY_FALLBACK.sub("", text, count=1)
    return text


def _thread_relation(root_id: str) -> dict[str, Any]:
    return {
        "rel_type": "m.thread",
        "event_id": root_id,
        "is_falling_back": True,
        "m.in_reply_to": {"event_id": root_id},
    }


def _is_encrypted(events: list[dict[str, Any]]) -> bool:
    return any(
        event.get("type") in ("m.room.encryption", "m.room.encrypted")
        for event in events
    )


@dataclass
class _Room:
    name: str | None
    channel_type: ChannelType


class MatrixAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Matrix"
    # The bot leaves a room whose Switch room was deleted.
    channel_on_delete = "left"
    # `/sync` is a long-lived connection: a copy in every process would relay
    # every room's messages once per process.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # Matrix clients linkify only web schemes in a message.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Drawn as text: a turn's status, and approval and question cards answered
    # by typing, since Matrix has no buttons a bot can put on a message.
    draws_session_activity: ClassVar[bool] = True
    supports_activity_reactions: ClassVar[bool] = True
    # One account posts for every agent, so one reaction serves them all.
    activity_reactions_per_agent: ClassVar[bool] = False
    # A user may put two different reactions on one event.
    supports_queue_reaction: ClassVar[bool] = True

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask the homeserver who the token belongs to (`whoami`), as `start`
        will. `homeserver_url` has been through the outbound policy before this
        is called."""
        config = MatrixConnectionConfig.model_validate(connection_config)
        client = MatrixClient(
            config.homeserver_url, config.access_token, _new_http(None)
        )
        try:
            who = await client.whoami()
        except MatrixAPIError as error:
            if error.errcode in ("M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"):
                raise BridgeCredentialError(
                    "The homeserver rejected the access token. Create a new one "
                    "for the bot account and enter it again."
                ) from error
            raise BridgeCredentialError(
                f"The homeserver refused the check: {error.message or error.errcode}"
            ) from error
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                f"Could not reach a Matrix homeserver at {config.homeserver_url} "
                f"to check the token ({type(exc).__name__})."
            ) from exc
        finally:
            await client.aclose()
        actual = who.get("user_id")
        if actual != config.user_id:
            raise BridgeCredentialError(
                f"The token belongs to {actual or 'an unknown account'}, "
                f"not {config.user_id}. Enter the bot's own token and ID."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, MatrixAPIError):
            if exc.errcode in ("M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"):
                return "auth_failed"
            return "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        if isinstance(exc, httpx.HTTPError):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The bot account: two bridges on one account would each relay every
        message of its rooms into a different place."""
        return f"Matrix account {str(connection_config['user_id']).strip()}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [_homeserver(str(connection_config["homeserver_url"]))]

    def __init__(self, *, config: MatrixConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._user_id = config.user_id
        self._server = config.user_id.partition(":")[2]
        self._client: MatrixClient | None = None
        self._sync_task: asyncio.Task[None] | None = None
        # What was found out about a room, so it is asked once. A cache: it can
        # be lost and found again, and nothing in it is needed by another pod.
        self._rooms: dict[str, _Room] = {}
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._upload_limit: int | None = None
        self._upload_limit_read = False
        self._attention: str | None = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        # One bot for every agent, so there is no per-agent join to see.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        self._client = MatrixClient(
            self._config.homeserver_url,
            self._config.access_token,
            _new_http(self.outbound_policy),
        )
        who = await self._client.whoami()
        if who.get("user_id") != self._user_id:
            raise BridgeCredentialError(
                f"The token belongs to {who.get('user_id')}, not {self._user_id}."
            )
        if not self._listening:
            logger.info(
                "Matrix adapter for %s running quietly: another process holds "
                "this bridge and syncs for it",
                self._user_id,
            )
            return
        self._sync_task = asyncio.create_task(self._sync_loop())
        logger.info("Matrix adapter connected as %s", self._user_id)

    async def stop(self) -> None:
        task, self._sync_task = self._sync_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def attention(self) -> str | None:
        return self._attention

    @staticmethod
    def _callback(
        callback: Callable[[Any], Awaitable[None]] | None,
    ) -> Callable[[Any], Awaitable[None]]:
        if callback is None:
            raise RuntimeError("Matrix bridge not started")
        return callback

    def _require_client(self) -> MatrixClient:
        if self._client is None:
            raise RuntimeError("Matrix bridge not connected")
        return self._client

    # ── Inbound: sync ────────────────────────────────────────────────────────

    async def _sync_loop(self) -> None:
        client = self._require_client()
        since: str | None = None
        failures = 0
        while True:
            try:
                data = await client.sync(
                    since, 0 if since is None else _SYNC_TIMEOUT_MS, _SYNC_FILTER
                )
                await self._process_sync(data, initial=since is None)
                since = str(data["next_batch"])
                failures = 0
                self._attention = None
            except asyncio.CancelledError:
                raise
            except MatrixAPIError as error:
                if error.errcode in ("M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"):
                    self._attention = (
                        "The homeserver no longer accepts the bot's access token. "
                        "Create a new one and edit the connection."
                    )
                    logger.error(
                        "Matrix bridge for %s stopped: %s", self._user_id, error
                    )
                    return
                failures += 1
                logger.warning("Matrix sync failed: %s", error)
                await asyncio.sleep(self._backoff(failures))
            except Exception as error:
                failures += 1
                logger.warning(
                    "Matrix sync failed (%s); retrying", type(error).__name__
                )
                await asyncio.sleep(self._backoff(failures))

    @staticmethod
    def _backoff(failures: int) -> float:
        return float(min(2**failures, _BACKOFF_CEILING_SECONDS))

    async def _process_sync(self, data: dict[str, Any], *, initial: bool) -> None:
        rooms = data.get("rooms", {})
        for room_id, invite in rooms.get("invite", {}).items():
            await self._guarded(room_id, self._handle_invite(room_id, invite))
        for room_id, room in rooms.get("join", {}).items():
            await self._guarded(room_id, self._handle_joined(room_id, room, initial))

    async def _guarded(self, room_id: str, work: Awaitable[None]) -> None:
        """One room failing must not stop the others being read."""
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Could not process Matrix room %s", room_id)

    async def _handle_invite(self, room_id: str, invite: dict[str, Any]) -> None:
        stripped = invite.get("invite_state", {}).get("events", [])
        await self._require_client().join(room_id)
        if _is_encrypted(stripped):
            await self._refuse_encrypted(room_id)
            return
        name: str | None = None
        direct = False
        for event in stripped:
            content = event.get("content", {})
            if event.get("type") == "m.room.name":
                name = content.get("name") or None
            if event.get("type") == "m.room.member" and (
                event.get("state_key") == self._user_id
            ):
                direct = bool(content.get("is_direct"))
        room = await self._room(room_id, fresh=True)
        if direct:
            room = _Room(name, "direct")
            self._rooms[room_id] = room
        await self._callback(self._on_app_joined)(
            InboundAppJoin(
                channel_id=room_id,
                channel_type=room.channel_type,
                channel_name=room.name or name,
            )
        )

    async def _refuse_encrypted(self, room_id: str) -> None:
        """Say plainly why, and leave: an encrypted room can never be bridged."""
        client = self._require_client()
        try:
            await client.send_event(
                room_id,
                "m.room.message",
                {"msgtype": "m.notice", "body": _ENCRYPTION_NOTICE},
            )
        except MatrixAPIError as error:
            logger.warning("Could not post the encryption notice: %s", error)
        with contextlib.suppress(MatrixAPIError):
            await client.leave(room_id)
            await client.forget(room_id)
        self._rooms.pop(room_id, None)
        logger.info("Refused encrypted Matrix room %s", room_id)

    async def _handle_joined(
        self, room_id: str, room: dict[str, Any], initial: bool
    ) -> None:
        timeline = room.get("timeline", {})
        window: list[dict[str, Any]] = list(timeline.get("events", []))
        if _is_encrypted(room.get("state", {}).get("events", [])) or _is_encrypted(
            window
        ):
            await self._refuse_encrypted(room_id)
            return
        events = window
        if initial or timeline.get("limited"):
            events = await self._catch_up(room_id, timeline, window)
        for event in events:
            await self._handle_event(room_id, event)
        if window:
            await self._mark_read(room_id, window[-1]["event_id"])

    async def _catch_up(
        self, room_id: str, timeline: dict[str, Any], window: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """The events not yet relayed, as the homeserver remembers them.

        Where the last holder stopped is the bot's `m.fully_read` marker in the
        room: stored on the homeserver, so it survives a restart and a move to
        another pod. With no marker, the room is new to this bot: relay from
        its own join, or from now if that is out of the window.
        """
        client = self._require_client()
        marker = await client.fully_read(self._user_id, room_id)
        if marker is None:
            joined = [
                index
                for index, event in enumerate(window)
                if event.get("type") == "m.room.member"
                and event.get("state_key") == self._user_id
                and event.get("content", {}).get("membership") == "join"
            ]
            return window[joined[-1] + 1 :] if joined else []
        ids = [event["event_id"] for event in window]
        if marker in ids:
            return window[ids.index(marker) + 1 :]
        older: list[dict[str, Any]] = []
        token = timeline.get("prev_batch")
        found = False
        while token and not found and len(older) < _MAX_BACKFILL_EVENTS:
            page = await client.room_messages_before(room_id, token, _BACKFILL_PAGE)
            for event in page.get("chunk", []):
                if event.get("event_id") == marker:
                    found = True
                    break
                older.append(event)
            token = page.get("end")
        if not found and older:
            logger.warning(
                "Matrix room %s: did not find where the last sync stopped within "
                "%d events; relaying what was found",
                room_id,
                len(older),
            )
        older.reverse()
        return older + window

    async def _mark_read(self, room_id: str, event_id: str) -> None:
        try:
            await self._require_client().set_fully_read(room_id, event_id)
        except MatrixAPIError as error:
            # The next batch moves it on. Until then a restart may relay a
            # message twice, which core drops.
            logger.warning(
                "Could not record where Matrix room %s was read to: %s", room_id, error
            )

    async def _handle_event(self, room_id: str, event: dict[str, Any]) -> None:
        event_id = event.get("event_id", "")
        sender = event.get("sender", "")
        if sender == self._user_id or not event_id:
            return
        if event_id in self._seen:
            return
        self._seen[event_id] = None
        if len(self._seen) > _SEEN_EVENTS_MAX:
            self._seen.popitem(last=False)
        etype = event.get("type")
        if etype == "m.room.member":
            await self._handle_member(room_id, event)
        elif etype == "m.room.message":
            await self._handle_message(room_id, event)

    async def _handle_member(self, room_id: str, event: dict[str, Any]) -> None:
        user = str(event.get("state_key", ""))
        if event.get("content", {}).get("membership") != "join" or (
            user == self._user_id or not user
        ):
            return
        room = await self._room(room_id)
        await self._callback(self._on_user_joined)(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=room.channel_type,
                external_user_id=user,
                external_username=handle_of(user, self._server),
                channel_name=room.name,
            )
        )

    async def _handle_message(self, room_id: str, event: dict[str, Any]) -> None:
        content: dict[str, Any] = event.get("content", {})
        relation = content.get("m.relates_to") or {}
        if relation.get("rel_type") == "m.replace":
            # An edit of a message. Core has no way to take one, so it is not
            # relayed; the original stays as it was sent.
            return
        sender: str = event["sender"]
        room = await self._room(room_id)
        body = str(content.get("body", ""))
        msgtype = content.get("msgtype")
        text = self.translate_inbound(body)
        root_id = self._root_of(relation)
        name = handle_of(sender, self._server)
        event_id: str = event["event_id"]
        if msgtype in _MEDIA_TYPES:
            filename = str(content.get("filename") or body or "file")
            text = body if content.get("filename") and body != filename else ""
            attachments, failures = await self._fetch_attachment(content, filename)
        else:
            attachments, failures = [], []
        if msgtype in ("m.text", "m.emote", "m.notice") and text.lstrip().startswith(
            "!"
        ):
            parts = text.strip().split(None, 1)
            await self._callback(self._on_command)(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=room.channel_type,
                    sender_id=sender,
                    sender_name=name,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=event_id,
                    root_id=root_id,
                    channel_name=room.name,
                )
            )
            return
        if not text and not attachments and not failures:
            return
        await self._callback(self._on_message)(
            InboundMessage(
                channel_id=room_id,
                channel_type=room.channel_type,
                sender_id=sender,
                sender_name=name,
                content=text,
                message_ref=event_id,
                root_id=root_id,
                channel_name=room.name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=(
                    handle_of(self._user_id, self._server)
                    if self._mentions_bot(content, body)
                    else None
                ),
                sender_is_app=msgtype == "m.notice",
            )
        )

    @staticmethod
    def _root_of(relation: dict[str, Any]) -> str | None:
        """The thread a message is in: its `m.thread` root, or else the message
        it replies to, which stands in as the root as it does on Telegram."""
        if relation.get("rel_type") == "m.thread":
            return str(relation["event_id"])
        replied = (relation.get("m.in_reply_to") or {}).get("event_id")
        return str(replied) if replied else None

    def _mentions_bot(self, content: dict[str, Any], body: str) -> bool:
        listed = (content.get("m.mentions") or {}).get("user_ids") or []
        return self._user_id in listed or self._user_id in body

    async def _fetch_attachment(
        self, content: dict[str, Any], filename: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        url = content.get("url")
        if not isinstance(url, str):
            return [], [
                AttachmentFailure(
                    filename=filename, reason="it is not an uploaded file"
                )
            ]
        info = content.get("info") or {}
        mimetype = str(info.get("mimetype") or "application/octet-stream")
        cap = min(self._max_attachment_bytes, _MAX_DOWNLOAD_BYTES)
        size = info.get("size")
        if isinstance(size, int) and size > cap:
            return [], [
                AttachmentFailure(
                    filename=filename,
                    reason=f"{size} bytes exceeds the {cap} byte limit",
                )
            ]
        try:
            data = bytearray()
            async with self._require_client().download(url) as response:
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > cap:
                        return [], [
                            AttachmentFailure(
                                filename=filename,
                                reason=f"it exceeds the {cap} byte limit",
                            )
                        ]
        except (MatrixAPIError, httpx.HTTPError) as error:
            logger.warning(
                "Could not download Matrix attachment %s: %s", filename, error
            )
            return [], [
                AttachmentFailure(filename=filename, reason=f"download failed: {error}")
            ]
        return [Attachment(filename=filename, mimetype=mimetype, data=bytes(data))], []

    async def _room(self, room_id: str, *, fresh: bool = False) -> _Room:
        known = self._rooms.get(room_id)
        if known is not None and not fresh:
            return known
        client = self._require_client()
        named = await client.state_event(room_id, "m.room.name")
        rules = await client.state_event(room_id, "m.room.join_rules")
        members = await client.joined_members(room_id)
        channel_type: ChannelType
        if (rules or {}).get("join_rule") == "public":
            channel_type = "channel_public"
        elif len(members) == 2:
            channel_type = "direct"
        else:
            channel_type = "channel_private"
        room = _Room((named or {}).get("name") or None, channel_type)
        self._rooms[room_id] = room
        return room

    def translate_inbound(self, raw_message: str) -> str:
        return strip_reply_fallback(raw_message)

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        # Matrix takes Markdown, which is what Switch writes. It is turned into
        # HTML when the message is sent, so a long reply is cut as Markdown.
        return content

    def rich_fallback_limit(self) -> int:
        # Three thousand characters is at most 12,000 bytes: one message, so a
        # card is never split and can be edited in place.
        return 3000

    async def _send(
        self, channel_id: str, content: dict[str, Any], thread_root_id: str | None
    ) -> str:
        if thread_root_id is not None:
            content = {**content, "m.relates_to": _thread_relation(thread_root_id)}
        return await self._require_client().send_event(
            channel_id, "m.room.message", content
        )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the bot with the agent's name at the head of the message, in
        as many messages as the text needs. Returns the first one's id."""
        agent = await self.agent_rendering(sender_name)
        first: str | None = None
        for piece in chunk_message(content):
            ref = await self._send(
                channel_id, text_content(piece, agent.body_label), thread_root_id
            )
            first = first or ref
        return first

    async def _replace(
        self, channel_id: str, message_ref: str, text: str, label: str | None
    ) -> None:
        new = text_content(chunk_message(text)[0], label)
        content = {
            **new,
            "body": f"* {new['body']}",
            "m.new_content": new,
            "m.relates_to": {"rel_type": "m.replace", "event_id": message_ref},
        }
        await self._require_client().send_event(channel_id, "m.room.message", content)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._replace(channel_id, message_ref, new_content, None)
        except MatrixAPIError as error:
            logger.error("Failed to edit Matrix message %s: %s", message_ref, error)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: Any,
        thread_root_id: str | None,
    ) -> None:
        # The edit replaces the whole message, so it carries the agent's name
        # again: the bot's name is not what the reader should see.
        text = self.rich_fallback_text(content)
        agent = await self.agent_rendering(agent_name)
        try:
            await self._replace(channel_id, message_ref, text, agent.body_label)
        except Exception as error:
            raise RichContentFailed(
                f"Matrix could not update the message in {channel_id}: {error}",
                text=text,
            ) from error

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_client().redact(channel_id, message_ref)
        except MatrixAPIError as error:
            logger.error("Failed to delete Matrix message %s: %s", message_ref, error)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        try:
            await self._require_client().set_typing(
                channel_id, self._user_id, is_typing, 30_000
            )
        except MatrixAPIError as error:
            logger.warning(
                "Could not set typing in Matrix room %s: %s", channel_id, error
            )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self.send_typing(channel_id, agent_name, True)

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        """Put 👀 (or ⏳, for a prompt still waiting) on the message being worked
        on, or take it off. Taking it off finds the bot's own reaction on the
        homeserver, so it works from any pod and after a restart."""
        client = self._require_client()
        key = _REACTIONS[mark]
        try:
            if on:
                await client.send_event(
                    channel_id,
                    "m.reaction",
                    {
                        "m.relates_to": {
                            "rel_type": "m.annotation",
                            "event_id": message_ref,
                            "key": key,
                        }
                    },
                )
                return
            for reaction in await client.annotations(channel_id, message_ref):
                relation = reaction.get("content", {}).get("m.relates_to", {})
                if (
                    reaction.get("sender") == self._user_id
                    and relation.get("key") == key
                ):
                    await client.redact(channel_id, reaction["event_id"])
        except MatrixAPIError as error:
            if error.errcode == "M_DUPLICATE_ANNOTATION":
                return
            if error.errcode == "M_FORBIDDEN":
                raise ActivityMarkRefused(
                    f"Matrix will not {'add' if on else 'remove'} the working "
                    f"reaction in {channel_id} ({error.message})."
                ) from error
            raise

    async def _homeserver_upload_limit(self) -> int | None:
        if not self._upload_limit_read:
            try:
                self._upload_limit = await self._require_client().upload_limit()
            except MatrixAPIError:
                self._upload_limit = None
            self._upload_limit_read = True
        return self._upload_limit

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Relay one file. A file over the homeserver's upload limit is not
        sent and the room is told so, so a file is never silently dropped."""
        agent = await self.agent_rendering(sender_name)
        limit = await self._homeserver_upload_limit()
        if limit is not None and len(data) > limit:
            logger.warning(
                "Matrix attachment %s is %d bytes, over the %d byte upload limit",
                filename,
                len(data),
                limit,
            )
            return await self.send_message(
                channel_id,
                sender_name,
                f"_sent {filename}, but it is {len(data)} bytes and this "
                f"homeserver accepts at most {limit}._",
                thread_root_id,
            )
        try:
            uri = await self._require_client().upload(filename, mimetype, data)
        except MatrixAPIError as error:
            logger.error("Failed to upload %s to Matrix: %s", filename, error)
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )
        await self._send(
            channel_id,
            text_content(caption or f"sent {filename}", agent.body_label),
            thread_root_id,
        )
        kind = {"image": "m.image", "audio": "m.audio", "video": "m.video"}.get(
            mimetype.partition("/")[0], "m.file"
        )
        return await self._send(
            channel_id,
            {
                "msgtype": kind,
                "body": filename,
                "url": uri,
                "info": {"mimetype": mimetype, "size": len(data)},
            },
            thread_root_id,
        )

    # ── Channels ─────────────────────────────────────────────────────────────

    @staticmethod
    def _refusal(error: MatrixAPIError) -> BridgeOperationError:
        return BridgeOperationError(f"Matrix refused: {error.message or error.errcode}")

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        try:
            room_id = await self._require_client().create_room(
                {
                    "name": name,
                    "topic": topic,
                    "preset": (
                        "public_chat"
                        if channel_type == "channel_public"
                        else "private_chat"
                    ),
                }
            )
        except MatrixAPIError as error:
            raise self._refusal(error) from error
        self._rooms[room_id] = _Room(name, channel_type)
        return room_id

    async def create_dm_channel(
        self, *, agent_name: str, user_name: str, user_external_id: str
    ) -> str:
        try:
            room_id = await self._require_client().create_room(
                {
                    "preset": "trusted_private_chat",
                    "is_direct": True,
                    "invite": [user_external_id],
                }
            )
        except MatrixAPIError as error:
            raise self._refusal(error) from error
        self._rooms[room_id] = _Room(None, "direct")
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        client = self._require_client()
        try:
            await client.leave(external_channel_id)
            await client.forget(external_channel_id)
        except MatrixAPIError as error:
            return RetireOutcome(
                outcome="failed", reason=error.message or error.errcode
            )
        self._rooms.pop(external_channel_id, None)
        return RetireOutcome(outcome="left")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return (await self._room(channel_id, fresh=True)).channel_type

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        pass

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        client = self._require_client()
        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                await client.invite(channel_id, user_id)
            except MatrixAPIError as error:
                logger.warning(
                    "Could not invite %s to Matrix room %s: %s",
                    user_id,
                    channel_id,
                    error,
                )
                failed.append(user_id)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """The homeserver's user directory, which by default holds only people
        who share a room with the bot or are in a public room."""
        found = await self._require_client().search_users(query, 20)
        return [
            DirectoryUser(
                external_user_id=str(user["user_id"]),
                username=handle_of(str(user["user_id"]), self._server),
                display_name=str(user.get("display_name") or user["user_id"]),
            )
            for user in found
        ]

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return f"https://matrix.to/#/{external_channel_id}"
