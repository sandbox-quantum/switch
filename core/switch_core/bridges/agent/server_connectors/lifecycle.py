"""Every server-side connector, run by the one switch-core process that holds it.

A server-side connector (OpenCode) discovers the agents on its server,
registers them, and long-polls each one's events, answering through the
platform. Run in two processes, every agent is polled twice and every turn
answered twice. So a connector runs in the one process that holds it
(`ownership.py`, kind `SERVER_CONNECTORS`), and is handed over when that
process stops or another should hold it. A connector registered or removed
through one process reaches the others as a `connector.changed` signal
(`signals.py`): the holder of a removed connector stops it, and a new one is
claimed by whichever process should hold it.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.server_connectors.base import (
    ServerSideConnector,
    ServerSideConnectorConfig,
)
from switch_core.bridges.agent.server_connectors.core import ConnectorCore
from switch_core.db.models import ApiKey, ServerConnector
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.tenant_lookup import all_tenant_ids, tenant_of_server_connector
from switch_core.keys import Keyring
from switch_core.outbound import OutboundPolicy
from switch_core.telemetry import TelemetryService, emit_safely
from switch_core.tenant_context import no_tenant, tenant_scope

if TYPE_CHECKING:
    from switch_core.bridges.agent.server_connectors.signals import ConnectorSignals
    from switch_core.ownership import Fence, Ownership

logger = logging.getLogger(__name__)

# The kind of owned work a server-side connector is (`ownership.py`), keyed by
# connector id.
SERVER_CONNECTORS = "connector"


def _connector_kind(connector_type: str) -> str:
    """A connector type as the catalogue spells it.

    Registered types are a runtime registry rather than a fixed list, so only
    the one Switch ships is named and anything else reports `other`.
    """
    return connector_type if connector_type == "opencode" else "other"


class ServerSideConnectorLifecycleService:
    # Class-level default, as elsewhere: a test may build this without
    # `__init__`, and `emit_safely` treats None as "report nothing".
    _telemetry: TelemetryService | None = None

    def __init__(
        self,
        *,
        connector_store: ServerConnectorStore,
        api_key_store: ApiKeyStore,
        protocol: AgentCore,
        session_factory: async_sessionmaker[AsyncSession],
        telemetry: TelemetryService | None = None,
        keyring: Keyring,
        outbound_policy: OutboundPolicy,
        ownership: Ownership,
    ) -> None:
        self._connector_store = connector_store
        self._agent_store = AgentStore()
        self._owned = ownership.kind(
            SERVER_CONNECTORS, start=self._take_over, stop=self._hand_over
        )
        self._signals: ConnectorSignals | None = None
        # Why the last take-over of each connector failed to start it, for
        # `register` to raise.
        self._failed_take_overs: dict[str, Exception] = {}
        # Connectors this process has taken over and is still starting. A
        # start dials the connector's server and registers each agent it
        # finds, so it runs in a task of its own: the ownership takes work
        # over one key at a time, and a server slow to answer would hold up
        # every other hand-over in this process meanwhile.
        self._starting: dict[str, asyncio.Task[None]] = {}
        self._api_key_store = api_key_store
        self._protocol = protocol
        self._session_factory = session_factory
        self._telemetry = telemetry
        self._keyring = keyring
        self._outbound_policy = outbound_policy

        self._connector_registry: dict[str, type[ServerSideConnector]] = {}
        self._config_registry: dict[str, type[ServerSideConnectorConfig]] = {}
        self._cores: dict[str, ConnectorCore] = {}
        # What this process means to be running: the connectors it holds.
        # `_cores` alone cannot answer "is anything missing": a connector that
        # failed to start never entered it, and the ownership logs each
        # failure and steps over it.
        self._expected: set[str] = set()

    def use_signals(self, signals: ConnectorSignals) -> None:
        """Where a connector registered or removed here is announced, so every
        other process applies it (`signals.py`)."""
        self._signals = signals

    def _announce(self, connector_id: str) -> None:
        if self._signals is not None:
            self._signals.changed(connector_id)

    def register_connector_type(
        self,
        type_name: str,
        connector_cls: type[ServerSideConnector],
        config_cls: type[ServerSideConnectorConfig],
    ) -> None:
        self._connector_registry[type_name] = connector_cls
        self._config_registry[type_name] = config_cls

    async def start_all(self) -> None:
        # Every tenant's active connectors, one tenant at a time — same
        # reasoning and same history as
        # CollaborationBridgeLifecycleService.start_all, and worse here: this
        # one is launched by a bare `create_task` in the lifespan, so when the
        # unscoped read it replaces began returning nothing under the runtime
        # role, no connector started and nothing said so at any log level.
        #
        # Nothing is bound around `start`: it reads the connector's own row
        # and hands that row's tenant to the core, which binds it per unit of
        # work rather than once for the poll loop's life.
        connectors: list[ServerConnector] = []
        for tenant_id in await all_tenant_ids(self._session_factory):
            async with tenant_session(self._session_factory, tenant_id) as session:
                # Filtered on the row's own tenant, not left to the policy: on an
                # owner connection no policy narrows this read, and the fan-out
                # would act on every tenant's rows once per tenant. See
                # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
                connectors.extend(
                    record
                    for record in await self._connector_store.get_active(session)
                    if record.tenant_id == tenant_id
                )

        logger.info("Wanting %d server-side connectors", len(connectors))
        for record in connectors:
            self._owned.want(record.id)
        # The ones this process holds start now, each failure logged and
        # stepped over; the rest run in the processes that hold them.
        await self._owned.settle()

    async def register(
        self,
        *,
        connector_type: str,
        display_name: str,
        connection_config: dict[str, object],
        user_id: str,
    ) -> ServerConnector:
        connector_cls = self._connector_registry.get(connector_type)
        config_cls = self._config_registry.get(connector_type)
        if connector_cls is None or config_cls is None:
            raise ValueError(f"Unknown connector type: {connector_type}")

        config_cls.model_validate(connection_config)
        for url in connector_cls.outbound_urls(connection_config):
            await self._outbound_policy.check_url(url)

        plaintext = secrets.token_urlsafe(32)
        key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
        reg_key = ApiKey(
            user_id=user_id,
            key_hash=key_hash,
            encrypted_key=self._keyring.encrypt(plaintext),
            label=f"server-connector:{display_name}",
            type="registration",
        )

        # Reached only from `POST /connectors`, so the session inherits the
        # tenant the auth dependency bound and both rows below land in the
        # operator's own — which is the answer, since it is their connector.
        # `start` then re-reads the row unscoped to learn that tenant back,
        # rather than assuming this one is still bound by then.
        async with self._session_factory() as session:
            await self._api_key_store.create(session, reg_key)

            record = ServerConnector(
                type=connector_type,
                display_name=display_name,
                connection_config=connection_config,  # type: ignore[arg-type]
                api_key_id=reg_key.id,
                status="active",
            )
            await self._connector_store.create(session, record)
            await session.commit()

        # Before `start`, not after: the rows above are durably committed and
        # are the fact this event describes, while `start` is a post-commit
        # side effect (decrypting the token, validating the connector's config,
        # dialling out) that can raise without undoing the registration. A
        # failure there still propagates to the caller unchanged.
        emit_safely(
            self._telemetry,
            "server_connector_registered",
            {"connector_kind": _connector_kind(connector_type)},
        )

        # Started where it is held: here, or in the process that claims it
        # once it hears of it. A start here is waited for, so its failure
        # reaches the caller as it did when registering started it directly.
        self._owned.want(record.id)
        await self._owned.settle()
        self._announce(record.id)
        starting = self._starting.get(record.id)
        if starting is not None:
            await asyncio.shield(starting)
        failed = self._failed_take_overs.pop(record.id, None)
        if failed is not None:
            raise failed

        logger.info(
            "Registered server-side connector %s (%s): %s (owner: %s)",
            record.id,
            connector_type,
            display_name,
            user_id,
        )
        return record

    async def start(self, connector_id: str) -> None:
        # The exemption answers which tenant this connector is in
        # (`db/tenant_lookup.py`); the two rows are then read scoped to it.
        # Reached both from boot with nothing bound and from an HTTP request
        # whose tenant is the caller's, not necessarily the connector's, so
        # the tenant is derived here rather than inherited either way. The
        # registration key is read in the same scoped session because
        # `server_connectors` carries a composite foreign key on
        # `(tenant_id, api_key_id)` — it cannot be another tenant's row.
        tenant_id = await tenant_of_server_connector(
            self._session_factory, connector_id
        )
        if tenant_id is None:
            raise ValueError(f"Connector not found: {connector_id}")
        async with tenant_session(self._session_factory, tenant_id) as session:
            record = await self._connector_store.get(session, connector_id)
            if record is None:
                raise ValueError(f"Connector not found: {connector_id}")
            reg_key = await self._api_key_store.get(session, record.api_key_id)
            if reg_key is None:
                raise ValueError(f"Registration key not found: {record.api_key_id}")

        connector_cls = self._connector_registry.get(record.type)
        config_cls = self._config_registry.get(record.type)
        if connector_cls is None or config_cls is None:
            raise ValueError(f"Unknown connector type: {record.type}")

        registration_token = self._keyring.decrypt(reg_key.encrypted_key)

        typed_config = config_cls.model_validate(record.connection_config or {})
        # Again at every start: what the host resolves to can have changed
        # since the connector was registered.
        for url in connector_cls.outbound_urls(record.connection_config or {}):
            await self._outbound_policy.check_url(url)
        connector = connector_cls(  # type: ignore[call-arg]
            config=typed_config, outbound_policy=self._outbound_policy
        )

        core = ConnectorCore(
            connector_id=connector_id,
            connector_tenant_id=record.tenant_id,
            connector_type=record.type,
            connector=connector,
            registration_token=registration_token,
            protocol=self._protocol,
        )
        try:
            await core.start()
        except BaseException:
            # Agents it registered before failing, or before being cancelled
            # by a hand-over, are already being polled.
            await core.stop()
            raise
        self._cores[connector_id] = core

    async def stop(self, connector_id: str) -> None:
        self._expected.discard(connector_id)
        core = self._cores.pop(connector_id, None)
        if core is None:
            return
        await core.stop()

    def expected_count(self) -> int:
        """Connectors this process means to be running."""
        return len(self._expected)

    def running_count(self) -> int:
        """Of those, how many actually are.

        Short of `expected_count` is an agent host that is not there, which is
        otherwise only a line in the boot log.
        """
        return sum(1 for connector_id in self._expected if connector_id in self._cores)

    async def stop_all(self) -> None:
        starting = list(self._starting.values())
        self._starting.clear()
        for task in starting:
            task.cancel()
        await asyncio.gather(*starting, return_exceptions=True)
        logger.info("Stopping all %d server-side connectors", len(self._cores))
        for connector_id in list(self._cores):
            await self.stop(connector_id)

    async def remove(self, connector_id: str) -> None:
        """Delete a connector: its agents, its running core, and its row, and
        tell the other processes, so the one holding it stops it.

        Scoped to the caller, and checked before anything is torn down. The
        session inherits the tenant the request bound (`gateway/auth.py`), so
        a connector belonging to another tenant is simply not there — but
        `_cores` is a process-wide registry with every tenant's connectors in
        it, so tearing down first and deleting second let a caller from the
        wrong tenant stop another tenant's connector and delete its agents,
        then match zero rows and report success. The read below is what makes
        the tenant check happen before the damage rather than after it.

        `ServerConnectorStore.delete` raises when it matches nothing, so the
        window between the two — the row deleted underneath us — surfaces as
        an error rather than as a second false success.
        """
        async with self._session_factory() as session:
            existing = await self._connector_store.get(session, connector_id)
            kind = existing.type if existing is not None else "other"
            if existing is None:
                raise ValueError(f"Connector not found: {connector_id}")

        core = self._cores.get(connector_id)
        if core is not None:
            await core.delete_agents()
        else:
            # Held by another process: its agents are found by their rows.
            await self._delete_agents(connector_id, existing.tenant_id)

        # Held here or not, let go of it: no process is to take it over.
        await self._owned.drop(connector_id)
        await self.stop(connector_id)

        async with self._session_factory() as session:
            await self._connector_store.delete(session, connector_id)
            await session.commit()
        self._announce(connector_id)

        emit_safely(
            self._telemetry,
            "server_connector_removed",
            {"connector_kind": _connector_kind(kind)},
        )
        logger.info("Removed server-side connector %s", connector_id)

    def get_registered_types(self) -> list[str]:
        return list(self._connector_registry.keys())

    def get_config_schema(self, type_name: str) -> dict[str, object]:
        config_cls = self._config_registry.get(type_name)
        if config_cls is None:
            raise ValueError(f"Unknown connector type: {type_name}")
        return config_cls.model_json_schema()

    def get_connector_ids(self) -> list[str]:
        return list(self._cores.keys())

    async def get_agent_names(self, connector_id: str) -> list[str]:
        """The names of the agents the connector registered, read from their
        rows in the bound tenant: the same answer from every process, whichever
        holds the connector."""
        async with self._session_factory() as session:
            agents = await self._agent_store.get_by_server_connector(
                session, connector_id
            )
        return [agent.name for agent in agents]

    async def _delete_agents(self, connector_id: str, tenant_id: str) -> None:
        with tenant_scope(tenant_id):
            async with self._session_factory() as session:
                agents = await self._agent_store.get_by_server_connector(
                    session, connector_id
                )
            for agent in agents:
                try:
                    await self._protocol.delete_agent(agent_id=agent.id)
                except Exception:
                    logger.exception(
                        "Failed to delete agent %s during connector removal",
                        agent.id,
                    )

    # ── Ownership ────────────────────────────────────────────────────────────

    async def _take_over(self, connector_id: str, fence: Fence) -> None:
        """This process now holds the connector: start it here, in the
        background (`_starting`)."""
        logger.info("Taking over server-side connector %s", connector_id)
        self._failed_take_overs.pop(connector_id, None)
        self._expected.add(connector_id)
        self._starting[connector_id] = asyncio.create_task(
            self._start_held(connector_id)
        )

    async def _start_held(self, connector_id: str) -> None:
        try:
            # Whoever's request led to the take-over, the connector acts as
            # its own row's tenant (`start`).
            with no_tenant():
                await self.start(connector_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._failed_take_overs[connector_id] = exc
            logger.exception("Failed to start connector %s", connector_id)
        finally:
            if self._starting.get(connector_id) is asyncio.current_task():
                del self._starting[connector_id]

    async def _hand_over(self, connector_id: str) -> None:
        """This process no longer holds the connector: stop it here, starting
        or started."""
        logger.info("Handing server-side connector %s over", connector_id)
        starting = self._starting.pop(connector_id, None)
        if starting is not None and not starting.done():
            starting.cancel()
            await asyncio.gather(starting, return_exceptions=True)
        await self.stop(connector_id)

    def holds(self, connector_id: str) -> bool:
        """Whether this process holds the connector and runs it."""
        return self._owned.fence(connector_id) is not None

    # ── Changes made in other processes ──────────────────────────────────────

    async def reconcile_connector(self, connector_id: str) -> None:
        """Bring this process in line with one connector's row, after another
        process registered or removed it."""
        tenant_id = await tenant_of_server_connector(
            self._session_factory, connector_id
        )
        record: ServerConnector | None = None
        if tenant_id is not None:
            async with tenant_session(self._session_factory, tenant_id) as session:
                record = await self._connector_store.get(session, connector_id)
        await self._reconcile_row(connector_id, record)

    async def reconcile_all(self) -> None:
        """`reconcile_connector` for every connector stored or wanted here,
        reading the rows one tenant at a time."""
        rows: dict[str, ServerConnector] = {}
        for tenant_id in await all_tenant_ids(self._session_factory):
            async with tenant_session(self._session_factory, tenant_id) as session:
                rows.update(
                    (record.id, record)
                    for record in await self._connector_store.get_active(session)
                    if record.tenant_id == tenant_id
                )
        for connector_id in sorted(set(rows) | self._owned.wanted() | set(self._cores)):
            try:
                await self._reconcile_row(connector_id, rows.get(connector_id))
            except Exception:
                logger.warning(
                    "Could not bring server-side connector %s in line with its "
                    "row; retrying at the next re-check",
                    connector_id,
                    exc_info=True,
                )

    async def _reconcile_row(
        self, connector_id: str, record: ServerConnector | None
    ) -> None:
        """Wanted where it is new here, so the process that should hold it
        claims it; stopped and let go of where it is gone or no longer
        active."""
        if self._owned.stopping:
            return
        if record is None or record.status != "active":
            if self._owned.wants(connector_id) or connector_id in self._cores:
                logger.info(
                    "Server-side connector %s was removed elsewhere; stopping it",
                    connector_id,
                )
                await self._owned.drop(connector_id)
                await self.stop(connector_id)
            return
        if not self._owned.wants(connector_id):
            logger.info(
                "Server-side connector %s was added elsewhere; wanting it",
                connector_id,
            )
            self._owned.want(connector_id)
            await self._owned.settle()
