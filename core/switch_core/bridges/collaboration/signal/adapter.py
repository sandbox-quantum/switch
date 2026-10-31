from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import PurePath
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, field_validator

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
from switch_core.bridges.collaboration.signal.chunking import chunk_signal_message
from switch_core.bridges.collaboration.signal.client import (
    SignalEvent,
    SignalRpcClient,
    SignalRpcError,
)
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

_COMMAND = re.compile(r"^!([a-z][a-z0-9_-]*)(?:\s+(.*))?$", re.DOTALL)
_MARKDOWN_LINK = re.compile(r"\[([^]]+)]\((https?://[^)]+)\)")
_MARKS = re.compile(r"(?<!\\)(?:\*\*|__|~~|`)")
_RECONNECT_MAX_SECONDS = 30.0


class SignalConnectionConfig(BridgeConnectionConfig):
    daemon_url: str = Field(
        title="signal-cli daemon URL",
        description=(
            "Private HTTP origin of a signal-cli 0.14.9 daemon, for example "
            "http://signal-cli:8080. Never expose it directly to the internet."
        ),
    )
    account: str = Field(
        title="Signal account",
        description="Registered E.164 phone number or account UUID used by signal-cli.",
        min_length=1,
    )
    daemon_token: str | None = Field(
        default=None,
        title="Proxy bearer token",
        description=(
            "Optional bearer token when a private reverse proxy protects the daemon. "
            "signal-cli itself does not provide HTTP authentication."
        ),
    )

    @field_validator("daemon_url")
    @classmethod
    def _valid_daemon_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("daemon_url must be an http or https origin")
        if parsed.username or parsed.password:
            raise ValueError("daemon_url must not contain credentials")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("daemon_url must be a bare origin with no path or query")
        return value

    @field_validator("account")
    @classmethod
    def _non_blank_account(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("account must not be blank")
        return value


class SignalAdapter(PlatformAdapter):
    """Signal bridge backed by a user-managed signal-cli HTTP daemon."""

    display_name: ClassVar[str] = "Signal"
    docs_slug: ClassVar[str | None] = "signal"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(self, *, config: SignalConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: SignalRpcClient | None = None
        self._http: httpx.AsyncClient | None = None
        self._events_task: asyncio.Task[None] | None = None
        self._last_event_id: str | None = None
        self._groups: dict[str, str] = {}

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [SignalConnectionConfig.model_validate(connection_config).daemon_url]

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        account = SignalConnectionConfig.model_validate(connection_config).account
        digest = hashlib.sha256(account.encode()).hexdigest()[:16]
        return f"signal-account:{digest}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SignalConnectionConfig.model_validate(connection_config)
        client = SignalRpcClient(
            daemon_url=config.daemon_url,
            account=config.account,
            daemon_token=config.daemon_token,
        )
        try:
            await client.check()
            await client.list_groups()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {401, 403}:
                raise BridgeCredentialError(
                    "The proxy rejected the signal-cli daemon token."
                ) from exc
            raise BridgeCredentialError(
                f"signal-cli health check failed with HTTP {exc.response.status_code}."
            ) from exc
        except SignalRpcError as exc:
            raise BridgeCredentialError(
                f"signal-cli rejected account {config.account!r}: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                "Could not reach the signal-cli daemon. Check its private URL and "
                "network policy."
            ) from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in {401, 403}:
                return "auth_failed"
            return "platform_error"
        if isinstance(exc, httpx.HTTPError):
            return "network"
        if isinstance(exc, SignalRpcError):
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
        headers = (
            {"Authorization": f"Bearer {self._config.daemon_token}"}
            if self._config.daemon_token
            else None
        )
        self._http = guarded_async_client(
            self.outbound_policy,
            timeout=httpx.Timeout(30, read=None),
            headers=headers,
        )
        self._client = SignalRpcClient(
            daemon_url=self._config.daemon_url,
            account=self._config.account,
            http=self._http,
        )
        await self._client.check()
        await self._refresh_groups()
        if self._listening:
            self._events_task = asyncio.create_task(
                self._consume_events(), name="signal-cli-events"
            )
        else:
            logger.info(
                "Signal bridge is quiet on this process; the lease holder consumes SSE"
            )

    async def stop(self) -> None:
        task, self._events_task = self._events_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client is not None:
            await client.close()
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    async def _refresh_groups(self) -> None:
        client = self._require_client()
        groups = await client.list_groups()
        self._groups = {
            str(group["id"]): str(group.get("name") or "Signal group")
            for group in groups
            if group.get("id") and group.get("isMember", True)
        }

    async def _consume_events(self) -> None:
        delay = 1.0
        while True:
            try:
                async for event in self._require_client().events(
                    last_event_id=self._last_event_id
                ):
                    await self._handle_event(event)
                    if event.id:
                        self._last_event_id = event.id
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Signal event stream failed; reconnecting in %.0f seconds", delay
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RECONNECT_MAX_SECONDS)

    async def _handle_event(self, event: SignalEvent) -> None:
        payload = event.payload
        if payload.get("method") != "receive":
            return
        params = payload.get("params")
        if not isinstance(params, dict):
            return
        nested = params.get("result")
        result: dict[str, Any] = nested if isinstance(nested, dict) else params
        envelope = result.get("envelope")
        if not isinstance(envelope, dict):
            return
        source = str(
            envelope.get("sourceNumber")
            or envelope.get("sourceUuid")
            or envelope.get("source")
            or ""
        )
        if not source or source == self._config.account or envelope.get("syncMessage"):
            return
        data = envelope.get("dataMessage")
        if not isinstance(data, dict):
            return
        timestamp = int(data.get("timestamp") or envelope.get("timestamp") or 0)
        if timestamp <= 0:
            return
        group = data.get("groupInfo")
        group_id = str(group.get("groupId") or "") if isinstance(group, dict) else ""
        channel_id = f"group:{group_id}" if group_id else f"direct:{source}"
        channel_type: ChannelType = "group" if group_id else "direct"
        channel_name = self._groups.get(group_id) if group_id else None
        content = self.translate_inbound(str(data.get("message") or ""))
        sender_name = str(envelope.get("sourceName") or source)
        message_ref = self._message_ref(source, timestamp)
        quote_value = data.get("quote")
        root_id: str | None = None
        if isinstance(quote_value, dict):
            quote_timestamp = int(
                quote_value.get("id") or quote_value.get("timestamp") or 0
            )
            quote_author = str(
                quote_value.get("authorNumber")
                or quote_value.get("authorUuid")
                or quote_value.get("author")
                or source
            )
            if quote_timestamp > 0:
                root_id = self._message_ref(quote_author, quote_timestamp)
        attachments, failures = await self._attachments(
            data.get("attachments"), group_id=group_id or None, sender=source
        )
        command = _COMMAND.match(content.strip())
        if command and self._on_command is not None:
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=source,
                    sender_name=sender_name,
                    command=command.group(1),
                    args=command.group(2) or "",
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return
        if self._on_message is None or not (content or attachments or failures):
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=source,
                sender_name=sender_name,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _attachments(
        self, raw: Any, *, group_id: str | None, sender: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if not isinstance(raw, list):
            return attachments, failures
        for item in raw:
            if not isinstance(item, dict):
                continue
            filename = PurePath(str(item.get("filename") or "attachment")).name
            size = int(item.get("size") or 0)
            if size > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"file is larger than {self._max_attachment_bytes} bytes",
                    )
                )
                continue
            attachment_id = item.get("id")
            if not attachment_id:
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="signal-cli supplied no attachment id"
                    )
                )
                continue
            params: dict[str, Any] = {"id": str(attachment_id)}
            if group_id:
                params["groupId"] = group_id
            else:
                params["recipient"] = sender
            try:
                result = await self._require_client().rpc("getAttachment", params)
                encoded = (
                    result
                    if isinstance(result, str)
                    else result.get("data") or result.get("base64")
                    if isinstance(result, dict)
                    else None
                )
                if not isinstance(encoded, str):
                    raise ValueError("signal-cli returned no attachment data")
                if len(encoded) > ((self._max_attachment_bytes + 2) // 3) * 4 + 4:
                    raise ValueError("encoded attachment exceeds the configured limit")
                data = base64.b64decode(encoded, validate=True)
                if len(data) > self._max_attachment_bytes:
                    raise ValueError("attachment exceeds the configured limit")
                attachments.append(
                    Attachment(
                        filename=filename,
                        mimetype=str(
                            item.get("contentType") or "application/octet-stream"
                        ),
                        data=data,
                    )
                )
            except (SignalRpcError, ValueError, binascii.Error, httpx.HTTPError) as exc:
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
        body = f"{sender_name}: {content}" if sender_name else content
        first_ref: str | None = None
        for index, chunk in enumerate(chunk_signal_message(body)):
            params = self._target(channel_id)
            params["message"] = chunk
            if index == 0 and thread_root_id:
                quote_author, quote_timestamp = self._parse_message_ref(thread_root_id)
                params["quoteAuthor"] = quote_author
                params["quoteTimestamp"] = quote_timestamp
            result = await self._require_client().rpc("send", params)
            timestamp = self._result_timestamp(result)
            if first_ref is None:
                first_ref = self._message_ref(self._config.account, timestamp)
        return first_ref

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
        if len(data) > self._max_attachment_bytes:
            raise BridgeOperationError(
                f"{filename} is larger than the {self._max_attachment_bytes}-byte limit"
            )
        encoded = base64.b64encode(data).decode("ascii")
        uri = f"data:{mimetype};filename={quote(filename, safe='')};base64,{encoded}"
        params = self._target(channel_id)
        params["message"] = (
            f"{sender_name}: {self.translate_outbound(caption)}"
            if caption
            else sender_name
        )
        params["attachments"] = [uri]
        if thread_root_id:
            author, timestamp = self._parse_message_ref(thread_root_id)
            params.update(quoteAuthor=author, quoteTimestamp=timestamp)
        result = await self._require_client().rpc("send", params)
        return self._message_ref(self._config.account, self._result_timestamp(result))

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        _, timestamp = self._parse_message_ref(message_ref)
        params = self._target(channel_id)
        params.update(message=new_content, editTimestamp=timestamp)
        await self._require_client().rpc("send", params)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        _, timestamp = self._parse_message_ref(message_ref)
        params = self._target(channel_id)
        params["targetTimestamp"] = timestamp
        await self._require_client().rpc("remoteDelete", params)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # signal-cli exposes typing receipts, but they are deliberately omitted
        # until its JSON-RPC parameter contract is stable across the pinned build.
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Signal groups must be created in a Signal client and the bot account added"
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "group" if channel_id.startswith("group:") else "direct"

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
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")

    def _render_outbound(self, content: str) -> str:
        content = _MARKDOWN_LINK.sub(r"\1 (\2)", content)
        content = content.replace("```", "")
        return _MARKS.sub("", content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _require_client(self) -> SignalRpcClient:
        if self._client is None:
            raise RuntimeError("Signal adapter is not started")
        return self._client

    @staticmethod
    def _message_ref(author: str, timestamp: int) -> str:
        return f"signal:{author}:{timestamp}"

    @staticmethod
    def _parse_message_ref(message_ref: str) -> tuple[str, int]:
        if not message_ref.startswith("signal:"):
            raise BridgeOperationError("Signal message reference is invalid")
        try:
            author, timestamp = message_ref.removeprefix("signal:").rsplit(":", 1)
        except ValueError as exc:
            raise BridgeOperationError("Signal message reference is invalid") from exc
        if not author:
            raise BridgeOperationError("Signal message reference is invalid")
        try:
            return author, int(timestamp)
        except ValueError as exc:
            raise BridgeOperationError("Signal message reference is invalid") from exc

    @staticmethod
    def _result_timestamp(result: Any) -> int:
        value = result.get("timestamp") if isinstance(result, dict) else result
        if value is None:
            raise BridgeOperationError(
                "signal-cli accepted the request but returned no message timestamp"
            )
        try:
            timestamp = int(value)
        except (TypeError, ValueError) as exc:
            raise BridgeOperationError(
                "signal-cli accepted the request but returned no message timestamp"
            ) from exc
        if timestamp <= 0:
            raise BridgeOperationError("signal-cli returned an invalid timestamp")
        return timestamp

    @staticmethod
    def _target(channel_id: str) -> dict[str, Any]:
        kind, separator, value = channel_id.partition(":")
        if not separator or not value:
            raise BridgeOperationError("Signal channel id is invalid")
        if kind == "group":
            return {"groupIds": [value]}
        if kind == "direct":
            return {"recipients": [value]}
        raise BridgeOperationError("Signal channel id has an unknown kind")
