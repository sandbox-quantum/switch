from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.types import AgentEvent, RoomJoinPayload
from switch_core.db.models import TENANT_ZERO_ID, AgentEventRow, Message
from switch_core.db.session_scope import tenant_session
from switch_core.delivery.recipient import AgentRecipient
from switch_core.transport import InboundMembership
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

AGENT = "agent-1"


class _FakeClientNames:
    """Resolves a matrix id to the Switch client that owns it, or nothing."""

    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get_by_transport_user_id(
        self, _session: object, transport_user_id: str
    ) -> object | None:
        name = self._names.get(transport_user_id)
        return SimpleNamespace(display_name=name) if name else None


def _client(
    *,
    receives: bool = True,
    known: dict[str, str] | None = None,
) -> SimpleNamespace:
    """A minimal fake `self` for the unbound `AgentRecipient.decide_arrival`.

    `receives` is the agent's per-room join-event setting, as the router read
    it with the agent's membership.
    """
    stub = SimpleNamespace(
        agent=SimpleNamespace(id=AGENT),
        tenant_id=TENANT_ZERO_ID,
        _member=SimpleNamespace(listening=receives),
        _meta=SimpleNamespace(
            room_id="room-1",
            name="Room",
            bridge_id="bridge-1",
            channel_type="channel_public",
        ),
        _clients=_FakeClientNames(
            {"@alice:switch.local": "Alice"} if known is None else known
        ),
    )
    # Bound, so the handler resolves the name through the real implementation.
    stub._member_name = lambda session, event: AgentRecipient._member_name(
        stub,  # type: ignore[arg-type]
        session,
        event,
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


async def _enqueued(
    client: SimpleNamespace, event: InboundMembership
) -> list[tuple[str, AgentEvent]]:
    """What the router would store for the agent as its own events, as
    (room, event). The arrival is passed as the row it was written as."""
    delivery = await AgentRecipient.decide_arrival(client, None, event)  # type: ignore[arg-type]
    if delivery.own_event is None:
        return []
    own = delivery.own_event(event)
    return [(own.event.room_id, own.event)]


class TestRoomJoinEnqueue:
    async def test_join_enqueues_room_join_event(self) -> None:
        enqueued = await _enqueued(_client(), _member_event())

        assert len(enqueued) == 1
        room_id, event = enqueued[0]
        assert room_id == "room-1"
        assert event.type == "room_join"
        assert event.bridge_id == "bridge-1"
        assert event.channel_type == "channel_public"
        assert isinstance(event.payload, RoomJoinPayload)
        assert event.payload.member == "@alice:switch.local"
        assert event.payload.member_name == "Alice"
        assert event.payload.timestamp == 123
        # The agent is opted in → listening is True.
        assert event.payload.listening is True

    async def test_listening_reflects_store_setting(self) -> None:
        # The per-room, per-agent receives_join_events setting (off here)
        # decides whether the arrival is one of the agent's own events. Off, it
        # is the room's conversation: nothing is stored, and a reader that
        # wants the conversation reads the arrival from the room's log, with
        # `listening` False.
        assert await _enqueued(_client(receives=False), _member_event()) == []

    async def test_the_member_is_named_the_way_switch_knows_them(self) -> None:
        """A profile carries the source platform's spelling of a name; the log
        records the Switch one. Delivering the profile name would make live
        events and history disagree about the same person."""
        enqueued = await _enqueued(
            _client(known={"@alice:switch.local": "alice"}),
            _member_event(displayname="Alice \U0001f495"),
        )

        _, event = enqueued[0]
        assert event.payload.member_name == "alice"

    async def test_a_member_no_switch_client_owns_falls_back_to_the_event(
        self,
    ) -> None:
        enqueued = await _enqueued(
            _client(known={}),
            _member_event(displayname=None, state_key="@bob:switch.local"),
        )

        assert len(enqueued) == 1
        _, event = enqueued[0]
        assert event.payload.member_name == "bob"

    async def test_leave_does_not_enqueue(self) -> None:
        assert (
            await _enqueued(
                _client(), _member_event(membership="leave", prev_membership="join")
            )
            == []
        )

    async def test_profile_update_does_not_enqueue(self) -> None:
        # membership-preserving update (e.g. display-name change): join -> join.
        assert (
            await _enqueued(
                _client(), _member_event(membership="join", prev_membership="join")
            )
            == []
        )

    async def test_no_room_meta_does_not_enqueue(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The router reads the room in the transaction that writes the row, so
        an arrival in a room that cannot be read is never decided for anyone:
        the row cannot be written either, and nothing is kept."""
        process = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        agent, client = await make_agent(session_factory, "listener")
        await add_member(session_factory, room, client, agent=agent, listening=True)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            arrival = Message(
                room_id="no-such-room",
                transport_event_id="$arrival",
                sender_id=alice.transport_user_id,
                sender_client_id=alice.id,
                sender_name=alice.display_name,
                event_type="m.room.member",
                content={"membership": "join"},
            )
            with pytest.raises(IntegrityError):
                await process.router.store(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    room_id="no-such-room",
                    transport_room_id="!gone:test",
                    message=arrival,
                    attachments=[],
                )
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            assert (await session.scalars(select(AgentEventRow))).all() == []


class TestArrivalsThroughTheRouter:
    async def test_an_arrival_reaches_the_agents_listening_for_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """End to end: a person joining is one own event for the agent that
        listens for joins here, stamped with the row's time, and none for the
        agent that does not."""
        process = process_on(session_factory)
        room = await make_room(session_factory)
        listener, listener_client = await make_agent(session_factory, "listener")
        deaf, deaf_client = await make_agent(session_factory, "deaf")
        await add_member(
            session_factory, room, listener_client, agent=listener, listening=True
        )
        await add_member(session_factory, room, deaf_client, agent=deaf)
        alice = await make_person(session_factory, "alice")

        await process.provisioning.invite_to_room(
            room.transport_room_id, alice.transport_user_id
        )
        await process.idle()

        [row] = await own_events(session_factory, listener.id)
        assert row.type == "room_join"
        payload = AgentEvent.model_validate(row.payload).payload
        assert isinstance(payload, RoomJoinPayload)
        assert payload.member == alice.transport_user_id
        assert payload.member_name == "alice"
        assert payload.listening is True
        assert payload.timestamp > 0
        assert await own_events(session_factory, deaf.id) == []


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
