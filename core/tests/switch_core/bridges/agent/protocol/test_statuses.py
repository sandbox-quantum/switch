from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import AgentStatus


class _FakeSessionStore:
    """Stub AgentSessionStore: an agent id is "live" iff it is in `live_ids`."""

    def __init__(self, live_ids: set[str]) -> None:
        self._live = live_ids
        self.calls: list[tuple[list[str], str | None]] = []

    async def get_live_agent_ids(
        self, _session: Any, agent_ids: list[str], room_id: str | None
    ) -> set[str]:
        self.calls.append((list(agent_ids), room_id))
        return {aid for aid in agent_ids if aid in self._live}


def _registry(
    *,
    agent_id: str | None = None,
    scope: str = "single",
    room: str | None = None,
    spawn_capable: bool = False,
) -> ConnectionRegistry:
    """A registry holding at most one live connection."""
    registry = ConnectionRegistry()
    if agent_id is not None:
        conn = registry.open(
            agent_id=agent_id,
            connection_id=f"c-{agent_id}",
            scope=scope,  # type: ignore[arg-type]
            delivery_filter="all",
            spawn_capable=spawn_capable,
            cursor=0,
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        )
        if room is not None:
            registry.claim_room(conn, room)
    return registry


def _agent(agent_id: str, connection_model: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        integration_profile={"connection_model": connection_model},
    )


class TestComputeAgentStatuses:
    async def test_status_per_connection_model(self) -> None:
        agents = [
            _agent("on-live", "always_on"),
            _agent("on-down", "always_on"),
            _agent("addr-live", "session_addressable"),
            _agent("addr-none", "session_addressable"),
            _agent("passive", "session_passive"),
        ]
        store = _FakeSessionStore(live_ids={"on-live", "addr-live"})

        statuses = await compute_agent_statuses(
            None, agents, "room-1", store, _registry()
        )

        assert statuses == {
            "on-live": AgentStatus.LIVE,
            "on-down": AgentStatus.DISCONNECTED,
            "addr-live": AgentStatus.LIVE,
            "addr-none": AgentStatus.NO_SESSION,
            "passive": AgentStatus.AWAITING_MANUAL_POLL,
        }

    async def test_liveness_scope_per_model(self) -> None:
        # always_on liveness is room-agnostic (room=None); session_addressable
        # liveness is scoped to the room.
        agents = [
            _agent("on", "always_on"),
            _agent("addr", "session_addressable"),
        ]
        store = _FakeSessionStore(live_ids=set())

        await compute_agent_statuses(None, agents, "room-9", store, _registry())

        assert (["on"], None) in store.calls
        assert (["addr"], "room-9") in store.calls

    async def test_missing_connection_model_defaults_to_passive(self) -> None:
        agent = SimpleNamespace(id="x", integration_profile={})
        store = _FakeSessionStore(live_ids=set())

        statuses = await compute_agent_statuses(
            None, [agent], "room-1", store, _registry()
        )

        assert statuses == {"x": AgentStatus.AWAITING_MANUAL_POLL}


