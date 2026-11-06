"""The Signal adapter's inbound path: one SSE event at a time into the room.

Every event is a scrubbed `signal_fixtures/sse_*.json` capture from a live
signal-cli 0.14.9 daemon (2026-11-06). The JSON-RPC side (attachment
downloads) is a real `httpx.AsyncClient` on a recording `MockTransport`;
the stream side is fed `async for` lines, so no live daemon is needed.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from switch_core.bridges.collaboration.signal import inbound as sse_inbound
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.bridges.collaboration.signal.rpc import SignalRpcClient

FIXTURES = Path(__file__).parent / "signal_fixtures"
_ACCOUNT = "+15555550100"
_PEER_UUID = "00000000-0000-4000-8000-000000000002"
_PEER = "+15555550200"
_GROUP_ID = "c3dpdGNoLWdyb3VwLTE="
_GROUPS = ("c3dpdGNoLWdyb3VwLTI=",)
_TS = 1793948571285


class _RecordingTransport:
    """Canned JSON-RPC answers, in call order, with every request recorded."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("more RPC calls than canned responses")
        next_response = self.responses.pop(0)
        if isinstance(next_response, Exception):
            raise next_response
        return next_response

    def last_json(self) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.requests[-1].content))


def _rpc_result(result: Any) -> httpx.Response:
    return httpx.Response(200, json={"jsonrpc": "2.0", "result": result, "id": 1})


def _adapter(
    *responses: httpx.Response | Exception, transport: _RecordingTransport | None = None
) -> tuple[SignalAdapter, _RecordingTransport]:
    recorder = transport if transport is not None else _RecordingTransport(*responses)
    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle))
    adapter = SignalAdapter(
        config=SignalConnectionConfig(
            daemon_url="http://127.0.0.1:8080", account=_ACCOUNT
        )
    )
    adapter._rpc_client = SignalRpcClient(
        daemon_url="http://127.0.0.1:8080", account=_ACCOUNT, http=http
    )
    return adapter, recorder


async def _drive(
    adapter: SignalAdapter, event: sse_inbound.InboundEvent
) -> tuple[list[InboundMessage], list[InboundCommand]]:
    """One event through the adapter's real dispatch path, collecting the
    callbacks `start` would have received."""
    messages: list[InboundMessage] = []
    commands: list[InboundCommand] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    async def on_command(command: InboundCommand) -> None:
        commands.append(command)

    async def on_join(whatever: object) -> None:  # the join hooks are unused
        return None

    adapter._on_message = None
    adapter._on_command = None
    await adapter.start(on_message, on_command, on_join, on_join, on_join)
    adapter._sse_task = None  # this test feeds events by hand, not over SSE
    await adapter._dispatch(event)
    return messages, commands


def _event(path: str) -> sse_inbound.InboundEvent:
    fixture = json.loads((FIXTURES / path).read_text())
    data: dict[str, Any] = cast(dict[str, Any], fixture["data"])
    return sse_inbound.InboundEvent(
        envelope=data["envelope"],
        account=data["account"],
        sse_id=fixture.get("sse_id"),
    )


