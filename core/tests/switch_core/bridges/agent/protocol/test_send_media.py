from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService


class _FakeClient:
    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str, str]] = []
        self.sends: list[dict[str, Any]] = []

    async def upload_media(self, data: bytes, content_type: str, filename: str) -> str:
        self.uploads.append((data, content_type, filename))
        return "mxc://s/uploaded"

    async def send_media(
        self,
        room_id: str,
        mxc: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> str | None:
        self.sends.append(
            {
                "room_id": room_id,
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
        return f"$media-event-{len(self.sends)}"


def _build_service(client: _FakeClient, *, max_bytes: int = 100) -> ProtocolService:
    async def _require(agent_id: str, room_id: str):
        return SimpleNamespace(matrix_room_id="!room")

    async def _set_typing(agent_id: str, room_id: str, is_typing: bool) -> None:
        pass

    async def _resolve_thread_root(client_: Any, matrix_room_id: str, thread_id: str):
        return f"root-of-{thread_id}"

    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.require_room_member = _require  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda agent_id: client
    )
    svc.config = SimpleNamespace(agent_media_max_bytes=max_bytes)  # type: ignore[assignment]
    svc.set_typing = _set_typing  # type: ignore[assignment]
    svc._resolve_thread_root = _resolve_thread_root  # type: ignore[assignment]
    return svc


async def test_send_media_uploads_and_posts_image() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    result = await svc.send_media(
        "agent-1", "room-1", [(b"png-bytes", "cat.png", "image/png")]
    )

    assert result["event_id"] == "$media-event-1"
    assert result["mxc"] == "mxc://s/uploaded"
    assert result["attachments"] == [
        {
            "event_id": "$media-event-1",
            "mxc": "mxc://s/uploaded",
            "filename": "cat.png",
        }
    ]
    assert client.uploads == [(b"png-bytes", "image/png", "cat.png")]
    sent = client.sends[0]
    assert sent["room_id"] == "!room"
    assert sent["msgtype"] == "m.image"
    assert sent["caption"] is None
    assert sent["thread_root_id"] is None
    # A lone attachment carries no group marker.
    assert sent["group"] is None


async def test_send_media_caption_and_thread() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    await svc.send_media(
        "agent-1",
        "room-1",
        [(b"x", "cat.png", "image/png")],
        caption="look",
        thread_id="$mid-thread",
    )

    sent = client.sends[0]
    assert sent["caption"] == "look"
    assert sent["thread_root_id"] == "root-of-$mid-thread"


async def test_send_media_non_image_is_file_msgtype() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    await svc.send_media("agent-1", "room-1", [(b"%PDF", "doc.pdf", "application/pdf")])

    assert client.sends[0]["msgtype"] == "m.file"


async def test_send_media_oversize_raises() -> None:
    client = _FakeClient()
    svc = _build_service(client, max_bytes=3)

    with pytest.raises(ValueError, match="over the 3-byte limit"):
        await svc.send_media("agent-1", "room-1", [(b"toolarge", "c.png", "image/png")])
    assert client.uploads == []


async def test_send_media_empty_raises() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    with pytest.raises(ValueError, match="empty"):
        await svc.send_media("agent-1", "room-1", [(b"", "c.png", "image/png")])


async def test_send_media_multiple_files_share_a_group_marker() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    result = await svc.send_media(
        "agent-1",
        "room-1",
        [
            (b"png-bytes", "cat.png", "image/png"),
            (b"# notes", "notes.md", "text/markdown"),
            (b"a,b", "data.csv", "text/csv"),
        ],
        caption="three files",
    )

    assert len(client.sends) == 3
    groups = [sent["group"] for sent in client.sends]
    assert {g["id"] for g in groups} == {groups[0]["id"]}, "all parts share one id"
    assert [g["index"] for g in groups] == [0, 1, 2]
    assert all(g["total"] == 3 for g in groups)
    # Caption rides on the first part only, mirroring the inbound convention.
    assert client.sends[0]["caption"] == "three files"
    assert client.sends[1]["caption"] is None
    assert client.sends[2]["caption"] is None
    # Non-image files keep their own msgtype within the group.
    assert [sent["msgtype"] for sent in client.sends] == [
        "m.image",
        "m.file",
        "m.file",
    ]
    assert [a["filename"] for a in result["attachments"]] == [
        "cat.png",
        "notes.md",
        "data.csv",
    ]


async def test_send_media_rejects_whole_batch_when_one_file_is_oversize() -> None:
    """A bad file in the batch must abort everything — never a half-posted
    message with the good files and a silently missing one."""
    client = _FakeClient()
    svc = _build_service(client, max_bytes=5)

    with pytest.raises(ValueError, match="over the 5-byte limit"):
        await svc.send_media(
            "agent-1",
            "room-1",
            [
                (b"ok", "small.md", "text/markdown"),
                (b"way-too-large", "big.bin", "application/octet-stream"),
            ],
        )

    assert client.uploads == []
    assert client.sends == []


async def test_send_media_rejects_empty_batch() -> None:
    client = _FakeClient()
    svc = _build_service(client)

    with pytest.raises(ValueError, match="no attachments"):
        await svc.send_media("agent-1", "room-1", [])
