"""Every client running in this process, and the consumers it reads with.

Every switch-core process runs an actor for each client (`clients/actor.py`),
because any process may be asked to write as any client: the admin answering
in a room created there, an agent posting through the API. A consumer is
different when what it does must happen once: the admin's `CommandConsumer`
answers commands and posts warnings, so it runs in the one process that owns
its client (`ownership.py`), reading from the client's stored cursors and
stopped when the ownership moves. Every consumer runs that way.
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.actor import Actor, AgentActor, ClientConfig
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.consumer import Consumer
from switch_core.config import SwitchConfig
from switch_core.db.models import Agent, Client, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.logging_context import log_context
from switch_core.provisioning import Provisioning
from switch_core.tenant_context import no_tenant, tenant_scope
from switch_core.transport.cursors import ConsumerCursors, CursorWriter

if TYPE_CHECKING:
    from switch_core.clients.client_signals import ClientSignals
    from switch_core.ownership import Fence, Ownership

# The kind of owned work a client's consumer is, where only one process may
# run it (`ownership.py`), keyed by client id.
CLIENT_CONSUMERS = "client"

logger = logging.getLogger(__name__)

# A client that fails on the database or the network is retried rather than
# dropped. At boot every client starts at once and asks for a connection in the
# same second; on 9 Oct that drained the pool, 13 clients timed out
# waiting for one, and each was dropped for good: its agent connected, but
# nothing on the server could post for it until the next restart. Such a
# failure says nothing about the client, so it waits and tries again, as long
# as it takes. Anything else is a bug in the client and still ends it.
# The wait is jittered: the clients that drained the pool failed together, and
# a deterministic backoff would keep them retrying together, re-draining it in
# synchronized waves. Each draws its own delay instead.
_TRANSIENT_START_ERRORS: tuple[type[BaseException], ...] = (
    PoolTimeoutError,
    OperationalError,
    InterfaceError,
    OSError,
    TimeoutError,
)
CLIENT_RETRY_BASE_SECONDS = 1.0
CLIENT_RETRY_CAP_SECONDS = 60.0


@runtime_checkable
class _PreloadsAgent(Protocol):
    """An agent's actor, which can connect with an agent row read for it in
    bulk rather than reading its own."""

    def preload_agent(self, agent: Agent) -> None: ...


class TenantIsolationNotInForce(Exception):
    """A second tenant was asked for on a deployment that cannot keep tenants apart."""


class ClientLifecycleService:
    def __init__(
        self,
        *,
        provisioning: Provisioning,
        client_store: ClientStore,
        tenant_store: TenantStore,
        client_factory: ClientFactory,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        tenants_isolated: bool,
        ownership: Ownership,
        cursor_writer: CursorWriter,
    ) -> None:
        self._provisioning = provisioning
        self._cursor_writer = cursor_writer
        self._cursor_store = DeliveryCursorStore()
        self._tenants_isolated = tenants_isolated
        self._client_store = client_store
        self._tenant_store = tenant_store
        self._client_factory = client_factory
        self._session_factory = session_factory
        self._config = config
        # Every running row is an actor; the ones that read rooms also have a
        # consumer, keyed by the same client id.
        self._clients: dict[str, Actor[ClientConfig]] = {}
        self._consumers: dict[str, Consumer[Any]] = {}
        self._client_types: dict[str, str] = {}
        # Which tenant each running client's row belongs to. The actor
        # carries the same value (`Actor.tenant_id`); this is the index
        # on it, keyed like `_clients` and `_client_types` so the three are
        # populated and emptied together and a caller picking clients *out* of
        # a registry that holds every tenant's at once can say which tenant it
        # wants without reaching into the objects. See `get_by_type`.
        self._client_tenants: dict[str, str] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        # The read loops of the consumers this process owns, by client id.
        # Their actors' tasks are in `_tasks` like every other.
        self._owned_tasks: dict[str, asyncio.Task[None]] = {}
        # Clients stopped here on purpose (an agent being deleted stops its
        # client before its row goes) or whose task crashed on a bug.
        # `reconcile_tenant` leaves them stopped, as a crash always has, until
        # something starts them on purpose; otherwise a re-check between a
        # deletion's stop and its commit would start the client again. A
        # deletion that does not commit lets go of its client
        # (`deletion_failed`). Keyed by client id, to the client's tenant.
        self._left_stopped: dict[str, str] = {}
        self._signals: ClientSignals | None = None
        self._owned = ownership.kind(
            CLIENT_CONSUMERS,
            start=self._start_owned_consumer,
            stop=self._stop_owned_consumer,
        )
        # Told the tenant whenever a re-read starts or stops an agent client
        # here, which is how an agent registered or deleted in another process
        # reaches what keeps per-agent state of its own (a bridge's platform
        # identities, `CollaborationBridgeLifecycleService.agents_changed`).
        self._agents_changed_listeners: list[Callable[[str], None]] = []

    def add_agents_changed_listener(self, listener: Callable[[str], None]) -> None:
        self._agents_changed_listeners.append(listener)

    def _agents_changed(self, tenant_id: str) -> None:
        for listener in self._agents_changed_listeners:
            try:
                listener(tenant_id)
            except Exception:
                logger.exception(
                    "Telling a listener that tenant %s's agents changed failed",
                    tenant_id,
                )

    def use_signals(self, signals: ClientSignals) -> None:
        """Where a client started or deleted here is announced, so every
        other process starts or stops its own copy (`client_signals.py`)."""
        self._signals = signals

    def announce(self, tenant_id: str) -> None:
        """A client of `tenant_id` was registered or deleted, and has
        committed: every process reconciles its copies of the tenant's
        clients with the table."""
        if self._signals is not None:
            self._signals.changed(tenant_id)

    @property
    def tenants_isolated(self) -> bool:
        """Whether a tenant beyond the first can be created on this deployment."""
        return self._tenants_isolated

    def _make_user_id(self, localpart: str) -> str:
        return f"@{localpart}:{self._config.id_server_name}"

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

        Which tenants exist is exactly what a bound session cannot see, so it
        comes from `all_tenant_ids` — one of the seven `SECURITY DEFINER`
        lookups that make up the whole exemption from row-level security
        (`db/tenant_lookup.py`). Everything after that is an ordinary scoped
        read, one tenant at a time, and each row is created with that tenant
        bound so the `Client` picks it up from the same default every other
        scoped write uses instead of being handed a constant.

        A pass per tenant rather than one read across all of them: the
        enumeration this replaced could see every tenant's clients at once
        only because the connection was the tables' owner. Under the runtime
        role it read nothing, and this whole method silently created a second
        admin client for tenant zero on every boot.
        """
        tenant_ids = await all_tenant_ids(self._session_factory)
        already_served = set()
        for tenant_id in tenant_ids:
            async with tenant_session(self._session_factory, tenant_id) as session:
                # `get_by_type` carries no tenant filter of its own and leans
                # on the policy for it, so on an owner connection it answers
                # with every tenant's clients and marks every tenant served
                # as soon as one of them is. See `db/tenant_lookup.py`.
                if any(
                    client.tenant_id == tenant_id
                    for client in await self._client_store.get_by_type(
                        session, client_type
                    )
                ):
                    already_served.add(tenant_id)

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

    async def create_tenant(self, name: str, slug: str, organization_id: str) -> Tenant:
        """Create a tenant with everything it needs to function, in one call.

        Nothing in the running application ever created a `tenants` row
        before this: only the migration that seeds tenant zero does, so a
        second tenant onboarded so far meant inserting the row directly and
        restarting — the only thing that ever ran `ensure_system_client`'s
        enumeration. Between that insert and the restart the tenant existed
        with no admin client, so its rooms had no admin participant, with
        nothing to repair that short of the next boot.

        This is now the one seam a tenant comes into existence through, so
        that whatever offers tenant creation — `POST /tenants` today — has a
        single place to call rather than a row to insert and a checklist to
        remember. Whether a caller is *allowed* to create one is decided
        before this, at the route: this call provisions, it does not
        authorise. It reuses
        `ensure_system_client` rather than duplicating its per-type,
        per-tenant provisioning logic: the new tenant is simply the one gap
        that enumeration has not filled yet.

        The insert binds the new tenant's *own* id, which is the one binding
        that satisfies `tenants`' policy: it compares on `id` rather than on a
        `tenant_id` column, because a tenant is the boundary rather than
        something inside one. So creating a tenant needs no exemption at all —
        the row is written by a session scoped to exactly the tenant being
        created, and to nothing else. The id is generated here rather than by
        the database for that reason.

        The workspace belongs to `organization_id`, which must exist: creating
        the organization, or choosing one the caller administers, is the
        route's business, as authorising is.
        """
        if not self._tenants_isolated:
            raise TenantIsolationNotInForce(
                "This server is not isolating tenants: its database connection is "
                "not subject to the row-level-security policies, and it runs only "
                "because DB_REQUIRE_RESTRICTED_ROLE is false, which allows a single "
                "workspace. Connect it as the restricted runtime role before "
                "creating another."
            )
        tenant = Tenant(
            id=str(uuid.uuid4()), name=name, slug=slug, organization_id=organization_id
        )
        async with tenant_session(self._session_factory, tenant.id) as session:
            await self._tenant_store.create(session, tenant)
            await session.commit()
        try:
            await self.ensure_system_client("admin")
        except Exception:
            logger.error(
                "Tenant %s (slug %s) was created but provisioning admin clients "
                "failed; the next boot's ensure_system_client fills the gap.",
                tenant.id,
                slug,
            )
            raise
        # The admin client exists only as a row until something starts it.
        self.announce(tenant.id)
        return tenant

    async def start_all(self) -> None:
        # Every tenant's clients at boot, read one tenant at a time. The
        # enumeration is `all_tenant_ids` — the exemption answers which
        # tenants there are, and each tenant's clients are then an ordinary
        # scoped read (`db/tenant_lookup.py`).
        #
        # Nothing is bound around `_start_task`, and that is unchanged: a
        # client's own task derives its tenant from its client row rather than
        # inheriting one, so a binding here would only decide what the task
        # snapshots, which is exactly what must not matter.
        records: list[Client] = []
        for tenant_id in await all_tenant_ids(self._session_factory):
            async with tenant_session(self._session_factory, tenant_id) as session:
                # Filtered on the row's own tenant, not left to the policy: on an
                # owner connection no policy narrows this read, and the fan-out
                # would act on every tenant's rows once per tenant. See
                # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
                records.extend(
                    record
                    for record in await self._client_store.get_all(session)
                    if record.tenant_id == tenant_id
                )

        # A member client's messages are written by the chats routes in the
        # request's own transaction, so it has nothing to run.
        records = [
            r
            for r in records
            if r.type not in self.COLLAB_CLIENT_TYPES and r.type != MEMBER_CLIENT_TYPE
        ]
        try:
            agents = await self._agents_by_client_id(records)
        except Exception:
            # One bulk read must not cost every client. Without it each agent
            # client reads its own row as it starts, as it always did, with
            # its own retry.
            logger.exception("Bulk agent read failed; clients will each read their own")
            agents = {}

        logger.info("Starting %d clients", len(records))
        for record in records:
            actor = self._register(record)
            # Before the task first runs: `_register` only schedules it, and
            # nothing here yields until the loop is done.
            agent = agents.get(record.id)
            if agent is not None and isinstance(actor, _PreloadsAgent):
                actor.preload_agent(agent)

    async def reconcile_all(self) -> None:
        """`reconcile_tenant` for every tenant."""
        for tenant_id in await all_tenant_ids(self._session_factory):
            await self.reconcile_tenant(tenant_id)

    async def reconcile_tenant(self, tenant_id: str) -> None:
        """Run here exactly the tenant's clients that `start_all` would run.

        Every process starts every non-collaboration client at boot, and a
        client registered later used to start only in the process that served
        the registration, while a deleted one kept running everywhere else
        until a restart. This re-reads the tenant's rows: a client with no copy
        here is started, and a copy whose row is gone is stopped.

        An agent's client row commits before its agent row, so one without an
        agent row yet is left alone: its actor would find no agent and crash.
        The registration's own signal comes after both have committed.
        Collaboration clients (bridges and the people they speak for) are the
        bridges' to start and stop, and a client that crashed stays stopped.
        """
        # Only a client already running before the read can be judged deleted
        # by it. One registered in this process while the read awaits has a
        # row the read may not have seen, and stopping it would put it in
        # `_left_stopped`, where later re-checks leave it.
        running_before = [
            client_id
            for client_id, client_tenant in self._client_tenants.items()
            if client_tenant == tenant_id
            and self._client_types.get(client_id) not in self.COLLAB_CLIENT_TYPES
        ]
        async with tenant_session(self._session_factory, tenant_id) as session:
            records = [
                record
                for record in await self._client_store.get_all(session)
                if record.tenant_id == tenant_id
                and record.type not in self.COLLAB_CLIENT_TYPES
                # As in `start_all`: the chats routes write a member client's
                # messages themselves, so it has nothing to run.
                and record.type != MEMBER_CLIENT_TYPE
            ]
        present = {record.id for record in records}
        # A client whose row is gone will not be started again: nothing is
        # left to hold back.
        self._left_stopped = {
            client_id: client_tenant
            for client_id, client_tenant in self._left_stopped.items()
            if client_tenant != tenant_id or client_id in present
        }
        agents_changed = False
        # A rename served elsewhere changes the name a copy here sends under
        # (bridges recognise an agent's own messages by it) and the identities
        # a bridge here holds for the agent, so both follow it now.
        for record in records:
            actor = self._clients.get(record.id)
            if actor is not None and actor.display_name != record.display_name:
                await actor.set_display_name(record.display_name)
                agents_changed |= record.type == "agent"
        for client_id in running_before:
            if client_id in self._client_tenants and client_id not in present:
                logger.info("Client %s was deleted elsewhere; stopping it", client_id)
                agents_changed |= self._client_types.get(client_id) == "agent"
                await self.stop(client_id)
        missing = [
            record
            for record in records
            if record.id not in self._clients and record.id not in self._left_stopped
        ]
        if not missing:
            if agents_changed:
                self._agents_changed(tenant_id)
            return
        agents = await self._agents_by_client_id(missing)
        for record in missing:
            agent = agents.get(record.id)
            if record.type == "agent" and agent is None:
                continue
            # Checked again: `stop` above and the agent read both yield, and a
            # registration in this process may have started it meanwhile.
            if record.id in self._clients:
                continue
            logger.info(
                "Client %s (%s) was added elsewhere; starting it",
                record.display_name,
                record.transport_user_id,
            )
            actor = self._register(record)
            if agent is not None and isinstance(actor, _PreloadsAgent):
                actor.preload_agent(agent)
            agents_changed |= agent is not None
        if agents_changed:
            self._agents_changed(tenant_id)

    async def _agents_by_client_id(self, records: list[Client]) -> dict[str, Agent]:
        """The agent row behind each client, one query per tenant.

        Each agent client would otherwise read its own at start, and at boot
        they all start at once: a few hundred reads in the same second.
        """
        by_tenant: dict[str, list[str]] = {}
        for record in records:
            by_tenant.setdefault(record.tenant_id, []).append(record.id)
        agents: dict[str, Agent] = {}
        for tenant_id, client_ids in by_tenant.items():
            async with tenant_session(self._session_factory, tenant_id) as session:
                for agent in await AgentStore().get_by_client_ids(session, client_ids):
                    if agent.client_id is not None:
                        agents[agent.client_id] = agent
        return agents

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
        transport_user_id = self._make_user_id(localpart)

        record = Client(
            id=client_id,
            transport_user_id=transport_user_id,
            display_name=display_name,
            type=client_type,
            config=config,
        )
        async with self._session_factory() as session:
            await self._client_store.create(session, record)
            await session.commit()

        logger.info("Created client %s (%s)", display_name, transport_user_id)
        return record

    def start_client(self, record: Client) -> Actor[ClientConfig]:
        actor = self._register(record)
        logger.info(
            "Started client %s (%s)", record.display_name, record.transport_user_id
        )
        return actor

    def _leave_stopped(self, client_id: str) -> None:
        tenant_id = self._client_tenants.get(client_id)
        if tenant_id is not None:
            self._left_stopped[client_id] = tenant_id

    def _register(self, record: Client) -> Actor[ClientConfig]:
        self._left_stopped.pop(record.id, None)
        actor = self._client_factory.create_actor(record)
        self._clients[record.id] = actor
        self._client_types[record.id] = record.type
        self._client_tenants[record.id] = record.tenant_id
        # The actor here, and the consumer, if the type has one, where this
        # process owns the client.
        self._consumers.pop(record.id, None)
        self._start_task(record.id, actor)
        if self._client_factory.has_consumer(record.type):
            self._owned.want(record.id)
        return actor

    async def create_and_start(
        self,
        *,
        client_type: str,
        display_name: str,
        localpart: str | None = None,
        config: dict[str, object] | None = None,
    ) -> Actor[ClientConfig]:
        record = await self.create_client(
            client_type=client_type,
            display_name=display_name,
            localpart=localpart,
            config=config,
        )
        return self.start_client(record)

    async def stop(self, client_id: str) -> None:
        actor = self._clients.get(client_id)
        if actor is None:
            logger.warning("Cannot stop unknown client %s", client_id)
            return
        if self._owned.wants(client_id):
            # Its consumer, where this process owns it, and its lease with it.
            await self._owned.drop(client_id)
            await self._stop_owned_consumer(client_id)
        consumer = self._consumers.pop(client_id, None)
        if consumer is not None:
            await consumer.stop()
        else:
            await actor.close()
        self._leave_stopped(client_id)
        task = self._cancel_task(client_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        del self._clients[client_id]
        self._client_types.pop(client_id, None)
        self._client_tenants.pop(client_id, None)
        logger.info("Stopped client %s", client_id)

    async def stop_all(self) -> None:
        logger.info("Stopping all %d clients", len(self._clients))
        # The ownership has stopped and released the consumers it held
        # (`Ownership.stop`); whatever still runs here goes the same way.
        for client_id in list(self._owned_tasks):
            await self._stop_owned_consumer(client_id)
        for client_id, actor in self._clients.items():
            consumer = self._consumers.get(client_id)
            if consumer is not None:
                await consumer.stop()
            else:
                await actor.close()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        # Awaited, not merely cancelled. A cancelled task unwinds when the
        # loop next runs it, or never — and a receive loop that is never run
        # again is collected instead, which runs its `finally` under the
        # garbage collector, in a context that is not the task's.
        await asyncio.gather(*tasks, return_exceptions=True)
        self._clients.clear()
        self._consumers.clear()
        self._client_types.clear()
        self._client_tenants.clear()
        self._tasks.clear()

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        """Delete a client's row in the caller's transaction, committing nothing.

        The counterpart to `stop`, and separate from it on purpose. A client
        row is only ever deleted alongside whatever owned the client — a
        bridge and the human actors it minted, an agent — and those rows have to go
        in one transaction or not at all: the owner's delete commits first
        otherwise, and a failure after it leaves clients nothing points at and
        nothing will retry.

        Stopping the running client is the half that cannot join a
        transaction, so callers do that first. A rollback then leaves a
        stopped client whose row survives, which `deletion_failed` or the
        next start repairs; the opposite order leaves an orphan row that
        nothing repairs.
        """
        await self._client_store.delete(session, client_id)

    def deletion_failed(self, client_id: str) -> None:
        """Let a client stopped for a deletion that did not commit run again.

        Its row is still there, so the client still exists, but `stop` left
        it in `_left_stopped`, where every re-check leaves it, so it would
        stay stopped here until the process restarts. Announced rather than
        started here: the re-read that follows starts the client if its row
        is there, and nothing if the deletion committed after all and failed
        only on the way back.
        """
        tenant_id = self._left_stopped.pop(client_id, None)
        if tenant_id is not None:
            self.announce(tenant_id)

    def get(self, client_id: str) -> Actor[ClientConfig] | None:
        return self._clients.get(client_id)

    def running_count(self) -> int:
        """Consumers believed to be running in this process right now: the
        read loops.

        A crashed consumer removes itself, so this falling is the only signal.
        Actors with no consumer have no loop to crash, and that includes every
        agent's: what is for an agent is decided as each row is written, so
        nothing reads a room for it. A consumer another process owns is
        counted there.
        """
        return len(self._consumers)

    def owns(self, client_id: str) -> bool:
        """Whether this process holds the client's consumer lease."""
        return self._owned.fence(client_id) is not None

    def get_by_agent_id(self, agent_id: str) -> AgentActor | None:
        for actor in self._clients.values():
            if isinstance(actor, AgentActor) and actor.agent_id == agent_id:
                return actor
        return None

    def get_by_type(
        self, client_type: str, tenant_id: str
    ) -> list[Actor[ClientConfig]]:
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

    async def _start_owned_consumer(self, client_id: str, fence: Fence) -> None:
        """This process now owns the client: run its consumer here, a fresh
        one for this hold, reading from the client's stored cursors."""
        actor = self._clients.get(client_id)
        client_type = self._client_types.get(client_id)
        if actor is None or client_type is None:
            logger.warning(
                "Owning client %s, which is not running here; its consumer "
                "waits for it",
                client_id,
            )
            return
        consumer = self._client_factory.create_consumer(client_type, actor)
        if consumer is None:
            return
        cursors = ConsumerCursors(
            writer=self._cursor_writer,
            store=self._cursor_store,
            tenant_id=actor.tenant_id,
            client_id=client_id,
            fence=fence,
            actor_role=actor.role,
            on_lost=self._owned.lost,
        )
        self._consumers[client_id] = consumer
        self._owned_tasks[client_id] = asyncio.create_task(
            self._run_owned_consumer(client_id, consumer, cursors)
        )

    async def _stop_owned_consumer(self, client_id: str) -> None:
        """Stop the client's consumer here after the row in hand, and store
        how far it got, so the process that owns the client next starts where
        it ended. A progress write that fails is logged: the next owner then
        handles the last rows again, and writes their replies once."""
        task = self._owned_tasks.pop(client_id, None)
        if task is None:
            return
        consumer = self._consumers.pop(client_id, None)
        if consumer is not None:
            await consumer.stop()
        await asyncio.gather(task, return_exceptions=True)
        try:
            await self._cursor_writer.flush()
        except Exception:
            logger.warning(
                "Could not store client %s's progress as its consumer stopped; "
                "whoever reads for it next handles its last rows again",
                client_id,
                exc_info=True,
            )

    async def _run_owned_consumer(
        self, client_id: str, consumer: Consumer[Any], cursors: ConsumerCursors
    ) -> None:
        """An owned consumer's read loop, ambient-free for the reasons
        `_run_client` gives. A crash ends the consumer and leaves its actor:
        the client is still written as here, and is read nowhere until its
        ownership moves or the process restarts, as a crashed client always
        was."""
        actor = consumer.actor
        with no_tenant(), log_context(room_id=None):
            try:
                attempt = 0
                while True:
                    try:
                        await consumer.start(cursors)
                        return
                    except _TRANSIENT_START_ERRORS:
                        attempt += 1
                        delay = random.uniform(
                            0,
                            min(
                                CLIENT_RETRY_BASE_SECONDS * 2 ** (attempt - 1),
                                CLIENT_RETRY_CAP_SECONDS,
                            ),
                        )
                        logger.warning(
                            "Client %s (%s) failed on the database or network "
                            "(attempt %d); retrying in %.0fs",
                            actor.display_name,
                            actor.transport_user_id,
                            attempt,
                            delay,
                            exc_info=True,
                        )
                        await asyncio.sleep(delay)
            except Exception:
                logger.exception(
                    "Client %s (%s) crashed",
                    actor.display_name,
                    actor.transport_user_id,
                )
                if self._consumers.get(client_id) is consumer:
                    del self._consumers[client_id]
                if self._owned_tasks.get(client_id) is asyncio.current_task():
                    del self._owned_tasks[client_id]

    def _start_task(self, client_id: str, actor: Actor[ClientConfig]) -> None:
        # A client row is one running task. Anything that starts a second for
        # the same row — a boot sweep reaching a client that registration
        # already started, a bridge restarting its own — replaces the first,
        # and the first has to be told to stop rather than dropped on the
        # floor. An abandoned receive loop is still subscribed to its rooms and
        # still holds the invite slot for its user, and when the collector
        # finally reaches it, it runs the teardown for both: the live client
        # for that user goes deaf to invitations it never saw arrive.
        self._cancel_task(client_id)
        task = asyncio.create_task(self._run_client(client_id, actor))
        self._tasks[client_id] = task

    def _cancel_task(self, client_id: str) -> asyncio.Task[None] | None:
        task = self._tasks.pop(client_id, None)
        if task and not task.done():
            task.cancel()
        return task

    async def _run_client(self, client_id: str, actor: Actor[ClientConfig]) -> None:
        """A client's long-lived task, deliberately ambient-free.

        `no_tenant` because a task keeps the context of whoever created it,
        and the creators differ: boot, a gateway request that added an agent,
        or an inbound bridge message that minted a human actor mid-conversation.
        A human actor in particular is reused for every room the person it stands
        for speaks in, so the first room's tenant is exactly the value that
        must not survive into the second. Everything the client does binds
        the tenant of the room it is acting on.

        Nothing in here runs unbound, and nothing has to ask the database
        which tenant this client is in. An `Actor` carries its own
        `tenant_id`, taken from the `clients` row it was built from, and hands
        it to its transport; `joined_rooms` and every media read then go
        through an ordinary `tenant_session` under that tenant. An exemption
        call here would have been a question whose answer the caller was
        already holding.

        The room goes with it for the same reason: the inbound handler that
        mints a human actor has that room bound as log context, and the human actor's
        own log lines must not name it for the rest of its life. Each delivery
        binds its room.
        """
        with no_tenant(), log_context(room_id=None):
            try:
                attempt = 0
                while True:
                    try:
                        await actor.connect()
                        return
                    except _TRANSIENT_START_ERRORS:
                        attempt += 1
                        delay = random.uniform(
                            0,
                            min(
                                CLIENT_RETRY_BASE_SECONDS * 2 ** (attempt - 1),
                                CLIENT_RETRY_CAP_SECONDS,
                            ),
                        )
                        logger.warning(
                            "Client %s (%s) failed on the database or network "
                            "(attempt %d); retrying in %.0fs",
                            actor.display_name,
                            actor.transport_user_id,
                            attempt,
                            delay,
                            exc_info=True,
                        )
                        await asyncio.sleep(delay)
            except Exception:
                logger.exception(
                    "Client %s (%s) crashed",
                    actor.display_name,
                    actor.transport_user_id,
                )
                self._leave_stopped(client_id)
                self._clients.pop(client_id, None)
                self._consumers.pop(client_id, None)
                self._client_types.pop(client_id, None)
                self._client_tenants.pop(client_id, None)
                self._tasks.pop(client_id, None)
