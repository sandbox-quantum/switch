"""Building the management module and attaching it to the two apps.

`create_management` returns None when `AGENT_MANAGEMENT_ENABLED` is off, and
with None nothing is mounted and the bearer middleware has no controller
branch. When it is on, the authenticator goes to the middleware as the agent
bridge app is built, `install` adds the routes once both apps exist, and
`load_bindings` tells Core which controller runs each agent before the bridge
serves. `install` also hands Core the agent-facing side
(`ManagementAgentOperations`), which is what makes the agent operations on
machines and managed agents exist.

Each process also holds a lease (`process_lease.py`) and writes its
controllers' connection transitions (`connection_ledger.py`): `start` claims
the lease before the bridge serves, `run` renews it and writes transitions
until cancelled, and `stop` writes what is left and marks the lease stopped.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
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
from switch_core.config import SwitchConfig
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
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
from switch_core.management.process_lease import ProcessLease
from switch_core.management.service import ManagementService, ManagementSettings
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
        gateway_app.include_router(gateway_router, prefix=GATEWAY_PREFIX)
        protocol.set_agent_removal_listener(self.agent_removed)
        enable_agent_management(self.agent_operations)

    async def agent_removed(self, tenant_id: str, agent_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await self.service.forget_deleted_agent(session, tenant_id, agent_id)

    async def start(self) -> None:
        """Claim this process's lease, so the connections it records read as
        held. Raises when the database refuses: a process that cannot hold a
        lease would show every machine it connects as offline."""
        await self.lease.renew()
        logger.info("Claimed switch-core process lease %s", self.lease.process_id)

    async def run(self) -> None:
        """Renew the lease and write connection transitions, until cancelled."""
        await asyncio.gather(self.lease.run(), self.ledger.run())

    async def stop(self) -> None:
        """Write the transitions still queued, then mark the lease stopped.
        The lease is marked stopped even when the writes fail, so the
        machines this process held read offline either way."""
        try:
            await self.ledger.flush_all()
        finally:
            await self.lease.stop()

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
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    auth_cache: ControllerAuthCache,
    clock: Callable[[], datetime],
    process_id: str,
    user_changes: UserChangePublisher,
) -> Management:
    controllers = AgentControllerStore()
    processes = SwitchCoreProcessStore()
    presence.use_auth_cache(auth_cache)
    ledger = ControllerConnectionLedger(
        process_id=process_id,
        session_factory=session_factory,
        controllers=controllers,
        clock=clock,
        user_changes=user_changes,
    )
    presence.use_ledger(ledger)
    service = ManagementService(
        settings=ManagementSettings(
            token_secret=token_secret,
            status_interval_seconds=status_interval_seconds,
            server_url=server_url,
        ),
        notifier=ControllerNotifier(),
        user_changes=user_changes,
        controllers=controllers,
        definitions=AgentDefinitionStore(),
        operations=AgentControllerOperationStore(),
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
        lease=ProcessLease(
            process_id=process_id,
            session_factory=session_factory,
            processes=processes,
        ),
        ledger=ledger,
    )


def create_management(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    presence: ControllerPresence,
    user_changes: UserChangePublisher,
) -> Management | None:
    if not config.agent_management_enabled:
        return None
    if config.controller_token_secret is None:
        raise RuntimeError(
            "AGENT_MANAGEMENT_ENABLED is set without CONTROLLER_TOKEN_SECRET; the "
            "config validator should have refused this"
        )
    return build_management(
        token_secret=config.controller_token_secret,
        status_interval_seconds=config.controller_status_interval_seconds,
        server_url=config.gateway_public_url,
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
        process_id=str(uuid.uuid4()),
        user_changes=user_changes,
    )
