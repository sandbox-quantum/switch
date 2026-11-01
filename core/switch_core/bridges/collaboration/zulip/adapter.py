from __future__ import annotations

import asyncio
import logging
import urllib.parse
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ChannelCreationUnsupported,
    ChannelRetirement,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.zulip.chunking import split_zulip_message

logger = logging.getLogger(__name__)


class ZulipConnectionConfig(BridgeConnectionConfig):
    """Configuration for self-created Zulip generic bot integration."""

    site_url: str = Field(
        ...,
        description="The base URL of your Zulip organization (e.g. https://zulip.example.com).",
    )
    bot_email: str = Field(
        ...,
        description="The bot's email address created in Zulip organization settings.",
    )
    api_key: str = Field(
        ...,
        description="The bot's API key generated in Zulip organization settings.",
    )
    max_attachment_size_bytes: int = Field(
        default=25 * 1024 * 1024,
        description="Maximum file upload/download size in bytes (default 25MB).",
    )

    @field_validator("site_url")
    @classmethod
    def _normalize_site_url(cls, v: str) -> str:
        url = v.strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise ValueError("site_url must start with http:// or https://")
        return url

    @field_validator("bot_email")
    @classmethod
    def _validate_bot_email(cls, v: str) -> str:
        email = v.strip().lower()
        if "@" not in email:
            raise ValueError("bot_email must be a valid email address")
        return email


