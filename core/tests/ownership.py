"""A switch-core process's hold on work, for tests that read rooms.

A client's rooms are read only by the process that owns the client, under its
lease (`switch_core/ownership.py`), and the reading records progress through
that hold's cursors (`switch_core/transport/cursors.py`). A test standing in
for such a process claims the same rows production does: its own process
lease, then the lease for each client it reads for, and runs the cursor writer
the process would run.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.ownership import Fence, StartWork, StopWork
from switch_core.process_identity import new_process_id
from switch_core.process_lease import LEASE_TTL, ProcessLease
from switch_core.transport.cursors import ConsumerCursors, CursorWriter
from tests.conftest import TEST_KEYRING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.transport.postgres import PostgresTransport

logger = logging.getLogger(__name__)

CLIENT = "client"


def process_lease_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> ProcessLease:
    """A test process's lease, under a name of its own, as `main` claims one
    for each switch-core process (`process_identity.py`)."""
    return ProcessLease(
        process_id=new_process_id("test-pod"),
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
        key_ids=[key.id for key in TEST_KEYRING.keys],
    )


@dataclass
class Holder:
    """One process: its lease, its cursor writer, and the fences it holds."""

    session_factory: async_sessionmaker[AsyncSession]
    lease: ProcessLease
    writer: CursorWriter
    task: asyncio.Task[None]
    lost: list[Fence] = field(default_factory=list)

    @property
    def process_id(self) -> str:
        return self.lease.process_id

    async def claim(self, key: str, *, kind: str = CLIENT) -> Fence:
        """Claim the lease for `key`, as the ownership would. Raises when
        another live process holds it."""
        async with self.session_factory() as session:
            claimed = await OwnershipLeaseStore().claim(
                session,
                kind=kind,
                keys=[key],
                process_id=self.process_id,
                lease_ttl=LEASE_TTL,
            )
            await session.commit()
        if key not in claimed:
            raise AssertionError(f"{kind} {key} is held by another process")
        return Fence(kind=kind, key=key, process_id=self.process_id, token=claimed[key])

    async def cursors(
        self,
        client_id: str,
        *,
        tenant_id: str = TENANT_ZERO_ID,
        kind: str = CLIENT,
        key: str | None = None,
        actor_role: str = "agent",
    ) -> ConsumerCursors:
        """Cursors for reading `client_id`'s rooms under a fresh claim."""
        fence = await self.claim(key or client_id, kind=kind)
        return ConsumerCursors(
            writer=self.writer,
            store=DeliveryCursorStore(),
            tenant_id=tenant_id,
            client_id=client_id,
            fence=fence,
            actor_role=actor_role,
            on_lost=self.lost.append,
        )

    async def receiving(self, transport: PostgresTransport) -> asyncio.Task[None]:
        """Start `transport` reading its client's rooms under this process."""
        cursors = await self.cursors(transport.client_id, tenant_id=transport.tenant_id)
        return asyncio.create_task(transport.receive_forever(cursors))

    async def stop(self) -> None:
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


async def start_holder(session_factory: async_sessionmaker[AsyncSession]) -> Holder:
    """A process whose lease is claimed and whose cursor writer runs."""
    lease = process_lease_on(session_factory)
    await lease.renew()
    writer = CursorWriter(
        session_factory=session_factory,
        cursors=DeliveryCursorStore(),
        leases=OwnershipLeaseStore(),
        process_id=lease.process_id,
    )
    return Holder(
        session_factory=session_factory,
        lease=lease,
        writer=writer,
        task=asyncio.create_task(writer.run()),
    )


class NeverOwned:
    """An ownership under which this process claims nothing, for tests of a
    lifecycle that are not about which process owns what: work is wanted and
    dropped as the code under test asks, and never started."""

    def kind(self, name: str, *, start: object, stop: object) -> _NeverOwnedKind:
        return _NeverOwnedKind()


class _NeverOwnedKind:
    def __init__(self) -> None:
        self._wanted: set[str] = set()

    def want(self, key: str, *, placed_with: tuple[str, str] | None = None) -> None:
        self._wanted.add(key)

    def wants(self, key: str) -> bool:
        return key in self._wanted

    async def drop(self, key: str) -> None:
        self._wanted.discard(key)

    def fence(self, key: str) -> Fence | None:
        return None

    def lost(self, fence: Fence) -> None:
        return None


class SoleOwner:
    """An ownership under which this process is the only one, and holds all
    the work it wants, as a deployment of one process does after its first
    balance. For unit tests of a lifecycle that run without a database: work
    wanted starts when the code under test settles it or the test calls
    `start()`, as `main` does at boot, and every key reads as held here, so
    work a test starts by hand runs as its holder would."""

    process_id = "the-only-process"

    def __init__(self) -> None:
        self.stopping = False
        self._kinds: list[_SoleKind] = []

    def kind(self, name: str, *, start: StartWork, stop: StopWork) -> _SoleKind:
        kind = _SoleKind(self, name, start, stop)
        self._kinds.append(kind)
        return kind

    async def start(self) -> None:
        for kind in self._kinds:
            await kind.settle()

    async def stop(self) -> None:
        self.stopping = True
        for kind in self._kinds:
            for key in sorted(kind.held()):
                await kind.drop(key)

    @staticmethod
    def cursor_writer(
        session_factory: async_sessionmaker[AsyncSession] | Any,
    ) -> CursorWriter:
        """The process's cursor writer, never run: what a consumer under it
        records is written only when flushed."""
        return CursorWriter(
            session_factory=session_factory,
            cursors=DeliveryCursorStore(),
            leases=OwnershipLeaseStore(),
            process_id=SoleOwner.process_id,
        )


class _SoleKind:
    def __init__(
        self, owner: SoleOwner, name: str, start: StartWork, stop: StopWork
    ) -> None:
        self.name = name
        self._owner = owner
        self._start = start
        self._stop = stop
        self._wanted: set[str] = set()
        self._started: set[str] = set()

    def want(self, key: str, *, placed_with: tuple[str, str] | None = None) -> None:
        self._wanted.add(key)

    def wanted(self) -> set[str]:
        return set(self._wanted)

    def wants(self, key: str) -> bool:
        return key in self._wanted

    @property
    def stopping(self) -> bool:
        return self._owner.stopping

    async def settle(self) -> None:
        for key in sorted(self._wanted - self._started):
            self._started.add(key)
            fence = self.fence(key)
            assert fence is not None
            # As the ownership does: one key failing to start is logged, and
            # the rest still start.
            try:
                await self._start(key, fence)
            except Exception:
                logger.exception("Starting %s %s failed", self.name, key)

    def held(self) -> set[str]:
        return set(self._started)

    def fence(self, key: str) -> Fence | None:
        return Fence(
            kind=self.name, key=key, process_id=self._owner.process_id, token=1
        )

    async def drop(self, key: str) -> None:
        self._wanted.discard(key)
        if key in self._started:
            self._started.discard(key)
            await self._stop(key)

    def lost(self, fence: Fence) -> None:
        return None
