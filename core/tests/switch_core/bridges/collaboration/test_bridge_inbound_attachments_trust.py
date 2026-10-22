"""Switch Trust on a person's message that carries files: the typed text and
each file's text are checked before anything is uploaded, so a refusal
leaves nothing in the room. (`test_bridge_inbound_trust.py` covers the
text-only path; `trust/test_attachments.py` what a file is checked as.)"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import Attachment, InboundMessage
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.trust.client import (
    NullTrustClient,
    TrustCheckResult,
    TrustFinding,
)

_FINDING = (TrustFinding(category="pii/email", detector_name="e", severity="high"),)


class _ContentTrustClient:
    """Blocks text containing FORBIDDEN, redacts "alice@example.com", and
    allows the rest. `active=False` stands in for Switch Trust being off."""

    def __init__(self, *, active: bool = True) -> None:
        self._active = active
        self.checked: list[tuple[str, str]] = []

    async def is_active(self) -> bool:
        return self._active

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append((role, content))
        if "FORBIDDEN" in content:
            return TrustCheckResult("blocked", "p", "policy", _FINDING)
        if "alice@example.com" in content:
            return TrustCheckResult(
                "redacted",
                "p",
                "policy",
                _FINDING,
                content.replace("alice@example.com", "[redacted]"),
            )
        return TrustCheckResult("ok", "p", "policy")


class _FakeHumanActor:
    client_id = "human-actor-client"
    transport_user_id = "@human:s"

    def __init__(self) -> None:
        self.uploads: list[str] = []
        self.media: list[dict[str, Any]] = []

    async def upload_media(self, data: bytes, mimetype: str, filename: str) -> str:
        self.uploads.append(filename)
        return f"mxc://s/{filename}"

    async def send_media(self, transport_room_id, mxc, filename, mimetype, size, **kw):  # noqa: ANN001, ANN003, ANN201
        self.media.append({"filename": filename, "caption": kw.get("caption")})
        return f"$evt-{len(self.media) - 1}"

    async def send_message(self, *args: object, **kw: object) -> str:
        raise AssertionError("a message with files is relayed as media")


class _FakeAdapter:
    def __init__(self) -> None:
        self.admin_messages: list[tuple[str, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    async def admin_message(
        self, channel_id: str, body: str, root_or_ref: str | None, *, message_type: str
    ) -> None:
        self.admin_messages.append((body, message_type))


async def _none(*_args: object, **_kwargs: object) -> None:
    return None


async def _not_an_agent(_name: str) -> bool:
    return False


def _bridge(trust_client: object) -> SimpleNamespace:
    human_actor = _FakeHumanActor()
    recorded: list[dict[str, str]] = []

    async def _ensure_human_in_room(**_kw: object) -> _FakeHumanActor:
        return human_actor

    async def _record_message_map(**kwargs: str) -> None:
        recorded.append(kwargs)

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _handle_text_answer=_none,
        _repair_placeholder_username=_none,
        _adapter=_FakeAdapter(),
        _channel_to_room={"chan-1": ("room-1", "!room:s")},
        _channel_locks={},
        _is_registered_agent=_not_an_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _record_message_map=_record_message_map,
        _trust_client=trust_client,
        human_actor=human_actor,
        recorded=recorded,
    )
    bridge._post_trust_notice = lambda msg, body, message_type: (
        CollaborationCore._post_trust_notice(bridge, msg, body, message_type)
    )
    return bridge


def _msg(content: str, *attachments: Attachment) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="U1",
        sender_name="alice",
        content=content,
        message_ref="post-1",
        attachments=list(attachments),
    )


_IMAGE = Attachment(filename="cat.png", mimetype="image/png", data=b"\x89PNG")


async def test_blocked_caption_with_an_image_relays_nothing() -> None:
    bridge = _bridge(_ContentTrustClient())

    await CollaborationCore._handle_inbound_message(
        bridge, _msg("FORBIDDEN words", _IMAGE)
    )

    assert bridge.human_actor.uploads == []
    assert bridge.human_actor.media == []
    assert bridge.recorded == []
    [(body, message_type)] = bridge._adapter.admin_messages
    assert "blocked by Switch Trust" in body
    assert message_type == AdminMessageType.TRUST_BLOCKED.value


async def test_text_file_with_blocked_content_relays_nothing() -> None:
    trust = _ContentTrustClient()
    bridge = _bridge(trust)
    report = Attachment(
        filename="report.txt", mimetype="text/plain", data=b"FORBIDDEN data"
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _msg("see attached", report, _IMAGE)
    )

    assert bridge.human_actor.uploads == []
    assert bridge.human_actor.media == []
    [(body, message_type)] = bridge._adapter.admin_messages
    assert "report.txt was blocked" in body
    assert message_type == AdminMessageType.TRUST_BLOCKED.value
    # The caption and the file's text were each checked, as the person.
    assert sorted(trust.checked) == [
        ("user", "FORBIDDEN data"),
        ("user", "see attached"),
    ]


async def test_text_file_trust_would_redact_is_blocked_not_relayed() -> None:
    bridge = _bridge(_ContentTrustClient())
    contacts = Attachment(
        filename="contacts.csv", mimetype="text/csv", data=b"alice@example.com"
    )

    await CollaborationCore._handle_inbound_message(bridge, _msg("", contacts))

    assert bridge.human_actor.uploads == []
    [(body, _)] = bridge._adapter.admin_messages
    assert "contacts.csv" in body
    assert "cannot be redacted" in body


async def test_image_is_relayed_with_a_note_that_it_was_not_checked() -> None:
    bridge = _bridge(_ContentTrustClient())

    await CollaborationCore._handle_inbound_message(bridge, _msg("look", _IMAGE))

    [media] = bridge.human_actor.media
    assert media["filename"] == "cat.png"
    assert media["caption"].startswith("look\n\n")
    assert "Switch Trust did not check cat.png" in media["caption"]
    # The sender sees the note too, since the room never echoes their post back.
    [(body, message_type)] = bridge._adapter.admin_messages
    assert "did not check cat.png" in body
    assert message_type == AdminMessageType.TRUST_ERRORED.value


async def test_redacted_caption_becomes_the_redacted_text() -> None:
    bridge = _bridge(_ContentTrustClient())
    notes = Attachment(filename="notes.txt", mimetype="text/plain", data=b"fine")

    await CollaborationCore._handle_inbound_message(
        bridge, _msg("mail alice@example.com", notes)
    )

    [media] = bridge.human_actor.media
    assert media["caption"] == "mail [redacted]"
    [(body, message_type)] = bridge._adapter.admin_messages
    assert message_type == AdminMessageType.TRUST_REDACTED.value


async def test_with_trust_off_files_are_relayed_unchanged_and_unread() -> None:
    trust = _ContentTrustClient(active=False)
    bridge = _bridge(trust)
    report = Attachment(
        filename="report.txt", mimetype="text/plain", data=b"FORBIDDEN data"
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _msg("FORBIDDEN caption", report, _IMAGE)
    )

    assert trust.checked == []
    assert [m["filename"] for m in bridge.human_actor.media] == [
        "report.txt",
        "cat.png",
    ]
    assert bridge.human_actor.media[0]["caption"] == "FORBIDDEN caption"
    assert bridge._adapter.admin_messages == []


async def test_with_the_null_client_files_are_relayed_unchanged() -> None:
    bridge = _bridge(NullTrustClient())

    await CollaborationCore._handle_inbound_message(bridge, _msg("look", _IMAGE))

    [media] = bridge.human_actor.media
    assert media["caption"] == "look"
    assert bridge._adapter.admin_messages == []
