from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, ClassVar, cast

import httpx
from pydantic import Field, field_validator

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.google_chat.auth import (
    GoogleAuthManager,
)
from switch_core.bridges.collaboration.google_chat.cards import (
    render_request_card,
    render_turn_activity_card,
)
from switch_core.bridges.collaboration.google_chat.client import GoogleChatClient
from switch_core.bridges.collaboration.google_chat.consumer import (
    InboundConsumer,
    channel_type_of_space,
)
from switch_core.bridges.collaboration.google_chat.formatting import (
    markdown_to_google_chat,
    split_message_chunks,
)
from switch_core.bridges.collaboration.google_chat.subscriptions import (
    WorkspaceEventsManager,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelRetirement,
    ChannelType,
    CreatedChannel,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)

logger = logging.getLogger(__name__)


class GoogleChatConnectionConfig(BridgeConnectionConfig):
    """Connection configuration for Google Chat collaboration bridge."""

    service_account_json: str = Field(
        ...,
        description="GCP Service Account JSON key string with pubsub.subscriber and chat.bot permissions.",
        json_schema_extra={"format": "password"},
    )
    project_id: str = Field(
        ...,
        description="Google Cloud Project ID.",
    )
    subscription_id: str = Field(
        ...,
        description="Cloud Pub/Sub pull subscription receiving Chat App interaction events and Workspace Events.",
    )
    topic_id: str | None = Field(
        default=None,
        description="Optional Cloud Pub/Sub topic name for Google Workspace Events subscriptions.",
    )
    user_client_id: str | None = Field(
        default=None,
        description="Optional OAuth2 client ID for Workspace Events space subscriptions.",
    )
    user_client_secret: str | None = Field(
        default=None,
        description="Optional OAuth2 client secret for Workspace Events space subscriptions.",
        json_schema_extra={"format": "password"},
    )
    user_refresh_token: str | None = Field(
        default=None,
        description="Optional OAuth2 refresh token for Workspace Events space subscriptions.",
        json_schema_extra={"format": "password"},
    )
    slash_command_map: dict[str, str] | None = Field(
        default=None,
        description="Optional mapping from numeric Google Chat slash command IDs to Switch command names.",
    )
    api_base_url: str | None = Field(
        default=None,
        description="Optional base URL override for Google Chat API (for local simulators/testing).",
    )
    pubsub_base_url: str | None = Field(
        default=None,
        description="Optional base URL override for Cloud Pub/Sub API (for local simulators/testing).",
    )

    @field_validator("service_account_json")
    @classmethod
    def validate_service_account_json(cls, v: str) -> str:
        try:
            data = json.loads(v)
        except Exception as exc:
            raise ValueError(f"service_account_json is not valid JSON: {exc}") from exc

        if not isinstance(data, dict):
            raise ValueError("service_account_json must be a JSON object.")
        if data.get("type") != "service_account":
            raise ValueError("service_account_json 'type' must be 'service_account'.")
        if not data.get("client_email"):
            raise ValueError("service_account_json missing required 'client_email'.")
        if not data.get("private_key"):
            raise ValueError("service_account_json missing required 'private_key'.")
        return v

    @property
    def service_account_dict(self) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.service_account_json))


