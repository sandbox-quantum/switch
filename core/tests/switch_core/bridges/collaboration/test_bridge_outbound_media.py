from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import nio
from nio import DownloadError

from switch_core.bridges.collaboration.bridge_core import BridgeCore


def _media_event(
    *,
    msgtype: str = "m.image",
    body: str = "cat.png",
    filename: str | None = None,
    sender: str = "@agent:s",
    sender_name: str | None = "agent-a",
    thread_root: str | None = None,
    group: dict[str, Any] | None = None,
    mimetype: str = "image/png",
    event_id: str = "$media-event",
) -> nio.RoomMessageMedia:
    content: dict[str, Any] = {
        "msgtype": msgtype,
        "body": body,
        "url": "mxc://s/abc",
        "info": {"mimetype": mimetype, "size": 5},
    }
    if group is not None:
        content["com.switch.attachment_group"] = group
    if filename is not None:
        content["filename"] = filename
    if sender_name is not None:
        content["sender_name"] = sender_name
    if thread_root is not None:
        content["m.relates_to"] = {"rel_type": "m.thread", "event_id": thread_root}
    cls = nio.RoomMessageImage if msgtype == "m.image" else nio.RoomMessageFile
    return cls.from_dict(
        {
            "type": "m.room.message",
            "event_id": event_id,
            "sender": sender,
            "origin_server_ts": 1700000000000,
            "content": content,
        }
    )


class _FakeAdapter:
    def __init__(self) -> None:
        self.attachments: list[dict[str, Any]] = []
        self.batches: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []

    def agents_with_live_runtime_state(self, channel_id: str) -> list[str]:
        return []

    async def send_attachment(
        self,
        channel_id,
        sender_name,
        filename,
        mimetype,
        data,
        caption=None,
        thread_root_id=None,
    ):  # noqa: ANN001, ANN201
        self.attachments.append(
            {
                "channel_id": channel_id,
                "sender_name": sender_name,
                "filename": filename,
                "mimetype": mimetype,
                "data": data,
                "caption": caption,
                "thread_root_id": thread_root_id,
            }
        )
        return "ext-ref-1"

    async def send_attachments(
        self, channel_id, sender_name, files, caption=None, thread_root_id=None
    ):  # noqa: ANN001, ANN201
        self.batches.append(
            {
                "channel_id": channel_id,
                "sender_name": sender_name,
                "files": files,
                "caption": caption,
                "thread_root_id": thread_root_id,
            }
        )
        return "ext-ref-3"

    async def send_message(self, channel_id, sender_name, content, thread_root_id=None):  # noqa: ANN001, ANN201
        self.messages.append(
            {
                "channel_id": channel_id,
                "sender_name": sender_name,
                "content": content,
                "thread_root_id": thread_root_id,
            }
        )
        return "ext-ref-2"

    def translate_outbound(self, content: str) -> str:
        return content


def _fake_bridge(
    *,
    download: object = SimpleNamespace(body=b"bytes"),
    matrix_to_external: dict[str, str] | None = None,
    max_bytes: int = 1024,
) -> SimpleNamespace:
    adapter = _FakeAdapter()
    recorded: list[dict[str, str]] = []
    lookup = matrix_to_external or {}

    async def _external_post_for_matrix_event(matrix_event_id: str) -> str | None:
        return lookup.get(matrix_event_id)

    async def _record_message_map(**kwargs: str) -> None:
        recorded.append(kwargs)

    ns = SimpleNamespace(
        _adapter=adapter,
        _puppet_matrix_ids={"@puppet:s"},
        _bridge_client_matrix_user_id="@bridge:s",
        _max_attachment_bytes=max_bytes,
        _external_post_for_matrix_event=_external_post_for_matrix_event,
        _record_message_map=_record_message_map,
        recorded=recorded,
        _outbound_groups={},
        _outbound_group_timers={},
        _indicator_move_timers={},
    )
    ns._find_channel = lambda room_id=None, matrix_room_id=None: (
        "chan-1" if matrix_room_id == "!room:s" else None
    )
    ns._outbound_thread_root_ref = BridgeCore._outbound_thread_root_ref.__get__(ns)
    ns._download_matrix_media = BridgeCore._download_matrix_media.__get__(ns)
    ns._schedule_outbound_group_flush = (
        BridgeCore._schedule_outbound_group_flush.__get__(ns)
    )
    ns._cancel_outbound_group_flush = BridgeCore._cancel_outbound_group_flush.__get__(
        ns
    )
    ns._relay_outbound_group = BridgeCore._relay_outbound_group.__get__(ns)
    ns._move_indicator_for_sender = BridgeCore._move_indicator_for_sender.__get__(ns)
    ns._schedule_indicator_move = BridgeCore._schedule_indicator_move.__get__(ns)
    ns._flush_incomplete_outbound_group = (
        BridgeCore._flush_incomplete_outbound_group.__get__(ns)
    )

    async def _nio_download(mxc: str):
        return download

    ns.client = SimpleNamespace(nio_client=SimpleNamespace(download=_nio_download))
    return ns


def _room() -> SimpleNamespace:
    return SimpleNamespace(room_id="!room:s")


async def test_image_relays_via_send_attachment_and_records_map() -> None:
    bridge = _fake_bridge()

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(), bridge.client
    )

    assert bridge._adapter.attachments == [
        {
            "channel_id": "chan-1",
            "sender_name": "agent-a",
            "filename": "cat.png",
            "mimetype": "image/png",
            "data": b"bytes",
            "caption": None,
            "thread_root_id": None,
        }
    ]
    assert bridge.recorded == [
        {
            "external_channel_id": "chan-1",
            "matrix_event_id": "$media-event",
            "external_post_id": "ext-ref-1",
        }
    ]


