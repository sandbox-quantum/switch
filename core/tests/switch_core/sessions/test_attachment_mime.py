"""Media types as platforms actually report them.

A file relayed from a collaboration platform arrives with whatever media type
that platform put on it, and several of them attach parameters: Mattermost and
Discord both describe a plain text file as ``text/plain; charset=utf-8``. The
attachment allowlist holds bare types, so the parameter has to be gone before
the comparison or a text file is refused with "Unsupported attachment MIME
type" while an image, whose type carries no parameter, goes through.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AttachmentRef
from switch_core.bridges.collaboration.models import Attachment, OutboundAttachment
from switch_core.db.models import MediaBlob
from switch_core.sessions.attachments import (
    MIME_TYPES,
    normalise_mime_type,
    validate_attachment,
)
from tests.switch_core.sessions.test_authority import host_event, setup
from tests.switch_core.sessions.test_room_messages import event

REPO_ROOT = Path(__file__).resolve().parents[4]
HOST_ATTACHMENTS = (
    REPO_ROOT / "console/packages/agent-providers/src/host/attachments.ts"
)


def test_allowlist_matches_the_host_that_stages_the_files() -> None:
    """The server and Switch Console must accept exactly the same types.

    The two lists are separate implementations in separate languages; nothing
    fails on its own if they drift, the session just refuses a file the server
    already delivered (or the server refuses one the host could have staged).
    """
    block = re.search(
        r"ATTACHMENT_MIME_TYPES = \[(.*?)\]", HOST_ATTACHMENTS.read_text(), re.S
    )
    assert block is not None
    assert set(re.findall(r"'([^']+)'", block.group(1))) == MIME_TYPES


@pytest.mark.parametrize(
    ("reported", "expected"),
    [
        ("text/plain; charset=utf-8", "text/plain"),
        ("text/plain;charset=UTF-8", "text/plain"),
        ("Text/Markdown", "text/markdown"),
        (" application/json ", "application/json"),
        ("image/png", "image/png"),
    ],
)
def test_reported_media_types_lose_their_parameters(
    reported: str, expected: str
) -> None:
    assert normalise_mime_type(reported) == expected


def test_a_text_file_with_a_charset_is_accepted() -> None:
    validate_attachment("secret.txt", "text/plain; charset=utf-8", b"hello")


def test_an_unknown_type_is_still_refused_once_normalised() -> None:
    with pytest.raises(ValueError, match="Unsupported attachment MIME type"):
        validate_attachment("secret.xml", "application/xml; charset=utf-8", b"<x/>")


def test_a_bridge_attachment_records_the_bare_media_type() -> None:
    """Mattermost, Slack and Discord all hand their type straight to this model."""
    inbound = Attachment(
        filename="secret.txt", mimetype="text/plain; charset=utf-8", data=b"hello"
    )
    assert inbound.mimetype == "text/plain"
    outbound = OutboundAttachment(
        filename="secret.txt", mimetype="text/plain; charset=utf-8", data=b"hello"
    )
    assert outbound.mimetype == "text/plain"


@pytest.mark.asyncio
async def test_a_text_file_relayed_from_a_bridge_reaches_the_session(session_factory):
    """The end-to-end case: a `.txt` posted in Mattermost alongside a PNG.

    The blob carries the media type the platform reported, charset and all —
    the type stored before this normalisation existed looks exactly like this —
    so the delivered attachment proves the parameter is handled on read, not
    only on write.
    """
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            MediaBlob(
                uri="switch-media://secret",
                content_type="text/plain; charset=utf-8",
                filename="secret.txt",
                size=5,
                data=b"hello",
            )
        )
    snapshot = await service.snapshot("session-demo", "owner")
    session = snapshot.session.model_dump(by_alias=True)
    session["status"] = "ready"
    session["capabilities"]["attachmentMimeTypes"] = ["text/plain"]
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 1, {"type": "session.upsert", "session": session}),
    )
    message = event()
    message.payload.attachments = [
        AttachmentRef(
            filename="secret.txt",
            mimetype="text/plain; charset=utf-8",
            size=5,
            mxc="switch-media://secret",
            msgtype="m.file",
        )
    ]
    buffer = EventBuffer()
    sequence = buffer.enqueue("agent-demo", "room-demo", message)
    await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        0,
        None,
        buffer,
    )
    command = (await service.pending("agent-demo", "session-demo", "host-demo", epoch))[
        0
    ]
    assert "not delivered" not in command.body.text
    assert len(command.body.attachments) == 1
    attachment = command.body.attachments[0]
    assert attachment.mime_type == "text/plain"
    blob = await service.attachment(
        "agent-demo", "session-demo", "host-demo", epoch, attachment.attachment_id
    )
    assert blob.data == b"hello"
    assert blob.sha256 == hashlib.sha256(b"hello").hexdigest()
