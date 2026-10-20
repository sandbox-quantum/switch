from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.delivery.recipient import AgentRecipient, opening_message_for


class _Recorder:
    """Captures send_message calls so we can assert whether a greeting fired."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def __call__(self, room_id: str, body: str, **kwargs: object) -> str:
        self.calls.append({"room_id": room_id, "body": body, **kwargs})
        return "$sent"


def _fake_self(
    send_message: _Recorder,
    *,
    is_direct: bool = False,
    agent_greetings_enabled: bool = True,
    agent_greeting: dict[str, str] | None = None,
) -> SimpleNamespace:
    """The agent arriving in a room, as the router hands it its arrival."""
    return SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="cc-bug-fixing"),
        _meta=SimpleNamespace(
            room_id="room-uuid",
            name="Some Room",
            bridge_id="bridge-1",
            agent_greetings_enabled=agent_greetings_enabled,
            channel_type="direct" if is_direct else "channel_private",
            agent_greeting=agent_greeting,
        ),
        _room=_ROOM,
        actor=SimpleNamespace(send_message=send_message),
    )


_ROOM = SimpleNamespace(room_id="!matrix:server")


@pytest.mark.asyncio
async def test_self_join_greeting_suppressed_when_disabled() -> None:
    # CHOO-617: when the room's bridge has agent greetings toggled off, the
    # per-agent self-join greeting is suppressed.
    send_message = _Recorder()
    await AgentRecipient.greet(_fake_self(send_message, agent_greetings_enabled=False))  # type: ignore[arg-type]
    assert send_message.calls == []


@pytest.mark.asyncio
async def test_self_join_greeting_sent_when_enabled() -> None:
    send_message = _Recorder()
    await AgentRecipient.greet(_fake_self(send_message, agent_greetings_enabled=True))  # type: ignore[arg-type]
    assert len(send_message.calls) == 1


@pytest.mark.asyncio
async def test_direct_greeting_suppressed_when_disabled() -> None:
    # The toggle also covers the 1:1 "Hi! I'm …" greeting — it's an agent
    # greeting too.
    send_message = _Recorder()
    await AgentRecipient.greet(
        _fake_self(send_message, is_direct=True, agent_greetings_enabled=False)  # type: ignore[arg-type]
    )
    assert send_message.calls == []


@pytest.mark.asyncio
async def test_direct_greeting_sent_when_enabled() -> None:
    send_message = _Recorder()
    await AgentRecipient.greet(
        _fake_self(send_message, is_direct=True, agent_greetings_enabled=True)  # type: ignore[arg-type]
    )
    assert len(send_message.calls) == 1
    assert send_message.calls[0]["body"].startswith("Hi! I'm cc-bug-fixing")


@pytest.mark.asyncio
async def test_a_greeting_written_for_the_agent_replaces_its_line() -> None:
    send_message = _Recorder()
    await AgentRecipient.greet(
        _fake_self(  # type: ignore[arg-type]
            send_message,
            is_direct=True,
            agent_greeting={
                "agent_id": "agent-1",
                "body": "Welcome, I'm here to help.",
            },
        )
    )
    assert [call["body"] for call in send_message.calls] == [
        "Welcome, I'm here to help."
    ]


@pytest.mark.asyncio
async def test_a_greeting_written_for_another_agent_is_not_said() -> None:
    send_message = _Recorder()
    await AgentRecipient.greet(
        _fake_self(  # type: ignore[arg-type]
            send_message,
            is_direct=True,
            agent_greeting={"agent_id": "someone-else", "body": "Not mine."},
        )
    )
    assert send_message.calls[0]["body"].startswith("Hi! I'm cc-bug-fixing")


def test_the_opening_message_is_told_only_to_the_agent_it_was_written_for() -> None:
    meta = SimpleNamespace(agent_greeting={"agent_id": "agent-1", "body": "Welcome!"})
    assert opening_message_for(meta, "agent-1") == "Welcome!"  # type: ignore[arg-type]
    assert opening_message_for(meta, "agent-2") is None  # type: ignore[arg-type]
    assert opening_message_for(SimpleNamespace(agent_greeting=None), "agent-1") is None  # type: ignore[arg-type]
