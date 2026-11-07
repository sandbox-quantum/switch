"""Tests for Cisco Webex collaboration bridge adapter."""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.webex.adapter import (
    WEBEX_API_BASE,
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.webex.chunking import chunk_message

SECRET = "super-secret-key-12345"
BOT_TOKEN = "webex-test-bot-token"
BOT_ID = "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3Qx"
BOT_EMAIL = "switchbot@webex.bot"
BOT_NAME = "Switch Bot"


def make_config(**kwargs: object) -> WebexConnectionConfig:
    data = {
        "bot_token": BOT_TOKEN,
        "webhook_secret": SECRET,
        "bot_email": BOT_EMAIL,
    }
    data.update(kwargs)
    return WebexConnectionConfig.model_validate(data)


def sign_spark(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()


def sign_webex_sha256(secret: str, body: bytes, prefix: bool = False) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}" if prefix else digest


@pytest.fixture
def adapter() -> WebexAdapter:
    ad = WebexAdapter(config=make_config())
    ad.bot_id = BOT_ID
    ad.bot_email = BOT_EMAIL
    ad.bot_name = BOT_NAME
    return ad


class TestWebexConfigAndFailureClassification:
    def test_config_masks_secrets(self) -> None:
        config = make_config()
        schema = config.model_json_schema()
        assert schema["properties"]["bot_token"]["format"] == "password"
        assert schema["properties"]["webhook_secret"]["format"] == "password"

    def test_classify_failure(self) -> None:
        assert (
            WebexAdapter.classify_failure(BridgeCredentialError("bad token"))
            == "auth_failed"
        )
        req = httpx.Request("GET", "https://webexapis.com/v1/people/me")
        resp_401 = httpx.Response(401, request=req)
        assert (
            WebexAdapter.classify_failure(
                httpx.HTTPStatusError("401", request=req, response=resp_401)
            )
            == "auth_failed"
        )
        resp_429 = httpx.Response(429, request=req)
        assert (
            WebexAdapter.classify_failure(
                httpx.HTTPStatusError("429", request=req, response=resp_429)
            )
            == "network"
        )
        resp_500 = httpx.Response(500, request=req)
        assert (
            WebexAdapter.classify_failure(
                httpx.HTTPStatusError("500", request=req, response=resp_500)
            )
            == "platform_error"
        )
        assert (
            WebexAdapter.classify_failure(
                httpx.RequestError("connect fail", request=req)
            )
            == "network"
        )


class TestWebexStartupAndLifecycle:
    @pytest.mark.asyncio
    async def test_start_verifies_credentials_success(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/people/me"
            assert request.headers["Authorization"] == f"Bearer {BOT_TOKEN}"
            return httpx.Response(
                200,
                json={
                    "id": BOT_ID,
                    "emails": [BOT_EMAIL],
                    "displayName": BOT_NAME,
                },
            )

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url=WEBEX_API_BASE,
            headers={"Authorization": f"Bearer {BOT_TOKEN}"},
        )

        on_msg = AsyncMock()
        await adapter.start(on_msg, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock())
        assert adapter.bot_id == BOT_ID
        assert adapter.bot_email == BOT_EMAIL
        assert adapter.bot_name == BOT_NAME
        await adapter.stop()
        assert adapter._client is None

    @pytest.mark.asyncio
    async def test_start_raises_on_invalid_credentials(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": "Unauthorized"})

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        with pytest.raises(
            BridgeCredentialError, match="Invalid Webex Bot Access Token"
        ):
            await adapter.start(
                AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
            )
        await adapter.stop()


class TestWebhookSignatureVerification:
    @pytest.mark.asyncio
    async def test_verify_spark_sha1_signature(self, adapter: WebexAdapter) -> None:
        body = b'{"id":"123","resource":"messages","event":"created"}'
        sig = sign_spark(SECRET, body)

        req = WebhookRequest(
            method="POST",
            headers={"x-spark-signature": sig},
            query={},
            body=body,
        )
        await adapter.verify_webhook(req)

    @pytest.mark.asyncio
    async def test_verify_webex_sha256_signature_both_formats(
        self, adapter: WebexAdapter
    ) -> None:
        body = b'{"id":"456","resource":"messages","event":"created"}'

        # Raw hex
        sig_raw = sign_webex_sha256(SECRET, body, prefix=False)
        req_raw = WebhookRequest(
            method="POST",
            headers={"x-webex-signature": sig_raw},
            query={},
            body=body,
        )
        await adapter.verify_webhook(req_raw)

        # Prefixed sha256=...
        sig_prefix = sign_webex_sha256(SECRET, body, prefix=True)
        req_prefix = WebhookRequest(
            method="POST",
            headers={"x-webex-signature": sig_prefix},
            query={},
            body=body,
        )
        await adapter.verify_webhook(req_prefix)

    @pytest.mark.asyncio
    async def test_verify_fails_on_tampered_body_or_bad_secret(
        self, adapter: WebexAdapter
    ) -> None:
        body = b'{"id":"123","resource":"messages","event":"created"}'
        sig = sign_spark(SECRET, body)

        # Tampered body
        req_tampered = WebhookRequest(
            method="POST",
            headers={"x-spark-signature": sig},
            query={},
            body=body + b"tampered",
        )
        with pytest.raises(
            WebhookAuthenticityError, match="Invalid Webex webhook signature"
        ):
            await adapter.verify_webhook(req_tampered)

        # Missing header
        req_missing = WebhookRequest(
            method="POST",
            headers={},
            query={},
            body=body,
        )
        with pytest.raises(
            WebhookAuthenticityError, match="Missing Webex signature header"
        ):
            await adapter.verify_webhook(req_missing)


class TestWebhookParsingAndEventIdentity:
    def test_parse_webhook_extracts_distinct_event_ids(
        self, adapter: WebexAdapter
    ) -> None:
        # Same webhook subscription ID "webhook-sub-999", but distinct message IDs
        body1 = json.dumps(
            {
                "id": "webhook-sub-999",
                "resource": "messages",
                "event": "created",
                "data": {"id": "msg-001", "roomId": "room-A"},
            }
        ).encode("utf-8")

        body2 = json.dumps(
            {
                "id": "webhook-sub-999",
                "resource": "messages",
                "event": "created",
                "data": {"id": "msg-002", "roomId": "room-A"},
            }
        ).encode("utf-8")

        req1 = WebhookRequest(method="POST", headers={}, query={}, body=body1)
        req2 = WebhookRequest(method="POST", headers={}, query={}, body=body2)

        ev1 = adapter.parse_webhook(req1)
        ev2 = adapter.parse_webhook(req2)

        assert ev1.external_event_id == "messages:created:msg-001"
        assert ev2.external_event_id == "messages:created:msg-002"
        # Must not collide on the webhook subscription ID!
        assert ev1.external_event_id != ev2.external_event_id

    def test_parse_webhook_deletion_has_distinct_event_id(
        self, adapter: WebexAdapter
    ) -> None:
        body_create = json.dumps(
            {
                "id": "sub-1",
                "resource": "messages",
                "event": "created",
                "data": {"id": "msg-001"},
            }
        ).encode("utf-8")
        body_delete = json.dumps(
            {
                "id": "sub-1",
                "resource": "messages",
                "event": "deleted",
                "data": {"id": "msg-001"},
            }
        ).encode("utf-8")

        ev_create = adapter.parse_webhook(WebhookRequest("POST", {}, {}, body_create))
        ev_delete = adapter.parse_webhook(WebhookRequest("POST", {}, {}, body_delete))

        assert ev_create.external_event_id == "messages:created:msg-001"
        assert ev_delete.external_event_id == "messages:deleted:msg-001"
        assert ev_create.external_event_id != ev_delete.external_event_id

    def test_parse_webhook_rejects_malformed_json(self, adapter: WebexAdapter) -> None:
        req = WebhookRequest("POST", {}, {}, b"not-json")
        with pytest.raises(WebhookPayloadError, match="not valid JSON"):
            adapter.parse_webhook(req)


class TestInboundEventDispatching:
    @pytest.mark.asyncio
    async def test_dispatch_message_created_fetches_body_and_strips_mention(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/messages/msg-test-100"
            return httpx.Response(
                200,
                json={
                    "id": "msg-test-100",
                    "roomId": "room-webex-123",
                    "roomType": "group",
                    "personId": "user-456",
                    "personEmail": "alice@company.com",
                    "markdown": f"<@personId:{BOT_ID}|Switch Bot> what is status?",
                    "parentId": "thread-root-001",
                },
            )

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        on_message = AsyncMock()
        adapter._on_message = on_message

        payload = {
            "resource": "messages",
            "event": "created",
            "actorId": "user-456",
            "data": {"id": "msg-test-100", "personId": "user-456"},
        }
        await adapter.dispatch_event(envelope_type="messages", payload=payload)

        on_message.assert_called_once()
        msg: InboundMessage = on_message.call_args[0][0]
        assert msg.channel_id == "room-webex-123"
        assert msg.channel_type == "channel_public"
        assert msg.sender_id == "user-456"
        assert msg.sender_name == "alice"
        assert msg.content == "what is status?"  # Bot mention stripped!
        assert msg.message_ref == "msg-test-100"
        assert msg.root_id == "thread-root-001"

    @pytest.mark.asyncio
    async def test_dispatch_skips_bot_own_messages(self, adapter: WebexAdapter) -> None:
        on_message = AsyncMock()
        adapter._on_message = on_message

        # actorId is bot
        payload = {
            "resource": "messages",
            "event": "created",
            "actorId": BOT_ID,
            "data": {"id": "msg-from-bot", "personId": BOT_ID},
        }
        await adapter.dispatch_event(envelope_type="messages", payload=payload)
        on_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_dispatch_inbound_command(self, adapter: WebexAdapter) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "id": "msg-cmd-1",
                    "roomId": "room-1",
                    "roomType": "direct",
                    "personId": "user-1",
                    "personEmail": "bob@example.com",
                    "markdown": "!help agents",
                },
            )

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )
        on_cmd = AsyncMock()
        adapter._on_command = on_cmd

        payload = {
            "resource": "messages",
            "event": "created",
            "actorId": "user-1",
            "data": {"id": "msg-cmd-1", "personId": "user-1"},
        }
        await adapter.dispatch_event(envelope_type="messages", payload=payload)

        on_cmd.assert_called_once()
        cmd: InboundCommand = on_cmd.call_args[0][0]
        assert cmd.command == "help"
        assert cmd.args == "agents"
        assert cmd.channel_type == "direct"

    @pytest.mark.asyncio
    async def test_dispatch_attachment_actions_verified_endpoint(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            # Verified endpoint: /v1/attachment/actions/{id}
            assert request.url.path == "/v1/attachment/actions/action-submit-123"
            return httpx.Response(
                200,
                json={
                    "id": "action-submit-123",
                    "personId": "user-reviewer",
                    "roomId": "space-ops",
                    "messageId": "msg-card-99",
                    "inputs": {"action": "approve", "request_id": "req-xyz"},
                },
            )

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )
        on_cmd = AsyncMock()
        adapter._on_command = on_cmd

        payload = {
            "resource": "attachmentActions",
            "event": "created",
            "actorId": "user-reviewer",
            "data": {"id": "action-submit-123"},
        }
        await adapter.dispatch_event(envelope_type="attachmentActions", payload=payload)

        on_cmd.assert_called_once()
        cmd: InboundCommand = on_cmd.call_args[0][0]
        assert cmd.command == "approve"
        assert "req-xyz" in cmd.args


