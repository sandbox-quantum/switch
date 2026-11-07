"""Cisco Webex as a Switch messaging platform.

One Webex bot speaks for every agent, with the agent's name at the top of each
message, the way Telegram and Teams do it. What sets this adapter apart is how
it hears Webex: over the event socket Webex's own clients use
(`webex.socket`), not a webhook. Nothing has to reach Switch from the
internet — no public URL, no tunnel, no webhook for Webex to disable after a
run of failed deliveries — and when the socket drops, the messages sent while
it was down are read back when it returns.

What Webex itself does not allow a bot, and so this does not do, is declared
in the class attributes below and listed on the docs page: in a group space a
bot hears only the messages that mention it, there is no typing indicator or
reaction for a bot to set, and a message can be edited ten times.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    PrivateNoticeRefused,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    PrivateNoticeDelivery,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import (
    Drawn,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.webex.cards import (
    card_attachment,
    read_press,
    request_card,
)
from switch_core.bridges.collaboration.webex.client import (
    ServiceCatalog,
    WebexApiError,
    WebexClient,
    WebexFileTooLarge,
    WebexId,
    decode_id,
    same_entity,
)
from switch_core.bridges.collaboration.webex.socket import (
    WDM_URL,
    Connector,
    WebexEventStream,
    is_webex_socket,
)
from switch_core.bridges.collaboration.webex.text import (
    MAX_MESSAGE_BYTES,
    chunk,
    defuse_raw_mentions,
    mention,
    read_message,
    render_mentions,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# Webex accepts ten edits to a message and refuses the eleventh. A running
# turn's status is redrawn as the turn moves, so it stops at this many edits
# and keeps the rest for the redraw that matters most: the one that says how
# the turn ended.
_EDIT_LIMIT = 10
_PROGRESS_EDITS = 8

# How much a publication's text may spend. Webex measures its limit in bytes;
# the renderers count characters, so this leaves room for text that is not
# ASCII, and `_clamp` is the backstop in bytes.
_PUBLICATION_LIMIT = 3000

# What Webex calls a file it will carry in one message.
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# Reading back what was missed. After a dropped socket: everything since it
# dropped, with a margin for clocks. After a restart, when this process has no
# record of when the last one stopped listening: the last few minutes in the
# spaces Switch already knows. Switch writes a post once however many times it
# is delivered, so a message read back that was already handled writes nothing.
_RECONNECT_MARGIN = timedelta(seconds=30)
_RESTART_WINDOW = timedelta(minutes=5)
_CATCH_UP_ROOMS = 100
_CATCH_UP_MESSAGES = 50

# Bounded memory of what this process has seen, never needed for correctness:
# a restart that forgets it costs a lookup, not a duplicate.
_REMEMBERED = 2000

_COMMAND_PREFIXES = ("!", "/")
_MENTION_WORD = re.compile(r"(?<![\w@])@[\w.-]+")


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _handle_from(person: dict[str, Any], fallback: str) -> str:
    """The name a person goes by in Switch: their address's local part.

    A display name has spaces in it, and an agent has to be able to write
    `@name` for Switch to turn it back into a Webex mention. The address is
    the one thing Webex always has for a person, and its local part is what
    people already recognise as theirs.
    """
    emails = person.get("emails")
    email = (
        emails[0] if isinstance(emails, list) and emails else person.get("personEmail")
    )
    if isinstance(email, str) and "@" in email:
        return email.split("@", 1)[0].lower()
    name = person.get("displayName")
    return str(name) if isinstance(name, str) and name.strip() else fallback


class _Bounded(OrderedDict[str, Any]):
    def remember(self, key: str, value: Any) -> None:
        self[key] = value
        self.move_to_end(key)
        while len(self) > _REMEMBERED:
            self.popitem(last=False)


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        title="Bot access token",
        description=(
            "The bot's access token, shown once when you create the bot under "
            "My Webex Apps on developer.webex.com. Switch posts and listens as "
            "the bot with it. Not a personal access token: that one expires "
            "within a day and would post as you."
        ),
    )

    @field_validator("bot_token")
    @classmethod
    def _token_shape(cls, value: str) -> str:
        token = value.strip()
        if token.lower().startswith("bearer "):
            token = token[len("bearer ") :].strip()
        if not token:
            raise ValueError("Paste the bot's access token.")
        if any(ch.isspace() for ch in token):
            raise ValueError(
                "A Webex access token has no spaces in it. Copy it again from "
                "My Webex Apps."
            )
        return token


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Webex"
    # Set once docs/messaging-platforms/webex.md is published on the docs site.
    docs_slug: ClassVar[str | None] = None

    #: The event socket opens only in the process that holds the bridge.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    #: Turns and requests are drawn: a turn's status as one Markdown message
    #: edited as it moves, a request as an Adaptive Card with a button per
    #: option.
    draws_session_activity: ClassVar[bool] = True

    #: An edit notifies nobody on Webex, so a problem somebody has to act on
    #: gets a message of its own rather than an edit they would never see.
    separate_attention_slot: ClassVar[bool] = True

    #: Webex members choose to be notified of mentions only, and many do; a
    #: post that names nobody is a post nobody is told about.
    notifies_only_by_mention: ClassVar[bool] = True
    channel_mention: ClassVar[str | None] = "<@all>"

    #: Ten edits a message: the clock rides along with real changes.
    redraws_for_elapsed_time: ClassVar[bool] = False

    #: A bot can neither react to a message nor show itself typing.
    supports_activity_reactions: ClassVar[bool] = False
    supports_queue_reaction: ClassVar[bool] = False

    #: A bot creates spaces and adds people to them; and it can look people
    #: up by address everywhere, and by name where the organisation allows.
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = True

    #: Webex links only http(s), so Console links are rewritten to https.
    renders_custom_url_schemes: ClassVar[bool] = False

    #: Deleting a room takes the bot out of the space; the space and its
    #: history stay with the people in it.
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    #: A bot can write to anyone in a 1:1 space of their own, so a notice about
    #: what one person posted, or a press of theirs that did not land, goes to
    #: them alone.
    private_notice_delivery: ClassVar[PrivateNoticeDelivery] = "direct_message"

    def __init__(
        self,
        *,
        config: WebexConnectionConfig,
        http: httpx.AsyncClient | None = None,
        socket_connector: Connector | None = None,
        trusts_socket: Callable[[str], bool] = is_webex_socket,
        wdm_url: str | None = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=False
        )
        self._client = WebexClient(config.bot_token, self._http)
        self._socket_connector = socket_connector
        self._trusts_socket = trusts_socket
        # None: the device service is the one Webex's catalog names for this
        # bot, read on start.
        self._wdm_url = wdm_url
        self._catalog = ServiceCatalog()
        self._bot_email: str | None = None
        self._stream: WebexEventStream | None = None
        self._bot_id: str | None = None
        self._bot_handle = "webex-bot"
        self._bot_name = "Switch"
        # handle -> person id, for writing `@handle` as a real mention.
        self._mention_targets: dict[str, str] = {}
        # person id -> handle, for naming who said something.
        self._handles: _Bounded = _Bounded()
        self._rooms: _Bounded = _Bounded()
        self._seen: _Bounded = _Bounded()
        self._edits: _Bounded = _Bounded()
        self._drawn: _Bounded = _Bounded()
        # A card's first message id -> the message showing it now. Where Webex
        # won't edit a message that carries a card, a card that changes is
        # posted again (`_repost`) and the publisher keeps the id it was given.
        self._reposted: _Bounded = _Bounded()
        # False once Webex has refused to edit a card in this organisation.
        self._cards_editable = True
        # person id -> the name Webex shows for them.
        self._names: _Bounded = _Bounded()
        self._known_channels: set[str] = set()
        self._catching_up = asyncio.Lock()

    # ── Credentials and failures ────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexApiError):
            if exc.unauthorized:
                return "auth_failed"
            if exc.status == 0:
                return "config_invalid"
            return "platform_error"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WebexConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=15.0) as http:
            me = await cls._identify(WebexClient(config.bot_token, http))
        logger.info("Webex token belongs to bot %s", me.get("displayName"))

    @staticmethod
    async def _identify(client: WebexClient) -> dict[str, Any]:
        """The bot behind the token, or the reason it cannot be used."""
        try:
            me = await client.me()
        except WebexApiError as exc:
            if exc.unauthorized:
                raise BridgeCredentialError(
                    "Webex did not accept that token. Copy the bot's access token "
                    "again from My Webex Apps; regenerating it there replaces the "
                    "old one."
                ) from exc
            raise BridgeCredentialError(
                f"Could not check the token with Webex: {exc}"
            ) from exc
        if me.get("type") != "bot":
            raise BridgeCredentialError(
                "That token belongs to a person, not a bot. Create a bot under My "
                "Webex Apps on developer.webex.com and paste the bot's access "
                "token: a personal token expires within a day and would post as you."
            )
        return me

    # ── Lifecycle ───────────────────────────────────────────────────────────

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
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        me = await self._identify(self._client)
        self._bot_id = str(me["id"])
        self._bot_handle = _handle_from(me, self._bot_handle)
        self._bot_name = str(me.get("displayName") or self._bot_name)
        emails = me.get("emails")
        if isinstance(emails, list) and emails and isinstance(emails[0], str):
            self._bot_email = emails[0].lower()
        if not self._listening:
            logger.info("Webex bridge is quiet here; another process holds its socket")
            return
        await self._read_catalog()
        self._stream = self._event_stream()
        self._stream.start()

    async def _read_catalog(self) -> None:
        """Learn which regional services this bot's organisation uses."""
        try:
            self._catalog = await self._client.catalog()
        except WebexApiError as exc:
            logger.warning(
                "Could not read Webex's service catalog (%s); assuming the US "
                "services, which only works for an organisation hosted there",
                exc,
            )

    def _event_stream(self) -> WebexEventStream:
        extra: dict[str, Any] = {}
        if self._socket_connector is not None:
            extra["connector"] = self._socket_connector
        return WebexEventStream(
            self._client,
            self._config.bot_token,
            on_activity=self._on_activity,
            on_connected=self._on_socket_open,
            wdm_url=self._wdm_url or self._catalog.wdm_url or WDM_URL,
            trusts_socket=self._trusts_socket,
            **extra,
        )

    async def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            await stream.stop()
        if self._owns_http:
            await self._http.aclose()

    async def withdraw(self) -> None:
        """Remove the bot's device, so Webex stops holding events for it."""
        if self._stream is None and self._catalog.wdm_url is None:
            await self._read_catalog()
        await (self._stream or self._event_stream()).forget_device()

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Note the spaces Switch knows, for reading back after a restart."""
        self._known_channels.update(channel_id for channel_id, _ in channels)

    # ── Inbound ─────────────────────────────────────────────────────────────

    def _id_for(self, kind: str, uuid: str, where: str | None = None) -> str:
        """The REST id of something the socket named by uuid alone.

        Built in the cluster of the service `where` names — the conversation an
        activity happened in — since an organisation hosted outside the US has
        its spaces and messages in a cluster of its own. A person's id is in
        the bot's own cluster, which is also the fallback.
        """
        cluster = self._catalog.cluster_for(where)
        if cluster is None:
            own = decode_id(self._bot_id or "")
            cluster = own.cluster if own is not None else "us"
        return WebexId(cluster=cluster, kind=kind, uuid=uuid).encode()

    def _is_bot(self, actor: dict[str, Any]) -> bool:
        """Whether the socket's `actor` is this bot.

        The socket names an actor by address in `id` and by uuid in
        `entryUUID`, so both are checked.
        """
        for value in (actor.get("entryUUID"), actor.get("id")):
            if isinstance(value, str) and same_entity(value, self._bot_id):
                return True
        address = actor.get("emailAddress") or actor.get("id")
        return bool(
            self._bot_email
            and isinstance(address, str)
            and address.lower() == self._bot_email
        )

    async def _on_activity(self, activity: dict[str, Any]) -> None:
        verb = activity.get("verb")
        if self._is_bot(_dict(activity.get("actor"))) and verb != "add":
            return
        activity_id = str(activity.get("id") or "")
        where = str(
            _dict(activity.get("target")).get("url") or activity.get("url") or ""
        )
        if not activity_id:
            return
        if verb in ("post", "share"):
            message_id = self._id_for("MESSAGE", activity_id, where)
            try:
                message = await self._client.message(message_id)
            except WebexApiError as exc:
                if exc.status in (403, 404):
                    # In a group space a bot may read only what mentions it,
                    # and the socket announces everything said there.
                    logger.debug(
                        "Webex message %s is not one the bot may read", message_id
                    )
                    return
                raise
            await self._handle_message(message)
        elif verb == "cardAction":
            await self._handle_press(
                self._id_for("ATTACHMENT_ACTION", activity_id, where)
            )
        elif verb == "add":
            await self._handle_added(activity)

    async def _on_socket_open(self, down_since: datetime | None) -> None:
        """Read back what was said while nothing here was listening."""
        if down_since is None:
            since = datetime.now(UTC) - _RESTART_WINDOW
            only = set(self._known_channels)
            if not only:
                return
        else:
            since = down_since - _RECONNECT_MARGIN
            only = None
        await self._catch_up(since, only)

    async def _catch_up(self, since: datetime, only: set[str] | None) -> int:
        async with self._catching_up:
            relayed = 0
            for room in await self._client.rooms(limit=_CATCH_UP_ROOMS):
                active = _parse_time(room.get("lastActivity"))
                if active is not None and active < since:
                    break  # Webex lists the most recently active first.
                room_id = str(room.get("id") or "")
                if not room_id or (only is not None and room_id not in only):
                    continue
                self._rooms.remember(room_id, room)
                try:
                    messages = await self._client.messages(
                        room_id,
                        mentioned_me=room.get("type") != "direct",
                        limit=_CATCH_UP_MESSAGES,
                    )
                except WebexApiError as exc:
                    logger.warning(
                        "Could not read back Webex space %s: %s", room_id, exc
                    )
                    continue
                for message in reversed(messages):
                    created = _parse_time(message.get("created"))
                    if created is None or created < since:
                        continue
                    if await self._handle_message(message):
                        relayed += 1
            if relayed:
                logger.info(
                    "Read back %d Webex message(s) sent while the socket was down",
                    relayed,
                )
            return relayed

    async def _handle_message(self, message: dict[str, Any]) -> bool:
        """Hand one Webex message to Switch. False when it was not handed on."""
        message_id = str(message.get("id") or "")
        room_id = str(message.get("roomId") or "")
        person_id = str(message.get("personId") or "")
        if not message_id or not room_id or message_id in self._seen:
            return False
        self._seen.remember(message_id, True)
        if same_entity(person_id, self._bot_id):
            return False
        channel_type: ChannelType = (
            "direct" if message.get("roomType") == "direct" else "channel_private"
        )
        sender_name = await self._handle(person_id, message.get("personEmail"))
        channel_name = await self._room_title(room_id)
        inbound = read_message(message, self._bot_id)
        text = inbound.text
        root_id = message.get("parentId") or None

        command = self._command_in(text)
        if command is not None and self._on_command is not None:
            parts = text.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=channel_type,
                    sender_id=person_id,
                    sender_name=sender_name,
                    command=command,
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return True

        if self._on_message is None:
            return False
        attachments, failures = await self._files(message)
        if not text and not attachments and not failures:
            return False
        # The bot's mention is how a group message reaches the bot at all, so
        # it counts as addressing an agent only when the message names none:
        # `@Switch fix it` in a room with one agent is for that agent, and
        # `@Switch @coder fix it` is for coder without anything being guessed.
        addressed_to_bot = (inbound.mentions_bot or channel_type == "direct") and (
            _MENTION_WORD.search(text) is None
        )
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=person_id,
                sender_name=sender_name,
                content=text,
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._bot_handle if addressed_to_bot else None,
            )
        )
        return True

    @staticmethod
    def _command_in(text: str) -> str | None:
        """The command a message runs, or None for ordinary text.

        `!` is Switch's own and means nothing else, so an unknown `!name` is a
        misspelt command and is answered as one. `/` opens paths and dates as
        often as commands, so only a name Switch knows makes it one.
        """
        if not text or text[0] not in _COMMAND_PREFIXES:
            return None
        first = text.split(None, 1)[0]
        name = first[1:].lower()
        if not name:
            return None
        if name in COMMANDS_BY_NAME or first.startswith("!"):
            return name
        return None

    async def _files(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for url in message.get("files") or []:
            if not isinstance(url, str):
                continue
            try:
                filename, mimetype, data = await self._client.download(
                    url, max_bytes=self._max_attachment_bytes
                )
            except WebexFileTooLarge as exc:
                failures.append(
                    AttachmentFailure(filename=exc.filename, reason=str(exc))
                )
                continue
            except (WebexApiError, httpx.HTTPError) as exc:
                logger.warning("Could not download a Webex file: %s", exc)
                failures.append(
                    AttachmentFailure(
                        filename="file", reason="Webex would not hand it over"
                    )
                )
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    async def _handle_press(self, action_id: str) -> None:
        action = await self._client.attachment_action(action_id)
        press = read_press(action.get("inputs"))
        if press is None:
            logger.info("Ignoring a press on a Webex card that is not a Switch card")
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card has nowhere to go: this bridge handles "
                "no interactions, so the card should not have had buttons"
            )
            return
        person_id = str(action.get("personId") or "")
        if same_entity(person_id, self._bot_id):
            return
        token, position = press
        await self._on_interaction(
            InboundInteraction(
                channel_id=str(action.get("roomId") or ""),
                sender_id=person_id,
                sender_name=await self._handle(person_id, None),
                action_id=position_action(position),
                value=token,
                message_ref=str(action.get("messageId") or "") or None,
            )
        )

    async def _handle_added(self, activity: dict[str, Any]) -> None:
        """Someone, or the bot itself, was added to a space."""
        added = _dict(activity.get("object"))
        target = _dict(activity.get("target"))
        if added.get("objectType") != "person" or not target.get("id"):
            return
        room_id = self._id_for(
            "ROOM", str(target["id"]), str(target.get("url") or "") or None
        )
        try:
            room = await self._room(room_id)
        except WebexApiError as exc:
            logger.info("Could not read the Webex space someone was added to: %s", exc)
            return
        channel_type = self._channel_type_of(room)
        title = str(room.get("title") or "") or None
        if same_entity(str(added.get("id") or ""), self._bot_id):
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=room_id,
                        channel_type=channel_type,
                        channel_name=title,
                    )
                )
            return
        if self._on_user_joined is None:
            return
        person_id = self._id_for("PEOPLE", str(added["id"]))
        await self._on_user_joined(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=channel_type,
                external_user_id=person_id,
                external_username=await self._handle(
                    person_id, added.get("emailAddress")
                ),
                channel_name=title,
            )
        )

    async def _handle(self, person_id: str, email: object) -> str:
        """What a person is called in Switch, learned once and remembered."""
        known = self._handles.get(person_id)
        if known:
            return str(known)
        if isinstance(email, str) and "@" in email:
            handle = email.split("@", 1)[0].lower()
        else:
            try:
                handle = _handle_from(await self._client.person(person_id), person_id)
            except WebexApiError as exc:
                logger.info("Could not read Webex person %s: %s", person_id, exc)
                return person_id
        claimed = self._mention_targets.get(handle)
        if (
            claimed is not None
            and not same_entity(claimed, person_id)
            and isinstance(email, str)
        ):
            handle = (
                email.lower()
            )  # two people share a local part; the address does not
        self._handles.remember(person_id, handle)
        self._mention_targets.setdefault(handle, person_id)
        return handle

    def is_placeholder_username(self, username: str) -> bool:
        return decode_id(username) is not None

    async def _room(self, room_id: str) -> dict[str, Any]:
        cached = self._rooms.get(room_id)
        if cached is not None:
            return dict(cached)
        room = await self._client.room(room_id)
        self._rooms.remember(room_id, room)
        return room

    async def _room_title(self, room_id: str) -> str | None:
        try:
            room = await self._room(room_id)
        except WebexApiError as exc:
            logger.info("Could not read Webex space %s: %s", room_id, exc)
            return None
        return str(room.get("title") or "") or None

    @staticmethod
    def _channel_type_of(room: dict[str, Any]) -> ChannelType:
        return "direct" if room.get("type") == "direct" else "channel_private"

    # ── Text ────────────────────────────────────────────────────────────────

    def translate_inbound(self, raw_message: str) -> str:
        """Already Switch Markdown: `text.read_message` did the reading."""
        return raw_message

    def _render_outbound(self, content: str) -> str:
        return render_mentions(defuse_raw_mentions(content), self._mention_targets)

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        for handle, person_id in targets.items():
            self._mention_targets[handle] = person_id
            self._handles.remember(person_id, handle)

    def render_app_mention(self, token: str) -> str:
        return f"**@{self._bot_name}**"

    def _bridge_display_name(self) -> str:
        return self._bot_name

    # ── Outbound ────────────────────────────────────────────────────────────

    async def _label(self, sender_name: str) -> str:
        agent = await self.agent_rendering(sender_name)
        return f"**{agent.body_label}**"

    async def _post(
        self, channel_id: str, parts: list[str], thread_root_id: str | None
    ) -> str | None:
        """Post `parts` in order; the first one's id is the message's."""
        first: str | None = None
        parent = thread_root_id
        for part in parts:
            body: dict[str, Any] = {"roomId": channel_id, "markdown": part}
            if parent:
                body["parentId"] = parent
            try:
                sent = await self._client.post_message(body)
            except WebexApiError as exc:
                if parent and exc.status == 400:
                    parent = await self._thread_root(parent)
                    if parent:
                        body["parentId"] = parent
                    else:
                        body.pop("parentId", None)
                    sent = await self._client.post_message(body)
                else:
                    raise
            first = first or str(sent.get("id") or "") or None
        return first

    async def _thread_root(self, message_id: str) -> str | None:
        """The root a reply to `message_id` has to go under, or None for none.

        Webex threads are one level deep and refuse a reply to a reply, so a
        reply aimed at one goes to the root that one is under.
        """
        try:
            message = await self._client.message(message_id)
        except WebexApiError:
            return None
        parent = message.get("parentId")
        return str(parent) if parent else None

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        label = await self._label(sender_name)
        try:
            return await self._post(
                channel_id, chunk(f"{label}\n{content}"), thread_root_id
            )
        except WebexApiError as exc:
            logger.warning("Webex refused a message in space %s: %s", channel_id, exc)
            return None

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        body = self._admin_body(self.translate_outbound(content), drawn)
        try:
            return await self._post(channel_id, chunk(body), thread_root_id)
        except WebexApiError as exc:
            logger.warning("Webex refused a notice in space %s: %s", channel_id, exc)
            return None

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
        if len(data) > _MAX_UPLOAD_BYTES:
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )
        label = await self._label(sender_name)
        text = f"{label}\n{self.translate_outbound(caption)}" if caption else label
        fields = {"roomId": channel_id, "markdown": chunk(text)[0]}
        if thread_root_id:
            fields["parentId"] = thread_root_id
        try:
            sent = await self._client.post_file(fields, filename, mimetype, data)
        except WebexApiError as exc:
            logger.warning("Webex refused a file in space %s: %s", channel_id, exc)
            return None
        return str(sent.get("id") or "") or None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        if self._edits.get(message_ref, 0) >= _EDIT_LIMIT:
            logger.info(
                "Not editing Webex message %s: it has had all ten edits", message_ref
            )
            return
        try:
            await self._client.edit_message(
                message_ref, {"roomId": channel_id, "markdown": chunk(new_content)[0]}
            )
        except WebexApiError as exc:
            logger.warning("Webex refused an edit to %s: %s", message_ref, exc)
            return
        self._edits.remember(message_ref, self._edits.get(message_ref, 0) + 1)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._client.delete_message(message_ref)
        except WebexApiError as exc:
            if not exc.gone:
                logger.warning("Webex refused to delete %s: %s", message_ref, exc)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """A Webex bot has no typing indicator to show."""

    # ── Private notices ─────────────────────────────────────────────────────

    async def _direct(self, person_id: str, markdown: str) -> None:
        for part in chunk(markdown):
            await self._client.post_message({"toPersonId": person_id, "markdown": part})

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        where = channel_name or await self._room_title(channel_id)
        heading = (
            f"About your message in **{self.escape_label_for_body(where)}**:\n"
            if where
            else ""
        )
        try:
            await self._direct(user_id, heading + self.translate_outbound(content))
        except WebexApiError as exc:
            if exc.status in (400, 403, 404):
                raise PrivateNoticeRefused(str(exc)) from exc
            raise

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person, in their 1:1 space with the bot, that an answer missed.

        Only they need to know, and Webex lets a bot write to anyone directly,
        so the card's space is not told about somebody else's failed press.
        Falls back to saying it beside the card if the direct message fails.
        """
        where = await self._room_title(channel_id)
        place = f" in **{self.escape_label_for_body(where)}**" if where else ""
        try:
            await self._direct(
                actor_ref,
                f"Your answer{place} did not go through: "
                f"{self.escape_label_for_body(text)}",
            )
        except Exception as exc:
            logger.info(
                "Could not tell %s directly (%s); saying it in the space",
                actor_ref,
                exc,
            )
            await super().tell_actor(
                channel_id, actor_ref, actor_name, thread_ref, text
            )

    # ── Rich content ────────────────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return _PUBLICATION_LIMIT

    def rich_fallback_text(self, content: RichContent) -> str:
        return self._draw(content, mention=None).text

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None = None,
    ) -> Drawn:
        escape = self._rich_escape
        limit = self.rich_fallback_limit()
        markup = self.rich_markup()
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        if isinstance(content, TurnActivity):
            text = turn_status(
                content.items,
                content.turn,
                escape=escape,
                limit=max(1, limit - len(tail)),
                markup=markup,
                elapsed_seconds=content.elapsed_seconds,
                mention=mention,
                error_summary=content.error_summary,
                tool_detail=True,
            )
            return Drawn(text=f"{text}{tail}", answerable=False)
        drawn = render_request(
            content.request,
            content.reference,
            escape=escape,
            limit=max(1, limit - len(tail)),
            markup=markup,
            responder=responder,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=None,
        )
        return replace(drawn, text=f"{drawn.text}{tail}")

    @staticmethod
    def _clamp(text: str) -> str:
        return chunk(text, MAX_MESSAGE_BYTES)[0]

    async def _publication(
        self, channel_id: str, agent_name: str, content: RichContent, *, notify: bool
    ) -> tuple[dict[str, Any], str]:
        """The message a publication is, and its text for a failure to carry.

        A turn's status is Markdown, and its mention goes in it. A request is
        a card, and Webex refuses a mention in a message that carries one, so
        a request's mention is sent on its own beside it (`_ping`).
        """
        agent = await self.agent_rendering(agent_name)
        heading = f"**{agent.body_label}**\n"
        if isinstance(content, TurnActivity):
            who = content.notify_external_id if notify else None
            drawn = self._draw(content, mention=mention(who) if who else None)
            text = self._clamp(heading + drawn.text)
            return {"roomId": channel_id, "markdown": text}, text
        responder = await self._name(content.responder_external_id)
        drawn = self._draw(content, mention=None, responder=responder)
        text = self._clamp(heading + drawn.text)
        card = request_card(
            agent, drawn.text, content.reference.token, self._controls(content, drawn)
        )
        return (
            {
                "roomId": channel_id,
                "markdown": text,
                "attachments": [card_attachment(card)],
            },
            text,
        )

    async def _name(self, person_id: str | None) -> str | None:
        """Who answered a card, by the name Webex shows beside their messages.

        Elsewhere the answerer is a mention. Webex refuses a mention in a
        message that carries a card, so their name stands in for one. None
        where Webex won't say, and the card then names their Switch identity.
        """
        if not person_id:
            return None
        known = self._names.get(person_id)
        if known:
            return str(known)
        try:
            person = await self._client.person(person_id)
        except WebexApiError as exc:
            logger.info("Could not read Webex person %s: %s", person_id, exc)
            return None
        name = str(person.get("displayName") or "") or _handle_from(person, person_id)
        self._names.remember(person_id, name)
        return name

    def _controls(self, content: RequestCard, drawn: Drawn) -> list[Any]:
        """The buttons a card earns: none where a press could not land."""
        if not drawn.answerable or self._on_interaction is None:
            return []
        return offered_controls(content.request)

    @staticmethod
    def _rich_failure(exc: WebexApiError, what: str, text: str) -> Exception:
        if exc.throttled:
            return RichContentThrottled(retry_after=exc.retry_after or 5.0, text=text)
        if exc.status >= 500:
            # Webex may have taken it: not a refusal, so the caller keeps its
            # reservation rather than posting a second copy.
            return exc
        return RichContentFailed(f"{what}: {exc}", text=text)

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        body, text = await self._publication(
            channel_id, agent_name, content, notify=True
        )
        ref = await self._send(
            channel_id, body, text, thread_root_id, f"the post in space {channel_id}"
        )
        if isinstance(content, RequestCard) and content.notify_external_id:
            await self._ping(
                channel_id, agent_name, content.notify_external_id, thread_root_id
            )
        return ref

    async def _send(
        self,
        channel_id: str,
        body: dict[str, Any],
        text: str,
        thread_root_id: str | None,
        what: str,
    ) -> str:
        """Post a publication and remember what it shows, under its new id.

        What is remembered leaves the thread out: a redraw is compared with it,
        and a redraw is drawn without one.
        """
        sent_body = {**body, "parentId": thread_root_id} if thread_root_id else body
        try:
            sent = await self._client.post_message(sent_body, wait_out_throttle=False)
        except WebexApiError as exc:
            raise self._rich_failure(exc, f"Webex refused {what}", text) from exc
        ref = str(sent.get("id") or "")
        if not ref:
            raise RichContentFailed(f"Webex returned no id for {what}", text=text)
        self._edits.remember(ref, 0)
        self._drawn.remember(ref, body)
        return ref

    async def _ping(
        self,
        channel_id: str,
        agent_name: str,
        person_id: str,
        thread_root_id: str | None,
    ) -> None:
        """Mention the person a card is for, in a message beside it.

        Best effort: the card is posted and answerable either way, and this
        only decides whether the person is notified of it.
        """
        agent = await self.agent_rendering(agent_name)
        body: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": f"{mention(person_id)} **{agent.body_label}** is waiting for your answer on the card above.",
        }
        if thread_root_id:
            body["parentId"] = thread_root_id
        try:
            await self._client.post_message(body)
        except WebexApiError as exc:
            logger.warning("Could not mention the person a Webex card is for: %s", exc)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, within Webex's ten edits.

        A redraw that would show what is already there spends nothing. A
        running turn stops redrawing after `_PROGRESS_EDITS`, holding the last
        edits back for how it ends — that redraw, and a card's settled state,
        are the ones a reader scrolling back needs to be right.

        A card is edited where Webex allows it. Some organisations refuse any
        edit to a message that carries one ("Support for editing messages with
        files via Developer APIs currently disabled"). After the first such
        refusal, and for a card out of edits, the card is posted again instead
        (`_repost`).
        """
        body, text = await self._publication(
            channel_id,
            agent_name,
            replace(content, notify_external_id=None),
            notify=False,
        )
        message_ref = str(self._reposted.get(message_ref) or message_ref)
        if self._drawn.get(message_ref) == body:
            return
        card = "attachments" in body
        edits = self._edits.get(message_ref, 0)
        if card and (not self._cards_editable or edits >= _EDIT_LIMIT):
            await self._repost(channel_id, message_ref, body, text, thread_root_id)
            return
        final = (
            not isinstance(content, TurnActivity) or content.turn.status in TURN_ENDED
        )
        if not final and edits >= _PROGRESS_EDITS:
            logger.debug("Holding Webex status %s for its final edit", message_ref)
            return
        if edits >= _EDIT_LIMIT:
            raise RichContentFailed(
                f"Webex message {message_ref} has had all ten edits it allows",
                text=text,
            )
        try:
            await self._client.edit_message(message_ref, body, wait_out_throttle=False)
        except WebexApiError as exc:
            if card and exc.status == 400:
                logger.info(
                    "Webex refused to edit card %s (%s); cards are posted again "
                    "from now on",
                    message_ref,
                    exc,
                )
                self._cards_editable = False
                await self._repost(channel_id, message_ref, body, text, thread_root_id)
                return
            raise self._rich_failure(
                exc, f"Webex refused the edit to {message_ref}", text
            ) from exc
        self._edits.remember(message_ref, edits + 1)
        self._drawn.remember(message_ref, body)

    async def _repost(
        self,
        channel_id: str,
        message_ref: str,
        body: dict[str, Any],
        text: str,
        thread_root_id: str | None,
    ) -> None:
        """Show a card's new state by posting it again and deleting the old one.

        For where Webex won't edit the card, or the card is out of edits. The
        new card goes first, so a deletion Webex then refuses leaves the
        old card above the right one rather than neither of them.
        """
        ref = await self._send(
            channel_id, body, text, thread_root_id, f"the card replacing {message_ref}"
        )
        first = next(
            (k for k, v in self._reposted.items() if v == message_ref), message_ref
        )
        self._reposted.remember(first, ref)
        try:
            await self._client.delete_message(message_ref)
        except WebexApiError as exc:
            if not exc.gone:
                logger.warning(
                    "Posted card %s in place of %s, but Webex would not delete "
                    "the old one: %s",
                    ref,
                    message_ref,
                    exc,
                )

    # ── Spaces and people ───────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        try:
            room = await self._client.create_room(name.strip()[:128] or "Switch")
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Webex would not create the space: {exc}"
            ) from exc
        room_id = str(room["id"])
        self._rooms.remember(room_id, room)
        if topic.strip():
            await self.admin_message(room_id, topic.strip())
        return room_id

    async def create_dm_channel(
        self, *, agent_name: str, user_name: str, user_external_id: str
    ) -> str:
        """A 1:1 space between the bot and one person, opened by writing to them.

        Webex makes that space the first time a bot writes to someone, and
        there is no other way to make it, so this introduces the agent.
        """
        agent = await self.agent_rendering(agent_name)
        try:
            sent = await self._client.post_message(
                {
                    "toPersonId": user_external_id,
                    "markdown": f"**{agent.body_label}** from Switch will talk with you here.",
                }
            )
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Webex would not open a 1:1 space: {exc}"
            ) from exc
        return str(sent["roomId"])

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        try:
            return self._channel_type_of(await self._room(channel_id))
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Could not read the Webex space: {exc}"
            ) from exc

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Agents post through the one bot, which is already in the space."""

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        missing: list[str] = []
        for person_id in user_external_ids:
            try:
                await self._client.add_membership(channel_id, person_id)
            except WebexApiError as exc:
                if exc.status == 409:
                    continue  # already a member
                logger.warning(
                    "Could not add %s to Webex space %s: %s", person_id, channel_id, exc
                )
                missing.append(person_id)
        return missing

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """One bot speaks for every agent; the agent's name is in each message."""

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing on Webex belongs to one agent."""

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Take the bot out of the space, leaving it with the people in it."""
        try:
            membership = await self._client.my_membership(
                external_channel_id, self._bot_id or ""
            )
            if membership is None:
                return RetireOutcome(outcome="left")
            await self._client.delete_membership(str(membership["id"]))
        except WebexApiError as exc:
            if exc.gone:
                return RetireOutcome(outcome="left")
            return RetireOutcome.failed(f"Webex would not let the bot leave: {exc}")
        return RetireOutcome(outcome="left")

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """People by address anywhere, and by name where Webex allows a bot it.

        A free Webex organisation refuses a bot's search by name, so a name
        finds the people Switch has already seen, plus whoever the search
        returns where it is allowed. An address always works.
        """
        query = query.strip().lstrip("@")
        found: dict[str, dict[str, Any]] = {}
        try:
            if "@" in query:
                for person in await self._client.people(email=query):
                    found[str(person.get("id"))] = person
            else:
                known = self._mention_targets.get(query.lower())
                if known:
                    found[known] = await self._client.person(known)
                try:
                    for person in await self._client.people(display_name=query):
                        found[str(person.get("id"))] = person
                except WebexApiError as exc:
                    if exc.status not in (400, 403):
                        raise
        except WebexApiError as exc:
            raise RuntimeError(f"Webex directory search failed: {exc}") from exc
        users: list[DirectoryUser] = []
        for person_id, person in found.items():
            if person.get("type") == "bot" or not person_id:
                continue
            emails = person.get("emails")
            email = emails[0] if isinstance(emails, list) and emails else None
            # Learned the way a poster's handle is, so that linking, which
            # checks the account again by searching for this handle, finds it
            # even where Webex refuses a search by name.
            handle = (
                await self._handle(person_id, email)
                if email
                else _handle_from(person, person_id)
            )
            users.append(
                DirectoryUser(
                    external_user_id=person_id,
                    username=handle,
                    display_name=str(person.get("displayName") or ""),
                    email=email,
                )
            )
        return users
