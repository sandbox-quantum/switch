"""A messaging platform that exists only in the tests: Dummy Chat.

It is what "adding a platform is self-contained" is held to. Everything Switch
learns about Dummy Chat — its name, icon, docs page, capabilities, how to read
its failures and how to take its webhooks — is in this folder; the tests add it
with one `register_adapter` line and touch nothing else.

Two flavours, as real platforms come: `DummyChatAdapter` dials out and is
handed its events on a connection of its own, and `DummyHookAdapter` is called
by its platform on the bridge's own webhook address, proving each request with
an HMAC over the body keyed by this connection's own secret.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)


class DummyChatError(Exception):
    """What Dummy Chat's (imaginary) SDK raises."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DummyChatConnectionConfig(BridgeConnectionConfig):
    api_token: str


class DummyChatAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Dummy Chat"
    docs_slug: ClassVar[str | None] = "dummy-chat"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False

    def __init__(self, *, config: DummyChatConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self.sent: list[tuple[str, str, str]] = []

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, DummyChatError):
            return "auth_failed" if exc.code == "bad_token" else "platform_error"
        return None

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message

    async def stop(self) -> None:
        return None

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self.sent.append((channel_id, sender_name, content))
        return f"msg-{len(self.sent)}"

    async def update_message(self, *a: Any, **k: Any) -> Any:
        return None

    async def delete_message(self, *a: Any, **k: Any) -> Any:
        return None

    async def send_typing(self, *a: Any, **k: Any) -> Any:
        return None

    async def create_channel(self, *a: Any, **k: Any) -> Any:
        raise NotImplementedError

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any:
        return None

    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any:
        return None

    async def create_agent_identity(self, *a: Any, **k: Any) -> Any:
        return None

    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any:
        return None

    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw: Any) -> str:
        return str(raw)


class DummyHookConnectionConfig(BridgeConnectionConfig):
    signing_secret: str


SIGNATURE_HEADER = "x-dummy-signature"


def sign(secret: str, body: bytes) -> str:
    """What Dummy Hook's platform puts in `SIGNATURE_HEADER`."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class DummyHookAdapter(DummyChatAdapter):
    display_name: ClassVar[str] = "Dummy Hook"
    docs_slug: ClassVar[str | None] = "dummy-hook"
    receives_webhooks: ClassVar[bool] = True

    def __init__(self, *, config: DummyHookConnectionConfig) -> None:  # type: ignore[override]
        PlatformAdapter.__init__(self)
        self.hook_config = config
        self.sent = []
        self.dispatched: list[tuple[str, dict[str, Any]]] = []

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method == "GET":
            # The platform's address check: it proves itself with the secret
            # in the query, as WhatsApp's verify token does.
            if request.query.get("token") != self.hook_config.signing_secret:
                raise WebhookAuthenticityError("wrong address-check token")
            return
        given = request.headers.get(SIGNATURE_HEADER, "")
        expected = sign(self.hook_config.signing_secret, request.body)
        if not hmac.compare_digest(given, expected):
            raise WebhookAuthenticityError("signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method == "GET":
            return InboundWebhook(
                envelope_type="address_check",
                payload={},
                handshake=request.query.get("challenge", ""),
                external_event_id=None,
                delivery_attempt=0,
            )
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("body is not JSON") from exc
        if not isinstance(payload, dict) or "id" not in payload:
            raise WebhookPayloadError("event has no id")
        return InboundWebhook(
            envelope_type="message",
            payload=payload,
            handshake=None,
            external_event_id=str(payload["id"]),
            delivery_attempt=0,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        self.dispatched.append((envelope_type, payload))
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=payload["channel"],
                    channel_type="channel_public",
                    sender_id=payload["user"],
                    sender_name=payload["user"],
                    content=payload["text"],
                    message_ref=str(payload["id"]),
                )
            )
