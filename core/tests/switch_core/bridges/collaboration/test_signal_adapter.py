"""Tests for Signal collaboration adapter and client."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.bridges.collaboration.signal.chunking import chunk_message
from switch_core.bridges.collaboration.signal.client import (
    ProofRequiredException,
    RateLimitException,
    SignalRpcClient,
    UntrustedIdentityException,
)


class TestSignalConnectionConfig:
    def test_valid_config(self) -> None:
        cfg = SignalConnectionConfig(
            endpoint_url="http://127.0.0.1:8080",
            account="+1234567890",
        )
        assert cfg.endpoint_url == "http://127.0.0.1:8080"
        assert cfg.account == "+1234567890"

    def test_strip_trailing_slash(self) -> None:
        cfg = SignalConnectionConfig(
            endpoint_url="http://127.0.0.1:8080/",
            account="+1234567890",
        )
        assert cfg.endpoint_url == "http://127.0.0.1:8080"

    def test_invalid_scheme(self) -> None:
        with pytest.raises(ValueError, match="http or https"):
            SignalConnectionConfig(
                endpoint_url="ftp://127.0.0.1:8080",
                account="+1234567890",
            )

    def test_empty_account(self) -> None:
        with pytest.raises(ValueError, match="account cannot be empty"):
            SignalConnectionConfig(
                endpoint_url="http://127.0.0.1:8080",
                account="   ",
            )


class TestSignalRpcClient:
    @pytest.fixture
    def client(self) -> SignalRpcClient:
        return SignalRpcClient("http://127.0.0.1:8080", "+1234567890")

    async def test_rpc_call_success(self, client: SignalRpcClient) -> None:
        mock_response = httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": "sw-1", "result": {"timestamp": 123456789}},
            request=httpx.Request("POST", "http://127.0.0.1:8080/api/v1/rpc"),
        )
        with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response
            res = await client.rpc_call("send", {"message": "hi"})

            assert res == {"timestamp": 123456789}
            mock_post.assert_called_once()
            call_json = mock_post.call_args[1]["json"]
            assert call_json["jsonrpc"] == "2.0"
            assert call_json["method"] == "send"
            assert call_json["params"] == {"message": "hi"}

    async def test_rpc_call_untrusted_identity_error(self, client: SignalRpcClient) -> None:
        mock_response = httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": "sw-1",
                "error": {"code": -1, "message": "Untrusted identity for +123"},
            },
            request=httpx.Request("POST", "http://127.0.0.1:8080/api/v1/rpc"),
        )
        with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response
            with pytest.raises(UntrustedIdentityException):
                await client.rpc_call("send", {})

    async def test_rpc_call_proof_required_error(self, client: SignalRpcClient) -> None:
        mock_response = httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": "sw-1",
                "error": {"code": -1, "message": "Proof required: challenge token"},
            },
            request=httpx.Request("POST", "http://127.0.0.1:8080/api/v1/rpc"),
        )
        with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response
            with pytest.raises(ProofRequiredException):
                await client.rpc_call("send", {})

    async def test_rpc_call_rate_limit_error(self, client: SignalRpcClient) -> None:
        mock_response = httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": "sw-1",
                "error": {"code": -32000, "message": "Rate limit exceeded"},
            },
            request=httpx.Request("POST", "http://127.0.0.1:8080/api/v1/rpc"),
        )
        with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response
            with pytest.raises(RateLimitException):
                await client.rpc_call("send", {})

    async def test_send_message_direct(self, client: SignalRpcClient) -> None:
        with patch.object(client, "rpc_call", new_callable=AsyncMock) as mock_rpc:
            mock_rpc.return_value = {"timestamp": 1729760000000}
            ts = await client.send_message(
                "hello",
                recipient="+1987654321",
                quote_timestamp=1729759900000,
                quote_author="+1987654321",
                quote_message="original text",
            )
            assert ts == 1729760000000
            mock_rpc.assert_called_once_with(
                "send",
                {
                    "message": "hello",
                    "recipient": ["+1987654321"],
                    "quoteTimestamp": 1729759900000,
                    "quoteAuthor": "+1987654321",
                    "quoteMessage": "original text",
                },
            )

    async def test_send_message_group(self, client: SignalRpcClient) -> None:
        with patch.object(client, "rpc_call", new_callable=AsyncMock) as mock_rpc:
            mock_rpc.return_value = {"timestamp": 1729760000000}
            ts = await client.send_message("group hello", group_id="base64groupid==")
            assert ts == 1729760000000
            mock_rpc.assert_called_once_with(
                "send",
                {
                    "message": "group hello",
                    "groupId": "base64groupid==",
                },
            )

    async def test_send_reaction(self, client: SignalRpcClient) -> None:
        with patch.object(client, "rpc_call", new_callable=AsyncMock) as mock_rpc:
            mock_rpc.return_value = None
            await client.send_reaction(
                emoji="👍",
                target_author="+1987654321",
                target_timestamp=1729759900000,
                recipient="+1987654321",
                remove=False,
            )
            mock_rpc.assert_called_once_with(
                "sendReaction",
                {
                    "emoji": "👍",
                    "targetAuthor": "+1987654321",
                    "targetTimestamp": 1729759900000,
                    "remove": False,
                    "recipient": "+1987654321",
                },
            )

    async def test_send_typing(self, client: SignalRpcClient) -> None:
        with patch.object(client, "rpc_call", new_callable=AsyncMock) as mock_rpc:
            mock_rpc.return_value = None
            await client.send_typing(recipient="+1987654321", stop=False)
            mock_rpc.assert_called_once_with(
                "sendTyping",
                {
                    "recipient": "+1987654321",
                    "stop": False,
                },
            )

    async def test_get_attachment(self, client: SignalRpcClient) -> None:
        with patch.object(client, "rpc_call", new_callable=AsyncMock) as mock_rpc:
            mock_rpc.return_value = "aGVsbG8="  # "hello" base64
            data = await client.get_attachment("att-1", recipient="+1987654321")
            assert data == b"hello"
            mock_rpc.assert_called_once_with(
                "getAttachment",
                {"id": "att-1", "recipient": "+1987654321"},
            )

    async def test_stream_events_parser(self, client: SignalRpcClient) -> None:
        sse_lines = [
            ": keep-alive comment",
            "id: event-42",
            'data: {"envelope": {"source": "+111", "dataMessage": {"message": "test"}}}',
            "",
            "id: event-43",
            'data: {"envelope": {"source": "+222", "dataMessage": {"message": "second"}}}',
            "",
        ]

        class FakeStreamResponse:
            def __init__(self, lines: list[str]) -> None:
                self.lines = lines

            def raise_for_status(self) -> None:
                pass

            async def aiter_lines(self):
                for line in self.lines:
                    yield line

        class FakeAsyncContext:
            async def __aenter__(self):
                return FakeStreamResponse(sse_lines)

            async def __aexit__(self, *args):
                pass

        with patch.object(client._client, "stream", return_value=FakeAsyncContext()):
            events = []
            async for ev_id, payload in client.stream_events():
                events.append((ev_id, payload))

            assert len(events) == 2
            assert events[0][0] == "event-42"
            assert events[0][1]["envelope"]["source"] == "+111"
            assert events[1][0] == "event-43"
            assert events[1][1]["envelope"]["source"] == "+222"


class TestSignalAdapter:
    @pytest.fixture
    def adapter(self) -> SignalAdapter:
        cfg = SignalConnectionConfig(
            endpoint_url="http://127.0.0.1:8080",
            account="+1234567890",
        )
        return SignalAdapter(config=cfg)

    def test_capabilities(self, adapter: SignalAdapter) -> None:
        assert adapter.display_name == "Signal"
        assert adapter.keeps_quiet_unless_listening is True
        assert adapter.receives_webhooks is False
        assert adapter.supports_channel_creation is False
        assert adapter.supports_directory_search is False
        assert adapter.supports_activity_reactions is True
        assert adapter.outbound_urls({"endpoint_url": "http://127.0.0.1:8080"}) == [
            "http://127.0.0.1:8080"
        ]

    def test_classify_failure(self, adapter: SignalAdapter) -> None:
        assert (
            adapter.classify_failure(UntrustedIdentityException(-1, "untrusted"))
            == "auth_failed"
        )
        assert (
            adapter.classify_failure(ProofRequiredException(-1, "challenge"))
            == "platform_error"
        )
        assert (
            adapter.classify_failure(RateLimitException(-1, "rate limit"))
            == "platform_error"
        )
        assert (
            adapter.classify_failure(httpx.ConnectError("refused"))
            == "network"
        )

    async def test_start_unhealthy_raises_credential_error(
        self, adapter: SignalAdapter
    ) -> None:
        with patch.object(adapter._client, "check_health", new_callable=AsyncMock) as mock_health:
            mock_health.return_value = False
            with pytest.raises(BridgeCredentialError):
                await adapter.start(
                    AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
                )

    async def test_process_event_direct_message(self, adapter: SignalAdapter) -> None:
        received_messages: list[InboundMessage] = []

        async def on_message(msg: InboundMessage) -> None:
            received_messages.append(msg)

        adapter._on_message = on_message

        event = {
            "envelope": {
                "source": "+1987654321",
                "sourceName": "Alice",
                "dataMessage": {
                    "timestamp": 1729760000000,
                    "message": "Hello Switch",
                },
            }
        }

        await adapter._process_event(event)

        assert len(received_messages) == 1
        msg = received_messages[0]
        assert msg.sender_id == "+1987654321"
        assert msg.sender_name == "Alice"
        assert msg.content == "Hello Switch"
        assert msg.channel_id == "+1987654321"
        assert msg.channel_type == "direct"
        assert msg.message_ref == "+1234567890:signal:direct:+1987654321:+1987654321:1729760000000"

    async def test_process_event_command(self, adapter: SignalAdapter) -> None:
        received_commands: list[InboundCommand] = []

        async def on_command(cmd: InboundCommand) -> None:
            received_commands.append(cmd)

        adapter._on_command = on_command

        event = {
            "envelope": {
                "source": "+1987654321",
                "sourceName": "Alice",
                "dataMessage": {
                    "timestamp": 1729760000000,
                    "message": "!help run",
                },
            }
        }

        await adapter._process_event(event)

        assert len(received_commands) == 1
        cmd = received_commands[0]
        assert cmd.command == "help"
        assert cmd.args == "run"
        assert cmd.sender_id == "+1987654321"

    async def test_process_event_self_filter(self, adapter: SignalAdapter) -> None:
        received_messages: list[InboundMessage] = []

        async def on_message(msg: InboundMessage) -> None:
            received_messages.append(msg)

        adapter._on_message = on_message

        # Message sent by the bot's own account
        event = {
            "envelope": {
                "source": "+1234567890",
                "dataMessage": {
                    "timestamp": 1729760000000,
                    "message": "My own message",
                },
            }
        }

        await adapter._process_event(event)
        assert len(received_messages) == 0

    async def test_send_message_with_quote_and_chunking(
        self, adapter: SignalAdapter
    ) -> None:
        adapter._quote_cache[("+1987654321", 1729759900000)] = ("+1987654321", "prior text")

        with patch.object(adapter._client, "send_message", new_callable=AsyncMock) as mock_send:
            mock_send.return_value = 1729760000123
            sent_id = await adapter.send_message(
                channel_id="+1987654321",
                sender_name="Claude",
                content="Response text",
                thread_root_id="1729759900000",
            )

            assert sent_id == "1729760000123"
            mock_send.assert_called_once_with(
                "[Claude] Response text",
                recipient="+1987654321",
                group_id=None,
                quote_timestamp=1729759900000,
                quote_author="+1987654321",
                quote_message="prior text",
            )


class TestSignalChunking:
    def test_short_message(self) -> None:
        assert chunk_message("hello") == ["hello"]

    def test_empty_message(self) -> None:
        assert chunk_message("") == [""]

    def test_long_message_splits_on_newline(self) -> None:
        first_line = "a" * 1500
        second_line = "b" * 1000
        text = f"{first_line}\n{second_line}"
        chunks = chunk_message(text, limit=2000)
        assert len(chunks) == 2
        assert chunks[0] == first_line
        assert chunks[1] == second_line
