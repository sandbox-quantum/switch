from __future__ import annotations

import json
from typing import Any, cast

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.bridges.collaboration.signal.chunking import chunk_signal_message
from switch_core.bridges.collaboration.signal.client import (
    SignalEvent,
    SignalRpcClient,
    SignalRpcError,
)


class FakeSignalClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.results: list[Any] = []

    async def rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        include_account: bool = True,
    ) -> Any:
        self.calls.append((method, dict(params or {})))
        return self.results.pop(0) if self.results else {"timestamp": 1234}


def adapter() -> SignalAdapter:
    value = SignalAdapter(
        config=SignalConnectionConfig(
            daemon_url="http://signal-cli:8080", account="+12025550123"
        )
    )
    value._client = cast(SignalRpcClient, FakeSignalClient())
    return value


def test_config_normalises_origin() -> None:
    config = SignalConnectionConfig(
        daemon_url="  http://signal-cli:8080/  ", account=" +12025550123 "
    )
    assert config.daemon_url == "http://signal-cli:8080"
    assert config.account == "+12025550123"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://signal-cli:8080",
        "http://signal-cli:8080/api/v1",
        "http://user:secret@signal-cli:8080",
        "http://signal-cli:8080?token=secret",
    ],
)
def test_config_refuses_unsafe_or_non_origin_url(url: str) -> None:
    with pytest.raises(ValidationError):
        SignalConnectionConfig(daemon_url=url, account="+12025550123")


def test_exclusive_resource_does_not_disclose_account() -> None:
    values = {"daemon_url": "http://signal-cli:8080", "account": "+12025550123"}
    resource = SignalAdapter.exclusive_resource(values)
    assert resource is not None
    assert "+12025550123" not in resource


def test_chunking_prefers_boundaries_and_never_exceeds_limit() -> None:
    chunks = chunk_signal_message("one two three four five", limit=8)
    assert "".join(chunks).replace(" ", "") == "onetwothreefourfive"
    assert all(0 < len(chunk) <= 8 for chunk in chunks)


@pytest.mark.asyncio
async def test_rpc_adds_account_and_returns_result() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"jsonrpc": "2.0", "result": {"ok": True}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = SignalRpcClient(
        daemon_url="http://signal-cli:8080",
        account="+12025550123",
        http=http,
    )
    assert await client.rpc("listGroups") == {"ok": True}
    assert seen["params"]["account"] == "+12025550123"
    await http.aclose()


@pytest.mark.asyncio
async def test_rpc_surfaces_json_rpc_error() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "error": {"code": -32000, "message": "bad"}},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = SignalRpcClient(
        daemon_url="http://signal-cli:8080",
        account="+12025550123",
        http=http,
    )
    with pytest.raises(SignalRpcError, match="bad"):
        await client.rpc("listGroups")
    await http.aclose()


@pytest.mark.asyncio
async def test_sse_parser_preserves_event_id() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b'id: event-7\ndata: {"method":"receive","params":{}}\n\n',
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = SignalRpcClient(
        daemon_url="http://signal-cli:8080",
        account="+12025550123",
        http=http,
    )
    events = [event async for event in client.events(last_event_id="event-6")]
    assert events == [
        SignalEvent(id="event-7", payload={"method": "receive", "params": {}})
    ]
    await http.aclose()


