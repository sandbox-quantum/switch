from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.clients.agent_consumer import AgentConsumer


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
) -> SimpleNamespace:
    async def _is_direct_room(_transport_room_id: str) -> bool:
        return is_direct

    async def _resolve_room_meta(_transport_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            room_id="room-uuid",
            name="Some Room",
            bridge_id="bridge-1",
            agent_greetings_enabled=agent_greetings_enabled,
            channel_type="channel_private",
        )

    return SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="cc-bug-fixing"),
        _connections=SimpleNamespace(
            controllers=SimpleNamespace(room_joined=lambda _agent, _room: None)
        ),
        _is_direct_room=_is_direct_room,
        _resolve_room_meta=_resolve_room_meta,
        actor=SimpleNamespace(send_message=send_message),
    )


_ROOM = SimpleNamespace(room_id="!matrix:server")
_EVENT = SimpleNamespace()


@pytest.mark.asyncio
async def test_self_join_greeting_suppressed_when_disabled() -> None:
    # CHOO-617: when the room's bridge has agent greetings toggled off, the
    # per-agent self-join greeting is suppressed.
    send_message = _Recorder()
    await AgentConsumer.on_self_join(
        _fake_self(send_message, agent_greetings_enabled=False), _ROOM, _EVENT
    )
    assert send_message.calls == []


@pytest.mark.asyncio
async def test_self_join_greeting_sent_when_enabled() -> None:
    send_message = _Recorder()
    await AgentConsumer.on_self_join(
        _fake_self(send_message, agent_greetings_enabled=True), _ROOM, _EVENT
    )
    assert len(send_message.calls) == 1


@pytest.mark.asyncio
async def test_direct_greeting_suppressed_when_disabled() -> None:
    # The toggle also covers the 1:1 "Hi! I'm …" greeting — it's an agent
    # greeting too.
    send_message = _Recorder()
    await AgentConsumer.on_self_join(
        _fake_self(send_message, is_direct=True, agent_greetings_enabled=False),
        _ROOM,
        _EVENT,
    )
    assert send_message.calls == []


@pytest.mark.asyncio
async def test_direct_greeting_sent_when_enabled() -> None:
    send_message = _Recorder()
    await AgentConsumer.on_self_join(
        _fake_self(send_message, is_direct=True, agent_greetings_enabled=True),
        _ROOM,
        _EVENT,
    )
    assert len(send_message.calls) == 1
    assert send_message.calls[0]["body"].startswith("Hi! I'm cc-bug-fixing")