class GoogleChatAdapter(PlatformAdapter):
    """Collaboration bridge adapter for Google Chat via Cloud Pub/Sub and Workspace Events."""

    display_name: ClassVar[str] = "Google Chat"
    docs_slug: ClassVar[str | None] = "google-chat"
    receives_webhooks: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(self, config: GoogleChatConnectionConfig) -> None:
        super().__init__()
        self.config = config

        self.auth_manager = GoogleAuthManager(
            config.service_account_dict,
            user_client_id=config.user_client_id,
            user_client_secret=config.user_client_secret,
            user_refresh_token=config.user_refresh_token,
        )
        client_kwargs: dict[str, Any] = {}
        if config.api_base_url:
            client_kwargs["chat_api_base"] = config.api_base_url
        if config.pubsub_base_url:
            client_kwargs["pubsub_api_base"] = config.pubsub_base_url

        self.client = GoogleChatClient(self.auth_manager, **client_kwargs)
        self.workspace_events_mgr = WorkspaceEventsManager(
            self.client,
            config.topic_id,
            has_user_oauth=self.auth_manager.has_user_oauth,
        )
        self.consumer = InboundConsumer(
            config.project_id,
            config.subscription_id,
            self.client,
            self.workspace_events_mgr,
            slash_command_map=config.slash_command_map,
            max_attachment_bytes=self._max_attachment_bytes,
        )
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self._tenant_id: str | None = None
        self._bridge_id: str | None = None

    def set_session_factory(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        self._session_factory = session_factory
        self.consumer.session_factory = session_factory

    def set_tenant_id(self, tenant_id: str) -> None:
        self._tenant_id = tenant_id
        self.consumer.tenant_id = tenant_id

    def set_bridge_id(self, bridge_id: str) -> None:
        self._bridge_id = bridge_id
        self.consumer.bridge_id = bridge_id

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """(Re)establish Workspace Events subscriptions for the given channels on startup."""
        if not self._listening:
            return
        for channel_id, _channel_type in channels:
            space_name = self.client._normalize_space_name(channel_id)
            await self.workspace_events_mgr.ensure_space_subscription(space_name)

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Verify Service Account parsing, token minting, Pub/Sub subscription access, and Chat API reachability."""
        config = GoogleChatConnectionConfig.model_validate(connection_config)
        auth = GoogleAuthManager(
            config.service_account_dict,
            user_client_id=config.user_client_id,
            user_client_secret=config.user_client_secret,
            user_refresh_token=config.user_refresh_token,
        )
        auth.validate_service_account_structure()

        client_kwargs: dict[str, Any] = {}
        if config.api_base_url:
            client_kwargs["chat_api_base"] = config.api_base_url
        if config.pubsub_base_url:
            client_kwargs["pubsub_api_base"] = config.pubsub_base_url

        async with httpx.AsyncClient(timeout=30.0) as http_client:
            client = GoogleChatClient(auth, http_client=http_client, **client_kwargs)
            # 1. Verify token minting
            await auth.get_service_account_token()

            # 2. Verify Pub/Sub subscription accessibility
            await client.get_subscription(config.project_id, config.subscription_id)

            # 3. Verify Google Chat API reachable
            try:
                await client.list_spaces()
            except BridgeCredentialError:
                raise
            except Exception as exc:
                raise BridgeCredentialError(
                    f"Google Chat API check failed. Verify Chat API is enabled in project {config.project_id}: {exc}"
                ) from exc

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, BridgeCredentialError):
            return "auth_failed"
        if isinstance(exc, (httpx.ConnectError, httpx.TimeoutException)):
            return "network"
        if isinstance(exc, BridgeOperationError):
            return "platform_error"
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
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        self.consumer.max_attachment_bytes = self._max_attachment_bytes
        self.consumer.set_callbacks(
            on_message=on_message,
            on_command=on_command,
            on_agent_joined=on_agent_joined,
            on_user_joined=on_user_joined,
            on_app_joined=on_app_joined,
            on_interaction=self._on_interaction,
        )

        # Multi-pod lease safety: Only pull and renew when holding lease!
        if self._listening:
            logger.info(
                "Lease-holding pod starting Google Chat Pub/Sub consumer and Workspace Events renewal."
            )
            self.consumer.start()
            self.workspace_events_mgr.start()
        else:
            logger.info(
                "Quiet pod running Google Chat adapter in API-only mode without listeners."
            )

    async def stop(self) -> None:
        logger.info("Stopping Google Chat adapter.")
        await self.consumer.stop()
        await self.workspace_events_mgr.stop()
        await self.client.aclose()

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        # Outbound Agent Presentation: prefix agent's name cleanly
        body_text = content
        if sender_name:
            body_text = f"*{sender_name}*: {content}"

        formatted = self._render_outbound(body_text)
        chunks = split_message_chunks(formatted)
        first_ref: str | None = None

        for chunk in chunks:
            res = await self.client.create_message(
                space_id=channel_id,
                text=chunk,
                thread_name=thread_root_id,
            )
            msg_name = res.get("name")
            if first_ref is None and msg_name:
                first_ref = msg_name

        return first_ref

    async def update_message(
        self,
        channel_id: str,
        message_ref: str,
        new_content: str,
    ) -> None:
        formatted = self._render_outbound(new_content)
        await self.client.patch_message(
            message_name=message_ref,
            text=formatted,
            update_mask="text",
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self.client.delete_message(message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Google Chat REST API does not support bot typing indicators; no-op
        pass

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        card: dict[str, Any]
        if isinstance(content, TurnActivity):
            card = render_turn_activity_card(content, agent_name)
        elif isinstance(content, RequestCard):
            card = render_request_card(content, agent_name)
        else:
            raise ValueError(f"Unknown RichContent type: {type(content)}")

        try:
            res = await self.client.create_message(
                space_id=channel_id,
                cards_v2=[card],
                thread_name=thread_root_id,
            )
            msg_ref = res.get("name")
            if not msg_ref:
                raise RichContentFailed(
                    f"Google Chat create_message returned no message name in space {channel_id}",
                    text=self.rich_fallback_text(content),
                )
            return str(msg_ref)
        except Exception as exc:
            raise RichContentFailed(
                f"Google Chat refused rich post in space {channel_id}: {exc}",
                text=self.rich_fallback_text(content),
            ) from exc

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        card: dict[str, Any]
        if isinstance(content, TurnActivity):
            card = render_turn_activity_card(content, agent_name)
        elif isinstance(content, RequestCard):
            card = render_request_card(content, agent_name)
        else:
            raise ValueError(f"Unknown RichContent type: {type(content)}")

        try:
            await self.client.patch_message(
                message_name=message_ref,
                cards_v2=[card],
                update_mask="cards_v2",
            )
        except Exception as exc:
            raise RichContentFailed(
                f"Google Chat refused rich update for {message_ref}: {exc}",
                text=self.rich_fallback_text(content),
            ) from exc

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        raise ChannelCreationUnsupported(
            "Google Chat app-authenticated bot cannot create spaces directly."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        space = await self.client.get_space(channel_id)
        return channel_type_of_space(space) or "channel_public"

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
        return []

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, identity: AgentIdentity) -> None:
        pass

    async def remove_agent_identity(self, identity: AgentIdentity) -> None:
        pass

    async def retire_channel(self, channel_id: str) -> RetireOutcome:
        try:
            await self.client.leave_space(channel_id)
            return RetireOutcome(outcome="left")
        except Exception as exc:
            return RetireOutcome.failed(f"Failed to leave Google Chat space: {exc}")

    def translate_inbound(self, text: str) -> str:
        return text

    def _render_outbound(self, text: str) -> str:
        return markdown_to_google_chat(text)
