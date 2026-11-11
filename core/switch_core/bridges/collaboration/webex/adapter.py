"""Webex collaboration bridge adapter.

Connects Switch to spaces on Webex through a bot the operator created at
developer.webex.com and gave Switch the access token of.

**Events arrive by webhook**, on the connection's own address
(`/messaging/bridges/<id>/events`), not over Webex's WebSocket. The WebSocket is
the Webex SDKs' device connection, which is not part of the documented REST API
for bots, so it would be a long-lived connection on an undocumented route that
only one pod could hold. A webhook is documented, is the same shape Switch
already serves for other platforms, is handled by whichever pod receives it, and
is recognised once by core when Webex delivers it twice. What it costs is a
public HTTPS address (`MESSAGING_PUBLIC_URL`).

Registering the webhooks is the one thing kept alive on the platform, so only
the process holding the bridge does it (`keeps_quiet_unless_listening`). Nothing
a second process would need is kept in this one.

Single-bot identity model, as on Telegram: a Webex message has no per-message
sender, so every agent posts through the one bot and is told apart by its name
at the head of the message.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, ClassVar

import httpx
from pydantic import field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RichContentFailed,
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
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.webex.chunking import chunk_message
from switch_core.bridges.collaboration.webex.client import WebexAPIError, WebexClient

logger = logging.getLogger(__name__)

# The events Switch asks Webex to call it for. A message is the content, and a
# membership is how Switch learns the bot was added to a space.
_WEBHOOKS = (("messages", "created"), ("memberships", "created"))
# Webex takes one file of up to 100 MB per message.
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
_HEADING = re.compile(r"^#{1,6}\s+(.*)$", re.MULTILINE)


def _new_http() -> httpx.AsyncClient:
    """The HTTP client for Webex's API: a fixed public host, no redirects."""
    return httpx.AsyncClient(follow_redirects=False, trust_env=False)