def _dm_envelope(
    text: str,
    *,
    source: str = _PEER,
    styles: list[dict[str, Any]] | None = None,
    mentions: list[dict[str, Any]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    quote: dict[str, Any] | None = None,
) -> sse_inbound.InboundEvent:
    """A DM event of the same shape the daemon captured, with its own text."""
    data_message: dict[str, Any] = {"timestamp": _TS, "message": text}
    if styles:
        data_message["textStyles"] = styles
    if mentions:
        data_message["mentions"] = mentions
    if attachments:
        data_message["attachments"] = attachments
    if quote:
        data_message["quote"] = quote
    envelope = {
        "source": source,
        "sourceNumber": source,
        "sourceUuid": _PEER_UUID,
        "sourceName": "Alex",
        "sourceDevice": 1,
        "timestamp": _TS,
        "serverReceivedTimestamp": _TS + 100,
        "serverDeliveredTimestamp": _TS + 200,
        "dataMessage": data_message,
    }
    return sse_inbound.InboundEvent(
        envelope=envelope, account=_ACCOUNT, sse_id="285-99"
    )


def _group_envelope(
    event: sse_inbound.InboundEvent, group_id: str = _GROUP_ID
) -> sse_inbound.InboundEvent:
    data = event.envelope["dataMessage"]
    data["groupInfo"] = {
        "groupId": group_id,
        "groupName": "Switch test",
        "revision": 0,
        "type": "DELIVER",
    }
    return event


# ── Event → InboundMessage ────────────────────────────────────────────────────


async def test_a_dm_event_maps_to_the_direct_channel_and_ref() -> None:
    adapter, _ = _adapter()
    messages, _ = await _drive(adapter, _event("sse_dm.json"))

    assert len(messages) == 1
    message = messages[0]
    assert message.channel_id == f"d:{_PEER_UUID}"
    assert message.channel_type == "direct"
    assert message.sender_id == _PEER_UUID
    assert message.sender_name == "Alex"
    assert message.content == "probe dm in"
    # The sender's account id and the message's own Signal timestamp: the same
    # string every redelivery of this event computes, so it dedupes.
    assert message.message_ref == f"{_PEER_UUID}:1013746"
    assert message.root_id is None


async def test_a_group_event_maps_to_the_group_channel_and_name() -> None:
    adapter, _ = _adapter()
    messages, _ = await _drive(adapter, _event("sse_group.json"))

    message = messages[0]
    assert message.channel_id == f"g:{_GROUP_ID}"
    assert message.channel_type == "group"
    assert message.channel_name == "Switch test"
    assert message.content == "probe group in"


async def test_a_quote_reply_carries_the_quoted_ref_as_root() -> None:
    adapter, _ = _adapter()
    messages, _ = await _drive(adapter, _event("sse_quote.json"))

    message = messages[0]
    # The quote's author and id, in Signal's own terms: the answer to a card
    # quote-replyed to it addresses the card's ref, and the core resolves it.
    assert message.root_id == f"{_PEER_UUID}:1021875"
    assert message.content == "probe quote in"
    # The reply's own ref is its own identity, never the target's.
    assert message.message_ref != message.root_id


async def test_an_inbound_style_run_reads_back_as_markdown() -> None:
    adapter, _ = _adapter()
    event = _dm_envelope(
        "probe styled", styles=[{"start": 6, "length": 5, "style": "BOLD"}]
    )
    messages, _ = await _drive(adapter, event)

    assert messages[0].content == "probe **styled**"


async def test_an_inbound_mention_reads_back_as_at_name() -> None:
    adapter, _ = _adapter()
    event = _dm_envelope(
        "hi Alex",
        mentions=[{"start": 3, "length": 4, "name": "Alex", "number": _PEER}],
    )
    messages, _ = await _drive(adapter, event)

    assert messages[0].content == "hi @Alex"


# ── Commands: `!` messages, always with their ref ────────────────────────────


async def test_a_command_event_reaches_the_dispatcher_with_its_ref() -> None:
    adapter, _ = _adapter()
    _, commands = await _drive(adapter, _dm_envelope("!help now"))

    assert len(commands) == 1
    command = commands[0]
    assert command.command == "help"
    assert command.args == "now"
    assert command.channel_id == f"d:{_PEER_UUID}"
    assert command.channel_type == "direct"
    # A redelivery of this command is the same write the router has, so it
    # is never run twice: the post's own ref is carried, not left to None.
    assert command.message_ref == f"{_PEER_UUID}:{_TS}"


async def test_a_command_quoting_a_card_carries_the_card_root() -> None:
    adapter, _ = _adapter()
    _, commands = await _drive(
        adapter, _dm_envelope("!approve yes", quote={"id": 55, "author": _PEER})
    )

    assert commands[0].root_id == f"{_PEER}:55"


async def test_an_ignored_command_leaves_the_room_nothing() -> None:
    # `!help` with no handler: the dispatcher's refusal posts its own
    # notice; the adapter still hands the room the text it was given.
    adapter, _ = _adapter()
    messages, commands = await _drive(adapter, _dm_envelope("!unknown-thing"))

    assert len(commands) == 1
    assert commands[0].command == "unknown-thing"
    assert messages == []


# ── What is not mirrored: the phone shows it, the room does not ─────────────


@pytest.mark.parametrize(
    "fixture",
    [
        "sse_receipt.json",
        "sse_typing.json",
        "sse_edit.json",
        "sse_delete.json",
        "sse_reaction.json",
    ],
)
async def test_receipts_typing_edits_deletes_and_reactions_are_ignored(
    fixture: str,
) -> None:
    adapter, _ = _adapter()
    messages, commands = await _drive(adapter, _event(fixture))
    assert messages == [] and commands == [], f"{fixture} was relayed into the room"


async def test_the_bots_own_account_is_ignored() -> None:
    # signal-cli treats the account's own messages as sync: a second device
    # posting on the bot's number must not feed the room.
    adapter, _ = _adapter()
    messages, _ = await _drive(
        adapter, _dm_envelope("echo from a second device", source=_ACCOUNT)
    )
    assert messages == []


# ── Attachments: through the daemon, capped, and never silently dropped ─────


async def test_an_attachment_event_downloads_through_the_daemon() -> None:
    body = base64.b64encode(b"probe image bytes").decode()
    adapter, recorder = _adapter(_rpc_result({"data": body}))
    messages, _ = await _drive(adapter, _event("sse_attachment.json"))

    message = messages[0]
    assert message.content == ""
    assert len(message.attachments) == 1
    attachment = message.attachments[0]
    assert attachment.filename == "probe-attachment.jpeg"
    assert attachment.mimetype == "image/jpeg"
    assert attachment.data == b"probe image bytes"
    assert message.attachment_failures == []
    # The download is addressed to the sender's number, as the daemon wants.
    assert recorder.last_json()["method"] == "getAttachment"
    assert recorder.last_json()["params"]["recipient"] == _PEER


async def test_a_group_attachment_is_fetched_from_the_group() -> None:
    body = base64.b64encode(b"group photo").decode()
    adapter, recorder = _adapter(_rpc_result({"data": body}))
    event = _group_envelope(
        _dm_envelope(
            "",
            attachments=[
                {
                    "contentType": "image/png",
                    "filename": "g.png",
                    "id": "Zy1waW5n",
                    "size": 9,
                    "isVoiceNote": False,
                }
            ],
        )
    )
    messages, _ = await _drive(adapter, event)

    assert messages[0].attachments[0].data == b"group photo"
    assert recorder.last_json()["params"]["groupId"] == _GROUP_ID
    assert "recipient" not in recorder.last_json()["params"]


async def test_an_oversize_attachment_is_disclosed_not_downloaded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, recorder = _adapter(
        _rpc_result({"data": base64.b64encode(b"x" * 100).decode()})
    )
    adapter.set_max_attachment_bytes(10)
    messages, _ = await _drive(adapter, _event("sse_attachment.json"))

    message = messages[0]
    assert message.attachments == []
    assert len(message.attachment_failures) == 1
    failure = message.attachment_failures[0]
    assert failure.filename == "probe-attachment.jpeg"
    assert "223,709" in failure.reason
    # Refused before the download: no RPC call went out at all.
    assert recorder.requests == []


async def test_a_failed_download_is_named_in_the_room() -> None:
    from switch_core.bridges.collaboration.signal.rpc import SignalRpcError

    adapter, _ = _adapter(SignalRpcError(-1, "Could not find attachment with ID"))
    messages, _ = await _drive(adapter, _event("sse_attachment.json"))

    message = messages[0]
    assert message.attachments == []
    assert len(message.attachment_failures) == 1
    assert "probe-attachment.jpeg" in message.attachment_failures[0].reason


# ── The stream itself ─────────────────────────────────────────────────────────


async def _feed(lines: list[str]) -> AsyncIterator[str]:
    for line in lines:
        yield line


def _sse_lines(fixture_path: str) -> list[str]:
    """One fixture event, in the stream's on-wire `id:/event:/data:` form."""
    fixture = json.loads((FIXTURES / fixture_path).read_text())
    event_id = fixture.get("sse_id")
    lines = []
    if event_id:
        lines.append(f"id:{event_id}")
    lines.append(f"event:{fixture['event']}")
    lines.append(f"data:{json.dumps(fixture['data'])}")
    lines.append("")
    return lines


async def test_the_stream_yields_the_receive_events_and_their_ids() -> None:
    lines = _sse_lines("sse_dm.json") + _sse_lines("sse_group.json")
    events = [event async for event in sse_inbound.parse_sse_stream(_feed(lines))]

    assert [event.sse_id for event in events] == ["285-10", "285-12"]
    assert [event.sender_id for event in events] == [_PEER_UUID, _PEER_UUID]


async def test_an_unreadable_data_line_drops_only_that_event() -> None:
    # A broken event block does not take down the stream: the next event
    # still arrives, and the broken line is a log line, not a crash.
    lines = [
        "id:285-98",
        "event:receive",
        "data:{{not json",
        "",
    ] + _sse_lines("sse_dm.json")
    events = [event async for event in sse_inbound.parse_sse_stream(_feed(lines))]

    assert [event.sse_id for event in events] == ["285-10"]


class _SseRecordingTransport:
    """An SSE stream of canned lines, recording the request it was asked to open."""

    def __init__(self, *lines: str) -> None:
        self.lines = list(lines)
        self.requests: list[httpx.Request] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        body = "".join(line + "\n" for line in self.lines)
        return httpx.Response(
            200, headers={"Content-Type": "text/event-stream"}, text=body
        )


async def test_a_reconnect_sends_the_last_confirmed_id() -> None:
    # Fresh start: `0`, the daemon's word for "replay everything kept".
    # After an event is confirmed, the reconnect's header carries it, so a
    # dropped stream resumes rather than restarting from the top.
    adapter, _ = _adapter()
    lines = _sse_lines("sse_dm.json")
    recorder = _SseRecordingTransport(*lines)
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle))

    events = [event async for event in adapter._sse_events()]
    assert [event.sse_id for event in events] == ["285-10"]
    assert recorder.requests[0].headers["Last-Event-ID"] == "0"

    # One confirmed event, then the stream drops: the next open resumes from it.
    adapter._last_event_id = "285-12"
    async for _ in adapter._sse_events():
        pass
    assert recorder.requests[1].headers["Last-Event-ID"] == "285-12"
    await adapter.stop()


