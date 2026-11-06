"""The Signal adapter: its config, formatting, and what it sends to and reads
from a signal-cli daemon, mocked at the HTTP transport."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.signal.adapter import (
    MAX_MESSAGE,
    SignalAdapter,
    SignalConnectionConfig,
    SignalRpcError,
    split_message,
    to_signal_text,
)

DAEMON = "http://localhost:8080"
ACCOUNT = "+15550000001"
ALICE = "+919812345678"
ALICE_UUID = "0f6c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
STRANGER = "+447700900123"
GROUP = "Zm9vYmFyZ3JvdXA="


def _config(**overrides: Any) -> SignalConnectionConfig:
    values: dict[str, Any] = {
        "daemon_url": DAEMON,
        "account": ACCOUNT,
        "allowed_senders": f"{ALICE}, {ACCOUNT}",
        "default_agent": "claude",
    }
    values.update(overrides)
    return SignalConnectionConfig.model_validate(values)


class Daemon:
    """signal-cli's HTTP daemon, as far as the adapter calls it."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.events_requests: list[httpx.Request] = []
        self.accounts = [{"number": ACCOUNT}]
        self.error: dict[str, Any] | None = None
        self.status = 200
        self.check_status = 200
        self.stream = b""
        self.attachment = base64.b64encode(b"hello file").decode()
        self.next_ts = 1_700_000_000_000

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/check":
            return httpx.Response(self.check_status)
        if request.url.path == "/api/v1/events":
            self.events_requests.append(request)
            return httpx.Response(
                200, content=self.stream, headers={"content-type": "text/event-stream"}
            )
        assert request.url.path == "/api/v1/rpc"
        body = json.loads(request.content)
        self.calls.append(body)
        if self.status != 200:
            return httpx.Response(self.status, text="broken")
        if self.error:
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": body["id"], "error": self.error}
            )
        method = body["method"]
        result: Any = {}
        if method == "listAccounts":
            result = self.accounts
        elif method == "send":
            self.next_ts += 1
            result = {"timestamp": self.next_ts, "results": [{"type": "SUCCESS"}]}
        elif method == "getAttachment":
            result = {"data": self.attachment}
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": body["id"], "result": result}
        )

    def sent(self, method: str = "send") -> list[dict[str, Any]]:
        return [c["params"] for c in self.calls if c["method"] == method]


@pytest.fixture
def daemon(monkeypatch: pytest.MonkeyPatch) -> Iterator[Daemon]:
    fake = Daemon()
    monkeypatch.setattr(SignalAdapter, "_transport", httpx.MockTransport(fake.handler))
    yield fake


class Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)


async def _ignore(_: Any) -> None:
    return None


async def _started(
    listening: bool = False, **overrides: Any
) -> tuple[SignalAdapter, Heard]:
    adapter = SignalAdapter(config=_config(**overrides))
    adapter.set_listening(listening)
    heard = Heard()
    await adapter.start(heard.message, heard.command, _ignore, _ignore, _ignore)
    return adapter, heard


def _received(
    text: str | None = "hi",
    *,
    source: str = ALICE,
    ts: int = 1_699_999_999_000,
    group: str | None = None,
    **data: Any,
) -> dict[str, Any]:
    message: dict[str, Any] = {"timestamp": ts, "message": text, **data}
    if group:
        message["groupInfo"] = {"groupId": group, "type": "DELIVER"}
    return {
        "jsonrpc": "2.0",
        "method": "receive",
        "params": {
            "account": ACCOUNT,
            "envelope": {
                "source": source,
                "sourceNumber": source,
                "sourceUuid": ALICE_UUID if source == ALICE else None,
                "sourceName": "Alice" if source == ALICE else "Someone",
                "timestamp": ts,
                "dataMessage": message,
            },
        },
    }


