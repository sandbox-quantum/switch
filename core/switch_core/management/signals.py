"""Management's nudges and bindings, kept current in whichever process holds
the controller.

A change commits in the process that handled the request; the controller it
affects may be streaming from any process, and every process answers that
controller's agents' requests. So every change is acted on here at once (the
local subscriptions and bindings, and on revocation the local presence) and
published on the `SignalBus` for the others, which do the same on receipt.

Nudges were already wake-ups, never the record: a controller woken pulls its
assignment or its operations. A binding is a copy of the record, which is why
a process that hears `controller.assignment_changed` or `controller.renamed`
reads the controller's placed definitions again rather than trusting the
signal (`bindings.reconcile_controller_bindings`). A move bumps the revision of
both controllers, so both are re-read.

Which process holds each controller's socket is kept the same way. A
controller opening a connection, another process taking one up, and a socket
attaching or going are announced as `controller.connection_changed`, and each
process told reads the controller's row again (`_read_connection`): an agent
run by a controller connected to any process then reads as live in every one,
and a connection this process holds that another process has since replaced
or taken up is closed `taken_over`.

Nothing here depends on a signal arriving. When the signal connection comes
back, every binding and every controller's connection is read again and every
controller held here is re-nudged from the database, so one that missed a
signal while the connection was down pulls again, and one revoked meanwhile is
closed. The periodic re-check does the same reads, but nudges a held
controller only with what it has not been told yet (a newer revision, an
operation it has not heard of), so a quiet controller is not made to pull
every `RECHECK_SECONDS`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.management.bindings import (
    reconcile_bindings,
    reconcile_controller_bindings,
)
from switch_core.process_lease import ProcessLeases, read_leases
from switch_core.tenant_context import no_tenant

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.controller_presence import (
        ControllerPresence,
    )
    from switch_core.db.models import AgentController
    from switch_core.db.stores.agent_controller_operation_store import (
        AgentControllerOperationStore,
    )
    from switch_core.db.stores.agent_controller_store import AgentControllerStore
    from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.switch_core_process_store import (
        SwitchCoreProcessStore,
    )
    from switch_core.management.notifier import ControllerNotifier
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

ASSIGNMENT_CHANGED_SIGNAL = "controller.assignment_changed"
OPERATION_PENDING_SIGNAL = "controller.operation_pending"
REVOKED_SIGNAL = "controller.revoked"
RENAMED_SIGNAL = "controller.renamed"
CONNECTION_CHANGED_SIGNAL = "controller.connection_changed"

# How many times a controller's row is read again when this process changed
# that controller's connection while it was being read, before it is left to
# the next re-check.
_READ_ATTEMPTS = 3


class ControllerSignals:
    def __init__(
        self,
        *,
        notifier: ControllerNotifier,
        presence: ControllerPresence,
        bus: SignalBus,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        definitions: AgentDefinitionStore,
        operations: AgentControllerOperationStore,
        rooms: RoomStore,
        processes: SwitchCoreProcessStore,
        clock: Callable[[], datetime],
    ) -> None:
        self.notifier = notifier
        # The process this is, as signals and the rows naming a holder call it.
        self.process_id = bus.process_id
        self._presence = presence
        self._bus = bus
        self._session_factory = session_factory
        self._controllers = controllers
        self._definitions = definitions
        self._operations = operations
        self._rooms = rooms
        self._processes = processes
        self._clock = clock
        # What each controller has been nudged with from this process, so the
        # periodic re-check tells a held controller only what is new to it.
        self._nudged_revision: dict[str, int] = {}
        self._nudged_operations: dict[str, set[str]] = {}
        # Controllers, by (tenant id, controller id), whose bindings another
        # process changed and this one has still to read.
        self._bindings_owed = bus.pending_work(
            "controller bindings", self._reconcile_controller
        )
        # Controllers, by (tenant id, controller id), whose connection another
        # process changed and this one has still to read.
        self._connections_owed = bus.pending_work(
            "controller connections", self._read_connection_of
        )
        bus.handle(ASSIGNMENT_CHANGED_SIGNAL, self._on_assignment_changed)
        bus.handle(OPERATION_PENDING_SIGNAL, self._on_operation_pending)
        bus.handle(REVOKED_SIGNAL, self._on_revoked)
        bus.handle(RENAMED_SIGNAL, self._on_renamed)
        bus.handle(CONNECTION_CHANGED_SIGNAL, self._on_connection_changed)
        bus.on_resync(self.resync)
        bus.on_recheck(self.recheck)

    # ── Announcing, from the process that made the change ─────────────────────

    def assignment_changed(
        self, tenant_id: str, controller_id: str, revision: int
    ) -> None:
        """The process that committed the change has already bound its agents."""
        self._nudge_assignment(controller_id, revision)
        self._bus.publish(
            ASSIGNMENT_CHANGED_SIGNAL,
            tenant_id=tenant_id,
            controller_id=controller_id,
            revision=revision,
        )

    def operation_pending(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        self._nudge_operation(
            controller_id, operation_id=operation_id, kind=kind, agent_id=agent_id
        )
        self._bus.publish(
            OPERATION_PENDING_SIGNAL,
            controller_id=controller_id,
            operation_id=operation_id,
            operation_kind=kind,
            agent_id=agent_id,
        )

    def revoked(self, controller_id: str) -> None:
        self._revoke_here(controller_id)
        self._bus.publish(REVOKED_SIGNAL, controller_id=controller_id)

    def renamed(self, tenant_id: str, controller_id: str) -> None:
        """The controller's owner renamed it. A rename bumps no assignment
        revision, so it needs a signal of its own for the other processes to
        re-read the name their bindings carry."""
        self._bus.publish(
            RENAMED_SIGNAL, tenant_id=tenant_id, controller_id=controller_id
        )

    def connection_changed(self, tenant_id: str, controller_id: str) -> None:
        """The controller's connection row changed (an open, a connection
        taken up, a socket attaching or going), and this process already acts
        on it."""
        self._bus.publish(
            CONNECTION_CHANGED_SIGNAL, tenant_id=tenant_id, controller_id=controller_id
        )

    # ── Receiving, in every other process ─────────────────────────────────────

    def _on_assignment_changed(self, signal: dict[str, Any]) -> None:
        # Nudged at once, as before bindings were re-read here: the
        # controller's pull may land on any process, so waiting for this
        # one's read would only delay it.
        self._nudge_assignment(signal["controller_id"], signal["revision"])
        self._bindings_owed.add((signal["tenant_id"], signal["controller_id"]))

    def _on_operation_pending(self, signal: dict[str, Any]) -> None:
        self._nudge_operation(
            signal["controller_id"],
            operation_id=signal["operation_id"],
            kind=signal["operation_kind"],
            agent_id=signal["agent_id"],
        )

    def _on_revoked(self, signal: dict[str, Any]) -> None:
        self._revoke_here(signal["controller_id"])

    def _on_renamed(self, signal: dict[str, Any]) -> None:
        self._bindings_owed.add((signal["tenant_id"], signal["controller_id"]))

    def _on_connection_changed(self, signal: dict[str, Any]) -> None:
        self._connections_owed.add((signal["tenant_id"], signal["controller_id"]))

    async def _reconcile_controller(self, key: tuple[str, str]) -> None:
        tenant_id, controller_id = key
        await reconcile_controller_bindings(
            session_factory=self._session_factory,
            definitions=self._definitions,
            controllers=self._controllers,
            presence=self._presence,
            tenant_id=tenant_id,
            controller_id=controller_id,
        )
        # An agent just bound to a controller another process holds needs its
        # rooms here, as the controller's other agents have them, to be
        # present in them at once: reading the connection again loads them.
        if self._presence.holder_elsewhere(controller_id) is not None:
            await self._read_connection(tenant_id, controller_id)

    # ── Which process holds each controller's socket ──────────────────────────

    async def _read_connection_of(self, key: tuple[str, str]) -> None:
        tenant_id, controller_id = key
        await self._read_connection(tenant_id, controller_id)

    async def _read_connection(self, tenant_id: str, controller_id: str) -> None:
        """Read the controller's row again and act on it here."""
        for _ in range(_READ_ATTEMPTS):
            mark = self._presence.connection_mark()
            async with tenant_session(self._session_factory, tenant_id) as session:
                controller = await self._controllers.get(
                    session, tenant_id, controller_id
                )
                if controller is None:
                    return
                leases = await read_leases(session, self._processes)
                rooms = await self._rooms_if_held_elsewhere(session, controller, leases)
            if self._presence.connection_changed_since(controller_id, mark):
                # Changed here while it was read: what was read may be older.
                continue
            self._apply_connection(controller, leases, rooms)
            return

    async def read_connections(self) -> None:
        """Read every controller's connection row again, in every tenant, and
        make this process's view of who holds each socket agree. Run at
        startup, before the bridge serves, and on resync and each re-check."""
        seen: set[str] = set()
        elsewhere = self._presence.controllers_elsewhere()
        with no_tenant():
            tenant_ids = await all_tenant_ids(self._session_factory)
        for tenant_id in tenant_ids:
            mark = self._presence.connection_mark()
            async with tenant_session(self._session_factory, tenant_id) as session:
                leases = await read_leases(session, self._processes)
                found = [
                    controller
                    for controller in await self._controllers.list_with_connections(
                        session, tenant_id
                    )
                    if controller.tenant_id == tenant_id
                ]
                rooms = {
                    controller.id: await self._rooms_if_held_elsewhere(
                        session, controller, leases
                    )
                    for controller in found
                }
            for controller in found:
                seen.add(controller.id)
                if self._presence.connection_changed_since(controller.id, mark):
                    # Changed here while it was read; read it again on its own.
                    await self._read_connection(tenant_id, controller.id)
                    continue
                self._apply_connection(controller, leases, rooms[controller.id])
        for controller_id in elsewhere - seen:
            self._presence.held_elsewhere(controller_id, None)

    async def _rooms_if_held_elsewhere(
        self,
        session: AsyncSession,
        controller: AgentController,
        leases: ProcessLeases,
    ) -> dict[str, set[str]]:
        """The rooms of each agent the controller runs, when another process
        holds its socket: they are what makes those agents present in a room
        here, and the stream that loads them runs over there."""
        if self._held_elsewhere(controller, leases) is None:
            return {}
        return {
            agent_id: {
                room.id
                for room in await self._rooms.get_rooms_for_agent(
                    session, agent_id, include_archived=True
                )
            }
            for agent_id in sorted(self._presence.agents_of(controller.id))
        }

    def _held_elsewhere(
        self, controller: AgentController, leases: ProcessLeases
    ) -> str | None:
        """The other process holding the controller's live socket, if any."""
        process_id = controller.connection_process_id
        if (
            controller.connection_id is None
            or controller.disconnected_at is not None
            or process_id is None
            or process_id == self.process_id
            or not leases.holds(process_id)
        ):
            return None
        return process_id

    def _apply_connection(
        self,
        controller: AgentController,
        leases: ProcessLeases,
        rooms: dict[str, set[str]],
    ) -> None:
        local = self._presence.current_connection(controller.id)
        if local is not None and controller.open_connection_id is not None:
            # The row names the connection the controller opened last and the
            # process holding it. A connection held here that is not that one,
            # or is that one but taken up by another process, is over here.
            if (
                controller.open_connection_id != local.id
                or controller.open_process_id != self.process_id
            ):
                self._presence.supersede(controller.id)
        self._presence.held_elsewhere(
            controller.id, self._held_elsewhere(controller, leases)
        )
        for agent_id, agent_rooms in rooms.items():
            self._presence.set_rooms(agent_id, agent_rooms)

    # ── Acting here ───────────────────────────────────────────────────────────

    def _nudge_assignment(self, controller_id: str, revision: int) -> None:
        if revision > self._nudged_revision.get(controller_id, -1):
            self._nudged_revision[controller_id] = revision
        self.notifier.assignment_changed(controller_id, revision)

    def _nudge_operation(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        self._nudged_operations.setdefault(controller_id, set()).add(operation_id)
        self.notifier.operation_pending(
            controller_id, operation_id=operation_id, kind=kind, agent_id=agent_id
        )

    def _revoke_here(self, controller_id: str) -> None:
        """The stream ends, the controller cannot open another here, and this
        process's token cache forgets it."""
        self.notifier.credential_revoked(controller_id)
        self._presence.revoke_controller(controller_id)

    # ── Resync and re-check ───────────────────────────────────────────────────

    async def resync(self) -> None:
        """Re-read every binding and every controller's connection, then
        re-nudge every controller this process holds from what the database
        says now: its assignment revision and its open operations, or its
        revocation."""
        await self._reconcile_all_bindings()
        await self._read_all_connections()
        await self._renudge_held(only_new=False)

    async def recheck(self) -> None:
        """What `resync` does, but a held controller is nudged only with what
        this process has not told it yet."""
        await self._reconcile_all_bindings()
        await self._read_all_connections()
        await self._renudge_held(only_new=True)

    async def _read_all_connections(self) -> None:
        try:
            await self.read_connections()
        except Exception:
            logger.error("Could not re-read controller connections", exc_info=True)

    async def _reconcile_all_bindings(self) -> None:
        try:
            await reconcile_bindings(
                session_factory=self._session_factory,
                definitions=self._definitions,
                controllers=self._controllers,
                presence=self._presence,
            )
        except Exception:
            logger.error("Could not re-read controller bindings", exc_info=True)

    async def _renudge_held(self, *, only_new: bool) -> None:
        held = self._presence.held_connections()
        # What a controller held elsewhere was told is no use here: if it
        # connects to this process later, its opening frame carries the state.
        held_ids = {conn.controller_id for conn in held}
        for remembered in (self._nudged_revision, self._nudged_operations):
            for controller_id in set(remembered) - held_ids:
                del remembered[controller_id]
        for conn in held:
            try:
                async with tenant_session(
                    self._session_factory, conn.tenant_id
                ) as session:
                    controller = await self._controllers.get(
                        session, conn.tenant_id, conn.controller_id
                    )
                    if controller is None or controller.revoked_at is not None:
                        self._revoke_here(conn.controller_id)
                        continue
                    offered = await self._operations.list_offered(
                        session, conn.tenant_id, conn.controller_id, self._clock()
                    )
                revision = controller.assignment_revision
                if not only_new or revision > self._nudged_revision.get(
                    conn.controller_id, -1
                ):
                    self._nudge_assignment(conn.controller_id, revision)
                told = self._nudged_operations.get(conn.controller_id, set())
                for operation in offered:
                    if only_new and operation.id in told:
                        continue
                    self._nudge_operation(
                        conn.controller_id,
                        operation_id=operation.id,
                        kind=operation.kind,
                        agent_id=operation.agent_id,
                    )
                # Only the operations still offered need remembering.
                self._nudged_operations[conn.controller_id] = {
                    operation.id for operation in offered
                }
            except Exception:
                logger.error(
                    "Could not resync controller %s", conn.controller_id, exc_info=True
                )
