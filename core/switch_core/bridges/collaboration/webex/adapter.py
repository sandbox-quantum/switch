"""Cisco Webex, through a bot the operator creates on developer.webex.com.

Events arrive on the bridge's own webhook address, not over Webex's device
WebSocket. A webhook needs nothing held open, so every switch-core pod can take
a delivery and the shared receipt store hands each event to one of them; the
WebSocket would need the Webex SDK's device registration and a lease-held
connection on one pod for the same events.

Webex sends a webhook only the ids of what happened. Each delivery is checked
against this connection's own secret, and then the message or card press it
names is fetched with the bot's token.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RemovalFailed,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    RichContentWedged,
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
    ChannelRetirement,
    ChannelType,
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
    Drawn,
    offered_controls,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.webex.cards import (
    MAX_BUTTON_LABEL,
    read_press,
    request_card,
)
from switch_core.bridges.collaboration.webex.cards import (
    MAX_MESSAGE_BYTES as MAX_CARD_MESSAGE_BYTES,
)
from switch_core.bridges.collaboration.webex.cards import (
    message_size as card_message_size,
)
from switch_core.bridges.collaboration.webex.chunking import chunk_message
from switch_core.bridges.collaboration.webex.client import (
    API_ORIGIN,
    FileTooLarge,
    WebexApiError,
    WebexClient,
)
from switch_core.bridges.collaboration.webex.markup import (
    defuse_webex_mentions,
    person_mention,
    read_message,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# The webhooks a connection keeps on its bot: messages people send it, presses
# on the cards it posts, and the bot or a person joining a space.
_SUBSCRIPTIONS = (
    ("messages", "created"),
    ("attachmentActions", "created"),
    ("memberships", "created"),
)

# Webex allows a message this many edits and refuses the next.
_MAX_EDITS = 10

# Webex sends one file per message and refuses one over 100 MB.
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

_BOT_EMAIL_DOMAIN = "@webex.bot"

# Setting up webhooks is a burst of calls Webex may throttle. Each is retried
# after the wait Webex asks for, a few times, before the bridge gives up.
_SETUP_ATTEMPTS = 5
_SETUP_WAIT_CAP = 60.0
_SETUP_WAIT_DEFAULT = 2.0


def _no_mention(_: str | None) -> None:
    return None


async def _patiently[T](call: Callable[[], Awaitable[T]]) -> T:
    for attempt in range(1, _SETUP_ATTEMPTS + 1):
        try:
            return await call()
        except WebexApiError as exc:
            if not exc.throttled or attempt == _SETUP_ATTEMPTS:
                raise
            wait = min(
                _SETUP_WAIT_CAP,
                _SETUP_WAIT_DEFAULT if exc.retry_after is None else exc.retry_after,
            )
            logger.warning(
                "Webex throttled webhook setup; retrying in %.1fs (attempt %d of %d)",
                wait,
                attempt,
                _SETUP_ATTEMPTS,
            )
            await asyncio.sleep(wait)
    raise AssertionError("unreachable")


# An `@handle` written as a word of its own, which is how a person names an
# agent; an email address is not one.
_NAMES_SOMEONE = re.compile(r"(?:^|\s)@[A-Za-z0-9_][\w.-]*")

_PRESS_NOTICE: ContextVar[list[str] | None] = ContextVar(
    "switch_webex_press_notice", default=None
)


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        title="Bot access token",
        description=(
            "The access token shown once when you create the bot on "
            "developer.webex.com (My Webex Apps → Create a Bot)."
        ),
        min_length=1,
    )
    # Minted by `prepare_config` when the connection is created, and given to
    # Webex with each webhook so a delivery can prove it came from Webex.
    webhook_secret: SkipJsonSchema[str | None] = None

    @field_validator("bot_token")
    @classmethod
    def _strip(cls, value: str) -> str:
        token = value.strip()
        if not token or any(c.isspace() for c in token):
            raise ValueError("the bot access token must be a single word")
        return token


def _signature_matches(secret: bytes, body: bytes, headers: dict[str, str]) -> bool:
    """Whether a delivery carries a valid signature from Webex.

    `X-Webex-Signature` is a list of `SHA-256=<hex>` / `SHA-512=<hex>` pairs and
    is preferred where Webex sends it. `X-Spark-Signature` is HMAC-SHA1 of the
    same bytes and is sent on every webhook created with a secret.
    """
    newer = headers.get("x-webex-signature")
    if newer:
        algorithms = {"sha-256": hashlib.sha256, "sha-512": hashlib.sha512}
        for pair in newer.split(","):
            label, _, given = pair.strip().partition("=")
            digest = algorithms.get(label.strip().lower())
            if digest is None or not given:
                continue
            expected = hmac.new(secret, body, digest).hexdigest()
            if hmac.compare_digest(given.strip().lower(), expected):
                return True
    legacy = headers.get("x-spark-signature")
    if legacy:
        expected = hmac.new(secret, body, hashlib.sha1).hexdigest()
        return hmac.compare_digest(legacy.strip().lower(), expected)
    return False


def _room_type(raw: object) -> ChannelType:
    return "direct" if raw == "direct" else "group"


def _rich_failure(error: WebexApiError, description: str, text: str) -> Exception:
    """What a refused publication raises, keeping an unknown outcome as itself."""
    if error.throttled:
        return RichContentThrottled(retry_after=error.retry_after or 1.0, text=text)
    if 400 <= error.status < 500:
        return RichContentFailed(f"{description}: {error}", text=text)
    return error


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Webex"
    receives_webhooks: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    removes_answered_cards: ClassVar[bool] = True

    #: A bot can't look people up in the organisation's directory, only at the
    #: people it shares a space with.
    supports_directory_search: ClassVar[bool] = False
    #: Webex links only http(s).
    renders_custom_url_schemes: ClassVar[bool] = False
    #: Webex has no reactions or typing indicator a bot can set, so the
    #: "working" signal is the turn's status message.
    supports_activity_reactions: ClassVar[bool] = False
    #: Webex's own room-wide mention.
    channel_mention: ClassVar[str | None] = "<@all>"
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: WebexClient | None = None
        self._bot_id = ""
        self._bot_name = ""
        self._bot_handle = ""
        # Per message, how many edits Webex has taken. Safe to lose: a
        # restart forgets it, and an edit past the limit is refused by Webex
        # and reported then instead.
        self._edits: dict[str, int] = {}
        self._drawn: dict[str, str] = {}
        self._space_titles: dict[str, str | None] = {}
        # A card's companion message naming whoever must answer it, by the
        # card's ref: Webex refuses a mention in a message that carries a card.
        self._pings: dict[str, str] = {}

    # ── Connecting ───────────────────────────────────────────────────────────

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        prepared = dict(connection_config)
        if not prepared.get("webhook_secret"):
            prepared["webhook_secret"] = secrets.token_urlsafe(32)
        return prepared

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [API_ORIGIN]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WebexConnectionConfig.model_validate(connection_config)
        client = cls._connect(config.bot_token)
        try:
            me = await client.me()
        except WebexApiError as exc:
            if exc.rejected_credentials:
                raise BridgeCredentialError(
                    "Webex did not accept the bot access token. Copy it again "
                    "from developer.webex.com (My Webex Apps → your bot → "
                    "Regenerate Access Token)."
                ) from exc
            raise BridgeCredentialError(
                f"Webex could not check the bot access token: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(f"Could not reach Webex: {exc}") from exc
        finally:
            await client.aclose()
        if me.get("type") != "bot":
            raise BridgeCredentialError(
                "That token belongs to a person, not a bot. Create a bot on "
                "developer.webex.com and use the bot's access token, so Switch "
                "does not act as you."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexApiError):
            if exc.status in (401, 403):
                return "auth_failed"
            return "network" if exc.throttled else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @staticmethod
    def _connect(token: str) -> WebexClient:
        return WebexClient.connect(token)

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Webex delivers events to a public https address, and this "
                "deployment has none: set MESSAGING_PUBLIC_URL."
            )
        if not self._config.webhook_secret:
            raise BridgeOperationError(
                "This Webex connection has no webhook secret. Remove it and "
                "connect the bot again."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        self._client = self._connect(self._config.bot_token)
        me = await self._client.me()
        self._bot_id = str(me.get("id") or "")
        if not self._bot_id:
            raise BridgeOperationError("Webex returned no id for the bot.")
        # A mention shows only the first word of the bot's name.
        self._bot_name = str(me.get("displayName") or "").split(" ", 1)[0]
        emails = me.get("emails") or []
        email = str(emails[0]) if emails else ""
        self._bot_handle = email.removesuffix(_BOT_EMAIL_DOMAIN).split("@", 1)[0]
        if not self._listening:
            logger.info(
                "Webex bot %s running quietly: the process holding this bridge "
                "keeps its webhooks",
                self._bot_handle or self._bot_id,
            )
            return
        await self._reconcile_webhooks()
        logger.info("Webex bot %s connected", self._bot_handle or self._bot_id)

    async def _reconcile_webhooks(self) -> None:
        """Make the bot's webhooks for this address exactly the ones Switch needs.

        Each one this address needs is created if it is missing, and the one
        kept is rewritten with this connection's secret and set active: Webex
        disables a webhook after repeated failed deliveries and never turns it
        back on itself, so a bridge that was down long enough would otherwise
        come back to silence. Any duplicates for the same address go.
        Webhooks the bot holds for other addresses are not this bridge's and
        are left alone.
        """
        client = self._require_client()
        assert self.webhook_url is not None
        assert self._config.webhook_secret is not None
        hooks = [
            hook
            for hook in await _patiently(client.list_webhooks)
            if hook.get("targetUrl") == self.webhook_url
        ]
        for resource, event in _SUBSCRIPTIONS:
            body = {
                "name": f"Switch {resource}",
                "targetUrl": self.webhook_url,
                "secret": self._config.webhook_secret,
                "status": "active",
            }
            matching = [
                hook
                for hook in hooks
                if hook.get("resource") == resource and hook.get("event") == event
            ]
            if not matching:
                created = {
                    "name": body["name"],
                    "targetUrl": self.webhook_url,
                    "resource": resource,
                    "event": event,
                    "secret": self._config.webhook_secret,
                }
                await _patiently(lambda: client.create_webhook(created))
                continue
            keep, *extra = matching
            await _patiently(lambda: client.update_webhook(str(keep["id"]), body))
            for duplicate in extra:
                hook_id = str(duplicate["id"])
                await _patiently(lambda: client.delete_webhook(hook_id))

    async def withdraw(self) -> None:
        if self.webhook_url is None:
            return
        client = self._require_client()
        for hook in await _patiently(client.list_webhooks):
            if hook.get("targetUrl") == self.webhook_url and hook.get("id"):
                hook_id = str(hook["id"])
                await _patiently(lambda: client.delete_webhook(hook_id))

    async def stop(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    def _require_client(self) -> WebexClient:
        if self._client is None:
            raise RuntimeError("The Webex adapter is not started")
        return self._client

    # ── Webhooks in ──────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        secret = self._config.webhook_secret
        if not secret:
            raise WebhookAuthenticityError("this connection has no webhook secret")
        headers = {key.lower(): value for key, value in request.headers.items()}
        if not _signature_matches(secret.encode(), request.body, headers):
            raise WebhookAuthenticityError("the Webex signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("the body is not JSON") from exc
        if not isinstance(payload, dict):
            raise WebhookPayloadError("the body is not a JSON object")
        resource = payload.get("resource")
        event = payload.get("event")
        data = payload.get("data")
        if not isinstance(resource, str) or not isinstance(event, str):
            raise WebhookPayloadError("the event names no resource or event")
        if not isinstance(data, dict) or not isinstance(data.get("id"), str):
            raise WebhookPayloadError("the event's data has no id")
        # The envelope's own `id` is the webhook's, the same on every delivery
        # it makes, so the event is named by what it is about instead.
        return InboundWebhook(
            envelope_type=f"{resource}:{event}",
            payload=payload,
            handshake=None,
            external_event_id=f"{resource}:{event}:{data['id']}",
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        data = payload["data"]
        if envelope_type == "messages:created":
            await self._message_created(data)
        elif envelope_type == "attachmentActions:created":
            await self._card_pressed(data)
        elif envelope_type == "memberships:created":
            await self._member_joined(data)
        else:
            logger.warning(
                "Ignoring a Webex %s event: this bridge subscribes to no such event",
                envelope_type,
            )
        return None

    async def _space_title(self, channel_id: str) -> str | None:
        """The space's title, which Switch names the room after. Webex sends
        it on no event, so it is fetched once per space."""
        if channel_id in self._space_titles:
            return self._space_titles[channel_id]
        try:
            room = await self._require_client().room(channel_id)
        except WebexApiError as exc:
            logger.warning(
                "Could not read the title of Webex space %s, so its room is "
                "named by its id: %s",
                channel_id,
                exc,
            )
            return None
        title = str(room.get("title") or "").strip() or None
        self._space_titles[channel_id] = title
        return title

    async def _message_created(self, data: dict[str, Any]) -> None:
        if data.get("personId") == self._bot_id:
            return
        message = await self._require_client().message(str(data["id"]))
        sender_id = str(message.get("personId") or "")
        if not sender_id or sender_id == self._bot_id:
            return
        channel_id = str(message.get("roomId") or "")
        message_ref = str(message.get("id") or "")
        if not channel_id or not message_ref:
            logger.warning("Ignoring a Webex message with no room or id")
            return
        channel_type = _room_type(message.get("roomType"))
        sender_email = str(message.get("personEmail") or "")
        sender_name = sender_email or sender_id
        root_id = str(message["parentId"]) if message.get("parentId") else None
        content, named_bot = read_message(message, self._bot_id, self._bot_name)
        channel_name = await self._space_title(channel_id)

        stripped = content.strip()
        if stripped.startswith("!") and self._on_command is not None:
            command, _, args = stripped[1:].partition(" ")
            if command:
                await self._on_command(
                    InboundCommand(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        channel_name=channel_name,
                        sender_id=sender_id,
                        sender_name=sender_name,
                        command=command,
                        args=args.strip(),
                        message_ref=message_ref,
                        root_id=root_id,
                    )
                )
                return

        if self._on_message is None:
            return
        attachments, failures = await self._fetch_files(message.get("files"))
        if not content and not attachments and not failures:
            return
        # In a group space a message reaches the bot only by naming it, so a
        # message that also names an agent is addressed to that agent. One
        # that names nobody else was addressed to the bot itself.
        addressed_to_bot = (
            named_bot
            and channel_type != "direct"
            and _NAMES_SOMEONE.search(content) is None
        )
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                channel_name=channel_name,
                sender_id=sender_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._bot_handle if addressed_to_bot else None,
                sender_is_app=sender_email.endswith(_BOT_EMAIL_DOMAIN),
            )
        )

    async def _fetch_files(
        self, files: object
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if not isinstance(files, list):
            return attachments, failures
        client = self._require_client()
        for position, url in enumerate(files, start=1):
            label = f"file {position}"
            try:
                name, mimetype, data = await client.download(
                    str(url), limit=self._max_attachment_bytes
                )
            except FileTooLarge as exc:
                failures.append(
                    AttachmentFailure(filename=label, reason=f"too large: {exc}")
                )
                continue
            except WebexApiError as exc:
                reason = (
                    "Webex is still scanning it for malware; send it again shortly"
                    if exc.status == 423
                    else str(exc)
                )
                failures.append(AttachmentFailure(filename=label, reason=reason))
                continue
            except httpx.HTTPError as exc:
                failures.append(
                    AttachmentFailure(filename=label, reason=f"download failed: {exc}")
                )
                continue
            attachments.append(Attachment(filename=name, mimetype=mimetype, data=data))
        return attachments, failures

    async def _card_pressed(self, data: dict[str, Any]) -> None:
        if self._on_interaction is None:
            logger.warning(
                "A press on a Webex card has nowhere to go: this bridge handles "
                "no interactions, so the card should not have had buttons."
            )
            return
        action = await self._require_client().attachment_action(str(data["id"]))
        press = read_press(action.get("inputs"))
        if press is None:
            logger.warning("Ignoring a press on a Webex card Switch did not draw")
            return
        sender_id = str(action.get("personId") or "")
        channel_id = str(action.get("roomId") or "")
        if not sender_id or not channel_id:
            logger.warning("Ignoring a Webex card press that names no person or space")
            return
        action_id, value = press
        notices: list[str] = []
        held = _PRESS_NOTICE.set(notices)
        try:
            await self._on_interaction(
                InboundInteraction(
                    channel_id=channel_id,
                    sender_id=sender_id,
                    sender_name=await self._person_name(sender_id),
                    action_id=action_id,
                    value=value,
                    message_ref=str(action.get("messageId") or "") or None,
                )
            )
        finally:
            _PRESS_NOTICE.reset(held)
        for notice in notices:
            await self._require_client().post_message(
                {
                    "roomId": channel_id,
                    "markdown": f"{person_mention(sender_id)} {notice}",
                }
            )

    async def _person_name(self, person_id: str) -> str:
        """How a person is named in Switch, as an inbound message names them."""
        try:
            person = await self._require_client().person(person_id)
        except WebexApiError as exc:
            logger.warning("Could not look up Webex person %s: %s", person_id, exc)
            return person_id
        emails = person.get("emails") or []
        return str(emails[0]) if emails else person_id

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person their press did not land, by naming them in the space.

        Webex gives a bot no reply only one person sees, so the notice goes
        into the space and names them, so they are notified. A notice raised
        while a press is being handled is held and posted once it is handled.
        """
        notices = _PRESS_NOTICE.get()
        safe = defuse_webex_mentions(self.escape_label_for_body(text))
        if notices is not None:
            notices.append(safe)
            return
        body: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": f"{person_mention(actor_ref)} {safe}",
        }
        if thread_ref:
            body["parentId"] = thread_ref
        await self._require_client().post_message(body)

    async def _member_joined(self, data: dict[str, Any]) -> None:
        channel_id = str(data.get("roomId") or "")
        person_id = str(data.get("personId") or "")
        if not channel_id or not person_id:
            return
        channel_type = _room_type(data.get("roomType"))
        if person_id == self._bot_id:
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        channel_name=await self._space_title(channel_id),
                    )
                )
            return
        if self._on_user_joined is not None:
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    channel_name=await self._space_title(channel_id),
                    external_user_id=person_id,
                    external_username=str(data.get("personEmail") or person_id),
                )
            )

    # ── Messages out ─────────────────────────────────────────────────────────

    async def _post(self, body: dict[str, Any]) -> str:
        try:
            return await self._require_client().post_message(body)
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Webex refused the message in space {body.get('roomId')}: {exc}"
            ) from exc

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as `sender_name`, split into as many messages as it takes.

        One bot speaks for every agent, so the agent's name goes in front of
        the text. The first part's id is the message's reference: it is the
        one that carries the name.
        """
        label = await self.agent_label_for_body(sender_name)
        first: str | None = None
        for index, part in enumerate(chunk_message(content)):
            body: dict[str, Any] = {
                "roomId": channel_id,
                "markdown": f"**{label}**\n{part}" if index == 0 else part,
            }
            if thread_root_id:
                body["parentId"] = thread_root_id
            ref = await self._post(body)
            if first is None:
                first = ref
        return first

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
        label = await self.agent_label_for_body(sender_name)
        if len(data) > _MAX_UPLOAD_BYTES:
            note = (
                f"_could not send {self.escape_label_for_body(filename)}: it is "
                f"{len(data)} bytes, and Webex takes files up to "
                f"{_MAX_UPLOAD_BYTES} bytes_"
            )
            body = f"{caption}\n{note}" if caption else note
            return await self.send_message(
                channel_id, sender_name, body, thread_root_id
            )
        markdown = f"**{label}**\n{caption}" if caption else f"**{label}**"
        try:
            return await self._require_client().post_file(
                channel_id, markdown, thread_root_id, filename, mimetype, data
            )
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Webex refused the file {filename} in space {channel_id}: {exc}"
            ) from exc

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Edit a message the bot sent. Webex allows each message ten edits."""
        await self._edit(
            message_ref,
            {"roomId": channel_id, "markdown": chunk_message(new_content)[0]},
        )

    async def _edit(self, message_ref: str, body: dict[str, Any]) -> None:
        await self._require_client().edit_message(message_ref, body)
        self._edits[message_ref] = self._edits.get(message_ref, 0) + 1

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_client().delete_message(message_ref)
        except WebexApiError as exc:
            if exc.status != 404:
                raise
        self._edits.pop(message_ref, None)
        self._drawn.pop(message_ref, None)

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        try:
            await self.delete_message(channel_id, message_ref)
            ping = self._pings.pop(message_ref, None)
            if ping is not None:
                await self.delete_message(channel_id, ping)
        except WebexApiError as exc:
            if exc.throttled:
                raise RichContentThrottled(
                    retry_after=exc.retry_after or 1.0, text=""
                ) from exc
            raise RemovalFailed(
                f"Webex did not delete message {message_ref}: {exc}"
            ) from exc

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    # ── Session activity and request cards ───────────────────────────────────

    def rich_fallback_limit(self) -> int:
        """Characters a turn's status or a card's text may take.

        Kept well under Webex's 7,439-byte message limit, because a card
        carries its text twice — in the card and as the text shown where cards
        are not drawn — and the two together must stay under 22,740 bytes.
        """
        return 4000

    def _draw(
        self, content: RichContent, label: str, *, controls: bool, mentions: bool
    ) -> Drawn:
        mention_of = self._mention if mentions else _no_mention
        escape = self._rich_escape
        markup = self.rich_markup()
        lead = f"**{label}**\n"
        limit = max(1, self.rich_fallback_limit() - len(lead))
        if isinstance(content, TurnActivity):
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
            text = turn_status(
                content.items,
                content.turn,
                escape=escape,
                limit=max(1, limit - len(tail)),
                markup=markup,
                elapsed_seconds=content.elapsed_seconds,
                mention=mention_of(content.notify_external_id),
                error_summary=content.error_summary,
                tool_detail=True,
            )
            return Drawn(text=f"{lead}{text}{tail}", answerable=False)
        mention = mention_of(content.notify_external_id)
        head = f"{mention}\n" if mention else ""
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=escape,
            limit=max(1, limit - len(head) - len(tail)),
            markup=markup,
            responder=mention_of(content.responder_external_id),
            unavailable_reason=content.unavailable_reason,
            control_label_limit=MAX_BUTTON_LABEL if controls else None,
        )
        return Drawn(
            text=f"{lead}{head}{drawn.text}{tail}", answerable=drawn.answerable
        )

    @staticmethod
    def _mention(external_user_id: str | None) -> str | None:
        return person_mention(external_user_id) if external_user_id else None

    async def _publication(
        self, channel_id: str, agent_name: str, content: RichContent
    ) -> tuple[dict[str, Any], str, str | None]:
        """The message body for `content`, its text for a failure to carry,
        and for a card, the mention of whoever must answer it.

        A request that can be answered here is drawn as a card with a button
        per option. Webex refuses a mention in a message that carries a card,
        so the card names nobody and the person is mentioned in a message of
        its own. A request that cannot be answered here — settled, or too
        long to decide from what fits — is plain text with its mentions.
        """
        label = await self.agent_label_for_body(agent_name)
        if isinstance(content, RequestCard) and self._on_interaction is not None:
            controls = offered_controls(content.request)
            if controls:
                drawn = self._draw(content, label, controls=True, mentions=False)
                card = request_card(drawn.text, content.reference.token, controls)
                if (
                    drawn.answerable
                    and card_message_size(drawn.text, [card]) <= MAX_CARD_MESSAGE_BYTES
                ):
                    body = {
                        "roomId": channel_id,
                        "markdown": drawn.text,
                        "attachments": [card],
                    }
                    return body, drawn.text, self._mention(content.notify_external_id)
        drawn = self._draw(content, label, controls=False, mentions=True)
        return {"roomId": channel_id, "markdown": drawn.text}, drawn.text, None

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        body, text, ping = await self._publication(channel_id, agent_name, content)
        if thread_root_id:
            body["parentId"] = thread_root_id
        client = self._require_client()
        ping_ref: str | None = None
        try:
            if ping is not None:
                label = await self.agent_label_for_body(agent_name)
                ping_body = {
                    "roomId": channel_id,
                    "markdown": f"{ping} **{label}** needs your answer:",
                }
                if thread_root_id:
                    ping_body["parentId"] = thread_root_id
                ping_ref = await client.post_message(ping_body)
            ref = await client.post_message(body)
        except WebexApiError as exc:
            if ping_ref is not None:
                await self.delete_message(channel_id, ping_ref)
            raise _rich_failure(
                exc, f"Webex refused the post in space {channel_id}", text
            ) from exc
        self._drawn[ref] = text
        if ping_ref is not None:
            self._pings[ref] = ping_ref
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, within Webex's ten edits a message.

        A redraw that would show the same thing is not sent, and a running
        turn's status keeps its last edit back for the turn's end, so the
        message finishes showing how the turn went rather than stopping
        wherever the edits ran out.
        """
        body, text, _ = await self._publication(channel_id, agent_name, content)
        if self._drawn.get(message_ref) == text:
            return
        used = self._edits.get(message_ref, 0)
        running = isinstance(content, TurnActivity) and (
            content.turn.status not in TURN_ENDED
        )
        if running and used >= _MAX_EDITS - 1:
            return
        if used >= _MAX_EDITS:
            raise RichContentWedged(
                f"Webex allows a message {_MAX_EDITS} edits and message "
                f"{message_ref} has had them, so it cannot be redrawn.",
                text=text,
            )
        try:
            await self._edit(message_ref, body)
        except WebexApiError as exc:
            raise _rich_failure(
                exc, f"Webex refused the edit in space {channel_id}", text
            ) from exc
        self._drawn[message_ref] = text

    # ── Spaces and people ────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """A new group space with the bot in it. Webex spaces have no topic or
        privacy setting: a space is open to the people added to it."""
        try:
            room = await self._require_client().create_room(name)
        except WebexApiError as exc:
            raise BridgeOperationError(
                f"Webex would not create the space {name!r}: {exc}"
            ) from exc
        room_id = room.get("id")
        if not isinstance(room_id, str) or not room_id:
            raise BridgeOperationError("Webex created a space but returned no id")
        return room_id

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._require_client().room(channel_id)
        return _room_type(room.get("type"))

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Nothing to add: every agent speaks through the one bot, which is
        already in the space."""
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        failed: list[str] = []
        for person in user_external_ids:
            try:
                await self._require_client().add_member(channel_id, person)
            except WebexApiError as exc:
                if exc.status == 409:
                    continue
                logger.warning(
                    "Could not add Webex person %s to space %s: %s",
                    person,
                    channel_id,
                    exc,
                )
                failed.append(person)
        return failed

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """The bot leaves the space rather than deleting it: the space and its
        history belong to the people in it, and leaving is what stops it
        relaying."""
        try:
            await self._require_client().leave_room(external_channel_id, self._bot_id)
        except WebexApiError as exc:
            return RetireOutcome.failed(f"Webex would not let the bot leave: {exc}")
        return RetireOutcome(outcome="left")

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def home_deeplink(self) -> str | None:
        return "https://web.webex.com/"

    def render_app_mention(self, token: str) -> str:
        return f"@{self._bot_name or token}"

    # ── Markup ───────────────────────────────────────────────────────────────

    def escape_label_for_body(self, label: str) -> str:
        return defuse_webex_mentions(super().escape_label_for_body(label))

    def _render_outbound(self, content: str) -> str:
        """Webex reads the same Markdown Switch writes. Only its mention
        syntax is broken, so a reply cannot page a person or the space."""
        return defuse_webex_mentions(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message