def _synced(
    text: str,
    destination: str,
    *,
    ts: int = 1_699_999_999_500,
    group: str | None = None,
) -> dict[str, Any]:
    sent: dict[str, Any] = {
        "timestamp": ts,
        "message": text,
        "destinationNumber": destination,
    }
    if group:
        sent = {"timestamp": ts, "message": text, "groupInfo": {"groupId": group}}
    return {
        "envelope": {
            "source": ACCOUNT,
            "sourceNumber": ACCOUNT,
            "sourceName": "Me",
            "timestamp": ts,
            "syncMessage": {"sentMessage": sent},
        }
    }


# ── Registration and config ──────────────────────────────────────────────────


def test_signal_is_registered() -> None:
    keys = {p.key: p for p in PLATFORMS}
    assert keys["signal"].adapter is SignalAdapter
    assert keys["signal"].config is SignalConnectionConfig
    assert SignalAdapter.display_name == "Signal"
    assert SignalAdapter.keeps_quiet_unless_listening is True
    assert SignalAdapter.supports_channel_creation is False
    assert SignalAdapter.supports_directory_search is False


def test_config_normalises_its_fields() -> None:
    config = _config(
        daemon_url=" http://127.0.0.1:8080/ ",
        allowed_senders=f"{ALICE}\n{ALICE_UUID}",
        default_agent="@claude",
    )
    assert config.daemon_url == "http://127.0.0.1:8080"
    assert config.allowed_senders == f"{ALICE}, {ALICE_UUID}"
    assert config.allowed == {ALICE, ALICE_UUID}
    assert config.default_agent == "claude"
    assert _config(default_agent="  ").default_agent is None


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("daemon_url", "localhost:8080", "http://host:port"),
        ("daemon_url", "ftp://localhost", "http://host:port"),
        ("daemon_url", "http://localhost:8080/api/v1/rpc", "without /api/v1"),
        ("account", "15550000001", "E.164"),
        ("account", "+1 555 000", "E.164"),
        ("allowed_senders", " , ", "at least one"),
        ("allowed_senders", f"{ALICE}, bob", "bob"),
    ],
)
def test_config_refuses_what_it_cannot_use(field: str, value: str, says: str) -> None:
    with pytest.raises(ValidationError, match=says):
        _config(**{field: value})


def test_outbound_urls_name_the_daemon() -> None:
    assert SignalAdapter.outbound_urls({"daemon_url": DAEMON}) == [DAEMON]
    assert SignalAdapter.outbound_urls({}) == []


# ── Credentials ──────────────────────────────────────────────────────────────


async def test_verify_credentials_accepts_a_daemon_serving_the_account(
    daemon: Daemon,
) -> None:
    await SignalAdapter.verify_credentials(_config().model_dump())
    assert daemon.calls[0]["method"] == "listAccounts"


async def test_verify_credentials_refuses_an_account_the_daemon_lacks(
    daemon: Daemon,
) -> None:
    daemon.accounts = [{"number": "+15559999999"}]
    with pytest.raises(BridgeCredentialError, match="not registered or linked"):
        await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_refuses_something_else_on_the_port(
    daemon: Daemon,
) -> None:
    daemon.check_status = 404
    with pytest.raises(BridgeCredentialError, match="--http"):
        await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_explains_a_single_account_daemon(
    daemon: Daemon,
) -> None:
    daemon.error = {"code": -32601, "message": "Method not implemented"}
    with pytest.raises(BridgeCredentialError, match="without -a"):
        await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_explains_no_daemon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(SignalAdapter, "_transport", httpx.MockTransport(refuse))
    with pytest.raises(BridgeCredentialError, match="No signal-cli daemon"):
        await SignalAdapter.verify_credentials(_config().model_dump())


def test_classify_failure() -> None:
    request = httpx.Request("POST", DAEMON)
    assert (
        SignalAdapter.classify_failure(httpx.ConnectError("x", request=request))
        == "network"
    )
    assert SignalAdapter.classify_failure(SignalRpcError(-1, "x")) == "platform_error"
    assert SignalAdapter.classify_failure(ValueError("x")) is None


# ── Formatting ───────────────────────────────────────────────────────────────


def test_markdown_becomes_text_styles() -> None:
    text, styles = to_signal_text("**claude:** a *b* `c` ~~d~~")
    assert text == "claude: a b c d"
    assert styles == ["0:7:BOLD", "10:1:ITALIC", "12:1:MONOSPACE", "14:1:STRIKETHROUGH"]