def receive_event(
    *,
    text: str = "hello",
    group_id: str | None = "group-base64=",
    quote: dict[str, Any] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> SignalEvent:
    data: dict[str, Any] = {"timestamp": 1700000000000, "message": text}
    if group_id:
        data["groupInfo"] = {"groupId": group_id}
    if quote:
        data["quote"] = quote
    if attachments:
        data["attachments"] = attachments
    return SignalEvent(
        id="sse-1",
        payload={
            "jsonrpc": "2.0",
            "method": "receive",
            "params": {
                "account": "+12025550123",
                "envelope": {
                    "sourceNumber": "+12025550124",
                    "sourceName": "Ada",
                    "timestamp": 1700000000000,
                    "dataMessage": data,
                },
            },
        },
    )


@pytest.mark.asyncio
async def test_group_message_and_quote_are_translated() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._handle_event(
        receive_event(quote={"id": 1699999999999, "authorNumber": "+12025550125"})
    )
    assert messages[0].channel_id == "group:group-base64="
    assert messages[0].channel_type == "group"
    assert messages[0].sender_name == "Ada"
    assert messages[0].message_ref == "signal:+12025550124:1700000000000"
    assert messages[0].root_id == "signal:+12025550125:1699999999999"


@pytest.mark.asyncio
async def test_direct_message_maps_to_direct_room() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._handle_event(receive_event(group_id=None))
    assert messages[0].channel_id == "direct:+12025550124"
    assert messages[0].channel_type == "direct"


@pytest.mark.asyncio
async def test_command_uses_command_callback() -> None:
    value = adapter()
    commands: list[InboundCommand] = []

    async def on_command(command: InboundCommand) -> None:
        commands.append(command)

    value._on_command = on_command
    await value._handle_event(receive_event(text="!invite-agent ada"))
    assert commands[0].command == "invite-agent"
    assert commands[0].args == "ada"


@pytest.mark.asyncio
async def test_own_account_and_sync_echoes_are_ignored() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    event = receive_event()
    event.payload["params"]["envelope"]["sourceNumber"] = "+12025550123"
    await value._handle_event(event)
    assert messages == []


@pytest.mark.asyncio
async def test_inbound_attachment_download_is_bounded() -> None:
    value = adapter()
    fake = cast(FakeSignalClient, value._client)
    fake.results = [{"data": "aGVsbG8="}]
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._handle_event(
        receive_event(
            attachments=[
                {
                    "id": "attachment-1",
                    "filename": "hello.txt",
                    "contentType": "text/plain",
                    "size": 5,
                }
            ]
        )
    )
    assert messages[0].attachments[0].data == b"hello"
    assert fake.calls[0][0] == "getAttachment"


@pytest.mark.asyncio
async def test_oversized_inbound_attachment_is_visible_failure() -> None:
    value = adapter()
    value.set_max_attachment_bytes(4)
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._handle_event(
        receive_event(attachments=[{"id": "a", "filename": "big.bin", "size": 5}])
    )
    assert messages[0].attachments == []
    assert "larger" in messages[0].attachment_failures[0].reason


@pytest.mark.asyncio
async def test_send_message_targets_group_and_quotes_root() -> None:
    value = adapter()
    fake = cast(FakeSignalClient, value._client)
    fake.results = [{"timestamp": 1700000000001}]
    ref = await value.send_message(
        "group:abc=",
        "Ada",
        "answer",
        "signal:+12025550124:1700000000000",
    )
    assert ref == "signal:+12025550123:1700000000001"
    method, params = fake.calls[0]
    assert method == "send"
    assert params["groupIds"] == ["abc="]
    assert params["quoteAuthor"] == "+12025550124"
    assert params["quoteTimestamp"] == 1700000000000


@pytest.mark.asyncio
async def test_update_and_delete_use_original_timestamp() -> None:
    value = adapter()
    fake = cast(FakeSignalClient, value._client)
    ref = "signal:+12025550123:1700000000001"
    await value.update_message("direct:+12025550124", ref, "edited")
    await value.delete_message("direct:+12025550124", ref)
    assert fake.calls[0] == (
        "send",
        {
            "recipients": ["+12025550124"],
            "message": "edited",
            "editTimestamp": 1700000000001,
        },
    )
    assert fake.calls[1][0] == "remoteDelete"
    assert fake.calls[1][1]["targetTimestamp"] == 1700000000001


@pytest.mark.asyncio
async def test_attachment_refuses_outbound_oversize() -> None:
    value = adapter()
    value.set_max_attachment_bytes(2)
    with pytest.raises(BridgeOperationError, match="larger"):
        await value.send_attachment(
            "direct:+12025550124", "Ada", "big.bin", "application/octet-stream", b"123"
        )


def test_plain_text_rendering_keeps_link_destination() -> None:
    value = adapter()
    assert value._render_outbound("**read** [docs](https://example.com)") == (
        "read docs (https://example.com)"
    )


@pytest.mark.asyncio
async def test_channel_creation_is_explicitly_unsupported() -> None:
    value = adapter()
    with pytest.raises(ValueError, match="must be created"):
        await value.create_channel("room", "topic")


def test_invalid_message_reference_is_refused() -> None:
    with pytest.raises(BridgeOperationError):
        SignalAdapter._parse_message_ref("bad")


def test_message_reference_allows_aci_author() -> None:
    assert SignalAdapter._parse_message_ref("signal:aci:abc-123:1700000000000") == (
        "aci:abc-123",
        1700000000000,
    )
