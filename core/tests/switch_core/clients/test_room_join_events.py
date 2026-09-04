from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.bridges.agent.protocol.types import AgentEvent, RoomJoinPayload
from switch_core.clients.agent_client import AgentClient, RoomMeta
from switch_core.transport import InboundMembership, RoomRef


class _FakeQueue:
    def __init__(self) -> None:
        self.enqueued: list[tuple[str, str, AgentEvent]] = []

    def enqueue(self, agent_id: str, room_id: str, event: AgentEvent) -> None:
        self.enqueued.append((agent_id, room_id, event))


class _FakeClientStore:
    """Resolves a matrix id to the Switch client that owns it, or nothing."""

    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get_by_matrix_user_id(
        self, _session: object, matrix_user_id: str
    ) -> object | None:
        name = self._names.get(matrix_user_id)
        return SimpleNamespace(display_name=name) if name else None


class _FakeRoomStore:
    def __init__(self, receives: bool) -> None:
        self._receives = receives

    async def get_receives_join_events(
        self, _session: object, _room_id: str, _agent_id: str
    ) -> bool:
        return self._receives


def _client(
    meta: RoomMeta | None = None,
    *,
    receives: bool = True,
    known: dict[str, str] | None = None,
) -> SimpleNamespace:
    """A minimal fake `self` for the unbound AgentClient.on_member_event.

    Stubs the event queue, agent identity, room-meta resolution, and the room
    store / session factory so the handler can run without a DB or live Matrix
    client. `receives` is what the stubbed store reports for this agent's
    per-room join-event setting.
    """
    resolved = meta or RoomMeta(
        room_id="room-1",
        name="Room",
        bridge_id="bridge-1",
        channel_type="channel_public",
    )

    async def _resolve_room_meta(_matrix_room_id: str) -> RoomMeta | None:
        return resolved

    @asynccontextmanager
    async def _session_factory():
        yield SimpleNamespace()

    stub = SimpleNamespace(
        _event_buffer=_FakeQueue(),
        agent=SimpleNamespace(id="agent-1"),
        _resolve_room_meta=_resolve_room_meta,
        _room_store=_FakeRoomStore(receives),
        client_store=_FakeClientStore(
            {"@alice:switch.local": "Alice"} if known is None else known
        ),
        session_factory=_session_factory,
    )
    # Bound, so the handler resolves the name through the real implementation.
    stub._member_name = lambda session, event: AgentClient._member_name(
        stub, session, event
    )
    return stub


def _member_event(
    *,
    membership: str = "join",
    prev_membership: str | None = "leave",
    state_key: str = "@alice:switch.local",
    displayname: str | None = "Alice",
    timestamp: int = 123,
) -> InboundMembership:
    content: dict[str, object] = {}
    if displayname is not None:
        content["displayname"] = displayname
    return InboundMembership(
        room_id="!matrix:switch.local",
        event_id="$member",
        sender=state_key,
        timestamp=timestamp,
        content=content,
        state_key=state_key,
        membership=membership,
        prev_membership=prev_membership,
        display_name=displayname,
    )


async def _run(client: SimpleNamespace, event: InboundMembership) -> None:
    await AgentClient.on_member_event(client, RoomRef("!matrix:switch.local"), event)


class TestRoomJoinEnqueue:
    async def test_join_enqueues_room_join_event(self) -> None:
        client = _client()
        await _run(client, _member_event())

        assert len(client._event_buffer.enqueued) == 1
        agent_id, room_id, event = client._event_buffer.enqueued[0]
        assert agent_id == "agent-1"
        assert room_id == "room-1"
        assert event.type == "room_join"
        assert event.bridge_id == "bridge-1"
        assert event.channel_type == "channel_public"
        assert isinstance(event.payload, RoomJoinPayload)
        assert event.payload.member == "@alice:switch.local"
        assert event.payload.member_name == "Alice"
        assert event.payload.timestamp == 123
        # Stubbed store opts this agent in → listening is True.
        assert event.payload.listening is True

    async def test_listening_reflects_store_setting(self) -> None:
        # The event is delivered regardless, but `listening` mirrors the
        # per-room, per-agent receives_join_events setting (off here).
        client = _client(receives=False)
        await _run(client, _member_event())

        assert len(client._event_buffer.enqueued) == 1
        _, _, event = client._event_buffer.enqueued[0]
        assert event.payload.listening is False

    async def test_the_member_is_named_the_way_switch_knows_them(self) -> None:
        """A profile carries the source platform's spelling of a name; the log
        records the Switch one. Delivering the profile name would make live
        events and history disagree about the same person."""
        client = _client(known={"@alice:switch.local": "alice"})
        await _run(client, _member_event(displayname="Alice \U0001f495"))

        _, _, event = client._event_buffer.enqueued[0]
        assert event.payload.member_name == "alice"

    async def test_a_member_no_switch_client_owns_falls_back_to_the_event(
        self,
    ) -> None:
        client = _client(known={})
        await _run(
            client, _member_event(displayname=None, state_key="@bob:switch.local")
        )

        assert len(client._event_buffer.enqueued) == 1
        _, _, event = client._event_buffer.enqueued[0]
        assert event.payload.member_name == "bob"

    async def test_leave_does_not_enqueue(self) -> None:
        client = _client()
        await _run(client, _member_event(membership="leave", prev_membership="join"))
        assert client._event_buffer.enqueued == []

    async def test_profile_update_does_not_enqueue(self) -> None:
        # membership-preserving update (e.g. display-name change): join -> join.
        client = _client()
        await _run(client, _member_event(membership="join", prev_membership="join"))
        assert client._event_buffer.enqueued == []

    async def test_no_room_meta_does_not_enqueue(self) -> None:
        async def _none(_matrix_room_id: str) -> RoomMeta | None:
            return None

        client = _client()
        client._resolve_room_meta = _none
        await _run(client, _member_event())
        assert client._event_buffer.enqueued == []


class TestRoomJoinPayloadRegistry:
    def test_agent_event_parses_room_join_payload(self) -> None:
        event = AgentEvent.model_validate(
            {
                "type": "room_join",
                "room_id": "room-1",
                "bridge_id": None,
                "channel_type": "channel_public",
                "payload": {
                    "member": "@alice:switch.local",
                    "member_name": "Alice",
                    "timestamp": 123,
                    "listening": True,
                },
            }
        )
        assert isinstance(event.payload, RoomJoinPayload)
        assert event.payload.member_name == "Alice"
        assert event.payload.listening is True