def test_style_offsets_count_utf16_units() -> None:
    text, styles = to_signal_text("😀 **hi**")
    assert text == "😀 hi"
    assert styles == ["3:2:BOLD"]


def test_code_is_left_alone() -> None:
    text, styles = to_signal_text(
        "```py\nx = a**b**c\n```\nthen `snake_case_name` and **done**"
    )
    assert text == "x = a**b**c\nthen snake_case_name and done"
    assert styles == ["0:11:MONOSPACE", "17:15:MONOSPACE", "37:4:BOLD"]


def test_headings_and_links_are_written_plainly() -> None:
    text, styles = to_signal_text("## Plan\nSee [the docs](https://example.com).")
    assert text == "Plan\nSee the docs (https://example.com)."
    assert styles == []


def test_split_message_cuts_at_boundaries() -> None:
    para = "word " * 300
    pieces = split_message(f"{para}\n\n{para}")
    assert all(len(p) <= MAX_MESSAGE for p in pieces)
    assert len(pieces) == 2
    assert split_message("x" * (MAX_MESSAGE + 5)) == ["x" * MAX_MESSAGE, "xxxxx"]


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_direct_message_reaches_the_room() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_received("hello there"))
    [message] = heard.messages
    assert message.channel_id == ALICE
    assert message.channel_type == "direct"
    assert message.sender_id == ALICE
    assert message.sender_name == "Alice"
    assert message.content == "hello there"
    assert message.message_ref == f"1699999999000:{ALICE}"
    assert message.root_id is None


async def test_a_group_message_lands_in_the_groups_room() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_received("hi all", group=GROUP))
    [message] = heard.messages
    assert message.channel_id == f"group.{GROUP}"
    assert message.channel_type == "channel_private"
    assert await adapter.get_channel_type(message.channel_id) == "channel_private"
    assert await adapter.get_channel_type(ALICE) == "direct"


async def test_a_quote_is_a_reply_in_the_quoted_messages_thread() -> None:
    adapter, heard = await _started()
    quote = {"id": 1_699_000_000_000, "authorNumber": ACCOUNT, "text": "earlier"}
    await adapter.handle_event(_received("following up", quote=quote))
    assert heard.messages[0].root_id == f"1699000000000:{ACCOUNT}"


async def test_mentions_are_written_back_as_names() -> None:
    adapter, heard = await _started()
    mention = {"name": "Bob", "number": "+15551112222", "start": 3, "length": 1}
    await adapter.handle_event(_received("hi ￼, look", mentions=[mention]))
    assert heard.messages[0].content == "hi @Bob, look"


async def test_strangers_are_ignored() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_received("let me in", source=STRANGER))
    assert heard.messages == []
    assert heard.commands == []


async def test_a_sender_can_be_allowed_by_account_id() -> None:
    adapter, heard = await _started(allowed_senders=ALICE_UUID)
    await adapter.handle_event(_received("hi"))
    assert len(heard.messages) == 1


async def test_bang_commands_become_commands() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_received("!invite-agent  claude "))
    [command] = heard.commands
    assert command.command == "invite-agent"
    assert command.args == "claude"
    assert command.channel_id == ALICE
    assert heard.messages == []


async def test_receipts_and_typing_are_ignored() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(
        {"envelope": {"source": ALICE, "receiptMessage": {"isRead": True}}}
    )
    await adapter.handle_event(
        {"envelope": {"source": ALICE, "typingMessage": {"action": "STARTED"}}}
    )
    await adapter.handle_event({"nonsense": True})
    assert heard.messages == []


async def test_note_to_self_from_the_owners_phone_reaches_the_room() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_synced("hello agent", ACCOUNT))
    [message] = heard.messages
    assert message.channel_id == ACCOUNT
    assert message.sender_id == ACCOUNT
    assert message.message_ref == f"1699999999500:{ACCOUNT}"


