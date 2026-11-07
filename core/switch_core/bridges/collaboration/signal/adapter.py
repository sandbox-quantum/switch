"""Signal collaboration platform adapter for Switch.

Communicates with a single-account signal-cli JSON-RPC 2.0 daemon over HTTP,
reading inbound events via SSE and sending outbound messages, reactions, edits,
and typing indicators.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlparse

import httpx
from pydantic import field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    AgentIdentity,
    PlatformAdapter,
    RemovalFailed,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelCreationUnsupported,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.signal.chunking import chunk_message
from switch_core.bridges.collaboration.signal.client import (
    ProofRequiredException,
    RateLimitException,
    SignalRpcClient,
    SignalRpcError,
    UntrustedIdentityException,
)

logger = logging.getLogger(__name__)

# Emojis for agent turn status
_REACTION_MAP: dict[ActivityMark, str] = {
    "working": "👀",
    "queued": "⏳",
}

MAX_QUOTE_CACHE: int = 1000
MAX_OUTBOUND_TIMESTAMPS: int = 1000


class SignalConnectionConfig(BridgeConnectionConfig):
    """Configuration for connecting to a local or internal signal-cli daemon."""

    endpoint_url: str
    account: str

    @field_validator("endpoint_url")
    @classmethod
    def validate_endpoint(cls, v: str) -> str:
        s = v.strip()
        parsed = urlparse(s)
        if not parsed.scheme or parsed.scheme not in ("http", "https"):
            raise ValueError("endpoint_url must have http or https scheme")
        if not parsed.netloc:
            raise ValueError("endpoint_url must include a valid host and port")
        return s.rstrip("/")

    @field_validator("account")
    @classmethod
    def validate_account(cls, v: str) -> str:
        val = v.strip()
        if not val:
            raise ValueError("account cannot be empty")
        return val


class SignalAdapter(PlatformAdapter):
    """Switch collaboration adapter for Signal messaging network."""

    display_name: ClassVar[str] = "Signal"
    docs_slug: ClassVar[str | None] = "signal"
    icon_file: ClassVar[str] = "icon.svg"

    receives_webhooks: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True

    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = False
    activity_reactions_per_agent: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = None
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(
        self,
        *,
        config: SignalConnectionConfig,
        client: SignalRpcClient | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self._client = client or SignalRpcClient(config.endpoint_url, config.account)
        self._listen_task: asyncio.Task[None] | None = None
        self._stopped = False
        self._last_event_id: str | None = None
        # Bounded LRU cache of recent messages for quote-reply context: (channel_id, timestamp) -> (author, text)
        self._quote_cache: OrderedDict[tuple[str, int], tuple[str, str | None]] = (
            OrderedDict()
        )
        # Bounded LRU set of outbound message timestamps to filter out reflection / echo
        self._outbound_timestamps: OrderedDict[int, None] = OrderedDict()

    def _cache_quote(
        self, channel_id: str, timestamp: int, author: str, text: str | None
    ) -> None:
        """Store quote metadata in LRU cache, evicting oldest when full."""
        self._quote_cache[(channel_id, timestamp)] = (author, text)
        if len(self._quote_cache) > MAX_QUOTE_CACHE:
            self._quote_cache.popitem(last=False)

    def _record_outbound_timestamp(self, timestamp: int) -> None:
        """Record outbound message timestamp to prevent self-loop echo."""
        self._outbound_timestamps[timestamp] = None
        if len(self._outbound_timestamps) > MAX_OUTBOUND_TIMESTAMPS:
            self._outbound_timestamps.popitem(last=False)

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Prove the daemon is reachable and account is valid before saving."""
        url = connection_config.get("endpoint_url")
        account = connection_config.get("account")
        if not isinstance(url, str) or not url.strip():
            raise BridgeCredentialError("endpoint_url is required")
        if not isinstance(account, str) or not account.strip():
            raise BridgeCredentialError("account is required")

        norm_url = url.strip().rstrip("/")
        norm_account = account.strip()

        client = SignalRpcClient(norm_url, norm_account)
        try:
            try:
                resp = await client._client.get(f"{norm_url}/api/v1/check")
                if resp.status_code != 200:
                    raise BridgeCredentialError(
                        f"Signal daemon health check returned HTTP {resp.status_code}"
                    )
            except httpx.HTTPStatusError as exc:
                raise BridgeCredentialError(
                    f"Signal daemon health check returned HTTP {exc.response.status_code}"
                ) from exc
            except (
                httpx.ConnectError,
                httpx.TimeoutException,
                httpx.NetworkError,
            ) as exc:
                raise BridgeCredentialError(
                    f"Cannot reach Signal daemon at '{norm_url}': {exc}"
                ) from exc

            try:
                await client.list_groups()
            except (UntrustedIdentityException, SignalRpcError) as exc:
                raise BridgeCredentialError(
                    f"Signal account '{norm_account}' error: {exc}"
                ) from exc
        except BridgeCredentialError:
            raise
        except Exception as exc:
            raise BridgeCredentialError(
                f"Signal credential verification failed: {exc}"
            ) from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        """Classify exceptions into telemetry failure reasons."""
        if isinstance(exc, (UntrustedIdentityException, BridgeCredentialError)):
            return "auth_failed"
        if isinstance(exc, (ProofRequiredException, RateLimitException)):
            return "platform_error"
        if isinstance(exc, SignalRpcError):
            if exc.code == -32600 or "unauthorized" in exc.message.lower():
                return "auth_failed"
            return "platform_error"
        if isinstance(
            exc, (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError)
        ):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        """The URLs this connection will call out to."""
        url = connection_config.get("endpoint_url")
        if isinstance(url, str) and url.strip():
            return [url.strip().rstrip("/")]
        return []

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        """Verify daemon connection and start event listener if leaseholder."""
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        # Health check and credentials verification
        is_healthy = await self._client.check_health()
        if not is_healthy:
            raise BridgeCredentialError(
                f"Cannot connect to signal-cli daemon at {self.config.endpoint_url} "
                f"or account '{self.config.account}' is not registered."
            )

        if self._listening:
            self._stopped = False
            self._listen_task = asyncio.create_task(self._listen_loop())

    async def stop(self) -> None:
        """Stop listening task and close client."""
        self._stopped = True
        if self._listen_task and not self._listen_task.done():
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        await self._client.close()

    async def _listen_loop(self) -> None:
        """Resilient SSE event loop with backoff retry."""
        retry_delay = 1.0
        while not self._stopped:
            try:
                async for event_id, payload in self._client.stream_events(
                    self._last_event_id
                ):
                    if self._stopped:
                        break
                    await self._process_event(payload)
                    if event_id:
                        self._last_event_id = event_id
                    retry_delay = 1.0  # Reset delay on successful event receipt
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if self._stopped:
                    break
                logger.warning(
                    "Signal SSE stream error: %s. Retrying in %.1fs...",
                    exc,
                    retry_delay,
                )
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30.0)

    async def _process_event(self, envelope_wrapper: dict[str, Any]) -> None:
        """Handle incoming event payload from signal-cli SSE."""
        envelope = envelope_wrapper.get("envelope") or envelope_wrapper
        source = (
            envelope.get("source")
            or envelope.get("sourceUuid")
            or envelope.get("sourceNumber")
            or "unknown"
        )
        source_name = envelope.get("sourceName") or source

        # Check for standard dataMessage
        data_msg = envelope.get("dataMessage")

        # Check for Note to Self via syncMessage (sent from primary phone)
        is_note_to_self = False
        if not data_msg and "syncMessage" in envelope:
            sent_msg = envelope["syncMessage"].get("sentMessage")
            if sent_msg:
                dest = (
                    sent_msg.get("destination")
                    or sent_msg.get("destinationNumber")
                    or sent_msg.get("destinationUuid")
                )
                if dest == self.config.account or dest == source:
                    data_msg = sent_msg
                    is_note_to_self = True

        if not data_msg:
            return

        text = data_msg.get("message") or ""
        timestamp = int(data_msg.get("timestamp", 0))

        # Filter out echo of our own outbound messages across groups or Note to Self
        if timestamp in self._outbound_timestamps:
            return

        # Regular dataMessage self-message filter
        if not is_note_to_self and source == self.config.account:
            return

        group_info = data_msg.get("groupInfo")
        if group_info and "groupId" in group_info:
            channel_id = f"group:{group_info['groupId']}"
            channel_type: ChannelType = "channel_public"
            conv_key = f"signal:group:{group_info['groupId']}"
        else:
            channel_id = source
            channel_type = "direct"
            conv_key = f"signal:direct:{source}"

        # Deduplication reference
        message_ref = f"{self.config.account}:{conv_key}:{source}:{timestamp}"

        # Store in bounded LRU quote cache
        self._cache_quote(channel_id, timestamp, source, text)

        # Thread root ID from quote if present
        root_id: str | None = None
        quote = data_msg.get("quote")
        if quote and "id" in quote:
            root_id = str(quote["id"])

        # Inbound attachments
        attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []
        raw_attachments = data_msg.get("attachments") or []

        for att in raw_attachments:
            att_id = att.get("id")
            filename = att.get("filename") or f"attachment_{att_id or timestamp}"
            content_type = att.get("contentType") or "application/octet-stream"
            size = att.get("size", 0)

            if size > self._max_attachment_bytes:
                attachment_failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"File exceeds maximum size limit ({self._max_attachment_bytes} bytes)",
                    )
                )
                continue

            if att_id:
                try:
                    group_b64 = group_info.get("groupId") if group_info else None
                    recip = source if not group_b64 else None
                    data_bytes = await self._client.get_attachment(
                        att_id, recipient=recip, group_id=group_b64
                    )
                    attachments.append(
                        Attachment(
                            filename=filename,
                            mimetype=content_type,
                            data=data_bytes,
                        )
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to fetch Signal attachment %s: %s", att_id, exc
                    )
                    attachment_failures.append(
                        AttachmentFailure(filename=filename, reason=str(exc))
                    )

        # Command routing
        stripped = text.strip()
        if stripped.startswith("!") and len(stripped) > 1:
            parts = stripped[1:].split(maxsplit=1)
            command_name = parts[0]
            args = parts[1] if len(parts) > 1 else ""
            if self._on_command:
                inbound_cmd = InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=source,
                    sender_name=source_name,
                    command=command_name,
                    args=args,
                    message_ref=message_ref,
                    root_id=root_id,
                )
                await self._on_command(inbound_cmd)
                return

        if self._on_message:
            inbound_msg = InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=source,
                sender_name=source_name,
                content=text,
                message_ref=message_ref,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=attachment_failures,
            )
            await self._on_message(inbound_msg)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Send message chunks to a recipient or group, returning message ID timestamp."""
        chunks = chunk_message(content)
        last_timestamp: int | None = None

        is_group = channel_id.startswith("group:")
        group_id = channel_id[6:] if is_group else None
        recipient = None if is_group else channel_id

        # Quote parameters if replying
        quote_ts: int | None = None
        quote_author: str | None = None
        quote_msg: str | None = None

        if thread_root_id:
            try:
                target_ts = int(thread_root_id)
                cached = self._quote_cache.get((channel_id, target_ts))
                if cached:
                    quote_ts = target_ts
                    quote_author, quote_msg = cached
                else:
                    quote_ts = target_ts
            except ValueError:
                pass

        for index, chunk in enumerate(chunks):
            # Prefix agent name on messages
            rendered_text = f"[{sender_name}] {chunk}" if sender_name else chunk
            # Quote only first chunk
            q_ts = quote_ts if index == 0 else None
            q_auth = quote_author if index == 0 else None
            q_msg = quote_msg if index == 0 else None

            sent_ts = await self._client.send_message(
                rendered_text,
                recipient=recipient,
                group_id=group_id,
                quote_timestamp=q_ts,
                quote_author=q_auth,
                quote_message=q_msg,
            )
            if sent_ts:
                last_timestamp = sent_ts
                self._record_outbound_timestamp(sent_ts)
                self._cache_quote(
                    channel_id, sent_ts, self.config.account, rendered_text
                )

        return str(last_timestamp) if last_timestamp else None

    async def update_message(
        self,
        channel_id: str,
        message_id: str,
        content: str,
    ) -> None:
        """Edit a message previously sent by the adapter."""
        try:
            edit_ts = int(message_id)
        except ValueError:
            return

        is_group = channel_id.startswith("group:")
        group_id = channel_id[6:] if is_group else None
        recipient = None if is_group else channel_id

        try:
            await self._client.send_message(
                content,
                recipient=recipient,
                group_id=group_id,
                edit_timestamp=edit_ts,
            )
        except Exception as exc:
            logger.warning("Signal message edit failed: %s", exc)
            raise RemovalFailed(f"Could not edit message {message_id}: {exc}") from exc

    async def delete_message(
        self,
        channel_id: str,
        message_id: str,
    ) -> None:
        """Delete a message previously sent by the adapter."""
        try:
            target_ts = int(message_id)
        except ValueError:
            return

        is_group = channel_id.startswith("group:")
        group_id = channel_id[6:] if is_group else None
        recipient = None if is_group else channel_id

        try:
            await self._client.remote_delete(
                target_timestamp=target_ts,
                recipient=recipient,
                group_id=group_id,
            )
        except Exception as exc:
            logger.warning("Signal message delete failed: %s", exc)
            raise RemovalFailed(
                f"Could not delete message {message_id}: {exc}"
            ) from exc

    async def send_typing(
        self,
        channel_id: str,
        sender_name: str,
        is_typing: bool,
    ) -> None:
        """Trigger typing indicator in direct message or group."""
        is_group = channel_id.startswith("group:")
        group_id = channel_id[6:] if is_group else None
        recipient = None if is_group else channel_id

        try:
            await self._client.send_typing(
                recipient=recipient,
                group_id=group_id,
                stop=not is_typing,
            )
        except Exception as exc:
            logger.debug("Signal typing indicator failed: %s", exc)

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        """Update reaction activity indicator on the target message."""
        emoji = _REACTION_MAP.get(mark)
        if not emoji:
            return

        parts = message_ref.split(":")
        target_author: str | None = None
        target_timestamp: int | None = None
        if len(parts) >= 2:
            try:
                target_timestamp = int(parts[-1])
                target_author = parts[-2]
            except (ValueError, IndexError):
                pass

        if not target_timestamp or not target_author:
            return

        is_group = channel_id.startswith("group:")
        group_id = channel_id[6:] if is_group else None
        recipient = None if is_group else channel_id

        try:
            await self._client.send_reaction(
                emoji=emoji,
                target_author=target_author,
                target_timestamp=target_timestamp,
                recipient=recipient,
                group_id=group_id,
                remove=not on,
            )
        except Exception as exc:
            logger.warning(
                "Failed to update Signal reaction %s (on=%s) on %s: %s",
                emoji,
                on,
                message_ref,
                exc,
            )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Signal once that the agent has begun working (ephemeral typing)."""
        await self.send_typing(channel_id, agent_name, True)

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            f"Signal group creation is not supported from Switch. "
            f"Create the group for '{name}' in Signal and add the bot ({self.config.account})."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        """Resolve channel type from identifier format."""
        if channel_id.startswith("group:"):
            return "channel_public"
        return "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Signal group membership cannot be managed directly from Switch.

        Returns all external IDs as failed additions.
        """
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any:
        return []

    def _render_outbound(self, content: str) -> str:
        """Outbound text rendering."""
        return content

    def translate_inbound(self, raw: Any) -> str:
        """Inbound text translation."""
        return str(raw)