class TestPresenceIsAUnion:
    """A live connection counts as presence, and so does a heartbeat row.

    Both arms are needed while both kinds of client exist (CHOO-1857 stage B):
    a client on the push transport keeps only a connection, one still polling
    keeps only the row. When the polling clients are gone the DB arm goes with
    them — these tests then describe what is left.
    """

    async def test_a_connection_makes_an_addressable_agent_live(self) -> None:
        # Nothing in the DB: this is a migrated client, which sends no
        # /connection/renew at all.
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", room="room-1")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.LIVE}

    async def test_a_connection_elsewhere_does_not_make_it_live_here(self) -> None:
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", room="other-room")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.NO_SESSION}

    async def test_the_db_arm_still_stands_on_its_own(self) -> None:
        """An un-migrated client keeps working with no connection at all."""
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids={"addr"})

        statuses = await compute_agent_statuses(
            None, agents, "room-1", store, _registry()
        )

        assert statuses == {"addr": AgentStatus.LIVE}

    async def test_an_all_scope_connection_makes_an_always_on_agent_live(self) -> None:
        # always_on has no separate session: the connection IS the agent being
        # up, and its liveness is room-agnostic.
        agents = [_agent("daemon", "always_on")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="daemon", scope="all")

        statuses = await compute_agent_statuses(
            None, agents, "any-room", store, registry
        )

        assert statuses == {"daemon": AgentStatus.LIVE}

    async def test_a_watcher_is_not_a_session(self) -> None:
        """An `all`-scope watcher covering a room is not a session in it.

        `covers()` is the delivery rule and deliberately includes the
        all-scope fallback. Presence for a session-shaped agent asks something
        narrower — is a session attending? — and only a claimed room slot
        answers that. Reading coverage as presence reports the agent LIVE in a
        room where nothing but a watcher is listening, which suppresses the
        "no session" reply.
        """
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", scope="all")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.NO_SESSION}

    async def test_a_watcher_leaves_auto_session_dormant_not_live(self) -> None:
        """The same distinction, where it matters most.

        DORMANT is what licenses "Starting a session…". Reporting LIVE instead
        means the room looks attended, the promise is never made, and the
        message waits with nothing to answer it.
        """
        agents = [_agent("auto", "auto_session")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="auto", scope="all")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"auto": AgentStatus.DORMANT}

    async def test_a_watching_connection_makes_auto_session_dormant_not_down(
        self,
    ) -> None:
        """The connection replaces /watch/heartbeat.

        DORMANT is what licenses the "Starting a session…" reply, so losing it
        would silently turn a spawnable agent into an unreachable one.
        """
        agents = [_agent("auto", "auto_session")]
        store = _FakeSessionStore(live_ids=set())
        # `single` scope, no room claimed: watching, covering nothing.
        registry = _registry(agent_id="auto")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"auto": AgentStatus.DORMANT}

    async def test_a_connection_in_the_room_makes_auto_session_live(self) -> None:
        agents = [_agent("auto", "auto_session")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="auto", room="room-1")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"auto": AgentStatus.LIVE}

    async def test_a_connection_never_rescues_a_passive_agent(self) -> None:
        """session_passive has no heartbeat by definition — including this one."""
        agents = [_agent("passive", "session_passive")]
        store = _FakeSessionStore(live_ids={"passive"})
        registry = _registry(agent_id="passive", room="room-1")

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"passive": AgentStatus.AWAITING_MANUAL_POLL}

    async def test_a_dead_connection_is_not_presence(self) -> None:
        """Liveness is the heartbeat, not the socket."""
        import time as _time

        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", room="room-1")
        conn = registry.get("c-addr")
        assert conn is not None
        # Stop beating: past the TTL the connection stops counting.
        conn.last_beat = _time.monotonic() - 3600

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.NO_SESSION}


class TestSpawnCapableConnections:
    """A connection that will start a session is reported DORMANT, not absent.

    The promise is keyed off what the client *declared* when it connected, not
    off the agent's configured `connection_model`. A stale or mis-set enum
    otherwise produces "my connector isn't reporting in" while a watcher sits
    connected and about to spawn — which is exactly what it looked like in
    production.
    """

    async def test_a_spawn_capable_watcher_makes_an_addressable_agent_dormant(
        self,
    ) -> None:
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", scope="all", spawn_capable=True)

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.DORMANT}

    async def test_a_watcher_that_cannot_spawn_leaves_it_absent(self) -> None:
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", scope="all", spawn_capable=False)

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.NO_SESSION}

    async def test_a_live_session_still_wins_over_dormant(self) -> None:
        agents = [_agent("addr", "session_addressable")]
        store = _FakeSessionStore(live_ids=set())
        registry = _registry(agent_id="addr", room="room-1", spawn_capable=True)

        statuses = await compute_agent_statuses(None, agents, "room-1", store, registry)

        assert statuses == {"addr": AgentStatus.LIVE}
