"""Google Chat collaboration bridge adapter.

A Chat app the operator creates in their Google Cloud project. Inbound
events arrive on the app's HTTP endpoint, which is this bridge's own
webhook address; Google proves each request with a bearer JWT this
adapter verifies. Outbound messages go through the Chat API, authenticated
with the app's service account. Spaces are bridged; 1:1 direct messages
with the app are not. Threads are Google Chat's own: a reply in Switch
is a threaded message, addressed by its thread key.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, Literal, override

import httpx
import jwt
from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
    WebhookVerificationUnavailable,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

_CHAT_ISSUER = "chat@system.gserviceaccount.com"
_GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_CHAT_CERTS_URL = (
    "https://www.googleapis.com/service_accounts/v1/metadata/x509/" + _CHAT_ISSUER
)
_CHAT_API = "https://chat.googleapis.com/v1"
_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CHAT_SCOPE = "https://www.googleapis.com/auth/chat"


class GoogleChatApiError(RuntimeError):
    """The Chat API answered with an error payload."""


class GoogleChatConnectionConfig(BridgeConnectionConfig):
    """Configuration for a Google Chat bridge connection."""

    service_account_email: str = Field(
        description="The Chat app's service account email address"
    )
    service_account_private_key: str = Field(
        description="The service account's private key (PEM)"
    )
    authentication_audience: Literal["endpoint_url", "project_number"] = Field(
        default="endpoint_url",
        description=(
            "How Google signs webhook requests: endpoint_url when the Chat "
            "app's Authentication Audience is the HTTP endpoint URL, "
            "project_number when it is the project number"
        ),
    )
    project_number: str | None = Field(
        default=None,
        description="The GCP project number, required in project_number mode",
    )

    @field_validator("service_account_email")
    @classmethod
    def _validate_email(cls, v: str) -> str:
        v = v.strip()
        if not v or "@" not in v:
            raise ValueError("service_account_email must be an email address")
        return v

    @field_validator("service_account_private_key")
    @classmethod
    def _validate_private_key(cls, v: str) -> str:
        if "BEGIN" not in v or "PRIVATE KEY" not in v:
            raise ValueError("service_account_private_key must be a PEM private key")
        return v

    @model_validator(mode="after")
    def _validate_audience(self) -> GoogleChatConnectionConfig:
        if self.authentication_audience == "project_number" and not self.project_number:
            raise ValueError(
                "project_number is required when authentication_audience is "
                "project_number"
            )
        if self.authentication_audience == "endpoint_url" and self.project_number:
            raise ValueError(
                "project_number must be omitted when authentication_audience is "
                "endpoint_url"
            )
        return self


class GoogleChatAdapter(PlatformAdapter):
    """Google Chat bridge: webhook events in, Chat API messages out."""

    display_name: ClassVar[str] = "Google Chat"
    docs_slug: ClassVar[str | None] = "google-chat"
    receives_webhooks: ClassVar[bool] = True
    channel_on_delete = "kept"
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = True
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
    removes_answered_cards: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = None

    def __init__(
        self,
        *,
        config: GoogleChatConnectionConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._access_token: str | None = None
        self._token_expires_at = 0.0
        self._seen_messages: OrderedDict[str, None] = OrderedDict()
        self._certs_cache: dict[str, str] = {}
        self._certs_fetched_at = 0.0

    # -- Failure classification and registration hooks --------------------

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
        if isinstance(exc, GoogleChatApiError | json.JSONDecodeError):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        config = GoogleChatConnectionConfig.model_validate(connection_config)
        return f"Google Chat service account {config.service_account_email}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return ["https://chat.googleapis.com", "https://oauth2.googleapis.com"]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = GoogleChatConnectionConfig.model_validate(connection_config)
        await cls._exchange_token(config, None)

    @classmethod
    async def _exchange_token(
        cls,
        config: GoogleChatConnectionConfig,
        transport: httpx.AsyncBaseTransport | None,
    ) -> tuple[str, int]:
        now = int(time.time())
        assertion = jwt.encode(
            {
                "iss": config.service_account_email,
                "scope": _CHAT_SCOPE,
                "aud": _OAUTH_TOKEN_URL,
                "iat": now,
                "exp": now + 3600,
            },
            config.service_account_private_key,
            algorithm="RS256",
        )
        try:
            async with httpx.AsyncClient(
                transport=transport, timeout=15.0, trust_env=False
            ) as client:
                resp = await client.post(
                    _OAUTH_TOKEN_URL,
                    data={
                        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                        "assertion": assertion,
                    },
                )
        except httpx.ConnectError as e:
            raise BridgeCredentialError(
                f"Could not reach Google's token endpoint: {e}"
            ) from e
        except httpx.TimeoutException as e:
            raise BridgeCredentialError(
                f"Timed out connecting to Google's token endpoint: {e}"
            ) from e
        if resp.status_code != 200:
            raise BridgeCredentialError(
                "Google rejected the service account credentials "
                f"(HTTP {resp.status_code}). Check the service account email "
                "and private key."
            )
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError) as e:
            raise BridgeCredentialError(
                f"Google's token endpoint answered with an unparseable response: {e}"
            ) from e
        token = data.get("access_token") if isinstance(data, dict) else None
        if not token:
            raise BridgeCredentialError(
                "Google's token endpoint did not return an access token"
            )
        try:
            expires = int(data.get("expires_in") or 3600)
        except (TypeError, ValueError):
            expires = 3600
        return str(token), expires

    # -- Lifecycle --------------------------------------------------------

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
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Google Chat needs a public webhook address: set "
                "MESSAGING_PUBLIC_URL so Switch can hand the Chat app its "
                "HTTP endpoint URL."
            )
        logger.info("Google Chat adapter started (webhook events)")

    @override
    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- REST transport ---------------------------------------------------

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = self._transport
            if transport is None:
                transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False)
            self._client = httpx.AsyncClient(
                transport=transport,
                timeout=httpx.Timeout(connect=10.0, read=30.0, write=60.0, pool=10.0),
                follow_redirects=False,
            )
        return self._client

    async def _ensure_token(self) -> str:
        if self._access_token and self._token_expires_at > time.monotonic() + 60:
            return self._access_token
        token, expires = await self._exchange_token(self._config, self._transport)
        self._access_token = token
        self._token_expires_at = time.monotonic() + expires
        return token

    async def _api(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = await self._ensure_token()
        client = await self._get_client()
        resp = await client.request(
            method,
            _CHAT_API + path,
            headers={"Authorization": f"Bearer {token}"},
            json=json_body,
            params=params,
            timeout=30.0,
        )
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError):
            resp.raise_for_status()
            raise GoogleChatApiError(
                f"{method} {path} returned an unparseable response"
            )
        if resp.status_code >= 400:
            message = (
                data.get("error", {}).get("message") if isinstance(data, dict) else None
            )
            raise GoogleChatApiError(
                f"{method} {path} failed: {message or resp.status_code}"
            )
        return data if isinstance(data, dict) else {}

    # -- Inbound: webhook verification and parsing -------------------------

    async def _fetch_certs(self) -> dict[str, str]:
        if self._certs_cache and time.monotonic() - self._certs_fetched_at < 3600:
            return self._certs_cache
        url = (
            _CHAT_CERTS_URL
            if self._config.authentication_audience == "project_number"
            else _GOOGLE_CERTS_URL
        )
        client = await self._get_client()
        try:
            resp = await client.get(url, timeout=15.0)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            raise WebhookVerificationUnavailable(
                f"Could not fetch Google's signing certificates: {e}"
            ) from e
        if not isinstance(data, dict):
            raise WebhookVerificationUnavailable(
                "Google signing certificates were unparseable"
            )
        self._certs_cache = {str(k): str(v) for k, v in data.items()}
        self._certs_fetched_at = time.monotonic()
        return self._certs_cache

    @override
    async def verify_webhook(self, request: WebhookRequest) -> None:
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise WebhookAuthenticityError("missing bearer token")
        token = authorization[len("Bearer ") :]
        if self._config.authentication_audience == "endpoint_url":
            if self.webhook_url is None:
                raise WebhookVerificationUnavailable(
                    "no webhook address configured to verify against"
                )
            audience = self.webhook_url
            issuer = "https://accounts.google.com"
        else:
            audience = self._config.project_number or ""
            issuer = _CHAT_ISSUER
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as e:
            raise WebhookAuthenticityError("malformed bearer token") from e
        kid = header.get("kid")
        certs = await self._fetch_certs()
        key = certs.get(str(kid)) if kid else None
        if key is None:
            raise WebhookAuthenticityError("unknown signing key")
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=audience,
                issuer=issuer,
                options={"require": ["exp", "iat", "aud", "iss"]},
            )
        except jwt.PyJWTError as e:
            raise WebhookAuthenticityError("bearer token verification failed") from e
        if (
            self._config.authentication_audience == "endpoint_url"
            and claims.get("email") != _CHAT_ISSUER
        ):
            raise WebhookAuthenticityError("token was not issued for the Chat app")

    @override
    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method != "POST":
            raise WebhookPayloadError("Google Chat events arrive as POST")
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("body is not JSON") from exc
        if not isinstance(payload, dict) or not payload.get("type"):
            raise WebhookPayloadError("event has no type")
        event_type = str(payload["type"])
        message = payload.get("message")
        if (
            event_type == "MESSAGE"
            and isinstance(message, dict)
            and message.get("name")
        ):
            external_id = str(message["name"])
        else:
            space = payload.get("space") or {}
            user = payload.get("user") or {}
            external_id = (
                f"{event_type}:{payload.get('eventTime')}:"
                f"{space.get('name')}:{user.get('name')}"
            )
        return InboundWebhook(
            envelope_type=event_type,
            payload=payload,
            handshake=None,
            external_event_id=external_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    @override
    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        if envelope_type == "MESSAGE":
            await self._dispatch_message(payload)
        elif envelope_type == "ADDED_TO_SPACE":
            await self._dispatch_added(payload)
        elif envelope_type == "REMOVED_FROM_SPACE":
            logger.info("Google Chat app removed from a space")
        else:
            logger.debug("Ignoring Google Chat event of type %s", envelope_type)

    async def _dispatch_added(self, payload: dict[str, Any]) -> None:
        space = payload.get("space") or {}
        if space.get("type") == "DM":
            return
        if self._on_app_joined is None:
            return
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=str(space.get("name") or ""),
                channel_type="channel_private",
                channel_name=space.get("displayName"),
            )
        )

    async def _dispatch_message(self, payload: dict[str, Any]) -> None:
        space = payload.get("space") or {}
        if space.get("type") == "DM":
            return
        message = payload.get("message") or {}
        sender = message.get("sender") or {}
        if sender.get("type") == "BOT":
            return
        message_ref = str(message.get("name") or "")
        channel_id = str(space.get("name") or message_ref.rsplit("/messages/", 1)[0])
        if not message_ref:
            return
        if message_ref in self._seen_messages:
            return
        self._seen_messages[message_ref] = None
        if len(self._seen_messages) > 1000:
            self._seen_messages.popitem(last=False)

        sender_name = str(sender.get("displayName") or sender.get("name") or "unknown")
        sender_id = str(sender.get("name") or "")
        content = str(message.get("text") or "")
        thread = message.get("thread") or {}
        root_id = str(thread["threadKey"]) if thread.get("threadKey") else None
        channel_type: ChannelType = "channel_private"

        if content.strip().startswith("!"):
            if self._on_command is None:
                return
            parts = content.strip().split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    command=parts[0][1:],
                    args=parts[1] if len(parts) > 1 else "",
                    message_ref=message_ref,
                    root_id=root_id,
                )
            )
            return

        self_mention_token: str | None = None
        for mention in message.get("mentions") or []:
            user = mention.get("user") or {}
            if user.get("type") == "BOT":
                self_mention_token = str(
                    user.get("displayName") or user.get("name") or ""
                )
                break

        attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []
        for attachment in message.get("attachment") or []:
            ref = attachment.get("attachmentRef") or {}
            resource_name = ref.get("resourceName")
            if not resource_name:
                continue
            filename = f"attachment{mimetypes.guess_extension(attachment.get('contentType', '')) or ''}"
            try:
                data_bytes, mimetype = await self._download_attachment(
                    str(resource_name)
                )
                attachments.append(
                    Attachment(filename=filename, mimetype=mimetype, data=data_bytes)
                )
            except Exception as e:
                logger.warning(
                    "Failed to download Chat attachment %s: %s", resource_name, e
                )
                attachment_failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"failed to download: {e}"
                    )
                )

        if not content and not attachments and not attachment_failures:
            return
        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=self_mention_token,
                sender_is_app=False,
            )
        )

    async def _download_attachment(self, resource_name: str) -> tuple[bytes, str]:
        token = await self._ensure_token()
        client = await self._get_client()
        async with client.stream(
            "GET",
            f"{_CHAT_API}/{resource_name}",
            headers={"Authorization": f"Bearer {token}"},
            params={"alt": "media"},
        ) as resp:
            resp.raise_for_status()
            declared = resp.headers.get("content-length")
            if declared and int(declared) > self._max_attachment_bytes:
                raise ValueError(
                    f"attachment exceeds maximum size of "
                    f"{self._max_attachment_bytes} bytes"
                )
            chunks = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > self._max_attachment_bytes:
                    raise ValueError(
                        f"attachment exceeds maximum size of "
                        f"{self._max_attachment_bytes} bytes"
                    )
                chunks.append(chunk)
            mimetype = (
                resp.headers.get("content-type", "").split(";")[0]
                or "application/octet-stream"
            )
            return b"".join(chunks), mimetype

    # -- Outbound ----------------------------------------------------------

    def _format_attributed(self, content: str, label: str) -> str:
        label = self.escape_label_for_body(label)
        if "\n" in content:
            return f"{label}:\n{content}"
        return f"{label}: {content}"

    def _chunk_message(self, text: str, limit: int = 4000) -> list[str]:
        if len(text) <= limit:
            return [text]
        chunks = []
        remaining = text
        while remaining:
            cut = remaining.rfind("\n\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind("\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind(" ", 0, limit)
            if cut == -1:
                cut = limit
            chunks.append(remaining[: cut + 1])
            remaining = remaining[cut + 1 :]
        return chunks

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

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
                payload: dict[str, Any] = {"text": self._render_outbound(chunk)}
                if thread_root_id and index == 0:
                    payload["threadKey"] = thread_root_id
                data = await self._api(
                    "POST", f"/{channel_id}/messages", json_body=payload
                )
                name = data.get("name")
                if not name:
                    logger.error("Chat send response missing message name: %s", data)
                    return None
                if first_ref is None:
                    first_ref = str(name)
            return first_ref
        except GoogleChatApiError as e:
            logger.error("Chat send failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Chat message")
            return None

    @override
    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._api(
                "PATCH",
                f"/{message_ref}",
                json_body={"text": self._render_outbound(new_content)},
                params={"updateMask": "text"},
            )
        except GoogleChatApiError as e:
            logger.error("Chat edit failed: %s", e)
            raise BridgeOperationError(f"Failed to edit message: {e}") from e

    @override
    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._api("DELETE", f"/{message_ref}")
        except GoogleChatApiError as e:
            logger.error("Chat delete failed: %s", e)
            raise BridgeOperationError(f"Failed to delete message: {e}") from e

    @override
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Google Chat has no typing indicator to send")

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
        if len(data) > self._max_attachment_bytes:
            logger.error(
                "Chat attachment %s exceeds maximum size of %d bytes",
                filename,
                self._max_attachment_bytes,
            )
            return None
        try:
            if caption:
                await self.send_message(
                    channel_id, sender_name, caption, thread_root_id=thread_root_id
                )
            token = await self._ensure_token()
            client = await self._get_client()
            metadata = json.dumps({"filename": filename, "contentType": mimetype})
            resp = await client.post(
                "https://chat.googleapis.com/upload/v1/"
                f"{channel_id}/attachments"
                "?uploadType=multipart",
                headers={"Authorization": f"Bearer {token}"},
                files={
                    "metadata": (None, metadata, "application/json; charset=UTF-8"),
                    "media": (filename, data, mimetype),
                },
                timeout=60.0,
            )
            uploaded = self._parse_upload(resp)
            resource_name = uploaded.get("attachmentRef", {}).get("resourceName")
            if not resource_name:
                logger.error(
                    "Chat upload response missing attachment ref: %s", uploaded
                )
                return None
            payload: dict[str, Any] = {
                "attachment": [{"attachmentRef": {"resourceName": resource_name}}]
            }
            if thread_root_id:
                payload["threadKey"] = thread_root_id
            sent = await self._api("POST", f"/{channel_id}/messages", json_body=payload)
            name = sent.get("name")
            return str(name) if name else None
        except GoogleChatApiError as e:
            logger.error("Chat send attachment failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Chat attachment")
            return None

    @staticmethod
    def _parse_upload(resp: httpx.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError):
            resp.raise_for_status()
            raise GoogleChatApiError("Chat upload returned an unparseable response")
        if resp.status_code >= 400:
            message = (
                data.get("error", {}).get("message") if isinstance(data, dict) else None
            )
            raise GoogleChatApiError(
                f"Chat upload failed: {message or resp.status_code}"
            )
        return data if isinstance(data, dict) else {}

    @override
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        try:
            data = await self._api(
                "POST",
                "/spaces",
                json_body={"displayName": name, "spaceType": "ROOM"},
            )
        except GoogleChatApiError as e:
            raise BridgeOperationError(f"Failed to create space: {e}") from e
        space_name = data.get("name")
        if not space_name:
            raise BridgeOperationError("Chat create space returned no space name")
        return str(space_name)

    @override
    async def get_channel_type(self, channel_id: str) -> ChannelType:
        try:
            data = await self._api("GET", f"/{channel_id}")
        except GoogleChatApiError as e:
            raise BridgeOperationError(f"Failed to read space type: {e}") from e
        space_type = data.get("spaceType")
        if space_type == "DM":
            return "direct"
        if space_type in ("ROOM", "GROUP_CHAT"):
            return "channel_private"
        raise BridgeOperationError(f"Unknown Chat space type: {space_type!r}")

    @override
    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                await self._api(
                    "POST",
                    f"/{channel_id}/members",
                    json_body={"name": user_id},
                )
            except GoogleChatApiError as e:
                logger.warning("Chat add member %s failed: %s", user_id, e)
                failed.append(user_id)
        return failed

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
        return None

    @override
    async def home_deeplink(self) -> str | None:
        return None
