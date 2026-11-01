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
from switch_core.bridges.collaboration.rocketchat.chunking import (
    split_rocketchat_message,
)

logger = logging.getLogger(__name__)


class RocketChatConnectionConfig(BridgeConnectionConfig):
    """Configuration for self-created Rocket.Chat bot integration."""

    server_url: str = Field(
        ...,
        description="The base URL of your Rocket.Chat server (e.g. https://chat.example.com).",
    )
    user_id: str = Field(
        ...,
        description="The bot user ID on Rocket.Chat (from Administration -> Users).",
    )
    auth_token: str = Field(
        ...,
        description="Personal access token generated for the bot user.",
    )
    max_attachment_size_bytes: int = Field(
        default=25 * 1024 * 1024,
        description="Maximum file upload/download size in bytes (default 25MB).",
    )

    @field_validator("server_url")
    @classmethod
    def _normalize_server_url(cls, v: str) -> str:
        url = v.strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise ValueError("server_url must start with http:// or https://")
        return url


class RocketChatAdapter(PlatformAdapter):
    """Rocket.Chat collaboration bridge adapter.

    Connects via WebSocket Realtime API for ingress and REST API for egress.
    Channels map to Switch rooms, and threads (tmid) map to Switch threads.
    """

    display_name: ClassVar[str] = "Rocket.Chat"
    docs_slug: ClassVar[str | None] = "rocketchat"
    receives_webhooks: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = True
    channel_on_delete: ClassVar[ChannelRetirement] = "archived"

    def __init__(self, config: RocketChatConnectionConfig, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.config = config
        self._headers = {
            "X-User-Id": config.user_id,
            "X-Auth-Token": config.auth_token,
            "Content-Type": "application/json",
        }
        self._base_api = f"{config.server_url}/api/v1"
        self._running = False
        self._http_client: httpx.AsyncClient | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._last_sync_timestamp: str | None = None

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
            cfg = RocketChatConnectionConfig.model_validate(connection_config)
            host = urllib.parse.urlparse(cfg.server_url).netloc.lower()
            return f"rocketchat:{host}:{cfg.user_id.lower()}"
        except Exception:
            return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Call GET /api/v1/me to verify credentials and ensure account is active."""
        try:
            cfg = RocketChatConnectionConfig.model_validate(connection_config)
            url = f"{cfg.server_url}/api/v1/me"
            headers = {
                "X-User-Id": cfg.user_id,
                "X-Auth-Token": cfg.auth_token,
            }
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.get(url, headers=headers)
                if res.status_code == 401:
                    raise BridgeCredentialError("Invalid user_id or auth_token")
                if res.status_code != 200:
                    raise BridgeCredentialError(
                        f"Rocket.Chat credential verification failed ({res.status_code}): {res.text}"
                    )
                data = res.json()
                if not data.get("active", True):
                    raise BridgeCredentialError(
                        "Rocket.Chat bot user account is deactivated"
                    )
        except BridgeCredentialError:
            raise
        except Exception as exc:
            raise BridgeCredentialError(
                f"Could not connect to Rocket.Chat server: {exc}"
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

    async def _poll_loop(self) -> None:
        """Poll syncMessages periodically when holding the lease."""
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        while self._running and self._listening:
            try:
                # We query rooms the bot is member of via /api/v1/rooms.get
                url = f"{self._base_api}/rooms.get"
                res = await client.get(url, headers=self._headers, timeout=20.0)
                if res.status_code == 200:
                    rooms = res.json().get("update", [])
                    for r in rooms:
                        rid = r.get("_id")
                        if rid:
                            await self._sync_room_messages(client, rid)
                await asyncio.sleep(5.0)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Rocket.Chat poll transient error: %s", exc)
                await asyncio.sleep(5.0)

    async def _sync_room_messages(self, client: httpx.AsyncClient, rid: str) -> None:
        params: dict[str, str] = {"roomId": rid}
        if self._last_sync_timestamp:
            params["lastUpdate"] = self._last_sync_timestamp
        url = f"{self._base_api}/chat.syncMessages"
        try:
            res = await client.get(
                url, params=params, headers=self._headers, timeout=20.0
            )
            if res.status_code == 200:
                data = res.json()
                for msg in data.get("result", {}).get("updated", []):
                    await self._process_message(msg)
        except Exception as exc:
            logger.debug("Error syncing room %s: %s", rid, exc)

    async def _process_message(self, msg: dict[str, Any]) -> None:
        sender_id = msg.get("u", {}).get("_id", "")
        if sender_id == self.config.user_id:
            return  # Suppress self-echo

        rid = msg.get("rid", "")
        msg_id = msg.get("_id", "")
        text = msg.get("msg", "").strip()
        tmid = msg.get("tmid")  # thread message id
        sender_name = msg.get("u", {}).get("name") or msg.get("u", {}).get(
            "username", "User"
        )

        if text.startswith("!"):
            parts = text[1:].split(maxsplit=1)
            cmd = parts[0]
            args = parts[1] if len(parts) > 1 else ""
            if self._on_command:
                await self._on_command(
                    InboundCommand(
                        channel_id=rid,
                        channel_type="channel_public",
                        sender_id=sender_id,
                        sender_name=sender_name,
                        command=cmd,
                        args=args,
                        message_ref=msg_id,
                        root_id=tmid,
                    )
                )
            return

        if self._on_message:
            await self._on_message(
                InboundMessage(
                    channel_id=rid,
                    channel_type="channel_public",
                    sender_id=sender_id,
                    sender_name=sender_name,
                    content=text,
                    message_ref=msg_id,
                    root_id=tmid,
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
        header = f"*{agent.body_label}*:\n" if sender_name else ""
        formatted = self.translate_outbound(content)
        full_text = f"{header}{formatted}"

        chunks = split_rocketchat_message(full_text)
        last_ref: str | None = None
        for chunk in chunks:
            last_ref = await self._send_chunk(channel_id, chunk, thread_root_id)
        return last_ref

    async def _send_chunk(self, rid: str, text: str, tmid: str | None) -> str | None:
        url = f"{self._base_api}/chat.postMessage"
        payload: dict[str, Any] = {
            "roomId": rid,
            "text": text,
        }
        if tmid:
            payload["tmid"] = tmid

        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        try:
            res = await client.post(url, json=payload, headers=self._headers)
            if res.status_code == 200:
                return str(res.json().get("message", {}).get("_id", ""))
            logger.error(
                "Rocket.Chat send_message failed (%s): %s", res.status_code, res.text
            )
            return None
        except Exception as exc:
            logger.error("Rocket.Chat send_message exception: %s", exc)
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
        url = f"{self._base_api}/chat.update"
        payload = {
            "roomId": channel_id,
            "msgId": message_ref,
            "text": self.translate_outbound(new_content),
        }
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        await client.post(url, json=payload, headers=self._headers)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        url = f"{self._base_api}/chat.delete"
        payload = {
            "roomId": channel_id,
            "msgId": message_ref,
        }
        client = self._http_client or httpx.AsyncClient(timeout=30.0)
        await client.post(url, json=payload, headers=self._headers)

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
            "Rocket.Chat bot cannot provision new channels directly."
        )
