from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    InboundMessage,
)


class _FakePuppet:
    matrix_user_id = "@puppet:s"

    def __init__(self) -> None:
        self.uploads: list[dict[str, Any]] = []
        self.media: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []

    async def upload_media(self, data: bytes, mimetype: str, filename: str) -> str:
        self.uploads.append({"data": data, "mimetype": mimetype, "filename": filename})
        return f"mxc://s/{filename}"

    async def send_media(
        self,
        matrix_room_id,
        mxc,
        filename,
        mimetype,
        size,
        msgtype,
        caption=None,
        thread_root_id=None,
        group=None,
    ):  # noqa: ANN001, ANN201
        self.media.append(
            {
                "matrix_room_id": matrix_room_id,
                "mxc": mxc,
                "filename": filename,
                "mimetype": mimetype,
                "size": size,
                "msgtype": msgtype,
                "caption": caption,
                "thread_root_id": thread_root_id,
                "group": group,
            }
        )
        return f"$evt-{len(self.media) - 1}"

    async def send_message(
        self, matrix_room_id, content, format=None, thread_root_id=None
    ):  # noqa: ANN001, ANN201, A002
        self.messages.append({"content": content, "thread_root_id": thread_root_id})
        return "$evt-text"


class _FakeAdapter:
    def translate_inbound(self, content: str) -> str:
        return content


def _fake_bridge() -> SimpleNamespace:
    puppet = _FakePuppet()
    recorded: list[dict[str, str]] = []

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _ensure_user_in_matrix_room(**_kwargs: Any) -> _FakePuppet:
        return puppet

    async def _record_message_map(**kwargs: str) -> None:
        recorded.append(kwargs)

    ns = SimpleNamespace(
        _adapter=_FakeAdapter(),
        _channel_to_room={"chan-1": ("room-1", "!room:s")},
        _is_registered_agent=_is_registered_agent,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _record_message_map=_record_message_map,
        puppet=puppet,
        recorded=recorded,
    )
    return ns


def _msg(
    *,
    content: str = "here you go",
    attachments: list[Attachment] | None = None,
    attachment_failures: list[AttachmentFailure] | None = None,
) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="U1",
        sender_name="alice",
        content=content,
        message_ref="post-1",
        attachments=attachments or [],
        attachment_failures=attachment_failures or [],
    )


def _attachment(filename: str, mimetype: str) -> Attachment:
    return Attachment(filename=filename, mimetype=mimetype, data=b"bytes")


async def test_three_attachments_are_stamped_as_one_group() -> None:
    bridge = _fake_bridge()

    await BridgeCore._handle_inbound_message(
        bridge,
        _msg(
            content="three files",
            attachments=[
                _attachment("cat.png", "image/png"),
                _attachment("notes.md", "text/markdown"),
                _attachment("data.csv", "text/csv"),
            ],
        ),
    )

    media = bridge.puppet.media
    assert len(media) == 3

    group_ids = {m["group"]["id"] for m in media}
    assert len(group_ids) == 1
    assert [m["group"]["index"] for m in media] == [0, 1, 2]
    assert {m["group"]["total"] for m in media} == {3}

    # Caption convention: text rides on the first attachment only.
    assert [m["caption"] for m in media] == ["three files", None, None]
    assert [m["msgtype"] for m in media] == ["m.image", "m.file", "m.file"]
    assert [m["filename"] for m in media] == ["cat.png", "notes.md", "data.csv"]

    # The first media event stands in for the post, so replies thread back.
    assert bridge.recorded == [
        {
            "external_channel_id": "chan-1",
            "matrix_event_id": "$evt-0",
            "external_post_id": "post-1",
        }
    ]
    assert bridge.puppet.messages == []


async def test_single_attachment_carries_no_group_marker() -> None:
    # A group of one needs no marker — the receiver treats an unmarked event as
    # a complete message and never buffers it.
    bridge = _fake_bridge()

    await BridgeCore._handle_inbound_message(
        bridge, _msg(attachments=[_attachment("cat.png", "image/png")])
    )

    assert len(bridge.puppet.media) == 1
    assert bridge.puppet.media[0]["group"] is None
    assert bridge.puppet.media[0]["caption"] == "here you go"


async def test_attachment_failures_are_disclosed_alongside_text() -> None:
    bridge = _fake_bridge()

    await BridgeCore._handle_inbound_message(
        bridge,
        _msg(
            content="see attached",
            attachment_failures=[
                AttachmentFailure(filename="huge.zip", reason="too large")
            ],
        ),
    )

    body = bridge.puppet.messages[0]["content"]
    assert body.startswith("see attached")
    assert "huge.zip" in body
    assert "too large" in body
    assert "attachment not relayed" in body


async def test_attachment_failures_are_disclosed_when_text_is_empty() -> None:
    # An attachment-only post whose single file failed must still say something
    # in the room — never a silent drop.
    bridge = _fake_bridge()

    await BridgeCore._handle_inbound_message(
        bridge,
        _msg(
            content="   ",
            attachment_failures=[
                AttachmentFailure(filename="huge.zip", reason="too large"),
                AttachmentFailure(filename="broken.pdf", reason="download failed"),
            ],
        ),
    )

    body = bridge.puppet.messages[0]["content"]
    assert body.splitlines() == [
        "_attachment not relayed: huge.zip — too large_",
        "_attachment not relayed: broken.pdf — download failed_",
    ]


async def test_attachment_failures_ride_on_the_caption_of_relayed_media() -> None:
    bridge = _fake_bridge()

    await BridgeCore._handle_inbound_message(
        bridge,
        _msg(
            content="two files, one failed",
            attachments=[_attachment("cat.png", "image/png")],
            attachment_failures=[
                AttachmentFailure(filename="huge.zip", reason="too large")
            ],
        ),
    )

    assert bridge.puppet.messages == []
    caption = bridge.puppet.media[0]["caption"]
    assert "two files, one failed" in caption
    assert "huge.zip" in caption