async def test_what_the_owner_writes_to_others_stays_private() -> None:
    adapter, heard = await _started()
    await adapter.handle_event(_synced("dinner at 8?", STRANGER))
    await adapter.handle_event(_synced("hi family", "", group=GROUP))
    assert heard.messages == []
    # A chat with someone on the allow-list does reach Switch.
    await adapter.handle_event(_synced("over to you", ALICE))
    assert [m.channel_id for m in heard.messages] == [ALICE]


async def test_the_owner_is_ignored_unless_allowed() -> None:
    adapter, heard = await _started(allowed_senders=ALICE)
    await adapter.handle_event(_synced("hello agent", ACCOUNT))
    assert heard.messages == []


async def test_attachments_are_downloaded(daemon: Daemon) -> None:
    adapter, heard = await _started()
    item = {
        "id": "att1.png",
        "filename": "photo.png",
        "contentType": "image/png",
        "size": 10,
    }
    await adapter.handle_event(_received("look", attachments=[item]))
    [message] = heard.messages
    [attachment] = message.attachments
    assert attachment.filename == "photo.png"
    assert attachment.mimetype == "image/png"
    assert attachment.data == b"hello file"
    assert daemon.sent("getAttachment") == [
        {"account": ACCOUNT, "id": "att1.png", "recipient": [ALICE]}
    ]


async def test_oversized_or_unfetchable_attachments_are_reported(
    daemon: Daemon,
) -> None:
    adapter, heard = await _started()
    huge = {
        "id": "big",
        "filename": "big.mov",
        "contentType": "video/quicktime",
        "size": 10**10,
    }
    await adapter.handle_event(_received(None, attachments=[huge]))
    daemon.error = {"code": -1, "message": "gone"}
    gone = {
        "id": "gone",
        "filename": "gone.pdf",
        "contentType": "application/pdf",
        "size": 5,
    }
    await adapter.handle_event(_received(None, ts=2, attachments=[gone]))
    failures = [f for m in heard.messages for f in m.attachment_failures]
    assert [f.filename for f in failures] == ["big.mov", "gone.pdf"]
    assert "larger" in failures[0].reason
    assert "gone" in failures[1].reason


# ── The event stream ─────────────────────────────────────────────────────────


def _sse(*events: tuple[str, dict[str, Any]]) -> bytes:
    out = ": keep-alive\n\n"
    for event_id, payload in events:
        out += f"id: {event_id}\nevent: receive\ndata: {json.dumps(payload)}\n\n"
    return out.encode()


async def test_the_event_stream_is_read_and_resumed(daemon: Daemon) -> None:
    daemon.stream = _sse(("7", _received("one")), ("8", _received("two", ts=2)))
    adapter = SignalAdapter(config=_config())
    events = [e async for e in adapter._events()]
    assert [e["params"]["envelope"]["dataMessage"]["message"] for e in events] == [
        "one",
        "two",
    ]
    assert daemon.events_requests[0].url.params["account"] == ACCOUNT
    assert "last-event-id" not in daemon.events_requests[0].headers
    _ = [e async for e in adapter._events()]
    assert daemon.events_requests[1].headers["last-event-id"] == "8"


async def test_a_listening_adapter_delivers_from_the_stream(daemon: Daemon) -> None:
    daemon.stream = _sse(("1", _received("streamed")))
    adapter, heard = await _started(listening=True)
    for _ in range(100):
        if heard.messages:
            break
        await asyncio.sleep(0.01)
    await adapter.stop()
    assert heard.messages[0].content == "streamed"


async def test_a_quiet_adapter_opens_no_stream(daemon: Daemon) -> None:
    adapter, _ = await _started(listening=False)
    await asyncio.sleep(0.02)
    await adapter.stop()
    assert daemon.events_requests == []


# ── Outbound ─────────────────────────────────────────────────────────────────


async def test_send_message_names_the_agent_and_styles_the_text(daemon: Daemon) -> None:
    adapter, _ = await _started()
    ref = await adapter.send_message(ALICE, "claude", "Done: **3** files")
    [params] = daemon.sent()
    assert params == {
        "account": ACCOUNT,
        "recipient": [ALICE],
        "message": "claude: Done: 3 files",
        "textStyle": ["0:7:BOLD", "14:1:BOLD"],
    }
    assert ref == f"{daemon.next_ts}:{ACCOUNT}"