class TestOutboundMessagingAndChunking:
    @pytest.mark.asyncio
    async def test_send_message_with_threading(self, adapter: WebexAdapter) -> None:
        captured_body: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal captured_body
            assert request.url.path == "/v1/messages"
            captured_body = json.loads(request.content)
            return httpx.Response(200, json={"id": "sent-msg-123"})

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        res_id = await adapter.send_message(
            channel_id="space-1",
            sender_name="ClaudeAgent",
            content="Hello from agent",
            thread_root_id="parent-thread-99",
        )
        assert res_id == "sent-msg-123"
        assert captured_body["roomId"] == "space-1"
        assert captured_body["parentId"] == "parent-thread-99"
        assert captured_body["markdown"] == "**[ClaudeAgent]** Hello from agent"

    def test_chunking_splits_cleanly_at_limit(self) -> None:
        long_text = "word " * 2000
        assert len(long_text) > 7439
        chunks = chunk_message(long_text, limit=7400)
        assert len(chunks) >= 2
        for ch in chunks:
            assert len(ch) <= 7400

    def test_chunking_preserves_code_fences(self) -> None:
        code_text = "```python\n" + "x = 1\n" * 1500 + "```"
        chunks = chunk_message(code_text, limit=7400)
        assert len(chunks) >= 2
        # First chunk closes fence
        assert chunks[0].endswith("```")
        # Second chunk reopens fence
        assert chunks[1].startswith("```python")

    @pytest.mark.asyncio
    async def test_delete_message(self, adapter: WebexAdapter) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "DELETE"
            assert request.url.path == "/v1/messages/msg-to-delete"
            return httpx.Response(204)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )
        await adapter.delete_message("space-1", "msg-to-delete")

    @pytest.mark.asyncio
    async def test_create_channel_and_get_type(self, adapter: WebexAdapter) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/rooms":
                data = json.loads(request.content)
                assert data["title"] == "New Webex Space"
                return httpx.Response(200, json={"id": "new-room-123"})
            if request.method == "GET" and request.url.path == "/v1/rooms/new-room-123":
                return httpx.Response(200, json={"id": "new-room-123", "type": "group"})
            return httpx.Response(404)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        ch_id = await adapter.create_channel("New Webex Space", "Topic")
        assert ch_id == "new-room-123"

        ch_type = await adapter.get_channel_type("new-room-123")
        assert ch_type == "channel_public"

    @pytest.mark.asyncio
    async def test_add_users_to_channel(self, adapter: WebexAdapter) -> None:
        added_members: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/memberships"
            added_members.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "mem-1"})

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        await adapter.add_users_to_channel(
            "space-123",
            user_names=["alice", "bob"],
            user_external_ids=["alice@company.com", "user-id-bob"],
        )
        assert len(added_members) == 2
        assert added_members[0] == {
            "roomId": "space-123",
            "personEmail": "alice@company.com",
        }
        assert added_members[1] == {"roomId": "space-123", "personId": "user-id-bob"}

    @pytest.mark.asyncio
    async def test_attachment_action_dispatches_inbound_interaction(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/attachment/actions/action-submit-123":
                return httpx.Response(
                    200,
                    json={
                        "id": "action-submit-123",
                        "roomId": "space-1",
                        "personId": "user-clicker",
                        "messageId": "card-msg-999",
                        "inputs": {"action_id": "approve", "value": "req-123"},
                    },
                )
            return httpx.Response(404)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        received_interactions: list[InboundInteraction] = []

        async def on_interaction(interaction: InboundInteraction) -> None:
            received_interactions.append(interaction)

        adapter.set_interaction_handler(on_interaction)

        payload = {
            "resource": "attachmentActions",
            "event": "created",
            "data": {"id": "action-submit-123"},
        }
        await adapter.dispatch_event(envelope_type="attachmentActions", payload=payload)

        assert len(received_interactions) == 1
        interaction = received_interactions[0]
        assert interaction.channel_id == "space-1"
        assert interaction.sender_id == "user-clicker"
        assert interaction.action_id == "approve"
        assert interaction.value == "req-123"
        assert interaction.message_ref == "card-msg-999"

    @pytest.mark.asyncio
    async def test_send_attachment(self, adapter: WebexAdapter) -> None:
        uploaded_parts: list[bytes] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/messages":
                uploaded_parts.append(request.content)
                return httpx.Response(200, json={"id": "msg-file-sent"})
            return httpx.Response(404)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        msg_ref = await adapter.send_attachment(
            channel_id="space-1",
            sender_name="Claude Code",
            filename="diff.patch",
            mimetype="text/x-diff",
            data=b"--- a/file\n+++ b/file\n",
            caption="Here is the patch",
            thread_root_id="root-123",
        )

        assert msg_ref == "msg-file-sent"
        assert len(uploaded_parts) == 1
        # Multipart content carries the file bytes and fields
        assert b"diff.patch" in uploaded_parts[0]
        assert b"--- a/file" in uploaded_parts[0]
        assert b"Here is the patch" in uploaded_parts[0]
        assert b"root-123" in uploaded_parts[0]

    @pytest.mark.asyncio
    async def test_inbound_file_download_and_size_limit(
        self, adapter: WebexAdapter
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/people/me":
                return httpx.Response(
                    200,
                    json={
                        "id": BOT_ID,
                        "displayName": BOT_NAME,
                        "emails": [BOT_EMAIL],
                    },
                )
            if request.url.path == "/v1/messages/msg-with-file":
                return httpx.Response(
                    200,
                    json={
                        "id": "msg-with-file",
                        "roomId": "space-1",
                        "personId": "user-sender",
                        "personEmail": "alice@company.com",
                        "text": "Check this file",
                        "files": [
                            "https://webexapis.com/v1/contents/file-valid",
                            "https://webexapis.com/v1/contents/file-too-large",
                        ],
                    },
                )
            if request.url.path == "/v1/contents/file-valid":
                return httpx.Response(
                    200,
                    content=b"hello file content",
                    headers={
                        "content-disposition": 'attachment; filename="notes.txt"',
                        "content-type": "text/plain; charset=utf-8",
                    },
                )
            if request.url.path == "/v1/contents/file-too-large":
                # Exceed 100MB limit
                large_bytes = b"0" * (101 * 1024 * 1024)
                return httpx.Response(
                    200,
                    content=large_bytes,
                    headers={"content-type": "application/octet-stream"},
                )
            return httpx.Response(404)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        received_messages: list[InboundMessage] = []

        async def on_message(msg: InboundMessage) -> None:
            received_messages.append(msg)

        await adapter.start(
            on_message=on_message,
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        payload = {
            "resource": "messages",
            "event": "created",
            "data": {"id": "msg-with-file"},
        }
        await adapter.dispatch_event(envelope_type="messages", payload=payload)

        assert len(received_messages) == 1
        msg = received_messages[0]
        # Valid file was downloaded
        assert len(msg.attachments) == 1
        assert msg.attachments[0].filename == "notes.txt"
        assert msg.attachments[0].mimetype == "text/plain"
        assert msg.attachments[0].data == b"hello file content"

        # Too-large file produced AttachmentFailure
        assert len(msg.attachment_failures) == 1
        assert "exceeds limit" in msg.attachment_failures[0].reason

    @pytest.mark.asyncio
    async def test_inbound_ssrf_file_rejected(self, adapter: WebexAdapter) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/people/me":
                return httpx.Response(200, json={"id": BOT_ID})
            if request.url.path == "/v1/messages/msg-ssrf":
                return httpx.Response(
                    200,
                    json={
                        "id": "msg-ssrf",
                        "roomId": "space-1",
                        "personId": "user-sender",
                        "files": ["http://169.254.169.254/latest/meta-data/"],
                    },
                )
            return httpx.Response(404)

        adapter._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url=WEBEX_API_BASE
        )

        received_messages: list[InboundMessage] = []

        async def on_message(msg: InboundMessage) -> None:
            received_messages.append(msg)

        await adapter.start(
            on_message=on_message,
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        payload = {
            "resource": "messages",
            "event": "created",
            "data": {"id": "msg-ssrf"},
        }
        await adapter.dispatch_event(envelope_type="messages", payload=payload)

        assert len(received_messages) == 1
        msg = received_messages[0]
        assert len(msg.attachments) == 0
        assert len(msg.attachment_failures) == 1
        assert "untrusted file URL host" in msg.attachment_failures[0].reason

    @pytest.mark.asyncio
    async def test_verify_credentials_checks_bot_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.headers.get("Authorization") == "Bearer valid-token":
                return httpx.Response(200, json={"id": "bot-id"})
            return httpx.Response(401, json={"message": "Unauthorized"})

        orig_async_client = httpx.AsyncClient
        transport = httpx.MockTransport(handler)

        def mock_client(*args: object, **kwargs: object) -> httpx.AsyncClient:
            return orig_async_client(transport=transport, base_url=WEBEX_API_BASE)

        monkeypatch.setattr(httpx, "AsyncClient", mock_client)

        # Valid credentials
        await WebexAdapter.verify_credentials({"bot_token": "valid-token"})

        # Invalid credentials
        with pytest.raises(
            BridgeCredentialError, match="Invalid Webex Bot Access Token"
        ):
            await WebexAdapter.verify_credentials({"bot_token": "invalid-token"})

        # Missing token
        with pytest.raises(
            BridgeCredentialError, match="Missing Webex Bot Access Token"
        ):
            await WebexAdapter.verify_credentials({})
