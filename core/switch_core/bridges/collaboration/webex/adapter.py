from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Awaitable, Callable
from pathlib import PurePath
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
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
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.webex.client import WebexApiError, WebexClient
from switch_core.outbound import guarded_async_client

_COMMAND = re.compile(r"^!([a-z][a-z0-9_-]*)(?:\s+(.*))?$", re.DOTALL)
_MAX_MESSAGE = 7000


def _chunks(text: str) -> list[str]:
    chunks: list[str] = []
    rest = text
    while len(rest) > _MAX_MESSAGE:
        cut = max(rest.rfind("\n", 0, _MAX_MESSAGE), rest.rfind(" ", 0, _MAX_MESSAGE))
        if cut < _MAX_MESSAGE // 3:
            cut = _MAX_MESSAGE
        chunks.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest or not chunks:
        chunks.append(rest)
    return chunks


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_access_token: str = Field(title="Bot access token", min_length=1)
    webhook_secret: str = Field(
        title="Webhook secret",
        min_length=16,
        description="A random secret used to authenticate Webex callbacks.",
    )


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Cisco Webex"
    docs_slug: ClassVar[str | None] = "webex"
    receives_webhooks: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: WebexClient | None = None
        self._http: httpx.AsyncClient | None = None
        self._bot_id = ""

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        WebexConnectionConfig.model_validate(connection_config)
        return ["https://webexapis.com"]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WebexConnectionConfig.model_validate(connection_config)
        client = WebexClient(token=config.bot_access_token)
        try:
            me = await client.me()
            if not me.get("id"):
                raise BridgeCredentialError("Webex returned no bot identity.")
        except WebexApiError as exc:
            raise BridgeCredentialError(f"Webex rejected the bot token: {exc}") from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError("Could not reach Webex.") from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WebexApiError):
            return "auth_failed" if exc.status in {401, 403} else "platform_error"
        if isinstance(exc, httpx.HTTPError):
            return "network"
        return None

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        if not self.webhook_url:
            raise BridgeOperationError(
                "Webex requires MESSAGING_PUBLIC_URL for callbacks."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._http = guarded_async_client(
            self.outbound_policy,
            headers={"Authorization": f"Bearer {self._config.bot_access_token}"},
            timeout=20,
        )
        self._client = WebexClient(token=self._config.bot_access_token, http=self._http)
        me = await self._client.me()
        self._bot_id = str(me["id"])
        await self._client.ensure_webhook(self.webhook_url, self._config.webhook_secret)

    async def stop(self) -> None:
        self._client = None
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    async def verify_webhook(self, request: WebhookRequest) -> None:
        supplied = request.headers.get("x-spark-signature")
        expected = hmac.new(
            self._config.webhook_secret.encode(), request.body, hashlib.sha1
        ).hexdigest()
        if not supplied or not hmac.compare_digest(supplied.lower(), expected):
            raise WebhookAuthenticityError("Webex signature did not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = json.loads(request.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebhookPayloadError("Webex posted invalid JSON") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
            raise WebhookPayloadError("Webex webhook has no data object")
        event_id = payload.get("id")
        message_id = payload["data"].get("id")
        if not isinstance(event_id, str) or not isinstance(message_id, str):
            raise WebhookPayloadError("Webex webhook has no event or message id")
        return InboundWebhook(
            envelope_type="message.created",
            payload=payload["data"],
            handshake=None,
            external_event_id=event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        if envelope_type != "message.created":
            return None
        message = await self._require_client().message(str(payload["id"]))
        if message.get("personId") == self._bot_id:
            return None
        room_id = str(message.get("roomId") or "")
        sender = str(message.get("personId") or message.get("personEmail") or "")
        message_id = str(message.get("id") or "")
        if not room_id or not sender or not message_id:
            return None
        body = str(message.get("markdown") or message.get("text") or "")
        root_id = str(message["parentId"]) if message.get("parentId") else None
        command = _COMMAND.match(body.strip())
        if command and self._on_command is not None:
            await self._on_command(
                InboundCommand(
                    channel_id=room_id,
                    channel_type="group",
                    sender_id=sender,
                    sender_name=str(message.get("personEmail") or sender),
                    command=command.group(1),
                    args=command.group(2) or "",
                    message_ref=message_id,
                    root_id=root_id,
                )
            )
            return None
        attachments, failures = await self._files(message)
        if self._on_message is not None and (body or attachments or failures):
            await self._on_message(
                InboundMessage(
                    channel_id=room_id,
                    channel_type="group",
                    sender_id=sender,
                    sender_name=str(message.get("personEmail") or sender),
                    content=body,
                    message_ref=message_id,
                    root_id=root_id,
                    attachments=attachments,
                    attachment_failures=failures,
                )
            )
        return None

    async def _files(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        files = message.get("files")
        if not isinstance(files, list):
            return attachments, failures
        for raw_url in files[:10]:
            url = str(raw_url)
            filename = PurePath(urlsplit(url).path).name or "webex-file"
            try:
                data, mimetype = await self._require_client().download(url)
                if len(data) > self._max_attachment_bytes:
                    raise ValueError(
                        f"file is larger than {self._max_attachment_bytes} bytes"
                    )
                attachments.append(
                    Attachment(filename=filename, mimetype=mimetype, data=data)
                )
            except (WebexApiError, httpx.HTTPError, ValueError) as exc:
                failures.append(AttachmentFailure(filename=filename, reason=str(exc)))
        return attachments, failures

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
        for index, part in enumerate(_chunks(content)):
            label = sender_name if index == 0 else f"{sender_name} (continued)"
            ref = await self._require_client().send(
                channel_id, f"**{label}:** {part}", thread_root_id
            )
            if first is None:
                first = ref
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._require_client().update(message_ref, channel_id, new_content)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._require_client().delete(message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        return await self._require_client().create_room(name)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._require_client().room(channel_id)
        return "direct" if room.get("type") == "direct" else "group"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        failed: list[str] = []
        for person in user_external_ids:
            try:
                await self._require_client().add_member(channel_id, person)
            except WebexApiError:
                failed.append(person)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return f"https://web.webex.com/spaces/{external_channel_id}"

    async def home_deeplink(self) -> str | None:
        return "https://web.webex.com/"

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _require_client(self) -> WebexClient:
        if self._client is None:
            raise RuntimeError("Webex adapter is not started")
        return self._client
