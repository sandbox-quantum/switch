"""Switch Trust on an agent's files: `send_media` checks its caption the way
`send_message` checks text, and each file's text, before uploading anything."""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.delivery.send_limits import MessageTooLong, SendLimits, SendRateLimited
from switch_core.tenant_context import tenant_scope
from switch_core.trust.client import (
    GuardrailBlockedError,
    TrustCheckResult,
    TrustFinding,
)

# The start of a real PNG: not text, so Switch Trust cannot read it.
_PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
# A PDF that cannot be parsed and is not text: Switch tries to read it and
# cannot, so it goes out with a "not checked" note.
_BROKEN_PDF = b"%PDF-1.4\x00garbage"
_FINDING = (TrustFinding(category="secrets", detector_name="s", severity="high"),)


@pytest.fixture(autouse=True)
def _bound_workspace() -> Iterator[None]:
    """A workspace bound, as agent authentication binds one before any send:
    each check names the workspace whose organization's policy applies."""
    with tenant_scope("tenant-a"):
        yield


class _ContentTrustClient:
    def __init__(self, *, active: bool = True) -> None:
        self._active = active
        self.checked: list[tuple[str, str]] = []

    async def is_active(self, tenant_id: str) -> bool:
        return self._active

    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        self.checked.append((role, content))
        if "FORBIDDEN" in content:
            return TrustCheckResult("blocked", "p", "policy", _FINDING)
        if "nothing-to-cut" in content:
            return TrustCheckResult("redacted", "p", "policy", _FINDING, content)
        if "token-123" in content:
            return TrustCheckResult(
                "redacted",
                "p",
                "policy",
                _FINDING,
                content.replace("token-123", "[redacted]"),
            )
        return TrustCheckResult("ok", "p", "policy")


class _FakeClient:
    def __init__(self) -> None:
        self.uploads: list[str] = []
        self.sends: list[dict[str, Any]] = []
        self.agent = SimpleNamespace(name="helper")
        self.limits: SendLimits | None = None

    def admit_message(self, authored: str | None) -> None:
        if self.limits is not None:
            self.limits.admit("helper-client", authored, actor="agent")

    async def upload_media(self, data: bytes, content_type: str, filename: str) -> str:
        if filename == "unsendable.txt":
            raise RuntimeError("upload failed")
        self.uploads.append(filename)
        return f"mxc://s/{filename}"

    async def send_media(self, room_id, mxc, filename, mimetype, size, **kw):  # noqa: ANN001, ANN003, ANN201
        self.sends.append({"filename": filename, "caption": kw.get("caption")})
        return f"$media-event-{len(self.sends)}"


def _build(
    session_factory: async_sessionmaker[AsyncSession],
    trust: _ContentTrustClient,
    notice_error: str | None = None,
) -> tuple[AgentCore, _FakeClient, list[Any]]:
    client = _FakeClient()
    notices: list[Any] = []

    async def _require(agent_id: str, room_id: str):
        return SimpleNamespace(id=room_id, transport_room_id="!room", bridge_id=None)

    async def _blocked_notice(room, thread_root_id, client_) -> None:  # noqa: ANN001
        notices.append(("blocked", thread_root_id))

    async def _alert_notice(room, event_id, annotation, outcome) -> str | None:  # noqa: ANN001
        notices.append(("alert", event_id, annotation, outcome))
        return notice_error

    async def _set_typing(*_args: object) -> None:
        return None

    svc = object.__new__(AgentCore)
    svc.session_factory = session_factory  # type: ignore[assignment]
    svc.require_room_poster = _require  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_tenant_agent=lambda agent_id, tenant_id: client
    )
    svc.config = SimpleNamespace(agent_media_max_bytes=1000)  # type: ignore[assignment]
    svc.trust_client = trust  # type: ignore[assignment]
    svc._post_trust_blocked_notice = _blocked_notice  # type: ignore[method-assign]
    svc._post_trust_alert_notice = _alert_notice  # type: ignore[method-assign]
    svc._set_typing = _set_typing  # type: ignore[method-assign]
    return svc, client, notices


