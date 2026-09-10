from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.client_factory import ClientFactory
from switch_core.config import SwitchConfig
from switch_core.db.models import Client
from switch_core.db.session_scope import unscoped_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.provisioning import Provisioning
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)


class ClientLifecycleService:
    def __init__(
        self,
        *,
        matrix_admin: Provisioning,
        client_store: ClientStore,
        client_factory: ClientFactory,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
    ) -> None:
        self._matrix_admin = matrix_admin
        self._client_store = client_store
        self._client_factory = client_factory
        self._session_factory = session_factory
        self._config = config
        self._clients: dict[str, ClientBase[ClientConfig]] = {}
        self._client_types: dict[str, str] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def _make_user_id(self, localpart: str) -> str:
        return f"@{localpart}:{self._config.matrix_server_name}"

    COLLAB_CLIENT_TYPES = ("bridge", "user")

    async def ensure_system_client(self, client_type: str) -> None:
        async with self._session_factory() as session:
            existing = await self._client_store.get_by_type(session, client_type)
        if existing:
            return
        localpart = f"switch-{client_type.replace('_', '-')}"
        await self.create_client(
            client_type=client_type,
            display_name=client_type.replace("_", "-"),
            localpart=localpart,
        )

    async def start_all(self) -> None:
        # Every tenant's clients in one pass at boot, so this read is
        # unscoped by nature. Nothing is bound around `_start_task`: a client
        # is not a single-tenant actor for the purposes of its own task. It
        # reads which rooms it is in — a lookup keyed by a globally unique
        # client id — and then works one room at a time, binding that room's
        # tenant per delivery. A boot-time binding would only decide what the
        # task snapshots, and the whole point is that nothing downstream may
        # depend on that.
        async with unscoped_session(self._session_factory) as session:
            records = await self._client_store.get_all(session)

        records = [r for r in records if r.type not in self.COLLAB_CLIENT_TYPES]

        logger.info("Starting %d clients", len(records))
        for record in records:
            client = self._client_factory.create(record)
            self._clients[record.id] = client
            self._client_types[record.id] = record.type
            self._start_task(record.id, client)

    async def create_client(
        self,
        *,
        client_type: str,
        display_name: str,
        localpart: str | None = None,
        config: dict[str, object] | None = None,
    ) -> Client:
        client_id = str(uuid.uuid4())
        if localpart is None:
            localpart = f"switch-{client_type}-{client_id[:8]}"
        matrix_user_id = self._make_user_id(localpart)

        record = Client(
            id=client_id,
            matrix_user_id=matrix_user_id,
            display_name=display_name,
            type=client_type,
            config=config,
        )
        async with self._session_factory() as session:
            await self._client_store.create(session, record)
            await session.commit()

        logger.info("Created client %s (%s)", display_name, matrix_user_id)
        return record

    def start_client(self, record: Client) -> ClientBase[ClientConfig]:
        client = self._client_factory.create(record)
        self._clients[record.id] = client
        self._client_types[record.id] = record.type
        self._start_task(record.id, client)
        logger.info(
            "Started client %s (%s)", record.display_name, record.matrix_user_id
        )
        return client

    async def create_and_start(
        self,
        *,
        client_type: str,
        display_name: str,
        localpart: str | None = None,
        config: dict[str, object] | None = None,
    ) -> ClientBase[ClientConfig]:
        record = await self.create_client(
            client_type=client_type,
            display_name=display_name,
            localpart=localpart,
            config=config,
        )
        return self.start_client(record)

    async def stop(self, client_id: str) -> None:
        client = self._clients.get(client_id)
        if client is None:
            logger.warning("Cannot stop unknown client %s", client_id)
            return
        await client.stop()
        self._cancel_task(client_id)
        del self._clients[client_id]
        self._client_types.pop(client_id, None)
        logger.info("Stopped client %s", client_id)

    async def stop_all(self) -> None:
        logger.info("Stopping all %d clients", len(self._clients))
        for client in self._clients.values():
            await client.stop()
        for task in self._tasks.values():
            task.cancel()
        self._clients.clear()
        self._client_types.clear()
        self._tasks.clear()

    async def remove(self, client_id: str) -> None:
        await self.stop(client_id)
        async with self._session_factory() as session:
            await self._client_store.delete(session, client_id)
            await session.commit()
        logger.info("Removed client %s", client_id)

    def get(self, client_id: str) -> ClientBase[ClientConfig] | None:
        return self._clients.get(client_id)

    def get_by_agent_id(self, agent_id: str) -> ClientBase[ClientConfig] | None:
        for client in self._clients.values():
            if isinstance(client, AgentClient) and client._agent is not None:
                if client._agent.id == agent_id:
                    return client  # type: ignore[return-value]
        return None

    def get_by_type(self, client_type: str) -> list[ClientBase[ClientConfig]]:
        return [
            client
            for client_id, client in self._clients.items()
            if self._client_types.get(client_id) == client_type
        ]

    def _start_task(self, client_id: str, client: ClientBase[ClientConfig]) -> None:
        task = asyncio.create_task(self._run_client(client_id, client))
        self._tasks[client_id] = task

    def _cancel_task(self, client_id: str) -> None:
        task = self._tasks.pop(client_id, None)
        if task and not task.done():
            task.cancel()

    async def _run_client(
        self, client_id: str, client: ClientBase[ClientConfig]
    ) -> None:
        """A client's long-lived task, deliberately ambient-free.

        `no_tenant` because a task keeps the context of whoever created it,
        and the creators differ: boot, a gateway request that added an agent,
        or an inbound bridge message that minted a puppet mid-conversation.
        A puppet in particular is reused for every room the person it stands
        for speaks in, so the first room's tenant is exactly the value that
        must not survive into the second. Everything the client does binds
        the tenant of the room it is acting on, or — for the two lookups that
        answer *which* tenant, its own row and its room list — is unscoped on
        purpose.
        """
        with no_tenant():
            try:
                await client.start()
            except Exception:
                logger.exception(
                    "Client %s (%s) crashed", client.display_name, client.matrix_user_id
                )
                self._clients.pop(client_id, None)
                self._tasks.pop(client_id, None)
