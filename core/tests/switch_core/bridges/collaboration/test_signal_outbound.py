"""The Signal adapter's outbound path: the daemon calls it makes.

The daemon is a real `httpx.AsyncClient` on a recording `MockTransport`
seeded into the adapter's `SignalRpcClient`, so the tests assert the exact
JSON-RPC params a `send` / `remoteDelete` / `sendTyping` puts on the wire —
the address, the quote/edit/delete targets, the `textStyle` ranges, and the
message ref that comes back.
"""

from __future__ import annotations

import json
from typing import Any, cast

import httpx
import pytest

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.signal.adapter import (
    MAX_ATTACHMENT_BYTES,
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.bridges.collaboration.signal.render import CHUNK_MAX
from switch_core.bridges.collaboration.signal.rpc import SignalRpcClient

from .session_fixtures import open_request

_ACCOUNT = "+15555550100"
_PEER_UUID = "00000000-0000-4000-8000-000000000002"
_GROUP_ID = "c3dpdGNoLWdyb3VwLTE="
_TS = 1793949560509


class _RecordingTransport:
    """Every request goes in, the daemon's canned result comes back."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "result": {"results": [{}], "timestamp": _TS},
                "id": 1,
            },
        )

    def _raw(self, index: int) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.requests[index].content))

    def method(self, index: int = -1) -> str:
        return self._raw(index)["method"]

    def params(self, index: int = -1) -> dict[str, Any]:
        return cast(dict[str, Any], self._raw(index)["params"])

    def count(self) -> int:
        return len(self.requests)


def _adapter() -> tuple[SignalAdapter, _RecordingTransport]:
    transport = _RecordingTransport()
    http = httpx.AsyncClient(transport=httpx.MockTransport(transport.handle))
    config = SignalConnectionConfig(
        daemon_url="http://127.0.0.1:8080", account=_ACCOUNT
    )
    adapter = SignalAdapter(config=config)
    adapter._rpc_client = SignalRpcClient(
        daemon_url=config.daemon_url, account=config.account, http=http
    )
    return adapter, transport


# ── send_message: the address, the ref, and the styles ───────────────────────


async def test_a_dm_send_addresses_the_recipient_and_returns_the_ref() -> None:
    adapter, transport = _adapter()
    ref = await adapter.send_message(f"d:{_PEER_UUID}", "Ops", "hello")

    params = transport.params()
    assert params["recipient"] == [_PEER_UUID]
    assert "groupId" not in params
    assert "hello" in params["message"]
    assert ref == f"{_ACCOUNT}:{_TS}"


async def test_a_group_send_addresses_the_group_id() -> None:
    adapter, transport = _adapter()
    await adapter.send_message(f"g:{_GROUP_ID}", "Ops", "hi")

    params = transport.params()
    assert params["groupId"] == _GROUP_ID
    assert "recipient" not in params


async def test_a_thread_reply_decodes_the_quote_from_the_root_ref() -> None:
    adapter, transport = _adapter()
    root_ref = f"{_ACCOUNT}:12345"
    await adapter.send_message(
        f"d:{_PEER_UUID}", "Ops", "a reply", thread_root_id=root_ref
    )

    params = transport.params()
    assert params["quoteAuthor"] == _ACCOUNT
    assert params["quoteTimestamp"] == 12345
    # The ref is the reply's own, so a later edit targets the reply not the root.
    assert "hello" not in params["message"]


async def test_a_styled_send_carries_utf16_text_style_ranges() -> None:
    adapter, transport = _adapter()
    await adapter.send_message(f"d:{_PEER_UUID}", "Ops", "🚀 **bold** `code`")

    styles = transport.params()["textStyle"]
    # The name prefix `**Ops**: ` precedes the body. `Ops` is BOLD at 0:3; the
    # 🚀 is two UTF-16 units so the inner `bold` BOLD range lands at 8:4 and
    # the `code` MONOSPACE at 13:4 — offsets counted in code units, not chars.
    assert "0:3:BOLD" in styles
    assert "8:4:BOLD" in styles
    assert "13:4:MONOSPACE" in styles


async def test_a_channel_this_connection_cannot_address_is_refused() -> None:
    adapter, transport = _adapter()
    with pytest.raises(BridgeOperationError, match="not a group"):
        await adapter.send_message("x:bad", "Ops", "hello")
    assert transport.count() == 0


# ── edit and delete ──────────────────────────────────────────────────────────


async def test_an_update_sends_the_same_call_with_an_edit_timestamp() -> None:
    adapter, transport = _adapter()
    await adapter.update_message(f"d:{_PEER_UUID}", f"{_ACCOUNT}:{_TS}", "new text")

    assert transport.method() == "send"
    params = transport.params()
    assert params["editTimestamp"] == _TS
    assert "new text" in params["message"]


async def test_a_delete_sends_remote_delete_of_the_target_timestamp() -> None:
    adapter, transport = _adapter()
    await adapter.delete_message(f"d:{_PEER_UUID}", f"{_ACCOUNT}:{_TS}")

    assert transport.method() == "remoteDelete"
    assert transport.params()["targetTimestamp"] == _TS


# ── typing ───────────────────────────────────────────────────────────────────


async def test_typing_off_sends_stop_on() -> None:
    adapter, transport = _adapter()
    await adapter.send_typing(f"d:{_PEER_UUID}", "Ops", is_typing=False)

    assert transport.method() == "sendTyping"
    assert transport.params()["stop"] is True


async def test_typing_on_sends_no_stop_flag() -> None:
    adapter, transport = _adapter()
    await adapter.send_typing(f"d:{_PEER_UUID}", "Ops", is_typing=True)

    assert "stop" not in transport.params()


# ── attachments ──────────────────────────────────────────────────────────────


async def test_an_oversized_attachment_is_refused_visibly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, transport = _adapter()
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.signal.adapter.MAX_ATTACHMENT_BYTES", 10
    )

    with pytest.raises(BridgeOperationError, match="cap at"):
        await adapter.send_attachment(
            f"d:{_PEER_UUID}", "Ops", "f.bin", "application/octet-stream", b"x" * 20
        )
    assert transport.count() == 0


async def test_a_multi_file_send_goes_out_as_one_call() -> None:
    adapter, transport = _adapter()
    files = [
        OutboundAttachment(filename="a.png", mimetype="image/png", data=b"a"),
        OutboundAttachment(filename="b.txt", mimetype="text/plain", data=b"b"),
    ]
    ref = await adapter.send_attachments(f"d:{_PEER_UUID}", "Ops", files)

    assert transport.count() == 1
    assert len(transport.params()["attachments"]) == 2
    assert ref == f"{_ACCOUNT}:{_TS}"


async def test_an_in_bounds_attachment_sends_a_data_uri() -> None:
    adapter, transport = _adapter()
    await adapter.send_attachment(
        f"d:{_PEER_UUID}", "Ops", "a.png", "image/png", b"\x89PNG"
    )

    params = transport.params()
    assert params["attachments"][0].startswith("data:image/png;")
    assert MAX_ATTACHMENT_BYTES // (1024 * 1024) == 100


# ── membership: what Signal cannot do is disclosed, not faked ───────────────


async def test_users_cannot_be_added_so_they_are_all_handed_back() -> None:
    adapter, _ = _adapter()
    left_out = await adapter.add_users_to_channel(
        f"g:{_GROUP_ID}", ["Alice", "Bob"], ["uuid-a", "uuid-b"]
    )
    assert left_out == ["uuid-a", "uuid-b"]


async def test_channel_creation_is_declared_unsupported() -> None:
    from switch_core.bridges.collaboration.models import ChannelCreationUnsupported

    adapter, _ = _adapter()
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("room", "topic")


# ── session activity: what the phone shows and how it is answered ───────────


async def test_a_request_card_posts_as_text_and_names_its_handle() -> None:
    """Signal has no buttons, so the card is posted through the base text
    fallback and answered by typing the handle the card names — not by a
    control press or a bare yes the platform cannot confirm."""
    adapter, transport = _adapter()
    card = RequestCard(
        open_request(),
        RequestReference(token="tok-signal", handle="R42"),
    )
    ref = await adapter.post_rich(f"d:{_PEER_UUID}", "Ops", card)

    assert ref == f"{_ACCOUNT}:{_TS}"
    assert transport.count() == 1
    params = transport.params()
    # The handle and the typed-answer instruction ride in the text itself.
    assert "R42" in params["message"]
    assert "Reply with" in params["message"]


async def test_a_chunked_send_returns_the_first_chunk_ref_and_edits_it() -> None:
    """A long body splits into sequential posts; the ref is the head's, so a
    later edit or delete targets that one chunk, not the tail."""
    adapter, transport = _adapter()
    body = "word\n" * (CHUNK_MAX * 2)
    ref = await adapter.send_message(f"d:{_PEER_UUID}", "Ops", body)

    chunks = transport.count()
    assert chunks >= 2
    assert ref == f"{_ACCOUNT}:{_TS}"
    assert "quoteTimestamp" not in transport.params(0)

    await adapter.update_message(f"d:{_PEER_UUID}", ref, "edited")
    assert transport.method() == "send"
    assert transport.params()["editTimestamp"] == _TS
    assert transport.count() == chunks + 1
    # The edit is one call, so the tail chunks keep their text.
    await adapter.delete_message(f"d:{_PEER_UUID}", ref)
    assert transport.method() == "remoteDelete"
    assert transport.params()["targetTimestamp"] == _TS
