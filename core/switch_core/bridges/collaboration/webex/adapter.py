"""Cisco Webex as a messaging platform, through a bot the operator creates.

Inbound arrives by webhook on the connection's own address
(`/messaging/bridges/<id>/events`), signed with a secret Switch mints for the
connection; outbound goes through the Webex REST API with the bot's token.

Why webhooks rather than a WebSocket device connection: webhooks are the
delivery Webex documents for bots, they work on whichever switch-core pod a
request reaches, and they need no device registration that Webex can expire.
The cost is that Switch must be reachable over public https, which the
deployment already provides for the other webhook platforms
(`MESSAGING_PUBLIC_URL`).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import logging
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from functools import partial
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    RichContentWedged,
    ThreadUnavailable,
    TurnActivity,
)
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
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
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import (
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.webex.chunking import (
    MAX_MESSAGE_BYTES,
    chunk_markdown,
    clamp_markdown,
)
from switch_core.bridges.collaboration.webex.client import (
    FileTooLarge,
    UntrustedFileLink,
    WebexAPIError,
    WebexClient,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# The events this bridge asks Webex for. A bot hears a group space's messages
# only when they mention it, and every message in a 1:1 space with it.
_SUBSCRIPTIONS: tuple[tuple[str, str], ...] = (
    ("messages", "created"),
    ("attachmentActions", "created"),
    ("memberships", "created"),
)

# Every webhook this bridge registers is named with this prefix and the
# bridge's own id, so a restart replaces its own and leaves anything else the
# operator registered with the same bot alone.
_WEBHOOK_NAME_PREFIX = "Switch"

SIGNATURE_HEADER = "x-spark-signature"

# Webex refuses an upload over 100 MB.
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# How far back a restart looks for messages it may have missed. Webex does not
# redeliver a webhook it saw fail, so whatever arrived while no process held
# the bridge is picked up from the space's history instead. Replays are safe:
# a post's rows are numbered from its own id, so a message that did arrive
# writes nothing the second time.
_CATCH_UP_SECONDS = 15 * 60
_CATCH_UP_MESSAGES = 25

# Webex refuses the eleventh edit of a message. A turn's status is redrawn as
# the turn moves, so a running turn spends its edits further and further apart
# and the last one is kept for the final state.
_MAX_EDITS = 10

# A 429 that names no wait, and the longest a plain message waits on one.
_DEFAULT_RETRY_SECONDS = 5.0
_MAX_SEND_WAIT_SECONDS = 30.0
# Webex limits how fast webhooks are made, and a bridge left with only some of
# them hears only some events, so connecting outlasts more than one wait.
_REGISTER_ATTEMPTS = 4

# Webex tells these refusals apart only in its words: each is a 400 with no
# code of its own, and each needs a different answer.
_EDIT_LIMIT_REACHED = "Max allowed number of edits"
_PARENT_DELETED = "Parent activity has been deleted"
_REPLY_TO_REPLY = "Cannot reply to a reply"

_ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive"

# The keys a card's button carries back in its press. Webex hands back exactly
# what was put in `Action.Submit.data`, so they are read as strictly as written.
_ACTION_KEY = "switch_action"
_VALUE_KEY = "switch_value"

# One bot posts for every agent, so a coloured mark derived from the agent's
# identifier is what tells two of them apart at a glance.
_AGENT_MARKERS = (
    "\U0001f535",
    "\U0001f7e2",
    "\U0001f7e3",
    "\U0001f7e0",
    "\U0001f534",
    "\U0001f7e1",
    "\U0001f7e4",
    "⚫",
)

_COMMAND_PREFIX = "!"

# `<spark-mention data-object-type="person" data-object-id="...">Name</spark-mention>`
_MENTION_HTML = re.compile(
    r"<spark-mention[^>]*data-object-id=\"(?P<id>[^\"]+)\"[^>]*>(?P<name>.*?)</spark-mention>",
    re.IGNORECASE | re.DOTALL,
)

# `@name` at a word boundary, for rendering an outbound mention of a person
# Switch has seen. Handles allow letters, digits and `._-`.
_OUTBOUND_MENTION = re.compile(r"(?<![\w<@])@(?P<name>[\w][\w.\-]*)")
# A mention as Webex takes it in `markdown`: `<@personId:id|Name>` or `<@all>`.
_MENTION_MARKDOWN = re.compile(r"<@(?:[^>|]*\|(?P<name>[^>]*)|(?P<word>[^>|]*))>")


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        title="Bot access token",
        description=(
            "The access token shown once when you create the bot at "
            "developer.webex.com (My Webex Apps → Create a Bot)."
        ),
    )
    #: Minted by `prepare_config` when the connection is created, and handed to
    #: Webex with every webhook this bridge registers. Never typed by anyone.
    webhook_secret: SkipJsonSchema[str | None] = None

    @field_validator("bot_token")
    @classmethod
    def _token_present(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError(
                "bot_token is required: it is how Switch posts as the bot."
            )
        if any(ch.isspace() for ch in value):
            raise ValueError(
                "bot_token has spaces in it. Paste the token exactly as Webex "
                "showed it, without the word Bearer."
            )
        return value


def sign(secret: str, body: bytes) -> str:
    """What Webex puts in `X-Spark-Signature`: HMAC-SHA1 of the body, in hex."""
    return hmac.new(secret.encode(), body, hashlib.sha1).hexdigest()


class _EditBudget:
    """How many of a message's edits this process has spent.

    Safe to lose, so it stays in memory: a process that does not know a
    message's count finds out from Webex's refusal."""

    _TRACKED = 2000

    def __init__(self) -> None:
        self._spent: OrderedDict[str, tuple[int, float]] = OrderedDict()

    def exhausted(self, message_ref: str) -> bool:
        return self._spent.get(message_ref, (0, 0.0))[0] >= _MAX_EDITS

    def allows_redraw(self, message_ref: str) -> bool:
        """Whether a running turn may spend an edit now.

        The wait doubles with each edit, so a short turn is drawn step by step
        and a long one still has edits left minutes later. One edit is always
        held back for the turn's final state."""
        spent, last = self._spent.get(message_ref, (0, 0.0))
        if spent == 0:
            return True
        return spent < _MAX_EDITS - 1 and time.monotonic() - last >= 2**spent

    def charge(self, message_ref: str) -> None:
        spent, _ = self._spent.get(message_ref, (0, 0.0))
        self._remember(message_ref, spent + 1)

    def exhaust(self, message_ref: str) -> None:
        self._remember(message_ref, _MAX_EDITS)

    def _remember(self, message_ref: str, spent: int) -> None:
        self._spent[message_ref] = (spent, time.monotonic())
        self._spent.move_to_end(message_ref)
        if len(self._spent) > self._TRACKED:
            self._spent.popitem(last=False)


