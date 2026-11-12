from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, ClassVar, TypeVar

import httpx
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
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
    CreatedChannel,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import render_request
from switch_core.bridges.collaboration.webex.client import (
    WebexClient,
    WebexError,
    resource_path,
)
from switch_core.bridges.collaboration.webex.formatting import from_html
from switch_core.outbound import OutboundPolicy, guarded_async_client

logger = logging.getLogger(__name__)
_ConfigurationResult = TypeVar("_ConfigurationResult")

# Markdown is limited in bytes, not Python characters; leave room for attribution.
MESSAGE_BYTES = 7000
SUBSCRIPTIONS = (
    ("messages", "created"),
    ("attachmentActions", "created"),
    ("memberships", "created"),
)


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        min_length=1,
        title="Bot access token",
        description="Create a bot at developer.webex.com and copy its access token. Personal access tokens are not supported.",
    )
    webhook_secret: SkipJsonSchema[str] = ""
    bot_id: SkipJsonSchema[str] = ""

    @field_validator("bot_token")
    @classmethod
    def token_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a Webex bot access token.")
        return value.strip()


def split_message(text: str, limit: int = MESSAGE_BYTES) -> list[str]:
    parts: list[str] = []
    while len(text.encode()) > limit:
        head = text.encode()[:limit].decode(errors="ignore")
        boundary = max(head.rfind("\n"), head.rfind(" "))
        if boundary > len(head) // 2:
            head = head[: boundary + 1]
        parts.append(head)
        text = text[len(head) :]
    if text or not parts:
        parts.append(text)
    return parts


