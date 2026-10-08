"""An agent's consumer reports each message its agent was actually asked to act on.

"Asked" means addressed *and* let through: a message the addressing policy or a
budget turned away was not a request the agent received, and Switch's own
auto-replies are not anyone asking for anything.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.clients.agent_consumer import (
    AUTO_REPLY_FLAG,
    AgentConsumer,
    HostedNote,
    _GateOutcome,
)
from switch_core.clients.room_meta import RoomMeta
from switch_core.transport import InboundMessage, RoomRef


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


class _FakeMessageTelemetry:
    def __init__(self) -> None:
        self.addressed: list[dict[str, Any]] = []

    def agent_addressed(self, **kwargs: Any) -> None:
        self.addressed.append(kwargs)


def _consumer(
    *, addressed: bool, allowed: bool = True, hosted: HostedNote | None = None
) -> SimpleNamespace:
    """An AgentConsumer stand-in that is live in the room, with addressing,
    the policy gate and a hosted agent's mailbox fixed by the test."""
    meta = RoomMeta(
        room_id="room-1", name="Room", bridge_id=None, channel_type="channel_public"
    )

    async def _resolve_room_meta(_transport_room_id: str) -> RoomMeta:
        return meta

    async def _compute_addressed(_s: object, _e: object, _m: object) -> bool:
        return addressed

    async def _fresh_agent(_s: object) -> object:
        return ns.agent

    async def _gate_addressed(
        _s: object, _a: object, _e: object, _m: object
    ) -> _GateOutcome:
        return _GateOutcome(addressed=allowed, refusal=None)

    async def _is_available(_s: object, _a: object, _r: str) -> bool:
        return True

    async def _note_hosted_addressed(_a: object, _e: object) -> HostedNote | None:
        return hosted

    ns = SimpleNamespace(
        agent=SimpleNamespace(
            id="agent-1", name="agent-a", metadata_={"known_agent_type": "codex"}
        ),
        tenant_id="tenant-1",
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        _addressed_without_lookup=lambda _e, _m: None,
        _compute_addressed=_compute_addressed,
        _fresh_agent=_fresh_agent,
        _gate_addressed=_gate_addressed,
        _is_available=_is_available,
        _note_hosted_addressed=_note_hosted_addressed,
        _post_auto_reply=_ignore_post,
        _sender_handle=lambda _e: "@alice",
        _triggered_by_auto_reply=AgentConsumer._triggered_by_auto_reply,
        _event_buffer=SimpleNamespace(enqueue=lambda *a, **k: None),
        _message_telemetry=_FakeMessageTelemetry(),
    )
    ns._report_addressed = AgentConsumer._report_addressed.__get__(ns)
    return ns


async def _ignore_post(*_args: object, **_kwargs: object) -> None:
    return None


def _message(**content: object) -> InboundMessage:
    return InboundMessage(
        room_id="!room:s",
        event_id="$evt",
        sender="@alice:s",
        timestamp=0,
        content={"sender_name": "alice", **content},
        body="@agent-a can you help",
        sender_name="alice",
    )


async def _deliver(consumer: SimpleNamespace, event: InboundMessage) -> None:
    await AgentConsumer.on_message(consumer, RoomRef(room_id="!room:s"), event)  # type: ignore[arg-type]


async def test_an_addressed_message_is_reported_once() -> None:
    consumer = _consumer(addressed=True)

    await _deliver(consumer, _message())

    assert consumer._message_telemetry.addressed == [
        {
            "tenant_id": "tenant-1",
            "room_id": "room-1",
            "sender_transport_user_id": "@alice:s",
            "from_platform": False,
            "agent_metadata": {"known_agent_type": "codex"},
            "has_attachment": False,
        }
    ]


async def test_room_chatter_is_not_reported() -> None:
    consumer = _consumer(addressed=False)

    await _deliver(consumer, _message())

    assert consumer._message_telemetry.addressed == []


async def test_a_message_the_policy_turned_away_is_not_reported() -> None:
    consumer = _consumer(addressed=True, allowed=False)

    await _deliver(consumer, _message())

    assert consumer._message_telemetry.addressed == []


async def test_an_auto_reply_is_not_reported() -> None:
    consumer = _consumer(addressed=True)

    await _deliver(consumer, _message(**{AUTO_REPLY_FLAG: True}))

    assert consumer._message_telemetry.addressed == []


async def test_a_platform_message_says_it_came_from_the_platform() -> None:
    consumer = _consumer(addressed=True)

    await _deliver(consumer, _message(**{PLATFORM_MARKER: {}}))

    [report] = consumer._message_telemetry.addressed
    assert report["from_platform"] is True


async def test_a_message_a_hosted_agents_mailbox_refused_is_not_reported() -> None:
    # A stopped or broken cloud worker: the agent never gets it.
    consumer = _consumer(
        addressed=True,
        hosted=HostedNote(
            launch=None, machine=None, refusal="worker stopped", deliver=False
        ),
    )

    await _deliver(consumer, _message())

    assert consumer._message_telemetry.addressed == []


async def test_a_message_held_for_a_waking_hosted_agent_is_reported() -> None:
    consumer = _consumer(
        addressed=True,
        hosted=HostedNote(launch=None, machine=None, refusal=None, deliver=False),
    )

    await _deliver(consumer, _message())

    assert len(consumer._message_telemetry.addressed) == 1