def handle_of(email: str) -> str:
    """The name Switch addresses a person by: the local part of their email."""
    local = email.partition("@")[0]
    return re.sub(r"[^A-Za-z0-9._-]", "_", local) or "user"


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    # Generated when the connection is created (`prepare_config`) and kept: it
    # signs each webhook Webex sends, so Switch can tell Webex from anyone else
    # who learns the address. Not something an operator types.
    webhook_secret: SkipJsonSchema[str | None] = None

    @field_validator("bot_token")
    @classmethod
    def _token_is_given(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("bot_token is required")
        return value


@dataclass
class _Space:
    title: str | None
    channel_type: ChannelType


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Webex"
    receives_webhooks: ClassVar[bool] = True
    # Only the holder registers and repairs the webhooks; any pod serves them.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # The bot leaves a space whose Switch room was deleted.
    channel_on_delete = "left"
    # Webex bots cannot search the organisation's people.
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # A turn's status and a request's question are posted as text and edited in
    # place. There are no reactions or typing for a bot, so the status text is
    # the working indicator, and an approval is answered by typing.
    draws_session_activity: ClassVar[bool] = True

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Mint the webhook secret, once, so what is stored is stable: minting
        it on every validation would sign with a secret Webex was never given."""
        prepared = dict(connection_config)
        if not prepared.get("webhook_secret"):
            prepared["webhook_secret"] = secrets.token_urlsafe(32)
        return prepared

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask Webex who the token belongs to, as `start` will, and refuse one
        that is a person's: a person's token would read their own messages."""
        config = WebexConnectionConfig.model_validate(connection_config)
        client = WebexClient(config.bot_token, _new_http())
        try:
            me = await client.me()
        except WebexAPIError as error:
            if error.status in (401, 403):
                raise BridgeCredentialError(
                    "Webex rejected the bot token. Copy it again from "
                    "developer.webex.com (My Webex Apps, your bot)."
                ) from error
            raise BridgeCredentialError(
                f"Webex refused the check: {error.message}"
            ) from error
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                f"Could not reach Webex to check the token ({type(exc).__name__})."
            ) from exc
        finally:
            await client.aclose()
        if me.get("type") != "bot":
            raise BridgeCredentialError(
                "That token belongs to a person, not a bot. Create a bot at "
                "developer.webex.com and use its token."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexAPIError):
            return "auth_failed" if exc.status == 401 else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        if isinstance(exc, httpx.HTTPError):
            return "platform_error"
        return None

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: WebexClient | None = None
        self._bridge_id = ""
        self._bot_id = ""
        self._bot_name = ""
        self._bot_handle = ""
        # What was found out about a space, so it is asked once. A cache: it
        # can be lost and found again, and no other pod needs it.
        self._spaces: dict[str, _Space] = {}

    def set_bridge_id(self, bridge_id: str) -> None:
        self._bridge_id = bridge_id

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

        self._client = WebexClient(self._config.bot_token, _new_http())
        me = await self._client.me()
        self._bot_id = str(me["id"])
        self._bot_name = str(me.get("displayName") or "")
        emails = me.get("emails") or [""]
        self._bot_handle = handle_of(str(emails[0]))
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Webex delivers messages by webhook, and this Switch server has no "
                "public address for it. Set MESSAGING_PUBLIC_URL to the server's "
                "public https origin."
            )
        if not self._listening:
            logger.info(
                "Webex adapter for %s running quietly: another process holds this "
                "bridge and keeps its webhooks registered",
                self._bot_handle,
            )
            return
        await self._register_webhooks(self.webhook_url)
        logger.info("Webex adapter connected as %s", self._bot_handle)

    async def stop(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def withdraw(self) -> None:
        """The bridge is being removed for good: stop Webex calling an address
        nobody will answer."""
        client = self._client
        if client is None:
            return
        for hook in await client.webhooks():
            if hook.get("name") == self._webhook_name():
                await client.delete_webhook(str(hook["id"]))

    def _require_client(self) -> WebexClient:
        if self._client is None:
            raise RuntimeError("Webex bridge not connected")
        return self._client

    def _webhook_name(self) -> str:
        return f"Switch {self._bridge_id}".strip()

    async def _register_webhooks(self, target_url: str) -> None:
        """Make Webex call the bridge's address for each event it needs, and
        nothing else under this bridge's name.

        Idempotent: a webhook already there is updated to the same settings,
        which also turns on one Webex switched off after failed deliveries, and
        a stray one is removed.
        """
        client = self._require_client()
        name = self._webhook_name()
        body = {
            "name": name,
            "targetUrl": target_url,
            "secret": self._config.webhook_secret,
        }
        ours = [hook for hook in await client.webhooks() if hook.get("name") == name]
        for resource, event in _WEBHOOKS:
            matching = [
                hook
                for hook in ours
                if hook.get("resource") == resource and hook.get("event") == event
            ]
            if matching:
                await client.update_webhook(
                    str(matching[0]["id"]), {**body, "status": "active"}
                )
                extras = matching[1:]
            else:
                await client.create_webhook(
                    {**body, "resource": resource, "event": event}
                )
                extras = []
            for extra in extras:
                await client.delete_webhook(str(extra["id"]))
        wanted = set(_WEBHOOKS)
        for hook in ours:
            if (hook.get("resource"), hook.get("event")) not in wanted:
                await client.delete_webhook(str(hook["id"]))

    # ── Inbound: webhooks ────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        """Webex signs each delivery: `X-Spark-Signature` is the HMAC-SHA1 of the
        body, keyed by the secret given when the webhook was registered."""
        secret = self._config.webhook_secret
        if request.method != "POST" or not secret:
            raise WebhookAuthenticityError("not a signed Webex delivery")
        given = request.headers.get("x-spark-signature", "").strip().lower()
        expected = hmac.new(secret.encode(), request.body, hashlib.sha1).hexdigest()
        if not hmac.compare_digest(given, expected):
            raise WebhookAuthenticityError("signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("body is not JSON") from exc
        data = payload.get("data") if isinstance(payload, dict) else None
        if (
            not isinstance(data, dict)
            or not data.get("id")
            or not payload.get("resource")
            or not payload.get("event")
        ):
            raise WebhookPayloadError("not a Webex event")
        return InboundWebhook(
            envelope_type=f"{payload['resource']}.{payload['event']}",
            payload=payload,
            handshake=None,
            # A webhook's own `id` is the same for every delivery it makes; the
            # id of the message or membership is what says which event this is.
            external_event_id=f"{payload['resource']}:{data['id']}",
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        data: dict[str, Any] = payload["data"]
        if envelope_type == "messages.created":
            await self._handle_message(data)
        elif envelope_type == "memberships.created":
            await self._handle_membership(data)
        return None

    @staticmethod
    def _callback(
        callback: Callable[[Any], Awaitable[None]] | None,
    ) -> Callable[[Any], Awaitable[None]]:
        if callback is None:
            raise RuntimeError("Webex bridge not started")
        return callback

    async def _space(self, room_id: str) -> _Space:
        known = self._spaces.get(room_id)
        if known is not None:
            return known
        room = await self._require_client().room(room_id)
        channel_type: ChannelType = (
            "direct" if room.get("type") == "direct" else "channel_private"
        )
        space = _Space(room.get("title") or None, channel_type)
        self._spaces[room_id] = space
        return space

    async def _handle_membership(self, data: dict[str, Any]) -> None:
        room_id = str(data["roomId"])
        space = await self._space(room_id)
        person_id = str(data.get("personId", ""))
        if person_id == self._bot_id:
            await self._callback(self._on_app_joined)(
                InboundAppJoin(
                    channel_id=room_id,
                    channel_type=space.channel_type,
                    channel_name=space.title,
                )
            )
            return
        await self._callback(self._on_user_joined)(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=space.channel_type,
                external_user_id=person_id,
                external_username=handle_of(str(data.get("personEmail", ""))),
                channel_name=space.title,
            )
        )

    async def _handle_message(self, data: dict[str, Any]) -> None:
        if data.get("personId") == self._bot_id:
            return
        message = await self._require_client().message(str(data["id"]))
        room_id = str(message["roomId"])
        space = await self._space(room_id)
        email = str(message.get("personEmail", ""))
        mentioned = self._bot_id in (message.get("mentionedPeople") or [])
        text = self.translate_inbound(str(message.get("text") or ""))
        if mentioned:
            text = self._without_leading_bot_name(text)
        root_id = message.get("parentId") or None
        sender_id = str(message["personId"])
        message_id = str(message["id"])
        if text.lstrip().startswith("!"):
            parts = text.strip().split(None, 1)
            await self._callback(self._on_command)(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=space.channel_type,
                    sender_id=sender_id,
                    sender_name=handle_of(email),
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=space.title,
                )
            )
            return
        attachments, failures = await self._fetch_files(message.get("files") or [])
        if not text and not attachments and not failures:
            return
        await self._callback(self._on_message)(
            InboundMessage(
                channel_id=room_id,
                channel_type=space.channel_type,
                sender_id=sender_id,
                sender_name=handle_of(email),
                content=text,
                message_ref=message_id,
                root_id=root_id,
                channel_name=space.title,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._bot_handle if mentioned else None,
                # Another bot's message is relayed, but cannot answer a request.
                sender_is_app=email.endswith("@webex.bot"),
            )
        )

    def _without_leading_bot_name(self, text: str) -> str:
        """In a space Webex delivers a message only when it mentions the bot, and
        its text then opens with the bot's display name."""
        if not self._bot_name:
            return text
        return re.sub(
            rf"^\s*{re.escape(self._bot_name)}[\s:,]*", "", text, flags=re.IGNORECASE
        )

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    async def _fetch_files(
        self, urls: list[str]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        cap = min(self._max_attachment_bytes, _MAX_DOWNLOAD_BYTES)
        for url in urls:
            filename = "file"
            try:
                async with self._require_client().download(url) as response:
                    disposition = response.headers.get("content-disposition", "")
                    found = re.search(r'filename="?([^";]+)"?', disposition)
                    filename = found.group(1) if found else "file"
                    stated = response.headers.get("content-length")
                    if stated is not None and int(stated) > cap:
                        failures.append(
                            AttachmentFailure(
                                filename=filename,
                                reason=f"{stated} bytes exceeds the {cap} byte limit",
                            )
                        )
                        continue
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > cap:
                            break
                    if len(data) > cap:
                        failures.append(
                            AttachmentFailure(
                                filename=filename,
                                reason=f"it exceeds the {cap} byte limit",
                            )
                        )
                        continue
                    mimetype = response.headers.get(
                        "content-type", "application/octet-stream"
                    ).partition(";")[0]
                    attachments.append(
                        Attachment(
                            filename=filename, mimetype=mimetype, data=bytes(data)
                        )
                    )
            except (WebexAPIError, httpx.HTTPError) as error:
                logger.warning("Could not download a Webex file: %s", error)
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {error}"
                    )
                )
        return attachments, failures

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        # Webex Markdown has no headings, so a heading becomes a bold line.
        return _HEADING.sub(r"**\1**", content)

    def rich_fallback_limit(self) -> int:
        # 1,750 characters is at most 7,000 bytes: one message, so a status can
        # be edited in place.
        return 1750

    @staticmethod
    def _headed(label: str | None, text: str) -> str:
        if label is None:
            return text
        return f"**{label}**\n{text}" if "\n" in text else f"**{label}**: {text}"

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
            body: dict[str, Any] = {
                "roomId": channel_id,
                "markdown": self._headed(agent.body_label, piece),
            }
            if thread_root_id is not None:
                body["parentId"] = thread_root_id
            ref = await self._require_client().create_message(body)
            first = first or ref
        return first

    async def _replace(
        self, channel_id: str, message_ref: str, text: str, label: str | None
    ) -> None:
        await self._require_client().update_message(
            message_ref,
            {
                "roomId": channel_id,
                "markdown": self._headed(label, chunk_message(text)[0]),
            },
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._replace(channel_id, message_ref, new_content, None)
        except WebexAPIError as error:
            logger.error("Failed to edit Webex message %s: %s", message_ref, error)

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
                f"Webex could not update the message in {channel_id}: {error}",
                text=text,
            ) from error

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_client().delete_message(message_ref)
        except WebexAPIError as error:
            if error.status != 404:
                logger.error(
                    "Failed to delete Webex message %s: %s", message_ref, error
                )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Webex has no typing indicator for a bot.
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
        """Relay one file, which Webex takes one to a message. A file over its
        limit is not sent and the space is told so, so a file is never silently
        dropped."""
        agent = await self.agent_rendering(sender_name)
        if len(data) > _MAX_UPLOAD_BYTES:
            logger.warning(
                "Webex attachment %s is %d bytes, over the %d byte limit",
                filename,
                len(data),
                _MAX_UPLOAD_BYTES,
            )
            return await self.send_message(
                channel_id,
                sender_name,
                f"_sent {filename}, but it is {len(data)} bytes and Webex accepts "
                f"at most {_MAX_UPLOAD_BYTES}._",
                thread_root_id,
            )
        fields = {
            "roomId": channel_id,
            "markdown": self._headed(agent.body_label, caption or f"sent {filename}"),
        }
        if thread_root_id is not None:
            fields["parentId"] = thread_root_id
        try:
            return await self._require_client().create_message_with_file(
                fields, filename, mimetype, data
            )
        except WebexAPIError as error:
            logger.error("Failed to upload %s to Webex: %s", filename, error)
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

    # ── Spaces ───────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """Create a space. Webex has no topic, so `topic` is not kept."""
        try:
            room_id = await self._require_client().create_room(name)
        except WebexAPIError as error:
            raise BridgeOperationError(f"Webex refused: {error.message}") from error
        self._spaces[room_id] = _Space(name, "channel_private")
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        client = self._require_client()
        try:
            for membership in await client.memberships(
                external_channel_id, self._bot_id
            ):
                await client.delete_membership(str(membership["id"]))
        except WebexAPIError as error:
            return RetireOutcome(outcome="failed", reason=error.message)
        self._spaces.pop(external_channel_id, None)
        return RetireOutcome(outcome="left")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        self._spaces.pop(channel_id, None)
        return (await self._space(channel_id)).channel_type

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
        for person_id in user_external_ids:
            try:
                await client.add_member(channel_id, person_id)
            except WebexAPIError as error:
                logger.warning(
                    "Could not add a person to Webex space %s: %s", channel_id, error
                )
                failed.append(person_id)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []
