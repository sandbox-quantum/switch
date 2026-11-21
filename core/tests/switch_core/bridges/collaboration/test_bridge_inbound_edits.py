"""A platform edit becomes an edit row in the room
(`switch_core.messages.edits`), checked by Switch Trust like any message."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundEdit
from switch_core.messages.edits import parse_edit
from switch_core.trust.client import TrustCheckResult

TRANSPORT_ROOM_ID = "!matrix:switch.local"


class _Actor:
    client_id = "alice-client"
    transport_user_id = "@ext_alice:switch.local"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict[str, Any]]] = []

    async def send_message(self, room_id: str, body: str, **kw: Any) -> str:
        self.sent.append((room_id, body, kw))
        return "$edit-1"


class _Trust:
    def __init__(self, outcome: str = "passed") -> None:
        self.outcome = outcome

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        return TrustCheckResult(
            outcome=self.outcome,  # type: ignore[arg-type]
            policy_id="policy-1",
            policy_name="default",
            findings=(),
            redacted_content=None,
        )


def _bridge(
    actor: _Actor, *, mapped: dict[str, str], trust: _Trust | None = None
) -> SimpleNamespace:
    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _ensure_human_in_room(**_kw: object) -> _Actor:
        return actor

    async def _event_for_external_post(ref: str) -> str | None:
        return mapped.get(ref)

    return SimpleNamespace(
        _bridge_id="bridge-1",
        _is_registered_agent=_is_registered_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _event_for_external_post=_event_for_external_post,
        _adapter=SimpleNamespace(translate_inbound=lambda text: text),
        _channel_to_room={"chan-1": ("room-uuid", TRANSPORT_ROOM_ID)},
        _trust_client=trust or _Trust(),
    )


def _edit(content: str = "fix the bug in parse.py", ref: str = "post-1") -> InboundEdit:
    return InboundEdit(
        channel_id="chan-1",
        sender_id="ext-alice",
        sender_name="alice",
        content=content,
        message_ref=ref,
        revision="1700",
    )


async def test_an_edit_is_written_as_an_edit_of_the_original() -> None:
    actor = _Actor()
    bridge = _bridge(actor, mapped={"post-1": "$original"})
    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]

    [(room_id, body, kw)] = actor.sent
    assert room_id == TRANSPORT_ROOM_ID
    assert body == "* fix the bug in parse.py"
    assert "thread_root_id" not in kw
    edit = parse_edit({"body": body, **kw["extra_content"]})
    assert edit is not None
    assert (edit.original_event_id, edit.body) == (
        "$original",
        "fix the bug in parse.py",
    )


async def test_an_edit_of_a_post_never_relayed_is_dropped() -> None:
    actor = _Actor()
    bridge = _bridge(actor, mapped={})
    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]
    assert actor.sent == []


async def test_a_blocked_edit_leaves_the_original_standing() -> None:
    actor = _Actor()
    bridge = _bridge(actor, mapped={"post-1": "$original"}, trust=_Trust("blocked"))
    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]
    assert actor.sent == []
