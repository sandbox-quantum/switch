"""Cisco Webex as a messaging platform: one bot the operator creates.

The operator creates a bot at developer.webex.com and gives Switch its access
token and a webhook secret of their choosing. Every agent speaks through the
bot, with its name in bold at the start of each message. A space is a room, a
1:1 space with the bot is a direct room, and a reply (`parentId`) stays in its
thread.

Events arrive by webhook, on the bridge's own address. Webex documents
webhooks as the way a bot receives messages; its device WebSocket is not
documented for bots. On start the adapter registers its webhooks itself
(`messages` and `attachmentActions`, each signed with the connection's
secret), so the operator pastes nothing into Webex. A webhook carries only an
id; the adapter reads the message with the bot's token, which is how Webex
keeps message text out of webhook payloads. Webhooks reach any pod, so a quiet
copy needs nothing of the holder, and a retried delivery carries the same
message id.

In a group space Webex delivers a bot only the messages that mention it, so
an unaddressed message never reaches the room there; the docs page says so.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
)
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.session.renderers import (
    offered_controls,
    position_action,
)

logger = logging.getLogger(__name__)

API = "https://webexapis.com/v1"
SIGNATURE_HEADER = "x-spark-signature"
# Webex takes a message of up to 7439 bytes; it is cut well inside that.
MAX_MESSAGE = 6000
_WEBHOOK_NAME = "Switch"
_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        title="Bot access token",
        description="Shown once when you create the bot at developer.webex.com.",
        repr=False,
    )
    webhook_secret: str = Field(
        title="Webhook secret",
        description=(
            "Any long random string. Webex signs each event with it, and Switch "
            "refuses an event it did not sign."
        ),
        min_length=16,
        repr=False,
    )

    @field_validator("bot_token")
    @classmethod
    def _token(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 40 or " " in value:
            raise ValueError("Paste the bot's access token as Webex showed it")
        return value


def sign(secret: str, body: bytes) -> str:
    """What Webex puts in `X-Spark-Signature`: HMAC-SHA1 of the body, hex."""
    return hmac.new(secret.encode(), body, hashlib.sha1).hexdigest()


class WebexError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status})")
        self.status = status
        self.message = message


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Webex"
    receives_webhooks: ClassVar[bool] = True
    # A bot can search people only in its own spaces' memberships.
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._http = httpx.AsyncClient(timeout=_TIMEOUT)
        self._me: dict[str, Any] = {}

    # ── Declarations ─────────────────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexError):
            return "auth_failed" if exc.status in (401, 403) else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [API]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WebexConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            try:
                response = await http.get(
                    f"{API}/people/me",
                    headers={"Authorization": f"Bearer {config.bot_token}"},
                )
            except httpx.TransportError as error:
                raise BridgeCredentialError(
                    f"Could not reach Webex: {error}"
                ) from error
        if response.status_code == 401:
            raise BridgeCredentialError(
                "Webex doesn't accept this access token. Copy it again from the "
                "bot's page at developer.webex.com, or regenerate it there."
            )
        if response.status_code != 200:
            raise BridgeCredentialError(f"Webex refused the token: {_reason(response)}")
        if response.json().get("type") != "bot":
            raise BridgeCredentialError(
                "This token is a person's, not a bot's. Create a bot at "
                "developer.webex.com and use its token."
            )

    # ── API ──────────────────────────────────────────────────────────────────

    async def _call(
        self, method: str, path: str, *, json_body: Any = None, params: Any = None
    ) -> dict[str, Any]:
        response = await self._http.request(
            method,
            f"{API}{path}",
            json=json_body,
            params=params,
            headers={"Authorization": f"Bearer {self.config.bot_token}"},
        )
        if response.status_code >= 300:
            raise WebexError(response.status_code, _reason(response))
        if not response.content:
            return {}
        body = response.json()
        return body if isinstance(body, dict) else {}

    async def _whoami(self) -> dict[str, Any]:
        if not self._me:
            self._me = await self._call("GET", "/people/me")
        return self._me

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
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        try:
            await self._whoami()
        except WebexError as error:
            raise BridgeCredentialError(error.message) from error
        if not self._listening:
            return
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Webex calls Switch for every message, so the server needs "
                "MESSAGING_PUBLIC_URL, an https address Webex can reach"
            )
        await self._register_webhooks(self.webhook_url)

    async def _register_webhooks(self, url: str) -> None:
        """This bridge's webhooks, made again on every start, so a changed
        address or secret takes effect and none is left behind."""
        existing = await self._call("GET", "/webhooks", params={"max": 100})
        for hook in existing.get("items") or []:
            if hook.get("name") == _WEBHOOK_NAME:
                await self._call("DELETE", f"/webhooks/{hook['id']}")
        for resource in ("messages", "attachmentActions"):
            await self._call(
                "POST",
                "/webhooks",
                json_body={
                    "name": _WEBHOOK_NAME,
                    "targetUrl": url,
                    "resource": resource,
                    "event": "created",
                    "secret": self.config.webhook_secret,
                },
            )

    async def stop(self) -> None:
        await self._http.aclose()

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        given = request.headers.get(SIGNATURE_HEADER, "")
        if not hmac.compare_digest(
            given, sign(self.config.webhook_secret, request.body)
        ):
            raise WebhookAuthenticityError("the Webex signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = json.loads(request.body)
        except ValueError as error:
            raise WebhookPayloadError("the event is not JSON") from error
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or not data.get("id"):
            raise WebhookPayloadError("the event names no message")
        return InboundWebhook(
            envelope_type=f"{payload.get('resource')}.{payload.get('event')}",
            payload=payload,
            handshake=None,
            external_event_id=str(data["id"]),
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        data = payload.get("data") or {}
        if envelope_type == "messages.created":
            await self._on_webex_message(data)
        elif envelope_type == "attachmentActions.created":
            await self._on_card_submit(data)

    async def _on_webex_message(self, data: dict[str, Any]) -> None:
        me = await self._whoami()
        if data.get("personId") == me.get("id"):
            return
        message = await self._call("GET", f"/messages/{data['id']}")
        text = str(message.get("markdown") or message.get("text") or "").strip()
        if message.get("roomType") == "group" and text.startswith(
            str(me.get("displayName"))
        ):
            # A group mention starts with the bot's name, which is not the
            # message's own text.
            text = text[len(str(me.get("displayName"))) :].strip()
        if not text and not message.get("files"):
            return
        channel_type: ChannelType = (
            "direct" if message.get("roomType") == "direct" else "channel_private"
        )
        sender_name = str(message.get("personEmail") or data.get("personEmail") or "")
        if text.startswith("!") and self._on_command is not None:
            command, _, args = text[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=str(message["roomId"]),
                    channel_type=channel_type,
                    sender_id=str(message.get("personId")),
                    sender_name=sender_name,
                    command=command,
                    args=args.strip(),
                    message_ref=str(message["id"]),
                    root_id=message.get("parentId"),
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=str(message["roomId"]),
                    channel_type=channel_type,
                    sender_id=str(message.get("personId")),
                    sender_name=sender_name,
                    content=text,
                    message_ref=str(message["id"]),
                    root_id=message.get("parentId"),
                    self_mention_token=str(me.get("id"))
                    if me.get("id") in (message.get("mentionedPeople") or [])
                    else None,
                )
            )

    async def _on_card_submit(self, data: dict[str, Any]) -> None:
        action = await self._call("GET", f"/attachment/actions/{data['id']}")
        inputs = action.get("inputs") or {}
        if not inputs.get("switch_action") or self._on_interaction is None:
            return
        await self._on_interaction(
            InboundInteraction(
                channel_id=str(action.get("roomId")),
                sender_id=str(action.get("personId")),
                sender_name=str(data.get("personEmail") or action.get("personId")),
                action_id=str(inputs["switch_action"]),
                value=str(inputs.get("switch_value") or ""),
                message_ref=action.get("messageId"),
            )
        )

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        first: str | None = None
        for part in _chunk(f"**{sender_name}**\n{content}"):
            body: dict[str, Any] = {"roomId": channel_id, "markdown": part}
            if thread_root_id:
                body["parentId"] = thread_root_id
            try:
                sent = await self._call("POST", "/messages", json_body=body)
            except WebexError as error:
                raise BridgeOperationError(
                    f"Webex refused the message in {channel_id}: {error.message}"
                ) from error
            first = first or str(sent.get("id"))
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._call(
                "PUT",
                f"/messages/{message_ref}",
                json_body={"roomId": channel_id, "markdown": _chunk(new_content)[0]},
            )
        except (WebexError, httpx.HTTPError) as error:
            logger.warning("Webex could not edit message %s: %s", message_ref, error)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._call("DELETE", f"/messages/{message_ref}")
        except (WebexError, httpx.HTTPError) as error:
            logger.warning("Webex could not delete message %s: %s", message_ref, error)

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        # Webex shows a bot no typing indicator.
        return None

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A request as an Adaptive Card with a button for each option; the
        text form goes with it, for clients that do not draw cards."""
        text = self.rich_fallback_text(content)
        body: dict[str, Any] = {
            "roomId": channel_id,
            "markdown": f"**{agent_name}**\n{text}",
        }
        if thread_root_id:
            body["parentId"] = thread_root_id
        if isinstance(content, RequestCard):
            body["attachments"] = [_card(agent_name, text, content)]
        try:
            sent = await self._call("POST", "/messages", json_body=body)
        except (WebexError, httpx.HTTPError) as error:
            raise RichContentFailed(
                f"Webex could not post the card: {error}", text=text
            ) from error
        return str(sent.get("id"))

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        try:
            room = await self._call("POST", "/rooms", json_body={"title": name[:100]})
        except WebexError as error:
            raise BridgeOperationError(
                f"Webex would not create the space: {error.message}"
            ) from error
        return str(room["id"])

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        left_out: list[str] = []
        for person in user_external_ids:
            try:
                await self._call(
                    "POST",
                    "/memberships",
                    json_body={"roomId": channel_id, "personId": person},
                )
            except WebexError:
                left_out.append(person)
        return left_out

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._call("GET", f"/rooms/{channel_id}")
        return "direct" if room.get("type") == "direct" else "channel_private"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # One bot speaks for every agent.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        # Webex renders Markdown itself.
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def _card(agent_name: str, text: str, content: RequestCard) -> dict[str, Any]:
    actions = [
        {
            "type": "Action.Submit",
            "title": f"{control.position}. {control.label}"[:60],
            "data": {
                "switch_action": position_action(control.position),
                "switch_value": content.reference.token,
            },
        }
        for control in offered_controls(content.request)
    ]
    return {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
            "type": "AdaptiveCard",
            "version": "1.3",
            "body": [
                {"type": "TextBlock", "text": agent_name, "weight": "Bolder"},
                {"type": "TextBlock", "text": text, "wrap": True},
            ],
            "actions": actions,
        },
    }


def _chunk(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    parts: list[str] = []
    while len(text.encode()) > limit:
        cut = text.rfind("\n", 0, limit // 2 * 2)
        if cut <= 0:
            cut = limit // 2
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n")
    return [*parts, text] if text else parts or [""]


def _reason(response: httpx.Response) -> str:
    try:
        return str(response.json().get("message") or f"HTTP {response.status_code}")
    except ValueError:
        return f"HTTP {response.status_code}"
