"""Signal collaboration bridge adapter.

Signal groups are bridged through the signal-cli JSON-RPC HTTP daemon.
Inbound events arrive on the daemon's SSE stream; outbound messages are
JSON-RPC ``send`` calls. Signal has no native threads, so a reply in Switch
is a Signal quote-reply, and no markdown, so outbound bodies are rendered
as plain text.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import mimetypes
import re
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, override
from urllib.parse import urlparse

import httpx
from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import Markup

logger = logging.getLogger(__name__)


_PHONE_RE = re.compile(r"^\+\d{5,15}$")
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class SignalRpcError(RuntimeError):
    """An error the signal-cli daemon answered a JSON-RPC call with."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class SignalConnectionConfig(BridgeConnectionConfig):
    """Configuration for a Signal bridge connection."""

    daemon_url: str = Field(
        description="The signal-cli HTTP daemon base URL (e.g. http://localhost:8080)"
    )
    account: str = Field(
        description="The registered Signal account (phone number in +E.164 "
        "format or ACI UUID)"
    )
    username: str | None = Field(
        default=None,
        description="Optional HTTP Basic auth username for the daemon endpoint",
    )
    password: str | None = Field(
        default=None,
        description="Optional HTTP Basic auth password for the daemon endpoint",
    )

    @field_validator("daemon_url")
    @classmethod
    def _validate_daemon_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("daemon_url is required")
        parsed = urlparse(v)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("daemon_url must use http or https scheme")
        if not parsed.netloc:
            raise ValueError("daemon_url must have a valid hostname")
        return v.rstrip("/")

    @field_validator("account")
    @classmethod
    def _validate_account(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("account is required")
        if " " in v:
            raise ValueError("account must not contain whitespace")
        if v.startswith("+"):
            if not _PHONE_RE.match(v):
                raise ValueError(
                    "phone number must be in +E.164 format (e.g. +1234567890)"
                )
        elif not _UUID_RE.match(v):
            raise ValueError(
                "account must be a phone number in +E.164 format or an ACI UUID"
            )
        return v

    @model_validator(mode="after")
    def _validate_auth(self) -> SignalConnectionConfig:
        if (self.username is None) != (self.password is None):
            raise ValueError(
                "username and password must be provided together or both omitted"
            )
        return self


class _PlainMarkup(Markup):
    """Signal renders no emphasis, so a card's marks are dropped, not drawn."""

    def bold(self, text: str) -> str:
        return text

    def code(self, text: str) -> str:
        return text

    def command(self, text: str) -> str:
        return text


_SIGNAL_MARKUP = _PlainMarkup()


class SignalAdapter(PlatformAdapter):
    """Signal groups bridged via the signal-cli JSON-RPC HTTP daemon.

    Groups only: 1:1 direct messages are not bridged, and groups are
    adopted on their first message rather than created from Switch.
    """

    display_name: ClassVar[str] = "Signal"
    docs_slug: ClassVar[str | None] = "signal"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    channel_on_delete = "kept"
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    notifies_only_by_mention: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    redraws_for_elapsed_time: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    supports_queue_reaction: ClassVar[bool] = False
    activity_reactions_per_agent: ClassVar[bool] = False
    recovers_uncertain_posts: ClassVar[bool] = False
    carries_publication_marker: ClassVar[bool] = False
    discloses_unconfirmed_posts: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = None

    def __init__(
        self,
        *,
        config: SignalConnectionConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._last_event_id: str | None = None
        self._seen_messages: OrderedDict[str, None] = OrderedDict()
        self._quoted_text_cache: OrderedDict[str, str] = OrderedDict()
        self._quoted_text_capacity = 500
        self._sse_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._multi_account = False
        self._max_sse_backoff = 30.0

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.ConnectError | httpx.TimeoutException):
            return "network"
        if isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in (401, 403):
                return "auth_failed"
            if exc.response.status_code == 404:
                return "config_invalid"
            return "platform_error"
        if isinstance(exc, SignalRpcError):
            if exc.code == -32602:
                return "config_invalid"
            return "platform_error"
        if isinstance(exc, json.JSONDecodeError):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        config = SignalConnectionConfig.model_validate(connection_config)
        return f"Signal account {config.account}"

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        config = SignalConnectionConfig.model_validate(connection_config)
        return f"signal:{config.account}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = SignalConnectionConfig.model_validate(connection_config)
        return [config.daemon_url]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SignalConnectionConfig.model_validate(connection_config)
        base_url = config.daemon_url.rstrip("/")
        auth = None
        if config.username and config.password:
            auth = httpx.BasicAuth(config.username, config.password)

        async with httpx.AsyncClient(
            timeout=15.0, trust_env=False, auth=auth
        ) as client:
            try:
                resp = await client.get(f"{base_url}/api/v1/check")
            except httpx.ConnectError as e:
                raise BridgeCredentialError(
                    f"Could not reach the signal-cli daemon at {base_url}: {e}"
                ) from e
            except httpx.TimeoutException as e:
                raise BridgeCredentialError(
                    f"Timed out connecting to the signal-cli daemon at {base_url}: {e}"
                ) from e

            if resp.status_code in (401, 403):
                raise BridgeCredentialError(
                    f"The signal-cli daemon at {base_url} rejected the credentials "
                    f"(HTTP {resp.status_code}). Check proxy authentication."
                )
            if resp.status_code != 200:
                raise BridgeCredentialError(
                    f"The signal-cli daemon at {base_url} answered "
                    f"HTTP {resp.status_code} on its health check endpoint"
                )

            accounts = await cls._rpc_result(client, base_url, "listAccounts", {})
            if accounts is None:
                return
            if not isinstance(accounts, list):
                raise BridgeCredentialError(
                    f"The signal-cli daemon at {base_url} answered listAccounts "
                    "with an unexpected response"
                )
            for entry in accounts:
                if not isinstance(entry, dict):
                    continue
                number = entry.get("number")
                aci = entry.get("aci")
                if cls._same_account(config.account, number or aci or ""):
                    return
            available = ", ".join(
                str(entry.get("number") or entry.get("aci") or "?")
                for entry in accounts
                if isinstance(entry, dict)
            )
            raise BridgeCredentialError(
                f"Account {config.account!r} is not registered on the "
                f"signal-cli daemon at {base_url}; registered accounts: {available}"
            )

    @staticmethod
    async def _rpc_result(
        client: httpx.AsyncClient,
        base_url: str,
        method: str,
        params: dict[str, Any],
    ) -> Any:
        """One JSON-RPC call for `verify_credentials`.

        Returns the result, or None in single-account mode, where the
        daemon answers ``listAccounts`` with METHOD_NOT_FOUND because it
        has no account list to check against.
        """
        try:
            resp = await client.post(
                f"{base_url}/api/v1/rpc",
                json={
                    "jsonrpc": "2.0",
                    "id": "verify",
                    "method": method,
                    "params": params,
                },
                timeout=15.0,
            )
        except httpx.ConnectError as e:
            raise BridgeCredentialError(
                f"Could not reach the signal-cli daemon at {base_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            raise BridgeCredentialError(
                f"Timed out connecting to the signal-cli daemon at {base_url}: {e}"
            ) from e

        if resp.status_code in (401, 403):
            raise BridgeCredentialError(
                f"The signal-cli daemon at {base_url} rejected the credentials "
                f"(HTTP {resp.status_code}). Check proxy authentication."
            )

        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError) as e:
            raise BridgeCredentialError(
                f"The signal-cli daemon at {base_url} answered with an "
                f"unparseable response: {e}"
            ) from e

        error = data.get("error") if isinstance(data, dict) else None
        if error:
            code = error.get("code")
            message = error.get("message", "unknown error")
            if code == -32601:
                return None
            if code == -32602:
                raise BridgeCredentialError(
                    f"The signal-cli daemon at {base_url} rejected the account: "
                    f"{message}"
                )
            raise BridgeCredentialError(
                f"The signal-cli daemon at {base_url} rejected the account: {message}"
            )
        if resp.status_code != 200:
            raise BridgeCredentialError(
                f"Could not verify the Signal account at {base_url}: "
                f"HTTP {resp.status_code}"
            )
        return data.get("result") if isinstance(data, dict) else None

    @staticmethod
    def _same_account(a: str, b: str) -> bool:
        a, b = a.strip(), b.strip()
        if a.casefold() == b.casefold():
            return True
        if a.startswith("+") and b.startswith("+"):
            return re.sub(r"\D", "", a) == re.sub(r"\D", "", b)
        return a.casefold() == b.casefold()

    # -- Lifecycle -----------------------------------------------------

    @override
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

        if not self._listening:
            logger.info("Signal adapter started in quiet mode (no SSE listener)")
            return

        await self._probe_daemon_mode()
        self._stop_event.clear()
        self._sse_task = asyncio.create_task(self._sse_loop())
        logger.info("Signal adapter started with SSE listener")

    @override
    async def stop(self) -> None:
        self._stop_event.set()
        if self._sse_task is not None:
            self._sse_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sse_task
            self._sse_task = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _probe_daemon_mode(self) -> None:
        try:
            accounts = await self._rpc("listAccounts", {})
        except SignalRpcError as e:
            if e.code == -32601:
                logger.info("Signal daemon running in single-account mode")
                self._multi_account = False
                return
            raise
        self._multi_account = True
        if isinstance(accounts, list):
            for entry in accounts:
                if not isinstance(entry, dict):
                    continue
                number = entry.get("number")
                aci = entry.get("aci")
                if self._same_account(self._config.account, number or aci or ""):
                    return
            available = ", ".join(
                str(entry.get("number") or entry.get("aci") or "?")
                for entry in accounts
                if isinstance(entry, dict)
            )
            raise BridgeCredentialError(
                f"Account {self._config.account!r} is not registered on the "
                f"daemon at {self._config.daemon_url}; registered accounts: "
                f"{available}"
            )

    # -- Daemon transport ----------------------------------------------

    async def _rpc(self, method: str, params: dict[str, Any]) -> Any:
        url = self._config.daemon_url.rstrip("/") + "/api/v1/rpc"
        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": method,
            "params": {**params, "account": self._config.account},
        }
        client = await self._get_client()
        resp = await client.post(url, json=payload, timeout=30.0)
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError):
            resp.raise_for_status()
            raise
        if isinstance(data, dict) and data.get("error"):
            error = data["error"]
            raise SignalRpcError(
                error.get("code", 0), error.get("message", "Unknown RPC error")
            )
        resp.raise_for_status()
        return data.get("result") if isinstance(data, dict) else None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            auth = None
            if self._config.username and self._config.password:
                auth = httpx.BasicAuth(self._config.username, self._config.password)
            transport = self._transport
            if transport is None:
                transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False)
            self._client = httpx.AsyncClient(
                transport=transport,
                auth=auth,
                timeout=httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=10.0),
                follow_redirects=False,
            )
        return self._client

    # -- Inbound: SSE loop ----------------------------------------------

    async def _sse_loop(self) -> None:
        backoff = 1.0
        while not self._stop_event.is_set():
            headers = {"Accept": "text/event-stream"}
            if self._last_event_id:
                headers["Last-Event-ID"] = self._last_event_id
            try:
                client = await self._get_client()
                async with client.stream(
                    "GET",
                    self._config.daemon_url.rstrip("/") + "/api/v1/events",
                    headers=headers,
                    timeout=httpx.Timeout(connect=10.0, read=300.0),
                ) as resp:
                    resp.raise_for_status()
                    backoff = 1.0
                    event_id: str | None = None
                    event_type: str | None = None
                    data_lines: list[str] = []
                    async for line in resp.aiter_lines():
                        if self._stop_event.is_set():
                            return
                        line = line.rstrip("\n")
                        if not line:
                            if data_lines and event_type == "receive":
                                try:
                                    await self._handle_sse_data("\n".join(data_lines))
                                except Exception:
                                    logger.exception("Error handling SSE event")
                            event_id = None
                            event_type = None
                            data_lines = []
                        elif line.startswith("id:"):
                            event_id = line[3:].strip()
                        elif line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            data_lines.append(line[5:].strip())
                        if event_id:
                            self._last_event_id = event_id
            except asyncio.CancelledError:
                raise
            except httpx.HTTPStatusError as e:
                if e.response.status_code in (401, 403):
                    logger.error(
                        "Signal SSE stream rejected (HTTP %d): credentials "
                        "rejected by daemon or proxy",
                        e.response.status_code,
                    )
                else:
                    logger.warning(
                        "Signal SSE stream HTTP error %d: %s",
                        e.response.status_code,
                        e,
                    )
            except httpx.TimeoutException:
                logger.warning("Signal SSE stream read timeout, reconnecting")
            except httpx.ConnectError as e:
                logger.warning("Signal SSE connection error: %s", e)
            except Exception:
                logger.exception("Unexpected error in Signal SSE loop")

            if self._stop_event.is_set():
                break
            logger.info("Signal SSE disconnected, reconnecting in %.1fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_sse_backoff)

    async def _handle_sse_data(self, data: str) -> None:
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            logger.warning("Invalid JSON in SSE data: %s", data[:100])
            return
        if "exception" in payload:
            logger.warning("Signal SSE exception: %s", payload["exception"])
            return
        envelope = payload.get("envelope")
        if not envelope:
            logger.debug("SSE event missing envelope: %s", payload)
            return
        event_account = payload.get("account")
        if (
            self._multi_account
            and event_account
            and not self._same_account(event_account, self._config.account)
        ):
            logger.debug(
                "Dropping event for different account: %s (ours: %s)",
                event_account,
                self._config.account,
            )
            return
        await self._process_envelope(envelope)

    async def _process_envelope(self, envelope: dict[str, Any]) -> None:
        data = envelope.get("dataMessage")
        if data is None:
            return
        if (
            data.get("reaction") is not None
            or data.get("remoteDelete") is not None
            or data.get("isExpirationUpdate")
        ):
            return

        group = data.get("groupInfo")
        if not group:
            logger.debug("Dropping direct message (groups only bridging)")
            return
        group_id = group.get("groupId")
        if not group_id:
            return

        source = (
            envelope.get("sourceUuid")
            or envelope.get("sourceNumber")
            or envelope.get("source")
        )
        if source and self._same_account(source, self._config.account):
            return

        timestamp = data.get("timestamp")
        if not timestamp:
            logger.warning("Message missing timestamp, skipping")
            return

        author = (
            envelope.get("sourceUuid")
            or envelope.get("sourceNumber")
            or envelope.get("source")
            or "unknown"
        )
        message_ref = f"{group_id}:{timestamp}:{author}"
        if message_ref in self._seen_messages:
            return
        self._seen_messages[message_ref] = None
        if len(self._seen_messages) > 1000:
            self._seen_messages.popitem(last=False)

        content = data.get("message") or ""
        root_id: str | None = None
        quote = data.get("quote")
        if quote:
            quote_ts = quote.get("id")
            quote_author = (
                quote.get("authorNumber")
                or quote.get("authorUuid")
                or quote.get("author")
            )
            if quote_ts and quote_author:
                root_id = f"{group_id}:{quote_ts}:{quote_author}"

        if content.strip().startswith("!"):
            if self._on_command is None:
                return
            parts = content.strip().split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=group_id,
                    channel_type="channel_private",
                    sender_id=author,
                    sender_name=envelope.get("sourceName") or author,
                    command=parts[0][1:],
                    args=parts[1] if len(parts) > 1 else "",
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=group.get("groupName"),
                )
            )
            return

        self_mention_token: str | None = None
        for mention in data.get("mentions") or []:
            if self._same_account(
                mention.get("number") or "", self._config.account
            ) or (
                mention.get("uuid")
                and self._same_account(mention["uuid"], self._config.account)
            ):
                self_mention_token = self._config.account
                break

        attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []
        for att in data.get("attachments") or []:
            size = att.get("size")
            if isinstance(size, int) and size > self._max_attachment_bytes:
                attachment_failures.append(
                    AttachmentFailure(
                        filename=att.get("filename") or "attachment",
                        reason=(
                            "attachment exceeds maximum size of "
                            f"{self._max_attachment_bytes} bytes"
                        ),
                    )
                )
                continue
            try:
                att_data = await self._rpc(
                    "getAttachment", {"id": att["id"], "groupId": group_id}
                )
                b64 = att_data.get("data", "") if isinstance(att_data, dict) else ""
                if not b64:
                    raise ValueError("empty attachment data")
                data_bytes = base64.b64decode(b64)
                if len(data_bytes) > self._max_attachment_bytes:
                    raise ValueError("attachment too large after decode")
                filename = att.get("filename")
                if not filename:
                    ext = mimetypes.guess_extension(att.get("contentType", "")) or ""
                    filename = f"attachment{ext}"
                attachments.append(
                    Attachment(
                        filename=filename,
                        mimetype=att.get("contentType", "application/octet-stream"),
                        data=data_bytes,
                    )
                )
            except Exception as e:
                logger.warning("Failed to fetch attachment %s: %s", att.get("id"), e)
                attachment_failures.append(
                    AttachmentFailure(
                        filename=att.get("filename") or "attachment",
                        reason=f"failed to download: {e}",
                    )
                )

        if not content and not attachments and not attachment_failures:
            return
        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=group_id,
                channel_type="channel_private",
                sender_id=author,
                sender_name=envelope.get("sourceName") or author,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                channel_name=group.get("groupName"),
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=self_mention_token,
                sender_is_app=False,
            )
        )

    # -- Outbound --------------------------------------------------------

    def _is_dm(self, channel_id: str) -> bool:
        return bool(_PHONE_RE.match(channel_id) or _UUID_RE.match(channel_id))

    def _target(self, channel_id: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._is_dm(channel_id):
            params["recipient"] = [channel_id]
        else:
            params["groupId"] = channel_id
        return params

    def _format_attributed(self, content: str, label: str) -> str:
        label = self.escape_label_for_body(label)
        if "\n" in content:
            return f"{label}:\n{content}"
        return f"{label}: {content}"

    def _chunk_message(self, text: str, limit: int = 60_000) -> list[str]:
        if len(text.encode("utf-8")) <= 64000:
            return [text]
        chunks = []
        remaining = text
        while remaining:
            chunk, remaining = self._split_at_boundary(remaining, limit)
            chunks.append(chunk)
        return chunks

    def _split_at_boundary(self, text: str, limit: int) -> tuple[str, str]:
        if len(text.encode("utf-8")) <= 64000:
            return text, ""
        cut = text.rfind("\n\n", 0, limit)
        if cut == -1:
            cut = text.rfind("\n", 0, limit)
        if cut == -1:
            cut = text.rfind(" ", 0, limit)
        if cut == -1:
            cut = limit
        return text[: cut + 1], text[cut + 1 :]

    def _build_send_params(
        self,
        channel_id: str,
        message: str,
        thread_root_id: str | None = None,
    ) -> dict[str, Any]:
        params = self._target(
            channel_id,
            {
                "account": self._config.account,
                "message": self._render_outbound(message),
            },
        )
        if thread_root_id:
            parts = thread_root_id.rsplit(":", 2)
            if len(parts) == 3:
                _, ts, author = parts
                params["quoteTimestamp"] = int(ts)
                params["quoteAuthor"] = author
                quoted_text = self._quoted_text_cache.get(thread_root_id)
                if quoted_text:
                    params["quoteMessage"] = quoted_text
        return params

    def _render_outbound(self, content: str) -> str:
        if not content:
            return ""

        def replace_link(match: re.Match[str]) -> str:
            label, url = match.group(1), match.group(2)
            if label == url:
                return url
            return f"{label} ({url})"

        text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", replace_link, content)
        text = re.sub(r"^(#{1,6})\s+", "", text, flags=re.MULTILINE)

        def code_block_repl(match: re.Match[str]) -> str:
            return "\n" + match.group(1).strip() + "\n"

        text = re.sub(r"```[\s\S]*?```", code_block_repl, text)
        text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
        text = re.sub(r"__([^_]+)__", r"\1", text)
        text = re.sub(r"~~([^~]+)~~", r"\1", text)
        text = re.sub(r"\*([^*]+)\*", r"\1", text)
        text = re.sub(r"`([^`]+)`", r"\1", text)
        return text

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def rich_markup(self) -> Markup:
        return _SIGNAL_MARKUP

    @override
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        try:
            body = self._format_attributed(content, sender_name)
            first_ref: str | None = None
            for index, chunk in enumerate(self._chunk_message(body)):
                params = self._build_send_params(
                    channel_id=channel_id,
                    message=chunk,
                    thread_root_id=thread_root_id if index == 0 else None,
                )
                result = await self._rpc("send", params)
                ts = result.get("timestamp") if isinstance(result, dict) else None
                if ts is None:
                    logger.error("Signal send response missing timestamp: %s", result)
                    return None
                ref = f"{channel_id}:{ts}:{self._config.account}"
                if first_ref is None:
                    first_ref = ref
                    self._quoted_text_cache[ref] = body
                    if len(self._quoted_text_cache) > self._quoted_text_capacity:
                        self._quoted_text_cache.popitem(last=False)
            return first_ref
        except SignalRpcError as e:
            logger.error("Signal send failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending message")
            return None

    @override
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
        safe_name = re.sub(r"[;,\"]", "_", filename)
        data_uri = (
            f"data:{mimetype};filename={safe_name};base64,"
            f"{base64.b64encode(data).decode('ascii')}"
        )
        message = self._format_attributed(caption or "", sender_name)
        params = self._target(
            channel_id,
            {
                "account": self._config.account,
                "message": self._render_outbound(message),
                "attachments": [data_uri],
            },
        )
        if thread_root_id:
            quote_params = self._build_send_params(
                channel_id=channel_id, message="", thread_root_id=thread_root_id
            )
            for key in ("quoteTimestamp", "quoteAuthor", "quoteMessage"):
                if key in quote_params:
                    params[key] = quote_params[key]
        try:
            result = await self._rpc("send", params)
            ts = result.get("timestamp") if isinstance(result, dict) else None
            if ts is None:
                return None
            return f"{channel_id}:{ts}:{self._config.account}"
        except SignalRpcError as e:
            logger.error("Signal send attachment failed: %s", e)
            return None

    @override
    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        parts = message_ref.rsplit(":", 2)
        if len(parts) != 3:
            raise BridgeOperationError(f"Invalid message reference: {message_ref}")
        params = self._target(
            channel_id,
            {
                "account": self._config.account,
                "editTimestamp": int(parts[1]),
                "message": self._render_outbound(new_content),
            },
        )
        try:
            await self._rpc("send", params)
        except SignalRpcError as e:
            logger.error("Signal edit failed: %s", e)
            raise BridgeOperationError(f"Failed to edit message: {e}") from e

    @override
    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        parts = message_ref.rsplit(":", 2)
        if len(parts) != 3:
            raise BridgeOperationError(f"Invalid message reference: {message_ref}")
        params = self._target(
            channel_id,
            {
                "account": self._config.account,
                "targetTimestamp": int(parts[1]),
            },
        )
        try:
            await self._rpc("remoteDelete", params)
        except SignalRpcError as e:
            logger.error("Signal delete failed: %s", e)
            raise BridgeOperationError(f"Failed to delete message: {e}") from e

    @override
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        params = self._target(
            channel_id,
            {"account": self._config.account, "stop": not is_typing},
        )
        try:
            await self._rpc("sendTyping", params)
        except SignalRpcError as e:
            logger.warning("Signal typing indicator failed: %s", e)

    @override
    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        try:
            await self.send_typing(channel_id, agent_name, True)
        except Exception:
            logger.warning("Failed to send working indicator", exc_info=True)

    @override
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Signal does not support creating groups from Switch. "
            "Create the group in the Signal app, add your registered number, "
            "and Switch will adopt it on the first message."
        )

    @override
    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_private"

    @override
    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        logger.warning(
            "Adding users to a Signal group is not implemented; "
            "returning all as not added"
        )
        return list(user_external_ids)

    @override
    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    @override
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    @override
    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        try:
            result = await self._rpc("listGroups", {})
        except SignalRpcError:
            logger.warning(
                "Failed to fetch group invite link for %s", external_channel_id
            )
            return None
        if isinstance(result, list):
            for group in result:
                if isinstance(group, dict) and group.get("id") == external_channel_id:
                    return group.get("groupInviteLink")
        return None

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")