class ZulipAdapter(PlatformAdapter):
    """Zulip collaboration bridge adapter.

    Maps Zulip streams to Switch rooms, and topics within streams to Switch threads.
    Connects via Zulip event queue API long-polling on the lease holder.
    """

    display_name: ClassVar[str] = "Zulip"
    docs_slug: ClassVar[str | None] = "zulip"
    receives_webhooks: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = True
    channel_on_delete: ClassVar[ChannelRetirement] = "kept"

    def __init__(self, config: ZulipConnectionConfig, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.config = config
        self._auth = (config.bot_email, config.api_key)
        self._base_api = f"{config.site_url}/api/v1"
        self._running = False
        self._poll_task: asyncio.Task[None] | None = None
        self._http_client: httpx.AsyncClient | None = None
        self._queue_id: str | None = None
        self._last_event_id: int = -1

        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self._on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        try:
            cfg = ZulipConnectionConfig.model_validate(connection_config)
            site = urllib.parse.urlparse(cfg.site_url).netloc.lower()
            return f"zulip:{site}:{cfg.bot_email.lower()}"
        except Exception:
            return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Call GET /api/v1/users/me to check credentials and bot status."""
        try:
            cfg = ZulipConnectionConfig.model_validate(connection_config)
            url = f"{cfg.site_url}/api/v1/users/me"
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.get(url, auth=(cfg.bot_email, cfg.api_key))
                if res.status_code == 401:
                    raise BridgeCredentialError(
                        "Invalid bot_email or api_key for Zulip"
                    )
                if res.status_code != 200:
                    raise BridgeCredentialError(
                        f"Zulip credentials verification failed ({res.status_code}): {res.text}"
                    )
                data = res.json()
                if not data.get("is_active", True):
                    raise BridgeCredentialError("Zulip bot account is deactivated")
        except BridgeCredentialError:
            raise
        except Exception as exc:
            raise BridgeCredentialError(
                f"Could not connect to Zulip organization: {exc}"
            ) from exc

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
        self._running = True
        self._http_client = httpx.AsyncClient(timeout=60.0)

        if self._listening:
            self._start_poller()

    async def stop(self) -> None:
        self._running = False
        self._stop_poller()
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    def set_listening(self, listening: bool) -> None:
        super().set_listening(listening)
        if not self._running:
            return
        if listening and (self._poll_task is None or self._poll_task.done()):
            self._start_poller()
        elif not listening and self._poll_task is not None:
            self._stop_poller()

    def _start_poller(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_loop())

    def _stop_poller(self) -> None:
        if self._poll_task is not None and not self._poll_task.done():
            self._poll_task.cancel()
            self._poll_task = None

    async def _register_queue(self, client: httpx.AsyncClient) -> bool:
        """Register a new event queue for messages."""
        url = f"{self._base_api}/register"
        data = {
            "event_types": '["message", "subscription"]',
            "apply_markdown": "false",
        }
        try:
            res = await client.post(url, data=data, auth=self._auth)
            if res.status_code == 200:
                payload = res.json()
                self._queue_id = payload.get("queue_id")
                self._last_event_id = payload.get("last_event_id", -1)
                return True
            logger.warning("Failed to register Zulip event queue: %s", res.text)
            return False
        except Exception as exc:
            logger.warning("Exception registering Zulip event queue: %s", exc)
            return False

    async def _poll_loop(self) -> None:
        """Long poll the Zulip events endpoint."""
        client = self._http_client or httpx.AsyncClient(timeout=60.0)
        while self._running and self._listening:
            try:
                if not self._queue_id:
                    ok = await self._register_queue(client)
                    if not ok:
                        await asyncio.sleep(5.0)
                        continue

                url = f"{self._base_api}/events"
                params = {
                    "queue_id": self._queue_id,
                    "last_event_id": str(self._last_event_id),
                    "dont_block": "false",
                }
                res = await client.get(
                    url, params=params, auth=self._auth, timeout=50.0
                )
                if res.status_code == 400 and "BAD_EVENT_QUEUE_ID" in res.text:
                    self._queue_id = None
                    continue

                if res.status_code == 200:
                    data = res.json()
                    events = data.get("events", [])
                    for ev in events:
                        ev_id = ev.get("id")
                        if ev_id is not None and ev_id > self._last_event_id:
                            self._last_event_id = ev_id
                        await self._process_event(ev)
                else:
                    await asyncio.sleep(2.0)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Zulip poll loop transient error: %s", exc)
                await asyncio.sleep(2.0)

    async def _process_event(self, ev: dict[str, Any]) -> None:
        ev_type = ev.get("type")
        if ev_type == "message":
            msg = ev.get("message", {})
            sender_email = msg.get("sender_email", "").lower()
            if sender_email == self.config.bot_email.lower():
                return  # Skip self-echoes

            content = msg.get("content", "").strip()
            stream_name = msg.get("display_recipient")
            if not isinstance(stream_name, str):
                # Direct message or group PM: fallback string
                stream_name = "direct-messages"

            topic = msg.get("subject", "").strip()
            msg_id = str(msg.get("id", ""))
            sender_id = str(msg.get("sender_id", ""))
            sender_name = msg.get("sender_full_name") or sender_email

            if content.startswith("!"):
                parts = content[1:].split(maxsplit=1)
                cmd = parts[0]
                args = parts[1] if len(parts) > 1 else ""
                if self._on_command:
                    await self._on_command(
                        InboundCommand(
                            channel_id=stream_name,
                            channel_type="channel_public",
                            sender_id=sender_id,
                            sender_name=sender_name,
                            command=cmd,
                            args=args,
                            message_ref=msg_id,
                            root_id=topic if topic else None,
                        )
                    )
                return

            if self._on_message:
                await self._on_message(
                    InboundMessage(
                        channel_id=stream_name,
                        channel_type="channel_public",
                        sender_id=sender_id,
                        sender_name=sender_name,
                        content=content,
                        message_ref=msg_id,
                        root_id=topic if topic else None,
                    )
                )

    # ── Outbound Messaging ────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        agent = await self.agent_rendering(sender_name)
        header = f"**{agent.body_label}**:\n" if sender_name else ""
        formatted_content = self.translate_outbound(content)
        full_text = f"{header}{formatted_content}"

        chunks = split_zulip_message(full_text)
        last_ref: str | None = None
        for chunk in chunks:
            last_ref = await self._send_chunk(channel_id, chunk, thread_root_id)
        return last_ref

    async def _send_chunk(
        self, stream_name: str, content: str, topic: str | None
    ) -> str | None:
        url = f"{self._base_api}/messages"
        data = {
            "type": "stream",
            "to": stream_name,
            "topic": topic or "general",
            "content": content,
        }
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        try:
            res = await client.post(url, data=data, auth=self._auth)
            if res.status_code == 200:
                return str(res.json().get("id", ""))
            logger.error(
                "Zulip send_message failed (%s): %s", res.status_code, res.text
            )
            return None
        except Exception as exc:
            logger.error("Zulip send_message exception: %s", exc)
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
        notice = f"[Attachment: {filename} ({len(data)} bytes)]"
        if caption:
            notice = f"{caption}\n{notice}"
        return await self.send_message(
            channel_id=channel_id,
            sender_name=sender_name,
            content=notice,
            thread_root_id=thread_root_id,
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        url = f"{self._base_api}/messages/{message_ref}"
        data = {"content": self.translate_outbound(new_content)}
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        await client.patch(url, data=data, auth=self._auth)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        url = f"{self._base_api}/messages/{message_ref}"
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        await client.delete(url, auth=self._auth)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        pass

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

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
        return user_external_ids

    async def create_agent_identity(self, agent: Any) -> None:
        pass

    async def remove_agent_identity(self, agent: Any) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Zulip bot cannot provision new streams directly. Please create the stream in Zulip and subscribe the bot."
        )