def split_markdown(text: str, limit: int) -> list[str]:
    if limit < 256:
        raise BridgeOperationError("Webex message has no room for its content.")
    if len(text.encode()) <= limit:
        return [text]
    parts: list[str] = []
    opening = ""
    for piece in split_message(text, limit - 160):
        prefix = opening
        for fence in re.finditer(r"(?m)^(```|~~~)([^\n]*)", piece):
            opening = (
                ""
                if opening
                else fence[1]
                + (fence[2][:40] if re.fullmatch(r"[A-Za-z0-9_+.-]*", fence[2]) else "")
                + "\n"
            )
        suffix = "\n" + opening[:3] if opening else ""
        parts.append(prefix + piece + suffix)
    return parts


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Cisco Webex"
    receives_webhooks: ClassVar[bool] = True
    confirms_webhook_delivery: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = True
    channel_mention: ClassVar[str | None] = "<@all>"
    recovers_uncertain_posts: ClassVar[bool] = False
    discloses_unconfirmed_posts: ClassVar[bool] = True

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._http: httpx.AsyncClient | None = None
        self._api: WebexClient | None = None
        self._bot_id = config.bot_id
        self._bot_name = ""

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        config = WebexConnectionConfig.model_validate(connection_config)
        async with guarded_async_client(OutboundPolicy.parse(""), timeout=30) as http:
            identity = await WebexClient(http, config.bot_token).me()
        return {
            **connection_config,
            "bot_id": str(identity["id"]),
            "webhook_secret": config.webhook_secret or secrets.token_urlsafe(32),
        }

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        bot_id = connection_config.get("bot_id")
        return str(bot_id) if bot_id else None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WebexConnectionConfig.model_validate(connection_config)
        async with guarded_async_client(OutboundPolicy.parse(""), timeout=30) as http:
            identity = await WebexClient(http, config.bot_token).me()
            if config.bot_id and identity["id"] != config.bot_id:
                raise BridgeOperationError(
                    "This token belongs to a different Webex bot. Create a new connection instead."
                )

    @classmethod
    def editable_config_keys(
        cls, connection_config: Mapping[str, object]
    ) -> frozenset[str]:
        return frozenset({"bot_token"})

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        return f"Send `!link-account {code}` in a direct message to your Webex bot. In a group space, @mention the bot before the command."

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    def _client(self) -> WebexClient:
        if self._api is None:
            raise BridgeOperationError("The Webex connection is not running.")
        return self._api

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        if not self.webhook_url or not self.config.webhook_secret:
            raise BridgeOperationError(
                "Webex requires MESSAGING_PUBLIC_URL (public HTTPS) and a persisted webhook secret. Reconnect this bot in Console."
            )
        self._on_message, self._on_command = on_message, on_command
        self._on_user_joined, self._on_app_joined = on_user_joined, on_app_joined
        self._http = guarded_async_client(self.outbound_policy, timeout=30)
        self._api = WebexClient(self._http, self.config.bot_token)
        try:
            identity = await self._retry_configuration(self._client().me)
            self._bot_id = str(identity["id"])
            self._bot_name = str(identity.get("displayName", ""))
            if self._listening:
                await self._subscribe()
        except BaseException:
            await self.stop()
            raise

    def _subscription_name(self, resource: str, event: str) -> str:
        # The bridge path survives an origin/tunnel change and ownership handover.
        path = httpx.URL(self.webhook_url or "").path
        key = hashlib.sha256(path.encode()).hexdigest()[:24]
        return f"Switch {key} {resource} {event}"

    async def _retry_configuration(
        self, operation: Callable[[], Awaitable[_ConfigurationResult]]
    ) -> _ConfigurationResult:
        while True:
            try:
                return await operation()
            except WebexError as error:
                if error.status != 429:
                    raise
                logger.warning(
                    "Webex rate-limited connection setup; retrying after %.1f seconds.",
                    error.retry_after,
                )
                await asyncio.sleep(error.retry_after)

    async def _subscribe(self) -> None:
        api = self._client()
        existing = await self._retry_configuration(lambda: api.items("webhooks"))
        for resource, event in SUBSCRIPTIONS:
            name = self._subscription_name(resource, event)
            matches = [hook for hook in existing if hook.get("name") == name]
            body = {
                "name": name,
                "targetUrl": self.webhook_url,
                "resource": resource,
                "event": event,
                "secret": self.config.webhook_secret,
            }
            if matches:
                hook = matches[0]
                if not (
                    hook.get("targetUrl") == self.webhook_url
                    and hook.get("status") == "active"
                    and hook.get("resource") == resource
                    and hook.get("event") == event
                    and hook.get("secret", self.config.webhook_secret)
                    == self.config.webhook_secret
                ):
                    await self._retry_configuration(
                        lambda: api.request(
                            "PUT",
                            resource_path("webhooks", str(hook["id"])),
                            json={
                                "name": name,
                                "targetUrl": self.webhook_url,
                                "secret": self.config.webhook_secret,
                                "status": "active",
                            },
                        )
                    )
                for duplicate in matches[1:]:
                    await self._retry_configuration(
                        lambda: api.request(
                            "DELETE",
                            resource_path("webhooks", str(duplicate["id"])),
                        )
                    )
            else:
                await self._retry_configuration(
                    lambda: api.request("POST", "webhooks", json=body)
                )

    async def stop(self) -> None:
        if self._http:
            await self._http.aclose()
        self._http = None
        self._api = None

    async def withdraw(self) -> None:
        names = {
            self._subscription_name(*subscription) for subscription in SUBSCRIPTIONS
        }
        for hook in await self._client().items("webhooks"):
            if hook.get("name") in names:
                await self._client().request(
                    "DELETE", resource_path("webhooks", str(hook["id"]))
                )

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method != "POST" or not self.config.webhook_secret:
            raise WebhookAuthenticityError("Invalid Webex signature.")
        modern = request.headers.get("x-webex-signature")
        if modern is not None:
            algorithms = {"SHA-256": hashlib.sha256, "SHA-512": hashlib.sha512}
            for pair in modern.split(","):
                algorithm, _, signature = pair.strip().partition("=")
                digest = algorithms.get(algorithm)
                if digest and signature.isascii():
                    expected = hmac.new(
                        self.config.webhook_secret.encode(), request.body, digest
                    ).hexdigest()
                    if hmac.compare_digest(signature, expected):
                        return
            raise WebhookAuthenticityError("Invalid Webex signature.")
        signature = request.headers.get("x-spark-signature", "")
        expected = hmac.new(
            self.config.webhook_secret.encode(), request.body, hashlib.sha1
        ).hexdigest()
        if not signature.isascii() or not hmac.compare_digest(signature, expected):
            raise WebhookAuthenticityError("Invalid Webex signature.")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            body = json.loads(request.body)
            if not isinstance(body, dict):
                raise ValueError
            resource, event, data = body["resource"], body["event"], body["data"]
            if (resource, event) not in SUBSCRIPTIONS or not isinstance(data, dict):
                raise ValueError
            identifier = data["id"]
            if not isinstance(identifier, str) or not identifier:
                raise ValueError
        except (ValueError, KeyError, TypeError) as error:
            raise WebhookPayloadError("Invalid Webex event payload.") from error
        return InboundWebhook(
            envelope_type=f"{resource}.{event}",
            payload=body,
            handshake=None,
            external_event_id=f"{resource}:{event}:{identifier}",
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        data = payload["data"]
        if envelope_type == "messages.created":
            await self._message(str(data["id"]))
        elif envelope_type == "attachmentActions.created":
            await self._action(str(data["id"]))
        elif envelope_type == "memberships.created":
            membership = await self._client().request(
                "GET", resource_path("memberships", str(data["id"]))
            )
            room_id, person_id = str(membership["roomId"]), str(membership["personId"])
            channel_type = await self.get_channel_type(room_id)
            if person_id == self._bot_id and self._on_app_joined:
                await self._on_app_joined(
                    InboundAppJoin(channel_id=room_id, channel_type=channel_type)
                )
            elif self._on_user_joined:
                person = await self._client().request(
                    "GET", resource_path("people", person_id)
                )
                await self._on_user_joined(
                    InboundUserJoin(
                        channel_id=room_id,
                        channel_type=channel_type,
                        external_user_id=person_id,
                        external_username=str(person.get("displayName", person_id)),
                    )
                )
        else:
            raise WebhookPayloadError("Unsupported Webex event.")
        return None

    async def _message(self, identifier: str) -> None:
        try:
            message = await self._client().request(
                "GET", resource_path("messages", identifier)
            )
        except WebexError as error:
            if error.status == 404:
                return  # The sender deleted the message before it could be fetched.
            raise
        sender = str(message["personId"])
        if sender == self._bot_id:
            return
        person = await self._client().request("GET", resource_path("people", sender))
        text = self.translate_inbound(
            str(
                message.get("markdown")
                or (
                    from_html(message["html"])
                    if message.get("html")
                    else message.get("text")
                )
                or ""
            )
        )
        # A group bot mention is transport addressing, not a Switch agent name.
        text = re.sub(
            r"<@personId:" + re.escape(self._bot_id) + r"(?:\|[^>]*)?>", "", text
        ).strip()
        if self._bot_id in message.get("mentionedPeople", []):
            label = self._bot_name
            if label:
                text = re.sub(r"^@?" + re.escape(label) + r"\s*", "", text).strip()
        common: dict[str, Any] = dict(
            channel_id=str(message["roomId"]),
            channel_type="direct" if message.get("roomType") == "direct" else "group",
            sender_id=sender,
            sender_name=str(person.get("displayName", sender)),
            message_ref=identifier,
            root_id=message.get("parentId"),
        )
        command = re.match(r"^!([a-zA-Z][\w-]*)(?:\s+(.*))?$", text, re.DOTALL)
        if command and self._on_command and person.get("type") != "bot":
            await self._on_command(
                InboundCommand(**common, command=command[1], args=command[2] or "")
            )
            return
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for url in message.get("files", []):
            try:
                attachments.append(
                    await self._client().download(str(url), self._max_attachment_bytes)
                )
            except (BridgeOperationError, httpx.HTTPError) as error:
                failures.append(
                    AttachmentFailure(
                        filename="Webex attachment",
                        reason=str(error)
                        if isinstance(error, BridgeOperationError)
                        else "The attachment download failed.",
                    )
                )
        if self._on_message:
            await self._on_message(
                InboundMessage(
                    **common,
                    content=text,
                    attachments=attachments,
                    attachment_failures=failures,
                    sender_is_app=person.get("type") == "bot",
                )
            )

    async def _action(self, identifier: str) -> None:
        action = await self._client().request(
            "GET", resource_path("attachment/actions", identifier)
        )
        inputs = action.get("inputs", {})
        token, position = inputs.get("switch_token"), inputs.get("switch_position")
        if (
            not isinstance(token, str)
            or not isinstance(position, int)
            or isinstance(position, bool)
            or position < 1
        ):
            raise WebhookPayloadError("Invalid Switch card action.")
        sender = str(action["personId"])
        person = await self._client().request("GET", resource_path("people", sender))
        if person.get("type") == "bot":
            raise WebhookPayloadError("Bots cannot answer Switch requests.")
        if self._on_interaction is None:
            raise BridgeOperationError("Webex card answers are not connected.")
        await self._on_interaction(
            InboundInteraction(
                channel_id=str(action["roomId"]),
                sender_id=sender,
                sender_name=str(person.get("displayName", sender)),
                sender_display_name=str(person.get("displayName", sender)),
                action_id=position_action(position),
                value=token,
                message_ref=str(action["messageId"]),
            )
        )

    def _attributed(self, name: str, content: str) -> str:
        return f"**{self.escape_label_for_body(name)}**\n{content}"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str:
        first: str | None = None
        heading = self._attributed(sender_name, "")
        budget = MESSAGE_BYTES - len(heading.encode())
        if budget < 256:
            raise BridgeOperationError("Webex sender name is too long.")
        for part in split_markdown(content, budget):
            body: dict[str, Any] = {"roomId": channel_id, "markdown": heading + part}
            if thread_root_id:
                body["parentId"] = thread_root_id
            sent = await self._client().request("POST", "messages", json=body)
            first = first or str(sent["id"])
        assert first is not None
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # Read attribution from Webex, so a different pod edits the same identity.
        old = await self._client().request(
            "GET", resource_path("messages", message_ref)
        )
        header = str(old.get("markdown", "")).partition("\n")[0]
        text = (
            f"{header}\n{new_content}"
            if header.startswith("**") and header.endswith("**")
            else new_content
        )
        if len(text.encode()) > MESSAGE_BYTES:
            raise BridgeOperationError(
                "Webex cannot edit one message into multiple messages; send the long text as a new reply."
            )
        await self._client().request(
            "PUT",
            resource_path("messages", message_ref),
            json={"roomId": channel_id, "markdown": text},
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._client().request(
                "DELETE", resource_path("messages", message_ref)
            )
        except WebexError as error:
            if error.status != 404:
                raise

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str:
        if len(data) > min(self._max_attachment_bytes, 100_000_000):
            return await self.send_message(
                channel_id,
                sender_name,
                f'Attachment "{self.escape_label_for_body(filename)}" was refused: it exceeds the file size limit.',
                thread_root_id,
            )
        fields = {
            "roomId": channel_id,
            "markdown": self._attributed(
                sender_name, self.translate_outbound(caption or filename)
            ),
        }
        if thread_root_id:
            fields["parentId"] = thread_root_id
        if len(fields["markdown"].encode()) > MESSAGE_BYTES:
            fields["markdown"] = self._attributed(
                sender_name, "File attached; caption follows."
            )
            await self.send_message(
                channel_id,
                sender_name,
                self.translate_outbound(caption or filename),
                thread_root_id,
            )
        result = await self._client().request(
            "POST", "messages", data=fields, files={"files": (filename, data, mimetype)}
        )
        return str(result["id"])

    def _rich_body(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> dict[str, Any]:
        actions: list[dict[str, Any]] = []
        if isinstance(content, RequestCard):
            drawn = render_request(
                content.request,
                content.reference,
                escape=self._rich_escape,
                limit=1400,
                markup=MARKDOWN,
                responder=None,
                unavailable_reason=content.unavailable_reason,
                control_label_limit=None,
            )
            text = drawn.text
            controls = offered_controls(content.request) if drawn.answerable else []
            if len(controls) <= 5:
                actions = [
                    {
                        "type": "Action.Submit",
                        "title": f"{control.position}. {control.label}"[:150],
                        "data": {
                            "switch_token": content.reference.token,
                            "switch_position": control.position,
                        },
                    }
                    for control in controls
                ]
        else:
            text = self.rich_fallback_text(content)
        text = self._attributed(agent_name, text)
        card: dict[str, Any] = {
            "type": "AdaptiveCard",
            "version": "1.3",
            "body": [{"type": "TextBlock", "text": text, "wrap": True}],
            "actions": actions,
        }
        body: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": text,
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": card,
                }
            ],
        }
        if thread_root_id:
            body["parentId"] = thread_root_id
        return body

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        try:
            sent = await self._client().request(
                "POST",
                "messages",
                json=self._rich_body(channel_id, agent_name, content, thread_root_id),
            )
            return str(sent["id"])
        except httpx.TransportError:
            # An unknown POST outcome keeps the durable reservation for recovery.
            raise
        except (WebexError, BridgeCredentialError) as error:
            if isinstance(error, WebexError) and error.status >= 500:
                raise
            if isinstance(error, WebexError) and error.status == 429:
                raise RichContentThrottled(
                    retry_after=error.retry_after, text=self.rich_fallback_text(content)
                ) from error
            raise RichContentFailed(
                "Webex could not publish the activity card.",
                text=self.rich_fallback_text(content),
            ) from error

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        try:
            await self._client().request(
                "PUT",
                resource_path("messages", message_ref),
                json=self._rich_body(channel_id, agent_name, content, thread_root_id),
            )
        except (WebexError, BridgeCredentialError) as error:
            if isinstance(error, WebexError) and error.status == 429:
                raise RichContentThrottled(
                    retry_after=error.retry_after, text=self.rich_fallback_text(content)
                ) from error
            raise RichContentFailed(
                "Webex could not update the activity card.",
                text=self.rich_fallback_text(content),
            ) from error
        except httpx.TransportError as error:
            raise RichContentFailed(
                "Webex could not update the activity card.",
                text=self.rich_fallback_text(content),
            ) from error

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Webex has no bot typing endpoint; persisted turn cards show work instead.
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        room = await self._client().request("POST", "rooms", json={"title": name})
        return CreatedChannel(id=str(room["id"]), name=str(room.get("title") or name))

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._client().request("GET", resource_path("rooms", channel_id))
        return "direct" if room.get("type") == "direct" else "group"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None  # All Switch agents speak through this one bot.

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        failed: list[str] = []
        for person in user_external_ids:
            key = "personEmail" if "@" in person else "personId"
            try:
                await self._client().request(
                    "POST", "memberships", json={"roomId": channel_id, key: person}
                )
            except WebexError as error:
                if error.status == 409:
                    continue
                if error.status not in (400, 403, 404):
                    raise
                failed.append(person)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def account_unlinkable_reason(self, external_user_id: str) -> str | None:
        person = await self._client().request(
            "GET", resource_path("people", external_user_id)
        )
        return (
            "A Webex bot is not a person's account and cannot be linked to a Switch user."
            if person.get("type") == "bot"
            else None
        )

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _render_outbound(self, content: str) -> str:
        return re.sub(
            r"<@(?:all|personId:[^>]+|personEmail:[^>]+)>",
            lambda match: match[0].replace("<", "&lt;"),
            content,
        )

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    async def home_deeplink(self) -> str:
        return "https://web.webex.com/"