def _new_client(token: str) -> WebexClient:
    """The client every adapter call goes through. A seam for the tests, which
    swap the transport rather than the adapter's own methods."""
    return WebexClient(token, transport=None)


class WebexAdapter(PlatformAdapter):
    """Webex collaboration bridge adapter.

    Single-bot identity model, as on Telegram: Webex gives a bot no
    per-message name or avatar, so every agent posts through the one bot and is
    told apart by its mark and name at the head of the message.

    What Webex does not allow a bot, declared rather than discovered:

    - In a group space a bot is sent only the messages that @mention it. A
      message that does not mention the bot never reaches Switch, so it cannot
      reach the room; people address an agent as `@Bot @agent …`. In a 1:1
      space with the bot every message arrives.
    - No reactions and no typing indicator, so an agent's work shows as its
      status message alone.
    - Edits and deletes made in Webex are not mirrored into the room, which
      has no way to take them. Edits and deletes made by Switch show in Webex.
    - A message takes ten edits and no more, so a running turn's status is
      redrawn less and less often (`_EditBudget`).
    """

    display_name: ClassVar[str] = "Webex"
    receives_webhooks: ClassVar[bool] = True
    registers_own_webhooks: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    # An edit notifies nobody, so a problem somebody has to act on is posted.
    separate_attention_slot: ClassVar[bool] = True
    # By default a group space notifies its members only of mentions of them.
    notifies_only_by_mention: ClassVar[bool] = True
    # Every redraw spends one of the message's ten edits.
    redraws_for_elapsed_time: ClassVar[bool] = False
    # Registering the webhooks is the one thing this adapter does that
    # subscribes to delivery, so only the process holding the bridge does it.
    # The deliveries themselves reach any process, and every process can
    # handle them.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # Webex links only http(s), so `switchdash://` links are rewritten.
    renders_custom_url_schemes: ClassVar[bool] = False
    # `<@all>` notifies everyone in a group space.
    channel_mention: ClassVar[str | None] = "<@all>"
    supports_activity_reactions: ClassVar[bool] = False
    # Every agent shares the one bot, so the work indicator is shared too.
    activity_reactions_per_agent: ClassVar[bool] = False
    # A bot may create a space and add people to it.
    supports_channel_creation: ClassVar[bool] = True
    # Webex lets a bot look people up by name or email.
    supports_directory_search: ClassVar[bool] = True
    # An edit takes a card's buttons away, so an answered card stays in the
    # space as the record of what was asked and what was decided.
    removes_answered_cards: ClassVar[bool] = False
    channel_on_delete = "kept"

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: WebexClient | None = None
        self._bot_id = ""
        self._bot_name = ""
        self._bot_handle = ""
        self._bridge_id: str | None = None
        # person id -> display name, so a sender is looked up once.
        self._names: OrderedDict[str, str] = OrderedDict()
        self._space_titles: OrderedDict[str, str] = OrderedDict()
        self._names_max = 2000
        # handle -> person id, for rendering an outbound `@handle` as a mention.
        self._mention_targets: dict[str, str] = {}
        self._edits = _EditBudget()

    # ── Configuration ────────────────────────────────────────────────────────

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Mint the webhook secret once, when the connection is created, so it
        survives restarts and every webhook this bridge registers shares it."""
        if not connection_config.get("webhook_secret"):
            return {**connection_config, "webhook_secret": secrets.token_urlsafe(32)}
        return connection_config

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask Webex who the token belongs to, and refuse anything but a bot.

        A person's access token works too, for twelve hours, and then the
        bridge goes silent with nothing on screen saying why."""
        config = WebexConnectionConfig.model_validate(connection_config)
        client = _new_client(config.bot_token)
        try:
            me = await client.me()
        except WebexAPIError as exc:
            if exc.status == 401:
                raise BridgeCredentialError(
                    "Webex rejected the bot access token. Copy it again from "
                    "developer.webex.com (My Webex Apps → your bot → Regenerate "
                    "Access Token)."
                ) from exc
            raise BridgeCredentialError(
                f"Could not check the bot token with Webex: {exc}. Try again."
            ) from exc
        except httpx.TransportError as exc:
            raise BridgeCredentialError(
                f"Could not reach Webex to check the bot token: {exc}. Try again."
            ) from exc
        finally:
            await client.aclose()
        if me.get("type") != "bot":
            raise BridgeCredentialError(
                "That token belongs to a person, not a bot. Personal access tokens "
                "expire after 12 hours; create a bot at developer.webex.com and use "
                "its token."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexAPIError):
            return "auth_failed" if exc.status == 401 else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    def set_bridge_id(self, bridge_id: str) -> None:
        super().set_bridge_id(bridge_id)
        self._bridge_id = bridge_id

    def _webhook_name(self) -> str:
        return f"{_WEBHOOK_NAME_PREFIX} {self._bridge_id or 'bridge'}"

    def _require_client(self) -> WebexClient:
        if self._client is None:
            raise RuntimeError("Webex adapter is not started")
        return self._client

    def _require_secret(self) -> str:
        secret = self._config.webhook_secret
        if not secret:
            raise BridgeOperationError(
                "This Webex connection has no webhook secret, so no delivery to it "
                "can be checked. Remove the connection and add it again."
            )
        return secret

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
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        secret = self._require_secret()

        self._client = _new_client(self._config.bot_token)
        me = await self._client.me()
        self._bot_id = str(me.get("id") or "")
        self._bot_name = str(me.get("displayName") or "")
        emails = me.get("emails")
        if isinstance(emails, list) and emails:
            self._bot_handle = str(emails[0]).split("@", 1)[0]
        if not self._bot_id:
            raise BridgeOperationError("Webex did not say which bot this token is.")

        if not self._listening:
            logger.info(
                "Webex adapter for %s running quietly: another process holds this "
                "bridge and registers its webhooks",
                self._bot_name,
            )
            return
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Webex delivers messages by webhook, and this deployment has no "
                "public address for one. Set MESSAGING_PUBLIC_URL to Switch's "
                "public https origin."
            )
        await self._register_webhooks(self.webhook_url, secret)
        logger.info("Webex adapter connected as %s", self._bot_name)

    async def _register_webhooks(self, target_url: str, secret: str) -> None:
        """Replace this bridge's webhooks with a fresh set pointing at `target_url`.

        Replaced rather than reused: Webex never shows a webhook's secret again,
        and one it disabled after failed deliveries stays disabled, so the only
        set that is known to be right is the one just made."""
        client = self._require_client()
        name = self._webhook_name()
        for hook in await _waiting_out_limits(client.webhooks):
            if hook.get("name") == name and hook.get("id"):
                await _waiting_out_limits(
                    partial(client.delete_webhook, str(hook["id"]))
                )
        for resource, event in _SUBSCRIPTIONS:
            await _waiting_out_limits(
                partial(
                    client.create_webhook,
                    name=name,
                    target_url=target_url,
                    resource=resource,
                    event=event,
                    secret=secret,
                )
            )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def withdraw(self) -> None:
        """Delete this bridge's webhooks, so Webex stops calling an address
        nobody will answer."""
        client = self._require_client()
        name = self._webhook_name()
        left: list[str] = []
        for hook in await _waiting_out_limits(client.webhooks):
            if hook.get("name") != name or not hook.get("id"):
                continue
            try:
                await _waiting_out_limits(
                    partial(client.delete_webhook, str(hook["id"]))
                )
            except WebexAPIError as exc:
                left.append(f"{hook.get('resource')}:{hook.get('event')} ({exc})")
        if left:
            raise BridgeOperationError(
                "Could not delete these Webex webhooks: " + ", ".join(left)
            )

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Pick up what was said while no process held the bridge.

        Webex does not redeliver a webhook it saw fail, so a message that
        arrived during a restart would otherwise be lost. Each known space's
        recent history is read and replayed through the ordinary path, where a
        message already relayed writes nothing."""
        if not self._listening or self._client is None:
            return
        cutoff = time.time() - _CATCH_UP_SECONDS
        for channel_id, channel_type in channels:
            try:
                recent = await self._client.recent_messages(
                    channel_id,
                    mentioning_me=channel_type != "direct",
                    limit=_CATCH_UP_MESSAGES,
                )
            except (WebexAPIError, httpx.TransportError) as exc:
                logger.warning(
                    "Could not read recent Webex messages in %s to catch up after a "
                    "restart: %s",
                    channel_id,
                    exc,
                )
                continue
            for message in reversed(recent):
                if _created_epoch(message) < cutoff:
                    continue
                try:
                    await self._relay(message)
                except Exception:
                    logger.exception(
                        "Could not replay Webex message %s in %s",
                        message.get("id"),
                        channel_id,
                    )

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method != "POST":
            raise WebhookAuthenticityError("Webex only POSTs to a webhook")
        secret = self._require_secret()
        given = request.headers.get(SIGNATURE_HEADER, "")
        if not given or not hmac.compare_digest(given, sign(secret, request.body)):
            raise WebhookAuthenticityError("X-Spark-Signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            envelope = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("body is not JSON") from exc
        if not isinstance(envelope, dict):
            raise WebhookPayloadError("body is not a JSON object")
        resource = envelope.get("resource")
        event = envelope.get("event")
        data = envelope.get("data")
        if not isinstance(resource, str) or not isinstance(event, str):
            raise WebhookPayloadError("event names no resource or event")
        if not isinstance(data, dict) or not isinstance(data.get("id"), str):
            raise WebhookPayloadError("event carries no data id")
        return InboundWebhook(
            envelope_type=f"{resource}:{event}",
            payload=envelope,
            handshake=None,
            # Webex numbers the thing that happened, not the delivery, and a
            # retried delivery carries the same thing.
            external_event_id=f"{resource}:{event}:{data['id']}",
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        if envelope_type == "messages:created":
            if data.get("personId") == self._bot_id:
                return None
            message = await self._require_client().message(str(data["id"]))
            await self._relay(message)
        elif envelope_type == "attachmentActions:created":
            await self._handle_press(str(data["id"]))
        elif envelope_type == "memberships:created":
            await self._handle_membership(data)
        else:
            logger.debug("Ignoring Webex %s event", envelope_type)
        return None

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _relay(self, message: dict[str, Any]) -> None:
        """Hand one Webex message to the room, as a command or a message."""
        person_id = str(message.get("personId") or "")
        if not person_id or person_id == self._bot_id:
            return
        room_id = str(message.get("roomId") or "")
        message_id = str(message.get("id") or "")
        if not room_id or not message_id:
            return
        channel_type = _channel_type(message.get("roomType"))
        sender_name = await self._name_of(person_id, message.get("personEmail"))
        content = self._inbound_text(message)
        root_id = message.get("parentId") or None
        channel_name = await self._space_title(room_id)

        parsed = _parse_command(content)
        if parsed is not None and self._on_command is not None:
            name, args = parsed
            await self._on_command(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=channel_type,
                    sender_id=person_id,
                    sender_name=sender_name,
                    command=name,
                    args=args,
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(message)
        if not content and not attachments and not failures:
            return
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=person_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._self_mention(content),
            )
        )

    def _self_mention(self, content: str) -> str | None:
        """The bot's handle, where nothing else says who a message is for.

        Nothing but the bot can be mentioned for real in Webex, and every
        message that arrives was sent to it, so `@Bot why did this fail?` is
        how a person addresses a room's agent. A message that also names an
        agent says who it is for already."""
        if _OUTBOUND_MENTION.search(content):
            return None
        return self._bot_handle or None

    def _inbound_text(self, message: dict[str, Any]) -> str:
        """The message's text, without the mention of the bot that delivered it.

        In a group space every message that reaches the bot mentions it, so
        the mention is how the message was delivered rather than something the
        person said to the room. Other people mentioned keep their names."""
        body = str(message.get("markdown") or message.get("text") or "")
        rich = str(message.get("html") or "")

        def said(match: re.Match[str]) -> str:
            return "" if match.group("id") == self._bot_id else _mention_name(match)

        # Webex's `markdown` carries mentions as the same tags as its `html`.
        body, tags = _MENTION_HTML.subn(said, body)
        if tags:
            return self.translate_inbound(body.strip())
        bot_names = {
            _mention_name(match)
            for match in _MENTION_HTML.finditer(rich)
            if match.group("id") == self._bot_id
        }
        for name in sorted(bot_names, key=len, reverse=True):
            if name:
                body = re.sub(
                    rf"(?:<@personId:[^|>]+\|)?@?{re.escape(name)}>?",
                    "",
                    body,
                    count=1,
                )
        return self.translate_inbound(body.strip())

    async def _space_title(self, room_id: str) -> str | None:
        """The space's title, which the room linked to it is named after.

        None where Webex would not say: a room can be named without it, and a
        lookup that failed is tried again on the next message."""
        cached = self._space_titles.get(room_id)
        if cached is not None:
            return cached
        try:
            room = await self._require_client().room(room_id)
        except (WebexAPIError, httpx.TransportError) as exc:
            logger.warning("Could not look up Webex space %s: %s", room_id, exc)
            return None
        title = str(room.get("title") or "")
        if not title:
            return None
        self._space_titles[room_id] = title
        if len(self._space_titles) > self._names_max:
            self._space_titles.popitem(last=False)
        return title

    async def _name_of(self, person_id: str, email: object) -> str:
        cached = self._names.get(person_id)
        if cached is not None:
            return cached
        name = ""
        try:
            person = await self._require_client().person(person_id)
            name = str(person.get("displayName") or "")
        except (WebexAPIError, httpx.TransportError) as exc:
            logger.warning("Could not look up Webex person %s: %s", person_id, exc)
        if not name:
            name = str(email).split("@", 1)[0] if isinstance(email, str) else person_id
        self._names[person_id] = name
        if len(self._names) > self._names_max:
            self._names.popitem(last=False)
        return name

    async def _fetch_attachments(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        files = message.get("files")
        if not isinstance(files, list):
            return [], []
        client = self._require_client()
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for index, url in enumerate(files):
            if not isinstance(url, str):
                continue
            label = f"file {index + 1}"
            try:
                info = await client.file_info(url)
                label = info.filename
                if info.size is not None and info.size > self._max_attachment_bytes:
                    failures.append(
                        AttachmentFailure(
                            filename=info.filename,
                            reason=(
                                f"it is {info.size // (1024 * 1024)} MB and the limit "
                                f"is {self._max_attachment_bytes // (1024 * 1024)} MB"
                            ),
                        )
                    )
                    continue
                info, data = await client.download(
                    url, max_bytes=self._max_attachment_bytes
                )
            except UntrustedFileLink as exc:
                logger.warning("Refused a Webex file link: %s", exc)
                failures.append(AttachmentFailure(filename=label, reason=str(exc)))
                continue
            except FileTooLarge as exc:
                failures.append(
                    AttachmentFailure(
                        filename=exc.filename,
                        reason=f"it is larger than {exc.max_bytes // (1024 * 1024)} MB",
                    )
                )
                continue
            except WebexAPIError as exc:
                # 423 is Webex still scanning the file for malware.
                reason = (
                    "Webex is still scanning it; send it again in a moment"
                    if exc.status == 423
                    else f"Webex refused the download: {exc}"
                )
                failures.append(AttachmentFailure(filename=label, reason=reason))
                continue
            except httpx.TransportError as exc:
                failures.append(
                    AttachmentFailure(
                        filename=label, reason=f"the download failed: {exc}"
                    )
                )
                continue
            attachments.append(
                Attachment(filename=info.filename, mimetype=info.mimetype, data=data)
            )
        return attachments, failures

    async def _handle_press(self, action_id: str) -> None:
        """Someone pressed a button on a card this bridge posted.

        Who pressed is Webex's `personId` on the action, which the card's data
        cannot set; the data says only which request and which option."""
        client = self._require_client()
        action = await client.attachment_action(action_id)
        inputs = action.get("inputs")
        person_id = str(action.get("personId") or "")
        room_id = str(action.get("roomId") or "")
        if not isinstance(inputs, dict) or not person_id or not room_id:
            return
        switch_action = inputs.get(_ACTION_KEY)
        value = inputs.get(_VALUE_KEY)
        if not isinstance(switch_action, str) or not isinstance(value, str):
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in Webex space %s has nowhere to go: this "
                "bridge handles no interactions.",
                room_id,
            )
            return
        # Webex has no private reply to a press, so a refusal is said in the
        # card's thread by the base `tell_actor`.
        name = await self._name_of(person_id, None)
        await self._on_interaction(
            InboundInteraction(
                channel_id=room_id,
                sender_id=person_id,
                sender_name=name,
                action_id=switch_action,
                value=value,
                message_ref=str(action.get("messageId") or "") or None,
            )
        )

    async def _handle_membership(self, data: dict[str, Any]) -> None:
        room_id = str(data.get("roomId") or "")
        person_id = str(data.get("personId") or "")
        if not room_id or not person_id:
            return
        channel_type = _channel_type(data.get("roomType"))
        if person_id == self._bot_id:
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(channel_id=room_id, channel_type=channel_type)
                )
            return
        if self._on_user_joined is None:
            return
        name = str(data.get("personDisplayName") or "") or await self._name_of(
            person_id, data.get("personEmail")
        )
        await self._on_user_joined(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=channel_type,
                external_user_id=person_id,
                external_username=name,
            )
        )

    # ── Outbound ─────────────────────────────────────────────────────────────

    @staticmethod
    def _agent_marker(sender_name: str) -> str:
        """A stable coloured mark for one agent, from its identifier.

        `blake2b` rather than `hash()`, which is salted per process and would
        give an agent a different colour after every restart."""
        digest = hashlib.blake2b(sender_name.encode("utf-8"), digest_size=8).digest()
        return _AGENT_MARKERS[digest[0] % len(_AGENT_MARKERS)]

    async def _attribution(self, sender_name: str) -> str:
        agent = await self.agent_rendering(sender_name)
        return f"{self._agent_marker(sender_name)} **{agent.body_label}**"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the bot with the agent's mark and name at the head.

        A reply too long for one Webex message is split; the first part's id
        is the message's reference, as that is the part that carries the name
        and the one an edit rewrites."""
        heading = await self._attribution(sender_name)
        return await self._post_text(
            channel_id, _join(heading, content), thread_root_id
        )

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        return await self._post_text(
            channel_id,
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
        )

    async def _post_text(
        self, channel_id: str, markdown: str, thread_root_id: str | None
    ) -> str | None:
        first: str | None = None
        for chunk in chunk_markdown(markdown):
            body: dict[str, Any] = {"roomId": channel_id, "markdown": chunk}
            if thread_root_id:
                body["parentId"] = thread_root_id
            try:
                sent = await self._send_waiting(body)
            except WebexAPIError as exc:
                logger.error("Webex refused a message in space %s: %s", channel_id, exc)
                return first
            if first is None:
                first = str(sent.get("id") or "") or None
        return first

    async def _send_waiting(self, body: dict[str, Any]) -> dict[str, Any]:
        """Send a plain message, waiting out one rate limit.

        Nothing retries a plain message on this bridge's behalf, so a wait
        Webex asked for is served here rather than losing what was said."""
        return await _waiting_out_limits(lambda: self._send(body), attempts=2)

    async def _send(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._in_thread(self._require_client().post_message, body)

    async def _in_thread(
        self,
        send: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        body: dict[str, Any],
    ) -> dict[str, Any]:
        """Send `body`, moving a reply aimed at a reply up to its thread's root.

        Webex threads are one level deep and it refuses a reply to a reply,
        while the message Switch answers can be any message in the thread."""
        try:
            return await send(body)
        except WebexAPIError as exc:
            if exc.status != 400 or _REPLY_TO_REPLY not in str(exc):
                raise
        parent = await self._require_client().message(str(body["parentId"]))
        return await send({**body, "parentId": parent["parentId"]})

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Rewrite a message in place, keeping whoever it was attributed to.

        The heading is read back from the message rather than remembered, so
        any process can make the edit and a restart forgets nothing."""
        client = self._require_client()
        try:
            current = await client.message(message_ref)
            heading = _heading_of(str(current.get("markdown") or ""))
            await client.edit_message(
                message_ref,
                room_id=channel_id,
                markdown=clamp_markdown(_join(heading, new_content)),
                attachments=[],
            )
        except WebexAPIError as exc:
            logger.error("Failed to update Webex message %s: %s", message_ref, exc)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_client().delete_message(message_ref)
        except WebexAPIError as exc:
            if exc.status == 404:
                return
            logger.error("Failed to delete Webex message %s: %s", message_ref, exc)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Webex gives bots no typing indicator; the status message carries it.
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
        """Upload one file, captioned with the agent's name.

        Webex takes one file per message, so several files are several messages
        (the base `send_attachments`). A file over Webex's 100 MB limit is not
        attempted; the channel is told instead."""
        heading = await self._attribution(sender_name)
        if len(data) > _MAX_UPLOAD_BYTES:
            return await self._post_text(
                channel_id,
                _join(
                    heading,
                    self.translate_outbound(
                        f"_couldn't send {filename}: it is over Webex's 100 MB limit_"
                    ),
                ),
                thread_root_id,
            )
        text = _join(heading, self.translate_outbound(caption) if caption else "")
        fields: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": clamp_markdown(text),
        }
        if thread_root_id:
            fields["parentId"] = thread_root_id
        client = self._require_client()

        async def upload(body: dict[str, Any]) -> dict[str, Any]:
            return await client.post_file(
                body, filename=filename, mimetype=mimetype, data=data
            )

        try:
            sent = await self._in_thread(upload, fields)
        except WebexAPIError as exc:
            logger.error(
                "Webex refused the file %s in space %s: %s", filename, channel_id, exc
            )
            return await self._post_text(
                channel_id,
                _join(
                    heading,
                    self.translate_outbound(f"_couldn't send {filename}: {exc}_"),
                ),
                thread_root_id,
            )
        return str(sent.get("id") or "") or None

    # ── Cards ────────────────────────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        # Characters, against a limit Webex counts in bytes; the heading and
        # multi-byte text share the rest, and `clamp_markdown` is the backstop.
        return 4000

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status, or a request's card with a button per option.

        A card is drawn as text that says how to answer by typing, as on every
        platform, with an Adaptive Card under it whose buttons answer in one
        press. The text is what a client without card support shows.

        Webex refuses a mention in a message with a card, and a mention is the
        only thing that notifies someone in a group space, so whoever a card
        is waiting on is mentioned in a message of its own, under the card.

        Raises `RichContentFailed` only for what Webex definitely refused. A
        send whose outcome nobody knows raises its own error, so the caller
        keeps its reservation."""
        heading = await self._attribution(agent_name)
        text, attachments = await self._draw(content)
        body: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": clamp_markdown(_join(heading, text)),
        }
        if thread_root_id:
            body["parentId"] = thread_root_id
        if attachments:
            body["attachments"] = attachments
        try:
            sent = await self._send(body)
        except WebexAPIError as exc:
            if exc.status == 400 and _PARENT_DELETED in str(exc):
                raise ThreadUnavailable(
                    f"The Webex message {thread_root_id} that this thread hangs "
                    "from was deleted.",
                    text=text,
                ) from exc
            failure = _as_rich_failure(
                exc,
                description=f"Webex refused the post in space {channel_id}",
                text=text,
            )
            if failure is None:
                raise
            raise failure from exc
        ref = str(sent.get("id") or "")
        if not ref:
            raise RichContentFailed(
                f"Webex accepted the post in space {channel_id} but gave no id.",
                text=text,
            )
        if attachments:
            await self._notify_of_card(
                channel_id, heading, content, thread_root_id or ref
            )
        return ref

    async def _notify_of_card(
        self,
        channel_id: str,
        heading: str,
        content: RichContent,
        thread_root_id: str,
    ) -> None:
        mention = await self._person_mention(content.notify_external_id)
        if mention is None:
            return
        try:
            await self._post_text(
                channel_id,
                _join(heading, f"{mention} this is waiting for your answer."),
                thread_root_id,
            )
        except httpx.TransportError as exc:
            logger.warning(
                "The card in Webex space %s is up, but its notice was not sent: %s",
                channel_id,
                exc,
            )

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place.

        The buttons are part of the edit: Webex takes a message's card away
        unless the edit names it again, so an open card keeps its buttons and
        an answered one is left showing its outcome with none.

        A redraw of a running turn may be passed over to save the message's
        edits; the next change to the turn draws the state it has reached."""
        if self._edits.exhausted(message_ref):
            logger.warning(
                "Webex message %s has no edits left, so this redraw is dropped",
                message_ref,
            )
            return
        if _can_wait(content) and not self._edits.allows_redraw(message_ref):
            return
        heading = await self._attribution(agent_name)
        text, attachments = await self._draw(content)
        try:
            await self._require_client().edit_message(
                message_ref,
                room_id=channel_id,
                markdown=clamp_markdown(_join(heading, text)),
                attachments=attachments,
            )
        except WebexAPIError as exc:
            if exc.status == 400 and _EDIT_LIMIT_REACHED in str(exc):
                self._edits.exhaust(message_ref)
                raise RichContentWedged(
                    f"Webex will take no more edits to {message_ref}: {exc}",
                    text=text,
                ) from exc
            failure = _as_rich_failure(
                exc, description=f"Webex refused the edit to {message_ref}", text=text
            )
            if failure is None:
                raise
            raise failure from exc
        self._edits.charge(message_ref)

    async def _draw(self, content: RichContent) -> tuple[str, list[dict[str, Any]]]:
        """The text of a publication, and the attachments that go with it:
        none where there is nothing one press could answer."""
        mention = await self._person_mention(content.notify_external_id)
        limit = self.rich_fallback_limit()
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        if isinstance(content, TurnActivity):
            status = turn_status(
                content.items,
                content.turn,
                escape=self._rich_escape,
                limit=max(1, limit - len(tail)),
                markup=self.rich_markup(),
                elapsed_seconds=content.elapsed_seconds,
                mention=mention,
                error_summary=content.error_summary,
                tool_detail=False,
            )
            return f"{status}{tail}", []
        lead = f"{mention}\n" if mention else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=max(1, limit - len(lead) - len(tail)),
            markup=self.rich_markup(),
            responder=await self._person_mention(content.responder_external_id),
            unavailable_reason=content.unavailable_reason,
            control_label_limit=None,
        )
        text = f"{lead}{drawn.text}{tail}"
        controls = offered_controls(content.request) if drawn.answerable else []
        if not controls:
            return text, []
        text = _MENTION_MARKDOWN.sub(_mention_as_text, text)
        actions = [
            {
                "type": "Action.Submit",
                "title": f"{control.position}. {control.label.strip()}"[:80],
                "data": {
                    _ACTION_KEY: position_action(control.position),
                    _VALUE_KEY: content.reference.token,
                },
            }
            for control in controls
        ]
        card = {
            "type": "AdaptiveCard",
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "version": "1.3",
            "body": [
                {
                    "type": "TextBlock",
                    "text": "Answer with a button, or reply with the option's number.",
                    "wrap": True,
                    "isSubtle": True,
                }
            ],
            "actions": actions,
        }
        return text, [{"contentType": _ADAPTIVE_CARD, "content": card}]

    async def _person_mention(self, person_id: str | None) -> str | None:
        """A real Webex mention, which is the only form that notifies them."""
        if person_id is None:
            return None
        name = await self._name_of(person_id, None)
        return f"<@personId:{person_id}|{name}>"

    # ── Spaces and people ────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """Create a space. Webex spaces are invite-only whatever the room's type,
        and have no topic field, so the topic is the space's first message."""
        try:
            room = await self._require_client().create_room(name)
        except WebexAPIError as exc:
            raise BridgeOperationError(
                f"Webex refused to create the space: {exc}"
            ) from exc
        room_id = str(room.get("id") or "")
        if not room_id:
            raise BridgeOperationError("Webex created the space but gave no id.")
        if topic.strip():
            await self._post_text(room_id, self.translate_outbound(topic), None)
        return room_id

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        """Open a 1:1 space by messaging the person, which is how Webex makes one."""
        heading = await self._attribution(agent_name)
        try:
            sent = await self._require_client().post_message(
                {
                    "toPersonId": user_external_id,
                    "markdown": _join(heading, "Hi! I've started a conversation here."),
                }
            )
        except WebexAPIError as exc:
            raise BridgeOperationError(
                f"Webex refused to open a conversation with {user_name}: {exc}"
            ) from exc
        room_id = str(sent.get("roomId") or "")
        if not room_id:
            raise BridgeOperationError("Webex opened the conversation but gave no id.")
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Leave the space as it is: deleting it would take the people's
        history with it, and a bot cannot delete a space it did not create."""
        return RetireOutcome(outcome="kept")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._require_client().room(channel_id)
        return _channel_type(room.get("type"))

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # One bot posts for every agent; there is nobody else to add.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        client = self._require_client()
        left_out: list[str] = []
        for name, person_id in zip(user_names, user_external_ids, strict=True):
            try:
                await client.add_member(channel_id, person_id)
            except WebexAPIError as exc:
                if exc.status == 409:
                    continue  # already a member
                logger.warning(
                    "Could not add %s to Webex space %s: %s", name, channel_id, exc
                )
                left_out.append(person_id)
        return left_out

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        query = query.strip()
        if not query:
            return []
        try:
            people = await self._require_client().search_people(query, limit=20)
        except WebexAPIError as exc:
            # A free (consumer) Webex org refuses every lookup by name and
            # answers only an exact email address.
            if exc.status == 400 and "@" not in query:
                raise NotImplementedError(
                    "This Webex organisation does not allow searching people by "
                    "name. Search by their full email address instead, or have "
                    "them message the bot once."
                ) from exc
            raise
        found: list[DirectoryUser] = []
        for person in people:
            person_id = person.get("id")
            if not isinstance(person_id, str) or person.get("type") == "bot":
                continue
            emails = person.get("emails")
            email = emails[0] if isinstance(emails, list) and emails else None
            display = str(person.get("displayName") or person_id)
            found.append(
                DirectoryUser(
                    external_user_id=person_id,
                    username=display,
                    display_name=display,
                    email=email if isinstance(email, str) else None,
                )
            )
        return found

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        return (
            f"Send `!link-account {code}` to the bot in a 1:1 Webex space, or "
            f"mention the bot with it in a group space."
        )

    # ── Markup ───────────────────────────────────────────────────────────────

    def render_app_mention(self, token: str) -> str:
        return f"@{self._bot_name or token}"

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        self._mention_targets.update(targets)

    def _render_outbound(self, content: str) -> str:
        """Switch Markdown is close enough to Webex's that it passes through;
        what changes is that an `@handle` of a person Switch knows becomes a
        real Webex mention, which is the only form that notifies them."""
        if not self._mention_targets:
            return content

        def mention(match: re.Match[str]) -> str:
            name = match.group("name")
            person_id = self._mention_targets.get(name)
            if person_id is None:
                return match.group(0)
            return f"<@personId:{person_id}|{name}>"

        return _OUTBOUND_MENTION.sub(mention, content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


# ── Helpers ──────────────────────────────────────────────────────────────────


def _mention_as_text(match: re.Match[str]) -> str:
    return match.group("name") or f"@{match.group('word')}"


async def _waiting_out_limits[T](
    call: Callable[[], Awaitable[T]], *, attempts: int = _REGISTER_ATTEMPTS
) -> T:
    """Make `call`, serving the waits Webex asks for with a 429."""
    for _ in range(attempts - 1):
        try:
            return await call()
        except WebexAPIError as exc:
            if exc.status != 429:
                raise
            await asyncio.sleep(
                min(exc.retry_after or _DEFAULT_RETRY_SECONDS, _MAX_SEND_WAIT_SECONDS)
            )
    return await call()


def _mention_name(match: re.Match[str]) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", match.group("name"))).strip()


def _can_wait(content: RichContent) -> bool:
    """Whether this redraw is only a running turn moving on."""
    return (
        isinstance(content, TurnActivity)
        and content.turn.status not in TURN_ENDED
        and not content.status_only
        and content.error_summary is None
    )


def _as_rich_failure(
    exc: WebexAPIError, *, description: str, text: str
) -> RichContentFailed | None:
    """What a refused publication means to its caller, or None where nobody
    knows whether it happened: a 5xx can come after Webex acted on the call."""
    if exc.status == 429:
        return RichContentThrottled(
            retry_after=exc.retry_after or _DEFAULT_RETRY_SECONDS, text=text
        )
    if exc.status >= 500:
        return None
    return RichContentFailed(f"{description}: {exc}", text=text)


def _channel_type(room_type: object) -> ChannelType:
    """A 1:1 space is a direct conversation; every group space is invite-only."""
    return "direct" if room_type == "direct" else "channel_private"


def _parse_command(text: str) -> tuple[str, str] | None:
    if not text.startswith(_COMMAND_PREFIX):
        return None
    parts = text[1:].split(None, 1)
    if not parts or not parts[0]:
        return None
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _join(heading: str, content: str) -> str:
    if not heading:
        return content
    if not content:
        return heading
    return f"{heading}\n{content}"


def _heading_of(markdown: str) -> str:
    """The attribution line at the head of a message this bridge posted, or
    nothing for a message that has none (an admin notice)."""
    first, _, _rest = markdown.partition("\n")
    if first and first[0] in _AGENT_MARKERS and "**" in first:
        return first
    return ""


def _created_epoch(message: dict[str, Any]) -> float:
    created = message.get("created")
    if not isinstance(created, str):
        return 0.0
    try:
        return datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


__all__ = [
    "MAX_MESSAGE_BYTES",
    "SIGNATURE_HEADER",
    "WebexAdapter",
    "WebexConnectionConfig",
    "sign",
]