async def test_send_message_to_a_group_quotes_the_thread_root(daemon: Daemon) -> None:
    adapter, _ = await _started()
    await adapter.send_message(
        f"group.{GROUP}", "claude", "on it", f"1699000000000:{ALICE}"
    )
    [params] = daemon.sent()
    assert params["groupId"] == GROUP
    assert "recipient" not in params
    assert params["quoteTimestamp"] == 1_699_000_000_000
    assert params["quoteAuthor"] == ALICE


async def test_a_long_reply_goes_as_several_messages(daemon: Daemon) -> None:
    adapter, _ = await _started()
    first_ts = daemon.next_ts + 1
    ref = await adapter.send_message(ALICE, "claude", "word " * 900, "1:" + ALICE)
    sent = daemon.sent()
    assert len(sent) == 3
    assert all(len(p["message"]) <= MAX_MESSAGE for p in sent)
    assert "quoteTimestamp" in sent[0]
    assert "quoteTimestamp" not in sent[1]
    assert ref == f"{first_ts}:{ACCOUNT}"


async def test_update_message_edits_the_accounts_own_message(daemon: Daemon) -> None:
    adapter, _ = await _started()
    await adapter.update_message(ALICE, f"1700000000123:{ACCOUNT}", "now *better*")
    await adapter.update_message(ALICE, f"1700000000123:{ALICE}", "not mine")
    [params] = daemon.sent()
    assert params["editTimestamp"] == 1_700_000_000_123
    assert params["message"] == "now better"
    assert params["textStyle"] == ["4:6:ITALIC"]


async def test_delete_message_deletes_for_everyone(daemon: Daemon) -> None:
    adapter, _ = await _started()
    await adapter.delete_message(f"group.{GROUP}", f"1700000000123:{ACCOUNT}")
    await adapter.delete_message(ALICE, f"1700000000123:{ALICE}")
    assert daemon.sent("remoteDelete") == [
        {"account": ACCOUNT, "targetTimestamp": 1_700_000_000_123, "groupId": GROUP}
    ]


async def test_send_typing_starts_and_stops(daemon: Daemon) -> None:
    adapter, _ = await _started()
    await adapter.send_typing(ALICE, "claude", True)
    await adapter.send_typing(ALICE, "claude", False)
    assert [p["stop"] for p in daemon.sent("sendTyping")] == [False, True]
    daemon.error = {"code": -1, "message": "nope"}
    await adapter.send_typing(ALICE, "claude", True)  # never raises


async def test_send_attachment_uploads_a_data_uri(daemon: Daemon) -> None:
    adapter, _ = await _started()
    ref = await adapter.send_attachment(
        ALICE, "claude", "re;port.txt", "text/plain", b"abc", caption="here"
    )
    [params] = daemon.sent()
    assert params["attachments"] == ["data:text/plain;filename=re_port.txt;base64,YWJj"]
    assert params["message"] == "claude: here"
    assert ref is not None


async def test_an_rpc_error_is_an_operation_error(daemon: Daemon) -> None:
    adapter, _ = await _started()
    daemon.error = {"code": -1, "message": "Unregistered user"}
    with pytest.raises(BridgeOperationError, match="Unregistered user"):
        await adapter.send_message(ALICE, "claude", "hi")
    daemon.error = None
    daemon.status = 500
    with pytest.raises(BridgeOperationError, match="500"):
        await adapter.send_message(ALICE, "claude", "hi")


# ── Conversations ────────────────────────────────────────────────────────────


async def test_conversations_start_on_signal() -> None:
    adapter, _ = await _started()
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("room", "topic")
    assert await adapter.add_users_to_channel(ALICE, ["bob"], ["+15551112222"]) == [
        "+15551112222"
    ]
    assert await adapter.get_channel_agent_names(ALICE) == ["claude"]
    no_default, _ = await _started(default_agent=None)
    assert await no_default.get_channel_agent_names(ALICE) == []
