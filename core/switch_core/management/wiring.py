"""Building the management module and attaching it to the two apps.

`create_management` returns None when the `agent_management` feature flag is off, and
with None nothing is mounted and the bearer middleware has no controller
branch. When it is on, the authenticator goes to the middleware as the agent
bridge app is built, `install` adds the routes once both apps exist, and
`load_bindings` tells Core which controller runs each agent before the bridge
serves. `install` also hands Core the agent-facing side
(`ManagementAgentOperations`), which is what makes the agent operations on
machines and managed agents exist.

Each process writes its controllers' connection transitions
(`connection_ledger.py`), read against the lease the server holds for the
process whether or not management is on (`switch_core/process_lease.py`): `run` writes
transitions until cancelled, and `flush` writes what is left as the process
drains, before the server marks its lease stopped. `load_connections` reads
which controllers the other processes hold, before the bridge serves.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.operations.agent_management import (
    enable_agent_management,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.config import ControllerRelease, SwitchConfig
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.management.agent_operations import ManagementAgentOperations
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.bindings import load_bindings
from switch_core.management.connection_ledger import ControllerConnectionLedger
from switch_core.management.controller_routes import router as controller_router
from switch_core.management.dependencies import init_management_dependencies
from switch_core.management.gateway_routes import router as gateway_router
from switch_core.management.notifier import ControllerNotifier
from switch_core.management.service import ManagementService, ManagementSettings
from switch_core.management.signals import ControllerSignals
from switch_core.process_lease import ProcessLease
from switch_core.signals import SignalBus
from switch_core.user_changes import UserChangePublisher

logger = logging.getLogger(__name__)

GATEWAY_PREFIX = "/management"


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Management:
    service: ManagementService
    authenticator: ManagementAuthenticator
    agent_operations: ManagementAgentOperations
    session_factory: async_sessionmaker[AsyncSession]
    lease: ProcessLease
    ledger: ControllerConnectionLedger

    def install(
        self,
        *,
        agent_bridge_app: FastAPI,
        gateway_app: FastAPI,
        protocol: AgentCore,
    ) -> None:
        init_management_dependencies(
            service=self.service,
            authenticator=self.authenticator,
            session_factory=self.session_factory,
        )
        agent_bridge_app.include_router(controller_router)
        mount_gateway_routes(gateway_app)
        protocol.set_agent_removal_listener(self.agent_removed)
        protocol.set_agent_rename_listener(self.agent_renamed)
        enable_agent_management(self.agent_operations)

    async def agent_removed(self, tenant_id: str, agent_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await self.service.forget_deleted_agent(session, tenant_id, agent_id)

    async def agent_renamed(self, tenant_id: str, agent_id: str, old_name: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await self.service.agent_renamed(session, tenant_id, agent_id, old_name)

    async def run(self) -> None:
        """Write connection transitions as they happen, until cancelled. The
        process lease they are read against is the server's to renew."""
        await self.ledger.run()

    async def flush(self) -> None:
        """Write the transitions still queued. Called as the process drains,
        before its lease is marked stopped, so the machines it held read as
        closed by the server rather than lost with it."""
        await self.ledger.flush_all()

    async def load_connections(self) -> None:
        """Read which controllers' sockets the other processes hold, before
        the bridge serves: until then every agent they run reads offline
        here. The signal bus keeps it current from then on."""
        await self.service.signals.read_connections()

    async def load_bindings(self) -> int:
        return await load_bindings(
            session_factory=self.session_factory,
            definitions=self.service.definitions,
            controllers=self.service.controllers,
            presence=self.service.presence,
        )


def build_management(
    *,
    token_secret: str,
    status_interval_seconds: int,
    server_url: str | None,
    third_party_avatars: bool,
    controller_release: ControllerRelease | None,
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    auth_cache: ControllerAuthCache,
    clock: Callable[[], datetime],
    signal_bus: SignalBus,
    lease: ProcessLease,
    user_changes: UserChangePublisher,
) -> Management:
    process_id = lease.process_id
    if signal_bus.process_id != process_id:
        raise ValueError(
            f"The signal bus speaks for process {signal_bus.process_id!r} and "
            f"the lease for {process_id!r}; one process has one name."
        )
    controllers = AgentControllerStore()
    definitions = AgentDefinitionStore()
    operations = AgentControllerOperationStore()
    processes = SwitchCoreProcessStore()
    presence.use_auth_cache(auth_cache)
    signals = ControllerSignals(
        notifier=ControllerNotifier(),
        presence=presence,
        bus=signal_bus,
        session_factory=session_factory,
        controllers=controllers,
        operations=operations,
        definitions=definitions,
        rooms=RoomStore(),
        processes=processes,
        clock=clock,
        user_changes=user_changes,
    )
    ledger = ControllerConnectionLedger(
        process_id=process_id,
        session_factory=session_factory,
        controllers=controllers,
        clock=clock,
        announce=signals.connection_changed,
    )
    presence.use_ledger(ledger)
    service = ManagementService(
        settings=ManagementSettings(
            token_secret=token_secret,
            status_interval_seconds=status_interval_seconds,
            server_url=server_url,
            third_party_avatars=third_party_avatars,
            controller_release=controller_release,
        ),
        signals=signals,
        user_changes=user_changes,
        controllers=controllers,
        definitions=definitions,
        operations=operations,
        api_keys=ApiKeyStore(),
        agents=AgentStore(),
        processes=processes,
        presence=presence,
        clock=clock,
    )
    # Switch cloud machines that run the controller enroll with codes it mints.
    set_cloud_enrollment(service)
    authenticator = ManagementAuthenticator(
        session_factory=session_factory,
        controllers=controllers,
        token_secret=token_secret,
        presence=presence,
        auth_cache=auth_cache,
    )
    return Management(
        service=service,
        authenticator=authenticator,
        agent_operations=ManagementAgentOperations(
            service=service, session_factory=session_factory
        ),
        session_factory=session_factory,
        lease=lease,
        ledger=ledger,
    )


def mount_gateway_routes(gateway_app: FastAPI) -> None:
    """Every route agent management adds to the gateway.

    The one place they are mounted: `Management.install` calls it, and so does
    the end-to-end surface snapshot (`scripts/e2e_surface.py`), which is how a
    route added here reaches the coverage gate.
    """
    gateway_app.include_router(gateway_router, prefix=GATEWAY_PREFIX)


def create_management(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    signal_bus: SignalBus,
    lease: ProcessLease,
    user_changes: UserChangePublisher,
) -> Management | None:
    if not config.agent_management_enabled:
        return None
    if config.controller_token_secret is None:
        raise RuntimeError(
            "The agent_management feature flag is on without CONTROLLER_TOKEN_SECRET; the "
            "config validator should have refused this"
        )
    return build_management(
        token_secret=config.controller_token_secret,
        status_interval_seconds=config.controller_status_interval_seconds,
        server_url=config.gateway_public_url,
        third_party_avatars=config.third_party_avatars_enabled,
        controller_release=config.controller_release,
        session_factory=session_factory,
        presence=presence,
        # The agent API-key cache's bound: the longest a controller revoked
        # by any path that does not go through `ControllerPresence` could go
        # on authenticating.
        auth_cache=ControllerAuthCache(
            ttl_seconds=config.agent_auth_cache_ttl_seconds,
            max_entries=config.agent_auth_cache_max_entries,
        ),
        clock=utc_now,
        signal_bus=signal_bus,
        lease=lease,
        user_changes=user_changes,
    )
