from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.client_factory import ClientFactory
from switch_core.config import SwitchConfig
from switch_core.db.models import Client, Tenant
from switch_core.db.session_scope import unscoped_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.provisioning import Provisioning
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)


class ClientLifecycleService:
    def __init__(
        self,
        *,
        matrix_admin: Provisioning,
        client_store: ClientStore,
        tenant_store: TenantStore,
        client_factory: ClientFactory,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
    ) -> None:
        self._matrix_admin = matrix_admin
        self._client_store = client_store
        self._tenant_store = tenant_store
        self._client_factory = client_factory
        self._session_factory = session_factory
        self._config = config
        self._clients: dict[str, ClientBase[ClientConfig]] = {}
        self._client_types: dict[str, str] = {}
        # Which tenant each running client's row belongs to. A `ClientBase`
        # does not carry it — a client's own work resolves the tenant from the
        # room it is acting on — but this registry holds every tenant's
        # clients at once, so anything picking clients *out* of it has to be
        # able to say which tenant it wants. See `get_by_type`.
        self._client_tenants: dict[str, str] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def _make_user_id(self, localpart: str) -> str:
        return f"@{localpart}:{self._config.matrix_server_name}"

    COLLAB_CLIENT_TYPES = ("bridge", "user")

    async def ensure_system_client(self, client_type: str) -> None:
        """One system client of `client_type` per tenant, created where missing.

        `clients` is a scoped table, so the admin client is one row per tenant
        rather than one per deployment — that is the whole reason
        `clients.matrix_user_id` became unique per tenant rather than globally
        (`docs/old/multi-tenancy-phase1-db.md`, "Which tables are scoped"). A
        tenant with no admin client has no client in its rooms to provision
        them or relay system messages, so "does one exist anywhere" is the
        wrong question to ask: it answers yes for a tenant that has none.

        The enumeration is unscoped by nature — which tenants exist is exactly
        what a bound session cannot see — and each row is then created with
        that tenant bound, so the `Client` picks it up from the same default
        every other scoped write uses instead of being handed a constant.
        """
        async with unscoped_session(self._session_factory) as session:
            tenant_ids = await self._tenant_store.get_all_ids(session)
            already_served = {
                client.tenant_id
                for client in await self._client_store.get_by_type(session, client_type)
            }

        localpart = f"switch-{client_type.replace('_', '-')}"
        for tenant_id in tenant_ids:
            if tenant_id in already_served:
                continue
            with tenant_scope(tenant_id):
                await self.create_client(
                    client_type=client_type,
                    display_name=client_type.replace("_", "-"),
                    localpart=localpart,
                )

    async def create_tenant(self, name: str, slug: str) -> Tenant:
        """Create a tenant with everything it needs to function, in one call.

        Nothing in the running application ever created a `tenants` row
        before this: only the migration that seeds tenant zero does, so a
        second tenant onboarded so far meant inserting the row directly and
        restarting — the only thing that ever ran `ensure_system_client`'s
        enumeration. Between that insert and the restart the tenant existed
        with no admin client, so its rooms had no admin participant, with
        nothing to repair that short of the next boot.

        This is now the one seam a tenant comes into existence through, so
        that whatever eventually offers tenant creation (there is no such
        endpoint yet — Phase 2's scope) has a single place to call rather
        than a row to insert and a checklist to remember. It reuses
        `ensure_system_client` rather than duplicating its per-type,
        per-tenant provisioning logic: the new tenant is simply the one gap
        that enumeration has not filled yet.
        """
        tenant = Tenant(name=name, slug=slug)
        async with unscoped_session(self._session_factory) as session:
            await self._tenant_store.create(session, tenant)
            await session.commit()
        await self.ensure_system_client("admin")
        return tenant

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
            self._client_tenants[record.id] = record.tenant_id
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
        self._client_tenants[record.id] = record.tenant_id
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
        task = self._cancel_task(client_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        del self._clients[client_id]
        self._client_types.pop(client_id, None)
        self._client_tenants.pop(client_id, None)
        logger.info("Stopped client %s", client_id)

    async def stop_all(self) -> None:
        logger.info("Stopping all %d clients", len(self._clients))
        for client in self._clients.values():
            await client.stop()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        # Awaited, not merely cancelled. A cancelled task unwinds when the
        # loop next runs it, or never — and a receive loop that is never run
        # again is collected instead, which runs its `finally` under the
        # garbage collector, in a context that is not the task's.
        await asyncio.gather(*tasks, return_exceptions=True)
        self._clients.clear()
        self._client_types.clear()
        self._client_tenants.clear()
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

    def get_by_type(
        self, client_type: str, tenant_id: str
    ) -> list[ClientBase[ClientConfig]]:
        """This tenant's running clients of `client_type`.

        The tenant is required rather than optional, and that is the fix for a
        real crash. `clients` is scoped, so `ensure_system_client` creates one
        admin client *per tenant* and this registry holds all of them at once.
        A caller that asked by type alone got every tenant's, and putting one
        of those into another tenant's room is not a bookkeeping slip:
        `client_rooms` carries a composite foreign key on
        `(tenant_id, client_id)`, so the insert raises
        `ForeignKeyViolationError`. In `reconcile_room_clients` that runs at
        startup and outside any per-room try/except, so the second tenant to
        own a room takes the whole process down with it.
        """
        return [
            client
            for client_id, client in self._clients.items()
            if self._client_types.get(client_id) == client_type
            and self._client_tenants.get(client_id) == tenant_id
        ]

    def _start_task(self, client_id: str, client: ClientBase[ClientConfig]) -> None:
        # A client row is one running task. Anything that starts a second for
        # the same row — a boot sweep reaching a client that registration
        # already started, a bridge restarting its own — replaces the first,
        # and the first has to be told to stop rather than dropped on the
        # floor. An abandoned receive loop is still subscribed to its rooms and
        # still holds the invite slot for its user, and when the collector
        # finally reaches it, it runs the teardown for both: the live client
        # for that user goes deaf to invitations it never saw arrive.
        self._cancel_task(client_id)
        task = asyncio.create_task(self._run_client(client_id, client))
        self._tasks[client_id] = task

    def _cancel_task(self, client_id: str) -> asyncio.Task[None] | None:
        task = self._tasks.pop(client_id, None)
        if task and not task.done():
            task.cancel()
        return task

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
                self._client_types.pop(client_id, None)
                self._client_tenants.pop(client_id, None)
                self._tasks.pop(client_id, None)
