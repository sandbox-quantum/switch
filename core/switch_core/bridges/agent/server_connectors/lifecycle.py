from __future__ import annotations

import hashlib
import logging
import secrets

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.server_connectors.base import (
    ServerSideConnector,
    ServerSideConnectorConfig,
)
from switch_core.bridges.agent.server_connectors.core import ConnectorCore
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import ApiKey, ServerConnector
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.tenant_lookup import all_tenant_ids, tenant_of_server_connector

logger = logging.getLogger(__name__)


class ServerSideConnectorLifecycleService:
    def __init__(
        self,
        *,
        connector_store: ServerConnectorStore,
        api_key_store: ApiKeyStore,
        protocol: ProtocolService,
        session_factory: async_sessionmaker[AsyncSession],
        encryption_secret: str,
    ) -> None:
        self._connector_store = connector_store
        self._api_key_store = api_key_store
        self._protocol = protocol
        self._session_factory = session_factory
        self._encryption_secret = encryption_secret

        self._connector_registry: dict[str, type[ServerSideConnector]] = {}
        self._config_registry: dict[str, type[ServerSideConnectorConfig]] = {}
        self._cores: dict[str, ConnectorCore] = {}

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

        logger.info("Starting %d server-side connectors", len(connectors))
        for record in connectors:
            try:
                await self.start(record.id)
            except Exception:
                logger.exception("Failed to start connector %s", record.id)

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

        plaintext = secrets.token_urlsafe(32)
        key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
        reg_key = ApiKey(
            user_id=user_id,
            key_hash=key_hash,
            encrypted_key=encrypt_token(plaintext, self._encryption_secret),
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

        await self.start(record.id)

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

        registration_token = decrypt_token(
            reg_key.encrypted_key, self._encryption_secret
        )

        typed_config = config_cls.model_validate(record.connection_config or {})
        connector = connector_cls(config=typed_config)  # type: ignore[call-arg]

        core = ConnectorCore(
            connector_id=connector_id,
            connector_tenant_id=record.tenant_id,
            connector_type=record.type,
            connector=connector,
            registration_token=registration_token,
            protocol=self._protocol,
        )
        await core.start()
        self._cores[connector_id] = core

    async def stop(self, connector_id: str) -> None:
        core = self._cores.pop(connector_id, None)
        if core is None:
            return
        await core.stop()

    async def stop_all(self) -> None:
        logger.info("Stopping all %d server-side connectors", len(self._cores))
        for connector_id in list(self._cores):
            await self.stop(connector_id)

    async def remove(self, connector_id: str) -> None:
        """Delete a connector: its agents, its running core, and its row.

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
            if await self._connector_store.get(session, connector_id) is None:
                raise ValueError(f"Connector not found: {connector_id}")

        core = self._cores.get(connector_id)
        if core is not None:
            await core.delete_agents()

        await self.stop(connector_id)

        async with self._session_factory() as session:
            await self._connector_store.delete(session, connector_id)
            await session.commit()

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

    def get_agent_names(self, connector_id: str) -> list[str]:
        core = self._cores.get(connector_id)
        if core is None:
            return []
        return core.get_agent_names()