async def test_a_quiet_pod_opens_no_stream() -> None:
    adapter, _ = _adapter()
    adapter.set_listening(False)
    await adapter.start(
        lambda m: _none(),
        lambda c: _none(),
        lambda j: _none(),
        lambda j: _none(),
        lambda j: _none(),
    )
    # No stream task on a quiet pod: nothing the platform delivers over.
    assert adapter._sse_task is None
    await adapter.stop()


async def _none() -> None:
    return None


# ── Two pods, one replay: the ref is computed, not remembered ────────────────


def test_a_second_pod_replaying_the_same_event_computes_the_same_ref() -> None:
    # The whole point of keeping no state in one process: two pods reading the
    # same replay derive the same `message_ref`, so the router dedupes.
    first = sse_inbound.message_ref_of(_event("sse_dm.json"))
    second = sse_inbound.message_ref_of(_event("sse_dm.json"))
    assert first == second


def test_the_outbound_ref_scheme_still_encodes_the_send_side() -> None:
    # A quote-reply on the way out decodes the inbound ref: author + target,
    # the same pair the phone built. No cache in between.
    author, target = SignalAdapter._parse_message_ref(f"{_PEER_UUID}:1021875")
    assert author == _PEER_UUID
    assert target == 1021875


# ── The channel id a quiet pod can still address ─────────────────────────────


async def test_get_channel_type_follows_the_prefix() -> None:
    adapter, _ = _adapter()
    assert await adapter.get_channel_type(f"d:{_PEER_UUID}") == "direct"
    assert await adapter.get_channel_type(f"g:{_GROUP_ID}") == "group"
