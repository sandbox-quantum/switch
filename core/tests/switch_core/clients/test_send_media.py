from __future__ import annotations

import pytest

from switch_core.clients.client_base import ClientBase
from switch_core.transport import TransportError, UploadResult
from tests.switch_core.transport.fake import FakeTransport


class _FailingUploadTransport(FakeTransport):
    """Upload is the one media call that must not degrade to a None result."""

    async def upload_media(
        self, data: bytes, content_type: str, filename: str
    ) -> UploadResult:
        raise TransportError(f"Failed to upload media '{filename}'")


def _client(transport: FakeTransport) -> ClientBase:
    client = object.__new__(ClientBase)
    client.transport = transport  # type: ignore[attr-defined]
    client.display_name = "Alice"  # type: ignore[attr-defined]
    client.matrix_user_id = "@alice:switch.local"  # type: ignore[attr-defined]
    client.client_id = "client-1"  # type: ignore[attr-defined]
    return client


async def test_upload_media_returns_content_uri() -> None:
    transport = FakeTransport(upload_uri="mxc://s/abc")
    client = _client(transport)

    mxc = await client.upload_media(b"bytes", "image/png", "cat.png")

    assert mxc == "mxc://s/abc"
    assert transport.uploads == [(b"bytes", "image/png", "cat.png")]


async def test_upload_media_raises_on_error() -> None:
    client = _client(_FailingUploadTransport())

    with pytest.raises(TransportError, match="Failed to upload media"):
        await client.upload_media(b"bytes", "image/png", "cat.png")


async def test_send_media_with_caption_passes_caption_and_filename_through() -> None:
    transport = FakeTransport()
    client = _client(transport)

    event_id = await client.send_media(
        "!room",
        "mxc://s/abc",
        "cat.png",
        "image/png",
        1234,
        msgtype="m.image",
        caption="look at this",
    )

    assert event_id == "$fake1"
    sent = transport.sent_media[0]
    assert sent["room_id"] == "!room"
    assert sent["msgtype"] == "m.image"
    # Caption convention: the caption travels beside the real filename, so the
    # transport can put one in `body` and carry the other separately.
    assert sent["caption"] == "look at this"
    assert sent["filename"] == "cat.png"
    assert sent["uri"] == "mxc://s/abc"
    assert sent["mimetype"] == "image/png"
    assert sent["size"] == 1234
    assert sent["sender_name"] == "Alice"


async def test_send_media_without_caption_sends_no_caption() -> None:
    transport = FakeTransport()
    client = _client(transport)

    await client.send_media(
        "!room", "mxc://s/abc", "cat.png", "image/png", 1234, msgtype="m.image"
    )

    sent = transport.sent_media[0]
    assert sent["caption"] is None
    assert sent["filename"] == "cat.png"


async def test_send_media_returns_none_when_the_transport_rejects_it() -> None:
    client = _client(FakeTransport(fail_send="nope"))

    result = await client.send_media(
        "!room", "mxc://s/abc", "cat.png", "image/png", 1234, msgtype="m.image"
    )

    assert result is None
