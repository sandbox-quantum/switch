"""Switch Trust on a Console chat: a person's message and the files they
attach are checked before anything is posted, as on every other platform."""

from __future__ import annotations

import httpx

from switch_core.trust.client import TrustCheckResult, TrustFinding
from tests.switch_core.gateway.conftest import _Harness

_FINDING = (TrustFinding(category="secrets", detector_name="s", severity="high"),)


class _ContentTrustClient:
    """Blocks text containing FORBIDDEN, redacts token-123, flags FLAG."""

    def __init__(self) -> None:
        self.checked: list[tuple[str, str]] = []

    async def is_active(self) -> bool:
        return True

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
        if "FLAG" in content:
            return TrustCheckResult("alerted", "p", "policy", _FINDING)
        return TrustCheckResult("ok", "p", "policy")


async def _chat(chats: _Harness) -> tuple[str, _ContentTrustClient]:
    trust = _ContentTrustClient()
    chats.service._trust_client = trust  # type: ignore[assignment]
    agent = await chats.agent("helper", owner=chats.alice)
    return await chats.new_chat(chats.alice, agent, "c1"), trust


async def _upload(
    chats: _Harness, room_id: str, upload_id: str, data: bytes, name: str, kind: str
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/attachments",
        data={"uploadId": upload_id},
        files={"file": (name, data, kind)},
        headers=chats.as_user(chats.alice),
    )


async def test_a_blocked_file_posts_nothing_and_says_why(chats: _Harness) -> None:
    room_id, trust = await _chat(chats)
    assert (
        await _upload(chats, room_id, "u1", b"FORBIDDEN", "leak.env", "text/plain")
    ).status_code == 200

    sent = await chats.send(
        chats.alice, room_id, "s1", "see attached", uploadIds=["u1"]
    )

    assert sent.status_code == 422
    detail = sent.json()["detail"]
    assert detail["code"] == "TRUST_BLOCKED"
    assert "leak.env was blocked (secrets)" in detail["message"]
    assert await chats.message_rows(room_id) == []
    assert ("user", "see attached") in trust.checked
    assert ("user", "FORBIDDEN") in trust.checked


async def test_a_blocked_caption_posts_nothing(chats: _Harness) -> None:
    room_id, _trust = await _chat(chats)
    await _upload(chats, room_id, "u1", b"fine", "notes.txt", "text/plain")

    sent = await chats.send(chats.alice, room_id, "s1", "FORBIDDEN", uploadIds=["u1"])

    assert sent.status_code == 422
    assert sent.json()["detail"]["code"] == "TRUST_BLOCKED"
    assert await chats.message_rows(room_id) == []


async def test_a_blocked_message_without_files_posts_nothing(chats: _Harness) -> None:
    room_id, _trust = await _chat(chats)

    sent = await chats.send(chats.alice, room_id, "s1", "FORBIDDEN")

    assert sent.status_code == 422
    assert sent.json()["detail"]["code"] == "TRUST_BLOCKED"
    assert await chats.message_rows(room_id) == []


async def test_an_unchecked_file_is_posted_with_a_note_and_a_redacted_caption(
    chats: _Harness,
) -> None:
    room_id, trust = await _chat(chats)
    await _upload(chats, room_id, "u1", b"\x89PNG", "cat.png", "image/png")

    sent = await chats.send(
        chats.alice, room_id, "s1", "my token-123 FLAG", uploadIds=["u1"]
    )

    assert sent.status_code == 200
    [row] = await chats.message_rows(room_id)
    assert row.body.startswith("my [redacted] FLAG\n\n")
    assert "Switch Trust did not check cat.png (images cannot be checked)" in row.body
    # The image's bytes were never sent as text.
    assert [content for _, content in trust.checked] == ["my token-123 FLAG"]


async def test_a_retry_after_the_post_is_answered_without_checking_again(
    chats: _Harness,
) -> None:
    room_id, trust = await _chat(chats)
    first = await chats.send(chats.alice, room_id, "s1", "hello")
    again = await chats.send(chats.alice, room_id, "s1", "hello")

    assert first.json() == again.json()
    assert trust.checked == [("user", "hello")]
