"""A post sent again under its key is the post already made.

The agent's host keys each post (`reply:<uuid>`) and sends it again after an
answer lost to a Switch restart. Core answers such a resend with the first
post before Trust, so it is neither judged nor alerted on a second time."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.agent_core import AgentCore


def _core(already: str | None) -> tuple[Any, list[str]]:
    seen: list[str] = []

    async def room_poster(_agent_id: str, _room_id: str) -> Any:
        return SimpleNamespace(transport_room_id="!room")

    async def sent_under(room_id: str, key: str) -> str | None:
        seen.append(f"lookup {room_id} {key}")
        return already

    async def send_message(*_args: Any, **kwargs: Any) -> str:
        seen.append(f"send {kwargs.get('client_txn_id')}")
        return "$new"

    async def trust(_room: Any, content: str, *_args: Any) -> tuple[str, None, str]:
        seen.append("trust")
        return content, None, "ok"

    async def typing(*_args: Any) -> None:
        return None

    client = SimpleNamespace(sent_under=sent_under, send_message=send_message)
    core = SimpleNamespace(
        require_room_poster=room_poster,
        client_lifecycle=SimpleNamespace(get_by_agent_id=lambda _agent: client),
        _enforce_trust=trust,
        _set_typing=typing,
    )
    return core, seen


@pytest.mark.asyncio
async def test_a_resend_of_a_post_already_made_skips_trust_and_sends_nothing() -> None:
    core, seen = _core(already="$first")
    sent = await AgentCore.send_message(
        core, "agent-1", "room-1", "the reply", client_txn_id="reply:k"
    )
    assert sent.event_id == "$first"
    # Answered before Trust, so there is nothing for Trust to report.
    assert sent.trust is None
    assert seen == ["lookup !room reply:k"]


@pytest.mark.asyncio
async def test_a_first_keyed_post_goes_through_trust_and_is_sent_under_its_key() -> (
    None
):
    core, seen = _core(already=None)
    sent = await AgentCore.send_message(
        core, "agent-1", "room-1", "the reply", client_txn_id="reply:k"
    )
    assert sent.event_id == "$new"
    assert seen == ["lookup !room reply:k", "trust", "send reply:k"]


@pytest.mark.asyncio
async def test_an_unkeyed_post_is_unchanged() -> None:
    core, seen = _core(already="$first")
    sent = await AgentCore.send_message(core, "agent-1", "room-1", "hi")
    assert sent.event_id == "$new"
    assert seen == ["trust", "send None"]