async def test_caption_convention_unpacks_body_and_filename() -> None:
    bridge = _fake_bridge()

    await BridgeCore.handle_outbound_media(
        bridge,
        _room(),
        _media_event(body="look at this", filename="plot.png"),
        bridge.client,
    )

    sent = bridge._adapter.attachments[0]
    assert sent["filename"] == "plot.png"
    assert sent["caption"] == "look at this"


async def test_threaded_media_resolves_external_root() -> None:
    bridge = _fake_bridge(matrix_to_external={"$root": "ext-root"})

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(thread_root="$root"), bridge.client
    )

    assert bridge._adapter.attachments[0]["thread_root_id"] == "ext-root"


async def test_puppet_media_is_skipped() -> None:
    # Media a puppet posted originated on the platform — relaying it back
    # would echo it.
    bridge = _fake_bridge()

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(sender="@puppet:s"), bridge.client
    )

    assert bridge._adapter.attachments == []
    assert bridge._adapter.messages == []


async def test_media_without_sender_name_is_skipped() -> None:
    bridge = _fake_bridge()

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(sender_name=None), bridge.client
    )

    assert bridge._adapter.attachments == []
    assert bridge._adapter.messages == []


async def test_non_image_file_relays_natively() -> None:
    """A .pdf / .md / .csv must upload as a real file, not degrade to a text
    notice — that was the reported bug."""
    bridge = _fake_bridge()

    await BridgeCore.handle_outbound_media(
        bridge,
        _room(),
        _media_event(msgtype="m.file", body="report.pdf", mimetype="application/pdf"),
        bridge.client,
    )

    assert bridge._adapter.messages == []
    assert len(bridge._adapter.attachments) == 1
    sent = bridge._adapter.attachments[0]
    assert sent["filename"] == "report.pdf"
    assert sent["mimetype"] == "application/pdf"
    assert sent["data"] == b"bytes"
    assert bridge.recorded[0]["external_post_id"] == "ext-ref-1"


async def test_download_failure_posts_disclosed_fallback() -> None:
    bridge = _fake_bridge(download=DownloadError("boom"))

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(), bridge.client
    )

    assert bridge._adapter.attachments == []
    assert len(bridge._adapter.messages) == 1
    assert "couldn't be relayed" in bridge._adapter.messages[0]["content"]


async def test_oversize_media_posts_disclosed_fallback() -> None:
    bridge = _fake_bridge(download=SimpleNamespace(body=b"too big"), max_bytes=3)

    await BridgeCore.handle_outbound_media(
        bridge, _room(), _media_event(), bridge.client
    )

    assert bridge._adapter.attachments == []
    assert "couldn't be relayed" in bridge._adapter.messages[0]["content"]


async def test_grouped_attachments_relay_as_one_platform_post() -> None:
    """Three files sent as one message must arrive as ONE post carrying all
    three, not three separate posts."""
    bridge = _fake_bridge()
    group_id = "grp-1"

    for index, (name, mimetype) in enumerate(
        [
            ("cat.png", "image/png"),
            ("notes.md", "text/markdown"),
            ("data.csv", "text/csv"),
        ]
    ):
        await BridgeCore.handle_outbound_media(
            bridge,
            _room(),
            _media_event(
                msgtype="m.image" if index == 0 else "m.file",
                body="three files" if index == 0 else name,
                filename=name if index == 0 else None,
                mimetype=mimetype,
                event_id=f"$part-{index}",
                group={"id": group_id, "index": index, "total": 3},
            ),
            bridge.client,
        )

    # Nothing relayed until the group completed.
    assert bridge._adapter.attachments == []
    assert bridge._adapter.messages == []
    assert len(bridge._adapter.batches) == 1

    batch = bridge._adapter.batches[0]
    assert [f.filename for f in batch["files"]] == ["cat.png", "notes.md", "data.csv"]
    assert batch["caption"] == "three files"
    # The group correlates via its first event, so replies thread back.
    assert bridge.recorded[0]["matrix_event_id"] == "$part-0"
    assert bridge.recorded[0]["external_post_id"] == "ext-ref-3"
    assert bridge._outbound_groups == {}


async def test_incomplete_group_is_flushed_with_a_disclosed_notice() -> None:
    """A group that never completes must still reach the platform, flagged —
    never silently held forever."""
    import switch_core.bridges.collaboration.bridge_core as bc

    original = bc.OUTBOUND_GROUP_TIMEOUT_SECONDS
    bc.OUTBOUND_GROUP_TIMEOUT_SECONDS = 0.01
    try:
        bridge = _fake_bridge()
        await BridgeCore.handle_outbound_media(
            bridge,
            _room(),
            _media_event(
                msgtype="m.file",
                body="only.md",
                mimetype="text/markdown",
                group={"id": "grp-2", "index": 0, "total": 3},
            ),
            bridge.client,
        )
        assert bridge._adapter.batches == []

        await asyncio.sleep(0.1)
    finally:
        bc.OUTBOUND_GROUP_TIMEOUT_SECONDS = original

    assert len(bridge._adapter.batches) == 1
    batch = bridge._adapter.batches[0]
    assert [f.filename for f in batch["files"]] == ["only.md"]
    assert "1 of 3" in (batch["caption"] or "")
    assert bridge._outbound_groups == {}