async def test_blocked_caption_sends_nothing_and_raises(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    trust = _ContentTrustClient()
    svc, client, notices = _build(session_factory, trust)

    with pytest.raises(GuardrailBlockedError):
        await svc.send_media(
            "agent-1",
            "room-1",
            [(_PNG, "cat.png", "image/png")],
            caption="FORBIDDEN",
        )

    assert client.uploads == []
    assert notices == [("blocked", None)]
    assert ("assistant", "FORBIDDEN") in trust.checked


async def test_a_post_past_the_agents_allowance_is_neither_checked_nor_stored(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Refused before Switch Trust reads it and before a file is stored, so
    a loop of refused posts costs no check, no notice and no orphan file."""
    trust = _ContentTrustClient()
    svc, client, notices = _build(session_factory, trust)
    client.limits = SendLimits(
        max_message_chars=10, burst=1, per_second=0.001, clock=lambda: 0.0
    )
    files = [(b"hello", "notes.txt", "text/plain")]

    with pytest.raises(MessageTooLong):
        await svc.send_media("agent-1", "room-1", files, caption="x" * 11)
    with pytest.raises(GuardrailBlockedError):
        await svc.send_media("agent-1", "room-1", files, caption="FORBIDDEN")
    with pytest.raises(SendRateLimited):
        await svc.send_media("agent-1", "room-1", files, caption="FORBIDDEN")

    assert [content for _, content in trust.checked].count("FORBIDDEN") == 1
    assert notices == [("blocked", None)]
    assert client.uploads == []


async def test_redacted_caption_is_sent_redacted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, _notices = _build(session_factory, _ContentTrustClient())

    result = await svc.send_media(
        "agent-1",
        "room-1",
        [(b"fine", "notes.txt", "text/plain")],
        caption="here is token-123",
    )

    assert client.sends[0]["caption"] == "here is [redacted]"
    # The agent is told its caption changed, and to what.
    assert result["trust"] == {"outcome": "redacted", "delivered": "here is [redacted]"}


async def test_a_caption_redaction_that_changed_nothing_is_still_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, _notices = _build(session_factory, _ContentTrustClient())

    result = await svc.send_media(
        "agent-1",
        "room-1",
        [(b"fine", "notes.txt", "text/plain")],
        caption="nothing-to-cut here",
    )

    assert client.sends[0]["caption"] == "nothing-to-cut here"
    assert result["trust"] == {
        "outcome": "redacted",
        "delivered": "nothing-to-cut here",
    }


async def test_blocked_file_text_sends_nothing_and_says_which_file(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, notices = _build(session_factory, _ContentTrustClient())

    with pytest.raises(GuardrailBlockedError, match="leak.env"):
        await svc.send_media(
            "agent-1",
            "room-1",
            [
                (_PNG, "cat.png", "image/png"),
                (b"FORBIDDEN", "leak.env", "text/plain"),
            ],
        )

    assert client.uploads == []
    assert notices == [("blocked", None)]


async def test_image_is_sent_without_a_notice(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, notices = _build(session_factory, _ContentTrustClient())

    result = await svc.send_media("agent-1", "room-1", [(_PNG, "cat.png", "image/png")])

    assert client.uploads == ["cat.png"]
    assert client.sends[0]["caption"] is None
    assert notices == []
    assert "trust" not in result


async def test_unreadable_document_is_sent_with_a_not_checked_notice(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, notices = _build(session_factory, _ContentTrustClient())

    result = await svc.send_media(
        "agent-1", "room-1", [(_BROKEN_PDF, "scan.pdf", "application/pdf")]
    )

    assert client.uploads == ["scan.pdf"]
    [(kind, event_id, annotation, outcome)] = notices
    assert (kind, event_id, outcome) == ("alert", "$media-event-1", "errored")
    assert "did not check scan.pdf" in annotation
    assert result["trust"] == {"outcome": "errored", "note": annotation}


async def test_a_notice_that_could_not_be_posted_is_reported_as_such(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, notices = _build(
        session_factory,
        _ContentTrustClient(),
        notice_error="no admin client is running to post it",
    )

    result = await svc.send_media(
        "agent-1", "room-1", [(_BROKEN_PDF, "scan.pdf", "application/pdf")]
    )

    assert client.uploads == ["scan.pdf"]
    assert len(notices) == 1
    assert result["trust"] == {
        "outcome": "errored",
        "notice_error": "no admin client is running to post it",
    }


async def test_agents_receive_the_not_checked_note_with_the_file(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # The room notice is an admin event that agents are never routed; the
    # caption of the file itself is what reaches them.
    svc, client, _notices = _build(session_factory, _ContentTrustClient())

    await svc.send_media(
        "agent-1",
        "room-1",
        [
            (_BROKEN_PDF, "scan.pdf", "application/pdf"),
            (b"fine", "notes.txt", "text/plain"),
        ],
        caption="have a look",
    )

    first, second = client.sends
    assert first["caption"].startswith("have a look\n\n")
    assert "did not check scan.pdf" in first["caption"]
    assert second["caption"] is None


async def test_a_later_failed_upload_still_posts_the_notice_for_files_sent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc, client, notices = _build(session_factory, _ContentTrustClient())

    with pytest.raises(RuntimeError):
        await svc.send_media(
            "agent-1",
            "room-1",
            [
                (_BROKEN_PDF, "scan.pdf", "application/pdf"),
                (b"fine", "unsendable.txt", "text/plain"),
            ],
        )

    assert client.uploads == ["scan.pdf"]
    assert "did not check scan.pdf" in client.sends[0]["caption"]
    [(kind, event_id, annotation, _outcome)] = notices
    assert (kind, event_id) == ("alert", "$media-event-1")
    assert "did not check scan.pdf" in annotation


async def test_with_trust_off_nothing_is_checked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    trust = _ContentTrustClient(active=False)
    svc, client, notices = _build(session_factory, trust)

    result = await svc.send_media(
        "agent-1",
        "room-1",
        [(b"FORBIDDEN", "leak.env", "text/plain")],
        caption="FORBIDDEN",
    )

    assert trust.checked == []
    assert client.sends[0]["caption"] == "FORBIDDEN"
    assert notices == []
    assert "trust" not in result
