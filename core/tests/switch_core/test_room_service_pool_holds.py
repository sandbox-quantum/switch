"""No database session is open while `RoomService` talks to Matrix.

An invite or a kick can take the full 10 s the Matrix admin client allows. Held
inside a transaction, that is a connection-pool slot removed from circulation
for ten seconds, and enough of them at once exhaust the pool and start failing
heartbeats fleet-wide. So the contract these tests pin is not a count: it is
that the number of *live* sessions is zero at the moment the Matrix call runs.

They also pin the ordering the split depends on — transport membership must
never exceed what the database records — because that is what makes the
resulting inconsistency recoverable rather than a silent over-permission. Both
ends of that read the same way: grant last, revoke first. Every row that says
someone is in a room goes before the kick that tells them so, and none is
written until the transport side is in place.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomService


class _TrackingSessionFactory:
    """The real factory, tracking how many sessions are open right now."""

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.live = 0
        self.opened = 0

    def __call__(self) -> Any:
        return _TrackedSession(self, self._inner())


class _TrackedSession:
    def __init__(self, tracker: _TrackingSessionFactory, inner: Any) -> None:
        self._tracker = tracker
        self._inner = inner

    async def __aenter__(self) -> AsyncSession:
        self._tracker.live += 1
        self._tracker.opened += 1
        return await self._inner.__aenter__()  # type: ignore[no-any-return]

    async def __aexit__(self, *exc: object) -> bool:
        self._tracker.live -= 1
        return await self._inner.__aexit__(*exc)  # type: ignore[no-any-return]


class _RecordingMatrix:
    """Records each Matrix call together with the sessions open at the time."""

    def __init__(self, tracker: _TrackingSessionFactory) -> None:
        self._tracker = tracker
        self.calls: list[tuple[str, str, int]] = []

    async def invite_to_room(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self.calls.append(("invite", matrix_user_id, self._tracker.live))

    async def kick_user(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self.calls.append(("kick", matrix_user_id, self._tracker.live))

    async def delete_room(self, matrix_room_id: str) -> None:
        self.calls.append(("delete_room", matrix_room_id, self._tracker.live))


class _RunningClients:
    def __init__(self, by_agent: dict[str, Any]) -> None:
        self._by_agent = by_agent
        self._by_id = {c.client_id: c for c in by_agent.values()}

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return self._by_id.get(client_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _RunningClient:
    def __init__(self, client_id: str, matrix_user_id: str) -> None:
        self.client_id = client_id
        self.matrix_user_id = matrix_user_id


async def _seed(
    session_factory: async_sessionmaker[AsyncSession], *, agents: int
) -> tuple[str, list[str], dict[str, Any]]:
    """A room plus `agents` agents that are NOT yet members of it."""
    async with session_factory() as session:
        user = User(name="o", email="o@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        agent_ids: list[str] = []
        running: dict[str, Any] = {}
        for i in range(agents):
            key = ApiKey(
                user_id=user.id,
                key_hash=f"hash-{i}",
                encrypted_key="enc",
                label=f"a{i}",
                type="agent",
            )
            client = Client(
                matrix_user_id=f"@a{i}:test",
                display_name=f"a{i}",
                type="agent",
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=f"a{i}",
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
            )
            session.add(agent)
            await session.flush()
            agent_ids.append(agent.id)
            running[agent.id] = _RunningClient(client.id, client.matrix_user_id)
        room = Room(matrix_room_id="!r:test", name="room", description="d")
        session.add(room)
        await session.flush()
        await session.commit()
        return room.id, agent_ids, running


def _service(
    tracker: _TrackingSessionFactory, running: dict[str, Any]
) -> tuple[RoomService, _RecordingMatrix]:
    matrix = _RecordingMatrix(tracker)
    svc = object.__new__(RoomService)
    svc._session_factory = tracker  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._matrix_admin = matrix  # type: ignore[assignment]
    svc._client_lifecycle = _RunningClients(running)  # type: ignore[assignment]
    svc._collab_lifecycle = _RunningClients({})  # type: ignore[assignment]
    return svc, matrix


class TestAddAgentsToRoom:
    async def test_no_session_is_open_across_the_invites(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_ids, running = await _seed(session_factory, agents=3)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)

        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)

        assert len(matrix.calls) == 3
        assert [live for _kind, _who, live in matrix.calls] == [0, 0, 0]

    async def test_membership_is_recorded_before_the_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The window this opens must be "member in Switch, not yet on Matrix" —
        # under-privileged and visible. The other order leaves an agent reading
        # a room Switch has no record of it being in.
        room_id, agent_ids, running = await _seed(session_factory, agents=1)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        seen_at_invite: list[list[str]] = []

        async def _invite(matrix_room_id: str, matrix_user_id: str) -> None:
            async with session_factory() as session:
                seen_at_invite.append(await RoomStore().get_agent_ids(session, room_id))

        matrix.invite_to_room = _invite  # type: ignore[method-assign]

        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)

        assert seen_at_invite == [agent_ids]

    async def test_room_clients_is_only_recorded_after_the_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # `reconcile_room_clients` treats a member with no `room_clients` row as
        # "the invite may not have landed", so the row must not be written until
        # the invite has actually gone out.
        room_id, agent_ids, running = await _seed(session_factory, agents=1)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        seen_at_invite: list[list[str]] = []

        async def _invite(matrix_room_id: str, matrix_user_id: str) -> None:
            async with session_factory() as session:
                seen_at_invite.append(
                    await RoomStore().get_client_ids(session, room_id)
                )

        matrix.invite_to_room = _invite  # type: ignore[method-assign]

        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)

        assert seen_at_invite == [[]]
        async with session_factory() as session:
            assert await RoomStore().get_client_ids(session, room_id) == [
                running[agent_ids[0]].client_id
            ]

    async def test_a_missing_room_still_raises_before_any_matrix_call(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, agent_ids, running = await _seed(session_factory, agents=1)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)

        with pytest.raises(ValueError, match="Room not found"):
            await svc.add_agents_to_room("no-such-room", agent_ids=agent_ids)

        assert matrix.calls == []


class TestRemoveAgentsFromRoom:
    async def test_no_session_is_open_across_the_kicks(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_ids, running = await _seed(session_factory, agents=3)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)
        matrix.calls.clear()

        await svc.remove_agents_from_room(room_id, agent_ids)

        assert [kind for kind, _who, _live in matrix.calls] == ["kick"] * 3
        assert [live for _kind, _who, live in matrix.calls] == [0, 0, 0]

    async def test_the_rows_are_gone_before_the_kick_lands(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Both records of the membership go first, then the kick.

        Addition revokes nothing, so it can write the row last; removal has to
        put every record of the membership beyond reach before it tells anyone,
        because a client's answer to being kicked is to re-read its rooms.
        `kick_user` promises exactly that — and keeps it for `client_rooms`
        alone. `room_agents` is the second record of the same fact, and it is
        the one `get_rooms_for_agent` reads, which is what the agent bridge
        applies as membership on every poll. Kicking first left a window where
        an agent already told to stop still passed that check for the room it
        had just been removed from.

        The window this opens instead is the harmless one: the rows are gone
        and the in-memory subscription has not been dropped yet, so every read
        of membership fails closed, and anything delivered in between is
        evicted by the removal it is racing.
        """
        room_id, agent_ids, running = await _seed(session_factory, agents=1)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)
        seen_at_kick: list[list[str]] = []

        async def _kick(matrix_room_id: str, matrix_user_id: str) -> None:
            async with session_factory() as session:
                seen_at_kick.append(await RoomStore().get_agent_ids(session, room_id))

        matrix.kick_user = _kick  # type: ignore[method-assign]

        await svc.remove_agents_from_room(room_id, agent_ids)

        assert seen_at_kick == [[]]
        async with session_factory() as session:
            assert await RoomStore().get_agent_ids(session, room_id) == []

    async def test_both_records_of_the_membership_go_in_one_transaction(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What makes the rows-first order safe against a crash, not just a race.

        The order this reverses was given its direction by CHOO's transaction
        split (af41b8e9): "Matrix membership must never exceed what the database
        records", so that a crash between the two halves leaves an agent
        under-privileged rather than reading a room Switch has no record of it
        being in. That reasoning rests on Matrix being a second, independent
        store of membership that survives the crash.

        There is no second store any more. `PostgresProvisioning` is the only
        implementation of the port, so what `kick_user` revokes is the
        `client_rooms` row and an in-memory subscription that dies with the
        process. The dangerous state the invariant protected against is
        therefore unreachable from this order — provided the two rows that
        record the membership go together, which is what this pins. Split
        across two commits, a crash between them would leave `room_agents`
        saying the agent is a member after `client_rooms` says it is not, and
        that is the stale-membership read the poll paths apply.
        """
        room_id, agent_ids, running = await _seed(session_factory, agents=2)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)

        # Every state the rows are seen in, sampled from a separate connection
        # on each commit the service makes.
        seen: list[tuple[int, int]] = []

        async def _sample() -> None:
            async with session_factory() as probe:
                agents = await RoomStore().get_agent_ids(probe, room_id)
                clients = await RoomStore().get_client_ids(probe, room_id)
            seen.append((len(agents), len(clients)))

        async def _kick(matrix_room_id: str, matrix_user_id: str) -> None:
            await _sample()

        matrix.kick_user = _kick  # type: ignore[method-assign]
        await svc.remove_agents_from_room(room_id, agent_ids)
        await _sample()

        # Never observed with one record of the membership gone and the other
        # still present — the state a crash between two commits would strand.
        assert all(a == 0 and c == 0 for a, c in seen), (
            f"the two membership records were observed out of step: {seen}"
        )


class TestDeleteRoom:
    async def test_no_session_is_open_across_the_teardown(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_ids, running = await _seed(session_factory, agents=2)
        tracker = _TrackingSessionFactory(session_factory)
        svc, matrix = _service(tracker, running)
        await svc.add_agents_to_room(room_id, agent_ids=agent_ids)
        matrix.calls.clear()

        await svc.delete_room(room_id)

        assert [kind for kind, _who, _live in matrix.calls] == [
            "kick",
            "kick",
            "delete_room",
        ]
        assert [live for _kind, _who, live in matrix.calls] == [0, 0, 0]

        async with session_factory() as session:
            assert await RoomStore().get(session, room_id) is None
