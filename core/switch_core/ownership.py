"""One owner for each piece of work that must run once, across switch-core processes.

Several switch-core processes share one database, and some work must run in
exactly one of them: a client's consumer, such as the admin's, which answers
commands and posts warnings; a collaboration bridge's platform connection and
the consumer that posts to the platform. Run in two processes, every such
effect happens twice.

Each piece of work is a kind and a key ("client" and a client id). A process
wants the keys it could run, and runs those it owns. Which process owns a key
is decided twice over:

- **Who should.** Rendezvous hashing over the processes whose lease in
  `switch_core_processes` holds: every process scores every key against every
  live process and the highest score wins. All processes reading the same
  leases agree, and a process coming or going moves only the keys it wins or
  held, not everyone's. A key that can only run beside another kind's key is
  hashed as that key (`OwnedKind.want`), so both land on the same process.
- **Who does.** A row in `ownership_leases`, claimed in one statement and only
  while nobody holds it or its holder's process lease has lapsed. The hash says
  who tries; the row makes sure only one succeeds, whatever two processes
  briefly believe about each other.

A key moves without overlap. The process that should no longer own it stops
the work first and then releases the row, and only then can the new owner claim
it. A process that dies holds nothing once its lease lapses, and its work is
claimed by the next owner. A process that cannot renew its own lease stops all
its work at half the lease's lifetime by its own clock, before anyone else may
claim it (`ProcessLease.surely_held`).

Every claim bumps the row's `token`, and the work is started with it (`Fence`).
Writes that must not outlive the hold name the token in the same statement
(`DeliveryCursorStore.advance`), so a holder taken over without knowing it is
refused, and is stopped when it is.

Changes reach the other processes over the signal bus: `ownership.changed`
after a process releases keys, starts, or has marked its process lease stopped
as it shuts down, so they rebalance at once. Every process also rebalances
every `BALANCE_INTERVAL_SECONDS`, which is how a process that died is noticed:
one read of the process leases, and no write unless something moved.

With one process this is that process owning everything, claimed once at boot.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from switch_core.process_lease import (
    LEASE_TTL,
    RENEW_INTERVAL_SECONDS,
    read_leases,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
    from switch_core.db.stores.switch_core_process_store import (
        SwitchCoreProcessStore,
    )
    from switch_core.process_lease import ProcessLease
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

OWNERSHIP_CHANGED_SIGNAL = "ownership.changed"

# How often every process re-reads the process leases and rebalances, which
# is how a process that stopped renewing is noticed. As often as leases are
# renewed: a lapse cannot be seen sooner than that.
BALANCE_INTERVAL_SECONDS = RENEW_INTERVAL_SECONDS

# How long a released row is kept. Work that still exists is claimed again
# within seconds of its release.
PRUNE_AFTER = timedelta(hours=1)

# How often a balance also prunes, so the delete is not a write on every pass.
PRUNE_EVERY_SECONDS = 600.0

StartWork = Callable[[str, "Fence"], Awaitable[None]]
StopWork = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class Fence:
    """The hold a piece of work was started under: which lease, which process,
    and the token the claim returned."""

    kind: str
    key: str
    process_id: str
    token: int


def owner_of(kind: str, key: str, processes: Sequence[str]) -> str | None:
    """The process that should own `key` among `processes`: the one whose
    score for it is highest. None when there is no process."""
    if not processes:
        return None
    return max(
        processes, key=lambda process_id: (_score(kind, key, process_id), process_id)
    )


def _score(kind: str, key: str, process_id: str) -> int:
    digest = hashlib.blake2b(
        f"{kind}\x1f{key}\x1f{process_id}".encode(), digest_size=8
    ).digest()
    return int.from_bytes(digest, "big")


class OwnedKind:
    """The keys of one kind of work: which this process could run, and which
    it runs. Built by `Ownership.kind`."""

    def __init__(
        self, ownership: Ownership, name: str, start: StartWork, stop: StopWork
    ) -> None:
        self.name = name
        self._ownership = ownership
        self._start = start
        self._stop = stop
        self._wanted: set[str] = set()
        # Keys placed with another kind's key (`want`), by that kind and key.
        self._placed_with: dict[str, tuple[str, str]] = {}
        self._held: dict[str, Fence] = {}
        # Fences the work reported taken over, kept until the next balance
        # stops it.
        self._lost: set[Fence] = set()

    def want(self, key: str, *, placed_with: tuple[str, str] | None = None) -> None:
        """This process could run `key`. It runs it once it owns it.

        `placed_with` names another kind's key, as (kind, key), whose owner
        should own this one too: work that can only run beside it, such as a
        Discord bridge whose events reach it in-process from the one shared
        Gateway connection. Both are hashed the same, so every process puts
        them on the same one. Each still has a lease of its own."""
        if key in self._wanted and self._placed_with.get(key) == placed_with:
            return
        self._wanted.add(key)
        if placed_with is None:
            self._placed_with.pop(key, None)
        else:
            self._placed_with[key] = placed_with
        self._ownership.nudge()

    def wanted(self) -> set[str]:
        return set(self._wanted)

    def wants(self, key: str) -> bool:
        return key in self._wanted

    @property
    def stopping(self) -> bool:
        """Whether the process is shutting down, so work stopped now is not
        to be started again in any form."""
        return self._ownership.stopping

    async def settle(self) -> None:
        """Balance now and return once done, for a caller that needs to know
        whether this process holds a key it has just wanted."""
        await self._ownership.balance()

    def held(self) -> set[str]:
        """The keys this process runs now."""
        return set(self._held)

    def fence(self, key: str) -> Fence | None:
        return self._held.get(key)

    async def drop(self, key: str) -> None:
        """This process will not run `key` any more: stop it here now if it
        runs, and let go of its lease. For work being deleted, which must be
        stopped before its rows go."""
        self._wanted.discard(key)
        self._placed_with.pop(key, None)
        async with self._ownership.balancing():
            if key in self._held:
                await self._stop_held([key])
                await self._ownership.release(self.name, [key])

    def lost(self, fence: Fence) -> None:
        """The work found its lease taken over: stop it at the next balance."""
        if self._held.get(fence.key) == fence:
            self._lost.add(fence)
            self._ownership.nudge()

    async def _balance(self, live: Sequence[str]) -> None:
        me = self._ownership.process_id
        lost = [fence.key for fence in self._lost if self._held.get(fence.key) == fence]
        self._lost.clear()
        if lost:
            logger.warning(
                "%d %s lease(s) were taken over by another process; stopping "
                "them here: %s",
                len(lost),
                self.name,
                ", ".join(sorted(lost)),
            )
            await self._stop_held(lost)
        mine = {key for key in self._wanted if self._owner(key, live) == me}
        leaving = [key for key in self._held if key not in mine]
        if leaving:
            logger.info(
                "Handing %d %s(s) to the process that now owns them",
                len(leaving),
                self.name,
            )
            await self._stop_held(leaving)
            await self._ownership.release(self.name, leaving)
        wanted = [key for key in mine if key not in self._held]
        if not wanted:
            return
        claimed = await self._ownership.claim(self.name, wanted)
        for key, token in sorted(claimed.items()):
            # Dropped while the claim was in flight: give it straight back.
            if key not in self._wanted:
                await self._ownership.release(self.name, [key])
                continue
            fence = Fence(kind=self.name, key=key, process_id=me, token=token)
            self._held[key] = fence
            try:
                await self._start(key, fence)
            except Exception:
                logger.exception("Starting %s %s failed", self.name, key)

    def _owner(self, key: str, live: Sequence[str]) -> str | None:
        kind, placed_key = self._placed_with.get(key, (self.name, key))
        return owner_of(kind, placed_key, live)

    async def _stop_held(self, keys: Sequence[str]) -> None:
        """Stop the work of `keys` here, all at once, each failure logged."""
        stopping = [key for key in keys if self._held.pop(key, None) is not None]
        results = await asyncio.gather(
            *(self._stop(key) for key in stopping), return_exceptions=True
        )
        for key, result in zip(stopping, results, strict=True):
            if isinstance(result, BaseException):
                logger.error(
                    "Stopping %s %s failed",
                    self.name,
                    key,
                    exc_info=result,
                )

    async def _stop_all(self) -> None:
        await self._stop_held(list(self._held))


class Ownership:
    """Which pieces of work this process runs, decided with the others."""

    def __init__(
        self,
        *,
        lease: ProcessLease,
        session_factory: async_sessionmaker[AsyncSession],
        bus: SignalBus,
        store: OwnershipLeaseStore,
        processes: SwitchCoreProcessStore,
    ) -> None:
        self._lease = lease
        self._session_factory = session_factory
        self._bus = bus
        self._store = store
        self._processes = processes
        # A kind can be registered while a balance is under way (Discord's
        # gateway registers its kind once the signal bus has started, and a
        # resync balances at any time), so every loop over the kinds that
        # awaits goes over a copy taken before it starts.
        self._kinds: dict[str, OwnedKind] = {}
        # One balance, drop or stop at a time: each reads what is held, then
        # awaits stops and claims, and two interleaved would claim or release
        # each other's keys.
        self._lock = asyncio.Lock()
        self._nudged = asyncio.Event()
        self._suspended = False
        self._stopped = False
        # Whether `stop` saw every piece of work here stop, rather than being
        # cancelled first.
        self._work_stopped = False
        self._pruned_at: float | None = None
        bus.handle(OWNERSHIP_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self._resync)

    @property
    def process_id(self) -> str:
        return self._lease.process_id

    @property
    def stopping(self) -> bool:
        return self._stopped

    def kind(self, name: str, *, start: StartWork, stop: StopWork) -> OwnedKind:
        """Register a kind of work. `start(key, fence)` runs the work here and
        returns once it is under way; `stop(key)` stops it and returns once it
        has stopped."""
        if name in self._kinds:
            raise ValueError(f"Ownership kind {name!r} is already registered")
        kind = OwnedKind(self, name, start, stop)
        self._kinds[name] = kind
        return kind

    def nudge(self) -> None:
        """Balance soon, rather than at the next interval."""
        self._nudged.set()

    @contextlib.asynccontextmanager
    async def balancing(self) -> Any:
        async with self._lock:
            yield

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """The first balance, before the process serves, so what this process
        owns is running as it would have at boot with one process. Then the
        other processes are told this one is here.

        The lease is renewed first, so the work starts with all the time the
        lease is sure for, however long the boot took since it was claimed."""
        await self._lease.renew()
        await self.balance()
        self._bus.publish(OWNERSHIP_CHANGED_SIGNAL)

    async def run(self) -> None:
        """Balance whenever nudged, every `BALANCE_INTERVAL_SECONDS`, and the
        moment this process's own lease stops being sure, until cancelled."""
        while not self._stopped:
            timeout = BALANCE_INTERVAL_SECONDS
            held_until = self._lease.held_until()
            if held_until is not None and held_until > time.monotonic():
                # Wake as the lease stops being sure, not up to an interval
                # after: that is the moment this process's work has to stop.
                timeout = min(timeout, held_until - time.monotonic())
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._nudged.wait(), timeout)
            self._nudged.clear()
            try:
                await self.balance()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Balancing owned work failed; retrying shortly")

    async def stop(self) -> None:
        """Stop everything this process runs, then let go of its leases. Called
        as the process shuts down, before its process lease is marked stopped;
        a second call waits for the first and does nothing. It raises instead
        when the first was cancelled before all the work had stopped, as
        `main` does with a stop that takes too long: that work may still run
        here, so the process lease must be left to lapse, not marked stopped.

        Nothing is signalled yet: while the process lease holds, the other
        processes still hash this one's work to it and claim none of it. The
        caller signals with `gone` once the lease is marked stopped."""
        async with self._lock:
            if self._stopped:
                if not self._work_stopped:
                    raise RuntimeError(
                        "This process's owned work was not all stopped; its "
                        "leases pass to the other processes once its process "
                        "lease lapses"
                    )
                return
            self._stopped = True
            for kind in list(self._kinds.values()):
                await kind._stop_all()
            self._work_stopped = True
            try:
                async with self._session_factory() as session:
                    await self._store.release_all(session, self.process_id)
                    await session.commit()
            except Exception:
                logger.warning(
                    "Could not release this process's owned work at shutdown; "
                    "the other processes take it over once its lease lapses",
                    exc_info=True,
                )
                return

    def gone(self) -> None:
        """Tell the other processes this one's process lease is marked
        stopped, so they rebalance at once and claim the work `stop` let go
        of, rather than at their next interval."""
        self._bus.publish(OWNERSHIP_CHANGED_SIGNAL)

    # ── Balancing ────────────────────────────────────────────────────────────

    async def balance(self) -> None:
        """Run here exactly the wanted keys this process should own, as far
        as the leases allow."""
        async with self._lock:
            if self._stopped:
                return
            if not self._lease.surely_held():
                await self._suspend()
                return
            async with self._session_factory() as session:
                leases = await read_leases(session, self._processes)
            await self._prune_now_and_then()
            live = sorted(
                process_id for process_id in leases.leases if leases.holds(process_id)
            )
            if self.process_id not in live:
                # Sure of its own lease by its own clock but not yet seen
                # renewed by the database's: claim nothing until both agree.
                logger.warning(
                    "This process's lease %s does not read as held; owning "
                    "nothing until it does",
                    self.process_id,
                )
                return
            if self._suspended:
                logger.warning(
                    "This process's lease %s holds again; claiming its share "
                    "of the work back",
                    self.process_id,
                )
                self._suspended = False
            for kind in list(self._kinds.values()):
                await kind._balance(live)

    async def _prune_now_and_then(self) -> None:
        now = time.monotonic()
        if self._pruned_at is not None and now - self._pruned_at < PRUNE_EVERY_SECONDS:
            return
        self._pruned_at = now
        async with self._session_factory() as session:
            pruned = await self._store.prune(session, PRUNE_AFTER)
            await session.commit()
        if pruned:
            logger.info("Pruned %d ownership lease(s) long released", pruned)

    async def _suspend(self) -> None:
        """Stop all work here because this process can no longer be sure its
        lease holds. Nothing is released: the database may not be reachable,
        and the leases pass to the other processes once this one lapses."""
        if not any(kind.held() for kind in self._kinds.values()):
            self._suspended = True
            return
        logger.error(
            "This process's lease %s was not renewed in time; stopping every "
            "piece of work it owns before another process may take it over",
            self.process_id,
        )
        self._suspended = True
        for kind in list(self._kinds.values()):
            await kind._stop_all()

    async def claim(self, kind: str, keys: Sequence[str]) -> dict[str, int]:
        async with self._session_factory() as session:
            claimed = await self._store.claim(
                session,
                kind=kind,
                keys=keys,
                process_id=self.process_id,
                lease_ttl=LEASE_TTL,
            )
            await session.commit()
        if claimed:
            logger.info("Claimed %d %s(s) of %d wanted", len(claimed), kind, len(keys))
        return claimed

    async def release(self, kind: str, keys: Sequence[str]) -> None:
        async with self._session_factory() as session:
            await self._store.release(
                session, kind=kind, keys=keys, process_id=self.process_id
            )
            await session.commit()
        self._bus.publish(OWNERSHIP_CHANGED_SIGNAL)

    # ── Signals ──────────────────────────────────────────────────────────────

    def _on_changed(self, signal: dict[str, Any]) -> None:
        self.nudge()

    async def _resync(self) -> None:
        """Signals sent while this process was not listening are gone; the
        balance reads what they would have said."""
        self.nudge()
