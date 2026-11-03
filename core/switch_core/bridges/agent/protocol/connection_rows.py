"""Agent connections recorded for every switch-core process.

An agent's connection lives in the memory of the process holding its socket
(`agent_connections.py`): the socket, the heartbeat and the frames it is owed
cannot be anywhere else. Its other requests (tool calls, room claims,
placements, an old client's heartbeat) may reach any process, and every
process answers presence questions about it. So the connection is also
recorded as rows (`AgentConnectionStore`), and each process keeps a copy of
the other processes' live connections in its own registry, which is what lets
every presence reader answer without a query.

What is written, and when:

- A connection's row is written when it opens or is reattached, inside a
  recorded move (`recorded`), and closed when it closes, by a queued writer
  (`closed`), fenced on the process and the incarnation so a late closing never
  touches a newer row. Detaching a socket writes nothing: the heartbeat window
  is the grace a client has to come back. Heartbeats write nothing at all.
- Room claims and session placements are rewritten whenever a recorded move
  changes them. Every recorded move takes a per-agent advisory lock and reads
  the agent's rows again first, so a fence, a claimant or a cap is judged on
  what every process has committed.

After each write the other processes are told to look, over the `SignalBus`
(`agent_connections.changed`), and read the agent's rows again. The process
holding a connection that lost a room is told which, so it can send
`room_released`. A connection whose row now names another process or a later
incarnation was taken over, and its holder closes it `taken_over`. One whose
row is gone was its agent's, deleted since, and its holder closes it too: told
by the process that deleted the agent, or on its next read of every tenant.

Liveness is the holding process's lease: a row counts while it is not closed
and its process's lease is held. A lost signal costs a delay, never a wrong
answer for long: on the signal bus's periodic re-check, and whenever the
signal connection comes back, every tenant's rows are read again, and every
lease check (`WATCH_SECONDS`) drops the copies of a process whose lease
lapsed. What a signal asks this process to read goes through the bus's
`PendingWork`, so a read that fails is kept and tried again.

Three requests are handed to the holder rather than served where they land: a
`POST /connection/beat` from an old event-stream client (forwarded in batches,
`agent_connections.beats`), a session command for a stream another process
holds, the agent's watcher or its controller's (stored as a relay row for that
process and signalled, `agent_connections.session_command`, since its content
may not travel in a `NOTIFY`), and a warm for a controller another process
holds (`agent_connections.warm`). A warm is nothing but ids, so it travels in
the signal itself; it is a hint, and one lost costs only the head start it
would have given the agent's session.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.agent_connections import (
    AgentConnection,
    AgentConnectionRegistry,
    Closure,
    ConnectionError_,
    Released,
    UnknownConnectionError,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import (
    AgentConnectionStore,
    AgentSlotRows,
)
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.process_lease import (
    LEASE_TTL,
    PRUNE_AFTER,
    RENEW_INTERVAL_SECONDS,
    ProcessLease,
)
from switch_core.signals import RETRY_SECONDS, payload_chunks
from switch_core.tenant_context import current_tenant_id, no_tenant

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

CHANGED_SIGNAL = "agent_connections.changed"
BEATS_SIGNAL = "agent_connections.beats"
SESSION_COMMAND_SIGNAL = "agent_connections.session_command"
WARM_SIGNAL = "agent_connections.warm"

# How many incarnations are drawn from the sequence at a time. One draw per
# this many opens, and a process restart wastes at most this many numbers out
# of about nine quadrillion.
INCARNATION_BATCH = 32

# How often beats forwarded to their holder go out, at most. A client beats
# every HEARTBEAT_INTERVAL_SECONDS and lapses after HEARTBEAT_TTL_SECONDS, so
# this leaves the holder plenty.
BEAT_FORWARD_SECONDS = 0.5

# How often every lease is checked, so a process that died stops counting as
# the holder of its connections soon after its lease goes stale, rather than
# at the bus's next re-check.
WATCH_SECONDS = RENEW_INTERVAL_SECONDS

# How long a session command waits for its watcher's process to take it.
RELAY_KEPT = timedelta(seconds=60)

# Room kept in every signal for what it carries beside its list of beats or
# released rooms: its kind, the sending process's id, and the tenant and agent
# a `changed` signal names, about 250 bytes at most.
_SIGNAL_ENVELOPE_BYTES = 400

_EMPTY = AgentSlotRows(connections={}, stored_claims={}, stored_placements={})


@dataclass(frozen=True)
class _Close:
    tenant_id: str
    agent_id: str
    connection_id: str
    incarnation: int
    reason: str


@dataclass(frozen=True)
class _Relay:
    tenant_id: str
    agent_id: str
    process_id: str
    frame: dict[str, Any]


class SharedConnections:
    """One process's side of the recorded agent connections."""

    def __init__(
        self,
        *,
        registry: AgentConnectionRegistry,
        session_factory: async_sessionmaker[AsyncSession],
        store: AgentConnectionStore,
        bus: SignalBus,
        lease: ProcessLease,
    ) -> None:
        if lease.process_id != bus.process_id:
            raise ValueError(
                "The process lease and the signal bus must name the same process"
            )
        self.process_id = bus.process_id
        self._registry = registry
        self._session_factory = session_factory
        self._store = store
        self._bus = bus
        self._lease = lease
        self._incarnations: list[int] = []
        self._incarnation_lock = asyncio.Lock()
        # Bumped every time an agent's state here is set from the rows or
        # written to them, so a full pass that read the rows before a move
        # does not set them back to what they were before it.
        self._versions: dict[str, int] = {}
        self._closes: dict[str, _Close] = {}
        self._relays: list[_Relay] = []
        self._writes = asyncio.Event()
        self._write_lock = asyncio.Lock()
        self._beats: dict[str, list[Any]] = {}
        self._beats_waiting = asyncio.Event()
        # Agents, by (tenant id, agent id), whose connections another process
        # changed and this one has still to read; and the rooms that process
        # took off connections held here, to be told once the read is in.
        self._changes_owed = bus.pending_work("agent connections", self._read_owed)
        self._released_owed: dict[tuple[str, str], list[Released]] = {}
        # Agents, by (tenant id, agent id), with session commands relayed to
        # this process and not yet taken.
        self._relays_owed = bus.pending_work(
            "relayed session commands", self._take_relays
        )
        bus.handle(CHANGED_SIGNAL, self._on_changed)
        bus.handle(BEATS_SIGNAL, self._on_beats)
        bus.handle(SESSION_COMMAND_SIGNAL, self._on_session_command)
        bus.handle(WARM_SIGNAL, self._on_warm)
        bus.on_resync(self.reload_all)
        bus.on_recheck(self.reload_all)
        registry.use_rows(self)

    # ── What the registry asks of its rows ────────────────────────────────

    def next_incarnation(self) -> int:
        if not self._incarnations:
            raise RuntimeError(
                "No incarnation drawn: a connection is opened inside a recorded "
                "move, which draws them"
            )
        return self._incarnations.pop(0)

    @asynccontextmanager
    async def recorded(self, agent_id: str) -> AsyncIterator[None]:
        tenant_id = current_tenant_id()
        if tenant_id is None:
            raise RuntimeError(
                f"Agent {agent_id}'s room slots are recorded in its tenant, and "
                "none is bound"
            )
        if not self._registry.holds_slots(agent_id):
            raise RuntimeError(
                f"A recorded move for agent {agent_id} is made inside its slots"
            )
        registry = self._registry
        async with tenant_session(self._session_factory, tenant_id) as session:
            await self._store.lock_agent(session, agent_id)
            rows = await self._read_agent(session, agent_id)
            # Every incarnation of the agent's connections is later than the
            # ones recorded before it, so a process holding an older one
            # knows a newer one presented is current and its copy is stale.
            # Numbers drawn in an earlier batch than the latest recorded are
            # passed over: the sequence's next ones are later than both.
            latest = max(
                (row.incarnation for row in rows.connections.values()), default=0
            )
            async with self._incarnation_lock:
                self._incarnations = [n for n in self._incarnations if n > latest]
                if not self._incarnations:
                    self._incarnations = await self._store.incarnations(
                        session, INCARNATION_BATCH
                    )
            self._apply(agent_id, tenant_id, rows)
            # Compared with what is recorded rather than with the copy just
            # set from it: a claim of a connection this process has closed,
            # and not yet recorded as closed, is in the rows but not here,
            # and a connection opening again on that id must not inherit it.
            slots_recorded = (rows.claims(), rows.placements())
            held_before = registry.incarnations_held_here(agent_id)
            opened: list[AgentConnection] = []
            try:
                with registry.collect_released() as released:
                    yield
                slots_after = registry.slot_state(agent_id)
                opened = [
                    conn
                    for conn in registry.held_here(agent_id)
                    if held_before.get(conn.id) != conn.stream_generation
                ]
                for conn in opened:
                    conn.tenant_id = tenant_id
                    written = await self._store.record_open(
                        session,
                        tenant_id=tenant_id,
                        connection_id=conn.id,
                        agent_id=agent_id,
                        process_id=self.process_id,
                        incarnation=conn.stream_generation,
                        scope=conn.scope,
                        delivery_filter=conn.delivery_filter,
                        spawn_capable=conn.spawn_capable,
                        transport=conn.stream_transport,
                        speaks=conn.declaration.speaks,
                        accepts=conn.declaration.protocol_floor,
                    )
                    if not written:
                        # Another agent's connection has this id, opened
                        # through a process this one has not heard from.
                        raise UnknownConnectionError(conn.id)
                if slots_after != slots_recorded:
                    claims, placements = slots_after
                    await self._store.replace_slots(
                        session,
                        tenant_id=tenant_id,
                        agent_id=agent_id,
                        claims=claims,
                        placements=placements,
                    )
                await session.commit()
            except BaseException:
                # Nothing was recorded, so nothing the block did stands: a
                # connection it opened is closed rather than left serving a row
                # no other process can see, and the rest is set back to what is
                # recorded.
                for conn in registry.held_here(agent_id):
                    if held_before.get(conn.id) != conn.stream_generation:
                        conn.tenant_id = None
                        registry.close(
                            conn.id,
                            Closure(
                                code="closed",
                                message="the connection could not be recorded",
                                room_id=None,
                            ),
                        )
                self._apply(agent_id, tenant_id, rows)
                raise
            self._bump(agent_id)
        if opened or slots_after != slots_recorded or released:
            self._publish_changed(tenant_id, agent_id, released)

    async def refresh(self, agent_id: str) -> None:
        tenant_id = current_tenant_id()
        if tenant_id is None:
            raise RuntimeError(
                f"Agent {agent_id}'s connections are read in its tenant, and none "
                "is bound"
            )
        await self._refresh(tenant_id, agent_id)

    async def agent_deleted(self, agent_id: str) -> None:
        tenant_id = current_tenant_id()
        if tenant_id is None:
            raise RuntimeError(
                f"Agent {agent_id}'s connections are recorded in its tenant, and "
                "none is bound"
            )
        # Its rows went with it, so there is nothing to read: what this
        # process holds of the agent is made what no rows say, which closes
        # the connections held here and drops the copies of the others'.
        async with self._registry.slots(agent_id):
            self._apply(agent_id, tenant_id, _EMPTY)
        self._publish_changed(tenant_id, agent_id, [])

    def closed(self, conn: AgentConnection) -> None:
        if conn.tenant_id is None or conn.closure is None:
            return
        self._closes[conn.id] = _Close(
            tenant_id=conn.tenant_id,
            agent_id=conn.agent_id,
            connection_id=conn.id,
            incarnation=conn.stream_generation,
            reason=conn.closure.code,
        )
        self._writes.set()

    def forward_beat(self, conn: AgentConnection, generation: int | None) -> None:
        self._beats[conn.id] = [conn.agent_id, conn.id, generation]
        self._beats_waiting.set()

    def relay_session_command(
        self, tenant_id: str, agent_id: str, process_id: str, frame: dict[str, Any]
    ) -> None:
        self._relays.append(
            _Relay(
                tenant_id=tenant_id,
                agent_id=agent_id,
                process_id=process_id,
                frame=frame,
            )
        )
        self._writes.set()

    def relay_warm(self, agent_id: str, process_id: str, room_id: str) -> None:
        self._bus.publish(
            WARM_SIGNAL, agent_id=agent_id, room_id=room_id, process_id=process_id
        )

    # ── Reading the rows into the registry ────────────────────────────────

    async def _read_agent(self, session: AsyncSession, agent_id: str) -> AgentSlotRows:
        return await self._store.read_agent(
            session, agent_id, process_id=self.process_id, lease_ttl=LEASE_TTL
        )

    def _apply(self, agent_id: str, tenant_id: str, rows: AgentSlotRows) -> None:
        for conn in self._registry.apply_rows(
            agent_id, tenant_id, rows, self.process_id
        ):
            logger.info(
                "[CONN] agent=%s connection=%s generation=%s was taken over by "
                "another process or a later incarnation; closed here",
                agent_id,
                conn.id,
                conn.stream_generation,
            )
        self._bump(agent_id)

    def _bump(self, agent_id: str) -> None:
        self._versions[agent_id] = self._versions.get(agent_id, 0) + 1

    async def _refresh(self, tenant_id: str, agent_id: str) -> None:
        async with self._registry.slots(agent_id):
            async with tenant_session(self._session_factory, tenant_id) as session:
                rows = await self._read_agent(session, agent_id)
            self._apply(agent_id, tenant_id, rows)
            # Told only once the read is in, so the rooms the stream reports
            # and the rooms it is told it lost agree.
            self._registry.notify_released(
                self._released_owed.pop((tenant_id, agent_id), [])
            )

    async def reload_all(self) -> None:
        """Read every tenant's rows again, and take any session commands
        waiting for a stream held here. Run when the signal connection comes
        back and on the bus's periodic re-check, so a tenant that cannot be
        read is logged and left to the next run, and the others are read."""
        with no_tenant():
            for tenant_id in await all_tenant_ids(self._session_factory):
                try:
                    await self._reload_tenant(tenant_id)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.error(
                        "Could not read tenant %s's agent connections again",
                        tenant_id,
                        exc_info=True,
                    )

    async def _reload_tenant(self, tenant_id: str) -> None:
        versions = dict(self._versions)
        async with tenant_session(self._session_factory, tenant_id) as session:
            pruned = await self._store.prune(
                session, tenant_id, closed_before=PRUNE_AFTER, relays_before=RELAY_KEPT
            )
            found = await self._store.read_tenant(
                session, tenant_id, process_id=self.process_id, lease_ttl=LEASE_TTL
            )
            relayed = await self._store.take_relays(
                session, tenant_id, process_id=self.process_id, agent_id=None
            )
            await session.commit()
        if pruned:
            logger.info(
                "Pruned %d agent connection row(s) in tenant %s closed or held by a "
                "process long gone",
                pruned,
                tenant_id,
            )
        for agent_id in set(found) | self._registry.agents_recorded_in(tenant_id):
            async with self._registry.slots(agent_id):
                if self._versions.get(agent_id, 0) != versions.get(agent_id, 0):
                    # Moved or read again since this pass read the rows, so
                    # what it holds is newer than what this pass found.
                    continue
                self._apply(agent_id, tenant_id, found.get(agent_id, _EMPTY))
        self._deliver(relayed)

    def _deliver(self, relayed: list[tuple[str, dict[str, Any]]]) -> None:
        for agent_id, frame in relayed:
            if not self._registry.deliver_relayed(agent_id, frame):
                logger.warning(
                    "A session command for agent %s arrived after the stream it "
                    "was relayed to went; dropped",
                    agent_id,
                )

    # ── Signals from the other processes ──────────────────────────────────

    def _on_changed(self, signal: dict[str, Any]) -> None:
        key = (signal["tenant_id"], signal["agent_id"])
        self._released_owed.setdefault(key, []).extend(
            Released(connection_id=entry[0], room_id=entry[1], session_id=entry[2])
            for entry in signal.get("released", [])
        )
        self._changes_owed.add(key)

    async def _read_owed(self, key: tuple[str, str]) -> None:
        tenant_id, agent_id = key
        await self._refresh(tenant_id, agent_id)

    def _on_beats(self, signal: dict[str, Any]) -> None:
        for agent_id, connection_id, generation in signal["beats"]:
            conn = self._registry.get(connection_id)
            if conn is None or conn.held_by is not None or conn.agent_id != agent_id:
                continue
            try:
                self._registry.beat(agent_id, connection_id, generation)
            except ConnectionError_ as refusal:
                # Fenced already where the beat landed; a refusal here means the
                # connection moved on in between, and the client is told at its
                # next beat.
                logger.debug(
                    "A forwarded beat for connection %s was refused: %s",
                    connection_id,
                    refusal,
                )

    def _on_session_command(self, signal: dict[str, Any]) -> None:
        if signal["process_id"] != self.process_id:
            return
        self._relays_owed.add((signal["tenant_id"], signal["agent_id"]))

    async def _take_relays(self, key: tuple[str, str]) -> None:
        tenant_id, agent_id = key
        async with tenant_session(self._session_factory, tenant_id) as session:
            relayed = await self._store.take_relays(
                session, tenant_id, process_id=self.process_id, agent_id=agent_id
            )
            await session.commit()
        self._deliver(relayed)

    def _on_warm(self, signal: dict[str, Any]) -> None:
        if signal["process_id"] != self.process_id:
            return
        if not self._registry.controllers.relay_warm(
            signal["agent_id"], signal["room_id"]
        ):
            logger.warning(
                "A warm for agent %s arrived after the controller stream it was "
                "relayed to went, or the agent was stopped; dropped",
                signal["agent_id"],
            )

    def _publish_changed(
        self, tenant_id: str, agent_id: str, released: list[Released]
    ) -> None:
        entries = [[r.connection_id, r.room_id, r.session_id] for r in released]
        # Sent with no rooms released too: the change is what is announced.
        for chunk in payload_chunks(entries, _SIGNAL_ENVELOPE_BYTES) or [[]]:
            self._bus.publish(
                CHANGED_SIGNAL, tenant_id=tenant_id, agent_id=agent_id, released=chunk
            )

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Read every other process's connections before this one serves.

        A tenant that cannot be read fails the start, as reading the
        controllers' connections does (`Management.load_connections`), rather
        than being logged as a re-read is: this process would otherwise serve
        and answer for that tenant's agents connected elsewhere as offline."""
        with no_tenant():
            for tenant_id in await all_tenant_ids(self._session_factory):
                await self._reload_tenant(tenant_id)

    async def run(self) -> None:
        """Write closings and relays, forward beats and watch the leases, until
        cancelled. What signals ask this process to read is worked by the
        signal bus, which runs it (`PendingWork`)."""
        # A task group rather than `gather`: cancelled, it waits for every
        # loop to unwind, so none is left holding a database connection.
        async with asyncio.TaskGroup() as group:
            group.create_task(self._write_forever())
            group.create_task(self._forward_beats_forever())
            group.create_task(self._watch_forever())

    async def flush(self) -> None:
        """Write every queued closing and relay. Raises the first failure,
        keeping what was not written."""
        async with self._write_lock:
            closes = list(self._closes.values())
            self._closes.clear()
            relays, self._relays = self._relays, []
            unwritten_closes = list(closes)
            unwritten_relays = list(relays)
            try:
                for close in closes:
                    async with tenant_session(
                        self._session_factory, close.tenant_id
                    ) as session:
                        written = await self._store.record_closed(
                            session,
                            tenant_id=close.tenant_id,
                            connection_id=close.connection_id,
                            incarnation=close.incarnation,
                            process_id=self.process_id,
                            reason=close.reason,
                        )
                        await session.commit()
                    unwritten_closes.remove(close)
                    if written:
                        self._publish_changed(close.tenant_id, close.agent_id, [])
                for relay in relays:
                    async with tenant_session(
                        self._session_factory, relay.tenant_id
                    ) as session:
                        await self._store.add_relay(
                            session,
                            tenant_id=relay.tenant_id,
                            agent_id=relay.agent_id,
                            process_id=relay.process_id,
                            frame=relay.frame,
                        )
                        await session.commit()
                    unwritten_relays.remove(relay)
                    self._bus.publish(
                        SESSION_COMMAND_SIGNAL,
                        tenant_id=relay.tenant_id,
                        agent_id=relay.agent_id,
                        process_id=relay.process_id,
                    )
            except BaseException:
                for close in unwritten_closes:
                    self._closes.setdefault(close.connection_id, close)
                self._relays[:0] = unwritten_relays
                raise

    async def _write_forever(self) -> None:
        while True:
            await self._writes.wait()
            self._writes.clear()
            try:
                await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Recording agent connection closings and session commands "
                    "failed; %d kept and retried in %.0fs",
                    len(self._closes) + len(self._relays),
                    RETRY_SECONDS,
                )
                await asyncio.sleep(RETRY_SECONDS)
                self._writes.set()

    async def _forward_beats_forever(self) -> None:
        while True:
            await self._beats_waiting.wait()
            self._beats_waiting.clear()
            beats, self._beats = list(self._beats.values()), {}
            for chunk in payload_chunks(beats, _SIGNAL_ENVELOPE_BYTES):
                try:
                    self._bus.publish(BEATS_SIGNAL, beats=chunk)
                except ValueError as error:
                    # Only a beat too large to send even alone is refused, and
                    # only a connection id recorded by a process that does not
                    # bound ids makes one. It is dropped rather than ending
                    # this loop, and with it the writer and the lease watcher
                    # that run beside it (`run`).
                    logger.error(
                        "A beat of agent %s could not be forwarded to its holder "
                        "and was dropped: %s",
                        chunk[0][0],
                        error,
                    )
            await asyncio.sleep(BEAT_FORWARD_SECONDS)

    async def _watch_forever(self) -> None:
        while True:
            await asyncio.sleep(WATCH_SECONDS)
            try:
                leases = await self._lease.read_all()
                lapsed = {
                    process_id
                    for process_id in self._registry.held_by_processes()
                    if not leases.holds(process_id)
                }
                if not lapsed:
                    continue
                agents = self._registry.drop_copies_held_by(lapsed)
                logger.warning(
                    "Switch-core process(es) %s stopped holding their lease; "
                    "their connections of %d agent(s) no longer count",
                    ", ".join(sorted(lapsed)),
                    len(agents),
                )
                # The placements those processes held go with them too, which
                # only a read of the rows can tell apart.
                await self.reload_all()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Checking the other processes' connections failed")
