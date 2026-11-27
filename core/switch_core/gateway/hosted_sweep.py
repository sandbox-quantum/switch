"""Core's own run of the hosted sweep, with hosted agents v2 on.

The sweep (`hosted_controller.sweep_hosted_machines`) also runs on every poll
of `GET /hosted-controller/machines`, but nothing guarantees a poll: with no
box provisioner or controller service deployed, a claimed box would wait for
its box for ever. So Core runs it itself, about once a minute, as owned work:
one process holds it at a time, as with the other sweeps. It's registered only
with v2 on, so a v1 server starts no loop and takes no lease for it. Each pass
is independent: one that fails logs a fixed line and the next runs as usual.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

HOSTED_SWEEP_KIND = "hosted_sweep"
HOSTED_SWEEP_KEY = "all"
HOSTED_SWEEP_EVERY_SECONDS = 60.0


async def sweep_once(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: Callable[[], HostedControllerSettings | None],
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> bool:
    """One pass, on a session with no tenant bound, as the controller's poll
    runs it. Nothing without v2 on or without the hosted controller config
    (then no box can be claimed). True when it ran."""
    from switch_core.gateway.hosted_controller import sweep_hosted_machines

    current = settings()
    if not process_hosted_v2() or current is None:
        return False
    with no_tenant():
        async with session_factory() as session:
            await sweep_hosted_machines(
                session, session_factory, config, current, now()
            )
            await session.commit()
    return True


async def hosted_sweep_loop(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: Callable[[], HostedControllerSettings | None],
    every_seconds: float = HOSTED_SWEEP_EVERY_SECONDS,
) -> None:
    """The sweep about once a minute, for as long as this process holds it."""
    while True:
        await asyncio.sleep(every_seconds)
        try:
            await sweep_once(session_factory, config, settings)
        except Exception as exc:
            # A fixed line: no request, machine or error text.
            logger.error("Hosted sweep pass failed (%s)", type(exc).__name__)


def own_hosted_sweep(
    ownership: Ownership,
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: Callable[[], HostedControllerSettings | None],
) -> OwnedKind:
    """Register the sweep as owned work, wanted by this process; it runs here
    only while it holds it. Call only with hosted agents v2 on."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(
            hosted_sweep_loop(session_factory, config, settings),
            name="hosted-sweep",
        )
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error("Hosted sweep stopped unexpectedly; restarting")
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(HOSTED_SWEEP_KIND, start=start, stop=stop)
    kind.want(HOSTED_SWEEP_KEY)
    return kind


def start_hosted_sweep(
    v2: bool,
    ownership: Ownership,
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: Callable[[], HostedControllerSettings | None],
) -> OwnedKind | None:
    """What boot calls: the sweep registered with v2 on, and nothing at all
    (no loop, no kind, no lease) with it off."""
    if not v2:
        return None
    return own_hosted_sweep(ownership, session_factory, config, settings)
