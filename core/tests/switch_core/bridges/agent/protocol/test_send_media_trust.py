"""Switch Trust on an agent's files: `send_media` checks its caption the way
`send_message` checks text, and each file's text, before uploading anything."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.trust.client import (
    GuardrailBlockedError,
    TrustCheckResult,
    TrustFinding,
)

_FINDING = (TrustFinding(category="secrets", detector_name="s", severity="high"),)


class _ContentTrustClient:
    def __init__(self, *, active: bool = True) -> None:
        self._active = active
        self.checked: list[tuple[str, str]] = []

    async def is_active(self) -> bool:
        return self._active

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append((role, content))
        if "FORBIDDEN" in content:
            return TrustCheckResult("blocked", "p", "policy", _FINDING)
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

    async def upload_media(self, data: bytes, content_type: str, filename: str) -> str:
        if filename == "unsendable.txt":
            raise RuntimeError("upload failed")
        self.uploads.append(filename)
        return f"mxc://s/{filename}"

    async def send_media(self, room_id, mxc, filename, mimetype, size, **kw):  # noqa: ANN001, ANN003, ANN201
        self.sends.append({"filename": filename, "caption": kw.get("caption")})
        return f"$media-event-{len(self.sends)}"


def _build(trust: _ContentTrustClient) -> tuple[AgentCore, _FakeClient, list[Any]]:
    client = _FakeClient()
    notices: list[Any] = []

    async def _require(agent_id: str, room_id: str):
        return SimpleNamespace(id=room_id, transport_room_id="!room", bridge_id=None)

    async def _blocked_notice(room, thread_root_id, client_) -> None:  # noqa: ANN001
        notices.append(("blocked", thread_root_id))

    async def _alert_notice(room, event_id, annotation, outcome) -> None:  # noqa: ANN001
        notices.append(("alert", event_id, annotation, outcome))

    async def _set_typing(*_args: object) -> None:
        return None

    svc = object.__new__(AgentCore)
    svc.require_room_poster = _require  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda agent_id: client
    )
    svc.config = SimpleNamespace(agent_media_max_bytes=1000)  # type: ignore[assignment]
    svc.trust_client = trust  # type: ignore[assignment]
    svc._post_trust_blocked_notice = _blocked_notice  # type: ignore[method-assign]
    svc._post_trust_alert_notice = _alert_notice  # type: ignore[method-assign]
    svc._set_typing = _set_typing  # type: ignore[method-assign]
    return svc, client, notices


async def test_blocked_caption_sends_nothing_and_raises() -> None:
    trust = _ContentTrustClient()
    svc, client, notices = _build(trust)

    with pytest.raises(GuardrailBlockedError):
        await svc.send_media(
            "agent-1",
            "room-1",
            [(b"png", "cat.png", "image/png")],
            caption="FORBIDDEN",
        )

    assert client.uploads == []
    assert notices == [("blocked", None)]
    assert ("assistant", "FORBIDDEN") in trust.checked


async def test_redacted_caption_is_sent_redacted() -> None:
    svc, client, _notices = _build(_ContentTrustClient())

    await svc.send_media(
        "agent-1",
        "room-1",
        [(b"fine", "notes.txt", "text/plain")],
        caption="here is token-123",
    )

    assert client.sends[0]["caption"] == "here is [redacted]"


async def test_blocked_file_text_sends_nothing_and_says_which_file() -> None:
    svc, client, notices = _build(_ContentTrustClient())

    with pytest.raises(GuardrailBlockedError, match="leak.env"):
        await svc.send_media(
            "agent-1",
            "room-1",
            [
                (b"png", "cat.png", "image/png"),
                (b"FORBIDDEN", "leak.env", "text/plain"),
            ],
        )

    assert client.uploads == []
    assert notices == [("blocked", None)]


async def test_image_is_sent_with_a_not_checked_notice() -> None:
    svc, client, notices = _build(_ContentTrustClient())

    await svc.send_media("agent-1", "room-1", [(b"png", "cat.png", "image/png")])

    assert client.uploads == ["cat.png"]
    [(kind, event_id, annotation, outcome)] = notices
    assert (kind, event_id, outcome) == ("alert", "$media-event-1", "errored")
    assert "did not check cat.png" in annotation


async def test_agents_receive_the_not_checked_note_with_the_file() -> None:
    # The room notice is an admin event that agents are never routed; the
    # caption of the file itself is what reaches them.
    svc, client, _notices = _build(_ContentTrustClient())

    await svc.send_media(
        "agent-1",
        "room-1",
        [(b"png", "cat.png", "image/png"), (b"fine", "notes.txt", "text/plain")],
        caption="have a look",
    )

    first, second = client.sends
    assert first["caption"].startswith("have a look\n\n")
    assert "did not check cat.png" in first["caption"]
    assert second["caption"] is None


async def test_a_later_failed_upload_still_posts_the_notice_for_files_sent() -> None:
    svc, client, notices = _build(_ContentTrustClient())

    with pytest.raises(RuntimeError):
        await svc.send_media(
            "agent-1",
            "room-1",
            [
                (b"png", "cat.png", "image/png"),
                (b"fine", "unsendable.txt", "text/plain"),
            ],
        )

    assert client.uploads == ["cat.png"]
    assert "did not check cat.png" in client.sends[0]["caption"]
    [(kind, event_id, annotation, _outcome)] = notices
    assert (kind, event_id) == ("alert", "$media-event-1")
    assert "did not check cat.png" in annotation


async def test_with_trust_off_nothing_is_checked() -> None:
    trust = _ContentTrustClient(active=False)
    svc, client, notices = _build(trust)

    await svc.send_media(
        "agent-1",
        "room-1",
        [(b"FORBIDDEN", "leak.env", "text/plain")],
        caption="FORBIDDEN",
    )

    assert trust.checked == []
    assert client.sends[0]["caption"] == "FORBIDDEN"
    assert notices == []
