"""Deciding, as a room row is written, which agents it is for.

Every row written to a room goes through `MessageRouter.store`, in the
transaction that writes it: a message, a file, a command, a task event, an
arrival. The router decides, for every agent member of the room, whether the
row is one of that agent's own events (`delivery/recipient.py` holds the
rules), and stores those events (`agent_events`) in the same transaction.
What the decisions leave to say in the room (a refusal, an offline notice, a
greeting, a command's answer) is posted once the transaction has committed,
by the process that wrote the row.

It replaced an agent consumer per agent in every process, each woken for
every row of its rooms to ask "is this for me?" and to store its answer in a
transaction of its own. Three things are better for it:

- **Atomic.** A row and the own events decided for it commit together or not
  at all. A consumer's place in a room lived in memory, so a process that
  stopped between storing a row and deciding it lost the row for the agent:
  a consumer started afterwards read each room from its head.
- **Cheaper.** One row woke agents times processes consumers, each with its
  own session; the router decides once, in the writer's session, with the
  reads every agent would have made asked once for the whole room
  (`RoomReads`).
- **Nothing to wait for.** A reader of a room's conversation used to hold back
  each new row for two seconds, so the consumer could decide first whether it
  was an own event. A row is decided by the time anything can read it now.

How the transaction runs, and why in this order:

1. Reads first, before the room's lock: the room, its agent members and
   whatever the decisions ask (aliases, role leases, the sender, budgets).
   `MessageStore.create` takes the room's advisory lock to number the row,
   and writers to one room wait on each other while it is held, so only
   inserts happen inside it.
2. The row is inserted and numbered (`MessageStore.create`, called from here
   and nowhere else; a test holds the code to that). An agent whose arrival
   committed between the reads and the lock comes before the row in the
   room, so the members are checked once more and, if one joined, the row is
   decided again from the members as they are.
3. The own events are inserted, one savepoint per agent, in the order of the
   agents' ids. Each claims the agent's next number from its row in
   `agent_event_heads`, which stays locked to commit, so an agent's events are
   numbered in commit order; a fixed order means two rows for the same two
   agents cannot each hold one agent's row and wait for the other's. A
   failure for one agent is logged and counted, and the row still commits.

Multi-file posts are written one file per row and are decided once, as a
whole: when the file that completes the post is written, or, when the rest
never comes, by a sweep every process runs once `ATTACHMENT_GROUP_TIMEOUT_SECONDS`
have passed since the first file (`PendingAttachmentGroup`, `flush_due_groups`).

During a rolling deploy a process still on the release before this one writes
rows without deciding them, and its agent consumers decide them a moment
later. The rows this release writes are decided here and once more by those
consumers, which find the events already stored (`uq_agent_events_source`)
but post their replies a second time until the old processes are gone.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, cast, overload

from sqlalchemy import and_, delete, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError

from switch_core.attachments import ATTACHMENT_GROUP_KEY, parse_attachment_group
from switch_core.budgets import BudgetGuard
from switch_core.clients.actor import AgentActor, ClientConfig
from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import (
    Agent,
    AgentConnectionRecord,
    Client,
    ClientRoom,
    CollaborationBridge,
    Message,
    PendingAttachmentGroup,
    RoleLease,
    Room,
    SwitchCoreProcess,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import follow_ups_enabled_in, main_agent_in
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal
from switch_core.delivery.conversation import (
    ConversationMessage,
    ConversationRules,
    may_follow,
)
from switch_core.delivery.recipient import (
    NOTHING,
    AgentRecipient,
    Delivery,
    RecipientServices,
    RoomMember,
    command_event,
    file_index,
)
from switch_core.events import (
    SwitchEvent,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
)
from switch_core.logging_context import log_context
from switch_core.observability.catalogue import ROUTING_FAILURES
from switch_core.observability.metrics import metrics
from switch_core.process_lease import LEASE_TTL
from switch_core.tenant_context import tenant_scope
from switch_core.transport.stored import to_inbound
from switch_core.transport.types import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.clients.actor import Actor
    from switch_core.db.models import MessageAttachment
    from switch_core.db.stores.budget_store import BudgetStanding, BudgetStore
    from switch_core.db.stores.client_store import ClientStore
    from switch_core.db.stores.message_store import MessageStore
    from switch_core.transport.port import MessageTransport

logger = logging.getLogger(__name__)

# How long a multi-file post waits for the rest of its files before it is
# decided with the files that did arrive, flagged as incomplete. A post's files
# normally arrive within milliseconds (one sender, back to back); this is a
# safety net so a broken batch surfaces rather than being held indefinitely.
# Counted from the post's first file and never extended by a later one.
ATTACHMENT_GROUP_TIMEOUT_SECONDS = 5.0

# How often every process looks for posts whose wait is over. The process
# that wrote a post's first file also sets a timer for its deadline; this is
# what decides a post whose writer has stopped since.
GROUP_SWEEP_SECONDS = 5.0

# The custom events an agent can be part of, by type. The rest (reports,
# observations) are the platform's own bookkeeping and are nobody's own event.
_TASK_EVENTS: dict[str, type[SwitchEvent]] = {
    "com.switch.task.delegate": TaskDelegate,
    "com.switch.task.accept": TaskAccept,
    "com.switch.task.update": TaskUpdate,
    "com.switch.task.finalise": TaskFinalise,
    "com.switch.task.cancel": TaskCancel,
}
_COMMAND_EVENT = "com.switch.command"


class RoomReads:
    """What deciding one row reads about its room, read once and shared by
    every agent the row is decided for.

    The room and its agent members are read up front. Everything else is
    read the first time an agent's decision asks and kept for the others:
    the role each agent live-holds here, who the sender is, the tenant's
    budgets, who a member is by the id they post under. The rules ask the
    same questions they always did (`AddressingResolver`, `BudgetGuard`);
    this only answers them for a whole room at once, so what a row costs in
    reads does not grow with the number of agents in the room.
    """

    def __init__(
        self,
        *,
        services: RecipientServices,
        client_store: ClientStore,
        budget_store: BudgetStore,
        tenant_id: str,
        room_id: str,
        transport_room_id: str,
        meta: RoomMeta,
        group_id: str | None,
        members: list[RoomMember],
    ) -> None:
        self.tenant_id = tenant_id
        self.room_id = room_id
        self.transport_room_id = transport_room_id
        self.meta = meta
        self.group_id = group_id
        self.members = members
        self._services = services
        self._client_store = client_store
        self._budget_store = budget_store
        self._roles: dict[str, str] | None = None
        self._senders: dict[tuple[str, str], SenderPrincipal | None] = {}
        self._claims: dict[str, list[str]] = {}
        self._standings: list[BudgetStanding] | None = None
        self._clients: dict[str, Client | None] = {}
        self.addressing = _RoomAddressing(
            self, services=services, client_store=client_store
        )
        self.budget_guard = BudgetGuard(_RoomBudgets(self))

    @classmethod
    async def load(
        cls,
        session: AsyncSession,
        *,
        services: RecipientServices,
        client_store: ClientStore,
        budget_store: BudgetStore,
        tenant_id: str,
        room_id: str,
    ) -> RoomReads | None:
        """The room and its agent members, or None when the room is gone.

        A member is one whose membership has committed by the time this
        reads it. Its arrival was written under the room's lock and committed
        with the membership, so it comes before the row being decided in the
        room's order, whatever the clocks of the two transactions say.
        """
        found = (
            await session.execute(
                select(Room, CollaborationBridge.agent_greetings_enabled)
                .outerjoin(
                    CollaborationBridge,
                    and_(
                        CollaborationBridge.tenant_id == Room.tenant_id,
                        CollaborationBridge.id == Room.bridge_id,
                    ),
                )
                .where(Room.id == room_id)
            )
        ).first()
        if found is None:
            return None
        room, greetings = found
        rows = (
            await session.execute(
                select(
                    Agent,
                    Client.id,
                    Client.transport_user_id,
                    Client.display_name,
                    room_agents.c.alias,
                    room_agents.c.receives_join_events,
                    ClientRoom.joined_at,
                )
                .select_from(ClientRoom)
                .join(Client, Client.id == ClientRoom.client_id)
                .join(Agent, Agent.client_id == Client.id)
                .outerjoin(
                    room_agents,
                    and_(
                        room_agents.c.room_id == ClientRoom.room_id,
                        room_agents.c.agent_id == Agent.id,
                    ),
                )
                .where(ClientRoom.room_id == room_id)
            )
        ).all()
        members = [
            RoomMember(
                agent=agent,
                client_id=client_id,
                transport_user_id=transport_user_id,
                display_name=display_name,
                alias=alias,
                listening=bool(listening),
                joined_at=joined_at,
            )
            for (
                agent,
                client_id,
                transport_user_id,
                display_name,
                alias,
                listening,
                joined_at,
            ) in rows
        ]
        return cls(
            services=services,
            client_store=client_store,
            budget_store=budget_store,
            tenant_id=tenant_id,
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            meta=RoomMeta(
                room_id=room.id,
                name=room.name,
                bridge_id=room.bridge_id,
                agent_greetings_enabled=True if greetings is None else greetings,
                channel_type=room.channel_type,
                follow_ups_enabled=follow_ups_enabled_in(room.metadata_),
                main_agent_id=main_agent_in(room.metadata_),
                agent_greeting=(room.metadata_ or {}).get("agent_greeting"),
            ),
            group_id=room.group_id,
            members=sorted(members, key=lambda member: member.agent.id),
        )

    def member(self, client_id: str | None) -> RoomMember | None:
        """The agent member posting as `client_id`, if it is one."""
        return next(
            (member for member in self.members if member.client_id == client_id),
            None,
        )

    def alias_of(self, agent_id: str) -> str | None:
        return next(
            (m.alias for m in self.members if m.agent.id == agent_id),
            None,
        )

    async def role_names(self, session: AsyncSession) -> dict[str, str]:
        """The role each agent live-holds in the room, by agent id.

        A seat taken over a connection is held while that connection is
        live. This process's memory knows its own connections, but its copy
        of another process's can be missing or late, and a message decided
        without a live holder is never decided again. So the connections
        recorded as holding a seat here are read as well: one counts while
        its row is open and the process named on it holds its lease.
        """
        if self._roles is None:
            live = self._services.connections.live_connection_ids()
            live |= set(
                (
                    await session.scalars(
                        select(AgentConnectionRecord.id).where(
                            AgentConnectionRecord.id.in_(
                                select(RoleLease.transport_session_id).where(
                                    RoleLease.room_id == self.room_id
                                )
                            ),
                            AgentConnectionRecord.closed_at.is_(None),
                            select(SwitchCoreProcess.id)
                            .where(
                                SwitchCoreProcess.id
                                == AgentConnectionRecord.process_id,
                                SwitchCoreProcess.stopped_at.is_(None),
                                SwitchCoreProcess.beat_at
                                > func.now() - literal(LEASE_TTL),
                            )
                            .exists(),
                        )
                    )
                ).all()
            )
            self._roles = await self._services.room_role_store.room_role_names(
                session, self.room_id, live
            )
        return self._roles

    async def sender(
        self,
        transport_user_id: str,
        content: Mapping[str, object] | None,
        resolve: Callable[[], Awaitable[SenderPrincipal | None]],
    ) -> SenderPrincipal | None:
        # Keyed on the platform marker as well as the sender: an admin client's
        # message speaks for whoever its marker names.
        marker = repr((content or {}).get(PLATFORM_MARKER))
        key = (transport_user_id, marker)
        if key not in self._senders:
            self._senders[key] = await resolve()
        return self._senders[key]

    async def claimed_accounts(
        self, user_id: str, read: Callable[[], Awaitable[list[str]]]
    ) -> list[str]:
        if user_id not in self._claims:
            self._claims[user_id] = await read()
        return self._claims[user_id]

    async def standings(self, session: AsyncSession) -> list[BudgetStanding]:
        if self._standings is None:
            self._standings = await self._budget_store.standings(
                session, tenant_id=self.tenant_id, agent_id=None
            )
        return self._standings

    async def get_by_transport_user_id(
        self, session: AsyncSession, transport_user_id: str
    ) -> Client | None:
        """Who posts as `transport_user_id`, for naming an arrival."""
        if transport_user_id not in self._clients:
            self._clients[
                transport_user_id
            ] = await self._client_store.get_by_transport_user_id(
                session, transport_user_id
            )
        return self._clients[transport_user_id]


class _RoomAddressing(AddressingResolver):
    """The addressing rules, answered from one row's `RoomReads`."""

    def __init__(
        self,
        reads: RoomReads,
        *,
        services: RecipientServices,
        client_store: ClientStore,
    ) -> None:
        super().__init__(
            room_store=services.room_store,
            room_role_store=services.room_role_store,
            client_store=client_store,
            agent_store=services.agent_store,
            external_user_store=services.external_user_store,
            live_connection_ids=services.connections.live_connection_ids,
        )
        self._reads = reads

    async def alias_of(
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> str | None:
        if room_id != self._reads.room_id:
            return await super().alias_of(session, room_id, agent_id)
        return self._reads.alias_of(agent_id)

    async def role_of(
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> str | None:
        if room_id != self._reads.room_id:
            return await super().role_of(session, room_id, agent_id)
        return (await self._reads.role_names(session)).get(agent_id)

    async def group_of(self, session: AsyncSession, room_id: str) -> str | None:
        if room_id != self._reads.room_id:
            return await super().group_of(session, room_id)
        return self._reads.group_id

    async def claimed_accounts(self, session: AsyncSession, user_id: str) -> list[str]:
        read = super().claimed_accounts
        return await self._reads.claimed_accounts(
            user_id, lambda: read(session, user_id)
        )

    async def resolve_sender(
        self,
        session: AsyncSession,
        transport_user_id: str,
        content: Mapping[str, object] | None = None,
    ) -> SenderPrincipal | None:
        resolve = super().resolve_sender
        return await self._reads.sender(
            transport_user_id,
            content,
            lambda: resolve(session, transport_user_id, content),
        )


class _RoomBudgets:
    """A tenant's budgets read once for one row, and narrowed to the ones
    covering each agent the way `BudgetStore.standings` narrows them: the
    agent's own and the tenant-wide ones, in the same order."""

    def __init__(self, reads: RoomReads) -> None:
        self._reads = reads

    async def standings(
        self, session: AsyncSession, *, tenant_id: str, agent_id: str | None
    ) -> list[BudgetStanding]:
        every = await self._reads.standings(session)
        return [
            standing
            for standing in every
            if agent_id is None
            or standing.agent_id is None
            or standing.agent_id == agent_id
        ]


@dataclass
class _GroupStep:
    """What writing one file does to its post's pending row."""

    group_id: str
    total: int
    # The file the pending post's files are counted from, when the post was
    # pending as this file was decided; None when this file starts it.
    pending_from: int | None
    complete: bool


@dataclass
class _Plan:
    """What was decided for one row, before it is written."""

    deliveries: list[tuple[AgentRecipient, Delivery]] = field(default_factory=list)
    # The agent whose arrival this row is, when it is one.
    arrival: AgentRecipient | None = None
    group: _GroupStep | None = None


class Routed:
    """A row decided and written in its writer's transaction, and what is
    left to do once that transaction commits.

    The writer calls `committed()` after its commit and never before: a row
    rolled back must not wake an agent, greet anybody or post a reply.
    """

    def __init__(
        self,
        router: MessageRouter,
        reads: RoomReads | None,
        plan: _Plan,
        row: InboundEvent,
        *,
        seq: int,
        stored: list[str],
        deadline_in: float | None,
    ) -> None:
        self._router = router
        self._reads = reads
        self._plan = plan
        self._row = row
        # The row's place in its room.
        self.seq = seq
        self._stored = stored
        self._deadline_in = deadline_in

    def committed(self) -> None:
        """Wake the agents the row is for, and leave the replies it owes to
        run in the background, in the order the room's rows were written.

        Never raises. The row is committed by now, and a writer told its send
        failed would send it again: a failure here is logged and counted, and
        costs only what it was about to do.
        """
        try:
            self._committed()
        except Exception:
            metrics().increment(ROUTING_FAILURES, {"stage": "after_commit"})
            logger.error(
                "Could not finish routing row %s after its commit; it is written "
                "and its own events are stored",
                self._row.event_id,
                exc_info=True,
            )

    def _committed(self) -> None:
        router = self._router
        for agent_id in self._stored:
            router.services.event_buffer.ring(agent_id)
        reads = self._reads
        if reads is None:
            return
        plan = self._plan
        if plan.arrival is not None:
            router.services.connections.controllers.room_joined(
                plan.arrival.agent.id, reads.room_id
            )
        if self._deadline_in is not None:
            router.flush_groups_after(reads.tenant_id, self._deadline_in)
        work: list[tuple[AgentRecipient, Callable[[], Awaitable[None]]]] = []
        row = self._row
        for recipient, delivery in plan.deliveries:
            if delivery.after is not None:
                work.append((recipient, _bind(recipient, delivery.after, row)))
        if plan.arrival is not None:
            arrival = plan.arrival
            work.append((arrival, _bind(arrival, lambda _row: arrival.greet(), row)))
        if work:
            router.after_commit(reads.tenant_id, reads.room_id, work)


def _bind(
    recipient: AgentRecipient,
    after: Callable[[InboundEvent], Awaitable[None]],
    row: InboundEvent,
) -> Callable[[], Awaitable[None]]:
    """The work `row` left the agent, run as the agent once the row has
    committed, and only while the agent is still a member of the room
    (`AgentRecipient.still_member`)."""

    async def run() -> None:
        if not await recipient.still_member():
            logger.info(
                "Agent %s was taken out of room %s after row %s was decided; "
                "what the row left it to say is not said",
                recipient.agent.name,
                row.room_id,
                row.event_id,
            )
            return
        await recipient.actor.connect()
        await after(row)

    return run


class Removed:
    """An agent taken out of a room, and what is let go of once the removal
    has committed."""

    def __init__(
        self,
        router: MessageRouter,
        *,
        tenant_id: str,
        agent_id: str | None,
        room_id: str,
    ) -> None:
        self._router = router
        self._tenant_id = tenant_id
        self._agent_id = agent_id
        self._room_id = room_id

    async def committed(self) -> None:
        """Take the room off the agent's connections, whichever process holds
        them, and off a controller streaming the agent from here
        (`MessageRouter.release_room`).

        Never raises. The removal is committed by now, and a caller told it
        failed would remove the agent again: a failure here is logged and
        counted, and the process holding a connection that still claims the
        room lets it go when the membership signal reaches it.
        """
        if self._agent_id is None:
            return
        try:
            await self._router.release_room(
                self._tenant_id, self._agent_id, self._room_id
            )
        except Exception:
            metrics().increment(ROUTING_FAILURES, {"stage": "after_commit"})
            logger.error(
                "Could not release room %s from agent %s's connections after "
                "the agent was removed from it",
                self._room_id,
                self._agent_id,
                exc_info=True,
            )


@dataclass(frozen=True)
class _Unwritten:
    """A row about to be written, as `to_inbound` reads one.

    Everything but its place in the room and the time the database will
    stamp on it, which nothing that decides a row reads: an own event is
    built from the row once it is written (`Delivery.own_event`).
    """

    content: dict[str, Any]
    transport_event_id: str
    sender_id: str
    sent_at: Any
    event_type: str
    seq: int
    body: str | None
    sender_name: str | None
    formatted_body: str | None
    msgtype: str | None
    thread_root_event_id: str | None


class _AfterCommit:
    """The replies and reports routed rows owe, run once each row's
    transaction has committed.

    Off the writer's path, as the consumers it replaced ran them: whoever
    wrote a message does not wait for an offline notice to be composed and
    posted. One task per room at a time, taking that room's work in the order
    its rows were written, so a room's notices and command answers come out
    in the order of the rows that caused them.

    Each piece of work runs in a context of its own, bound to its room's
    tenant: a writer's request context (its log fields, anything it bound)
    is not the context of the replies its message causes.
    """

    def __init__(self) -> None:
        self._queues: dict[str, deque[tuple[str, Callable[[], Awaitable[None]]]]] = {}
        self._runners: dict[str, asyncio.Task[None]] = {}

    def add(
        self,
        tenant_id: str,
        room_id: str,
        work: list[tuple[AgentRecipient, Callable[[], Awaitable[None]]]],
    ) -> None:
        queue = self._queues.setdefault(room_id, deque())
        for recipient, run in work:
            queue.append((recipient.agent.name, run))
        if room_id not in self._runners:
            self._runners[room_id] = asyncio.get_running_loop().create_task(
                self._drain(tenant_id, room_id), context=contextvars.Context()
            )

    async def _drain(self, tenant_id: str, room_id: str) -> None:
        queue = self._queues[room_id]
        try:
            with tenant_scope(tenant_id), log_context(room_id=room_id):
                while queue:
                    agent_name, run = queue.popleft()
                    try:
                        await run()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        metrics().increment(ROUTING_FAILURES, {"stage": "after_commit"})
                        logger.error(
                            "A reply owed by agent %s in room %s could not be "
                            "posted; the message it answers was delivered",
                            agent_name,
                            room_id,
                            exc_info=True,
                        )
        finally:
            del self._queues[room_id]
            del self._runners[room_id]

    async def idle(self) -> None:
        """Wait until every room's work, including work added meanwhile, is
        done."""
        while self._runners:
            await asyncio.gather(*self._runners.values(), return_exceptions=True)


class MessageRouter:
    """Decides every room row as it is written. One per process."""

    def __init__(
        self,
        *,
        services: RecipientServices,
        message_store: MessageStore,
        client_store: ClientStore,
        budget_store: BudgetStore,
        conversation: ConversationRules,
    ) -> None:
        self.services = services
        self._messages = message_store
        self._conversation = conversation
        self._client_store = client_store
        self._budget_store = budget_store
        self._transports: Callable[[Actor[ClientConfig]], MessageTransport] | None = (
            None
        )
        # The identity each agent posts its replies under, one per agent,
        # kept so its transport's room lookups are made once.
        self._posters: dict[str, AgentActor] = {}
        # The "machine is waking" notices posted for each agent's rooms.
        self._cloud_waking: dict[str, set[tuple[str, int]]] = {}
        self._after = _AfterCommit()
        self._timers: set[asyncio.TimerHandle] = set()
        self._flushes: set[asyncio.Task[None]] = set()

    def use_transports(
        self, transport_for: Callable[[Actor[ClientConfig]], MessageTransport]
    ) -> None:
        """How an agent's replies are posted: through a transport like every
        other client's (`ClientFactory.transport_for`), so they are routed in
        turn. Given by the client factory, which is built with this router."""
        self._transports = transport_for

    # ── Writing a row ─────────────────────────────────────────────────────────

    @overload
    async def store(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        room_id: str,
        transport_room_id: str,
        message: Message,
        attachments: list[MessageAttachment],
        unless_stored: Literal[False] = False,
    ) -> Routed: ...

    @overload
    async def store(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        room_id: str,
        transport_room_id: str,
        message: Message,
        attachments: list[MessageAttachment],
        unless_stored: bool,
    ) -> Routed | None: ...

    async def store(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        room_id: str,
        transport_room_id: str,
        message: Message,
        attachments: list[MessageAttachment],
        unless_stored: bool = False,
    ) -> Routed | None:
        """Decide `message` for every agent in its room, write it, and store
        the own events decided for it, all in the caller's transaction.

        The caller commits, then calls `Routed.committed()`.

        With `unless_stored`, a message whose `transport_event_id` is already
        stored is neither written nor routed again, and None comes back: the
        id was derived from what caused the write (`transport/derived_ids.py`),
        and an earlier run of the same cause wrote it and owed what it owed.
        """
        reads = await RoomReads.load(
            session,
            services=self.services,
            client_store=self._client_store,
            budget_store=self._budget_store,
            tenant_id=tenant_id,
            room_id=room_id,
        )
        plan = _Plan()
        if reads is not None:
            unwritten = to_inbound(
                # A row is decided before it is written; see `_Unwritten`.
                cast("Message", _unwritten(message)),
                attachments,
                transport_room_id=transport_room_id,
            )
            plan = await self._decide(
                session, reads, unwritten, sender_client_id=message.sender_client_id
            )
        if not unless_stored:
            await self._messages.create(session, message, attachments)
        elif not await self._messages.create_unless_stored(
            session, message, attachments
        ):
            return None
        if reads is not None and await self._joined_since(session, reads):
            # An agent's arrival committed between the reads and the room's
            # lock, so it comes before this row in the room and the row is
            # for it as much as for the members read. Rare enough to decide
            # the row again, inside the lock, from the members as they are.
            reads = await RoomReads.load(
                session,
                services=self.services,
                client_store=self._client_store,
                budget_store=self._budget_store,
                tenant_id=tenant_id,
                room_id=room_id,
            )
            plan = _Plan()
            if reads is not None:
                plan = await self._decide(
                    session,
                    reads,
                    unwritten,
                    sender_client_id=message.sender_client_id,
                )
        row = to_inbound(message, attachments, transport_room_id=transport_room_id)
        deadline_in: float | None = None
        stored: list[str] = []
        if reads is not None:
            if plan.group is not None:
                deadline_in = await self._step_group(session, reads, plan, row)
            stored = await self._store_own_events(session, reads, plan.deliveries, row)
        return Routed(
            self,
            reads,
            plan,
            row,
            seq=message.seq,
            stored=stored,
            deadline_in=deadline_in,
        )

    @staticmethod
    async def _joined_since(session: AsyncSession, reads: RoomReads) -> bool:
        """Whether an agent became a member of the room after `reads` read
        its members. Read with the room's lock held, when every arrival
        numbered before the row being written has committed."""
        known = {member.client_id for member in reads.members}
        now = set(
            (
                await session.scalars(
                    select(ClientRoom.client_id)
                    .join(Agent, Agent.client_id == ClientRoom.client_id)
                    .where(ClientRoom.room_id == reads.room_id)
                )
            ).all()
        )
        return bool(now - known)

    async def membership_changed(self, change: tuple[str, str, str]) -> None:
        """Bring what this process holds in memory for an agent up to date
        with a membership written by any process: `change` is the tenant, the
        client and the room of a `membership.changed` signal.

        The membership's own consequences (the greeting, the arrival handed
        to the agents listening for joins, the agent's events in a room it
        left, the room taken off the agent's connections wherever they are)
        were taken care of once, by the process that wrote it. What is left
        is per process: the rooms this process keeps for an agent run by a
        controller, which say where the agent is present; and, should the
        writer have failed to release them, the claims of the connections
        this process holds. The writer did all of it as it wrote, so for it
        this finds nothing to do.
        """
        tenant_id, client_id, room_id = change
        async with tenant_session(self.services.session_factory, tenant_id) as session:
            found = (
                await session.execute(
                    select(
                        Agent.id,
                        select(ClientRoom.room_id)
                        .where(
                            ClientRoom.client_id == client_id,
                            ClientRoom.room_id == room_id,
                        )
                        .exists(),
                    ).where(Agent.client_id == client_id)
                )
            ).first()
        if found is None:
            return
        agent_id, member = found
        connections = self.services.connections
        controllers = connections.controllers
        if member:
            if room_id not in controllers.rooms(agent_id):
                controllers.room_joined(agent_id, room_id)
            return
        if room_id in controllers.rooms(agent_id):
            controllers.room_left(agent_id, room_id)
        if any(room_id in conn.rooms for conn in connections.held_here(agent_id)):
            await self._release_claims(tenant_id, agent_id, room_id)

    async def recheck_agent_rooms(self, tenant_id: str) -> None:
        """Compare what this process holds in memory for the tenant's agents
        with their memberships, and repair any difference: the periodic
        re-check behind `membership_changed`, for a signal that never came.

        A read and nothing more when nothing changed, and nothing at all when
        this process holds no claim and keeps no rooms for a managed agent.
        """
        connections = self.services.connections
        controllers = connections.controllers
        claimed = connections.claims_held_here()
        kept = controllers.rooms_kept()
        agents = set(claimed) | set(kept)
        if not agents:
            return
        async with tenant_session(self.services.session_factory, tenant_id) as session:
            rows = (
                await session.execute(
                    select(Agent.id, ClientRoom.room_id)
                    .outerjoin(ClientRoom, ClientRoom.client_id == Agent.client_id)
                    .where(Agent.id.in_(agents))
                )
            ).all()
        memberships: dict[str, set[str]] = {}
        for agent_id, room_id in rows:
            rooms = memberships.setdefault(agent_id, set())
            if room_id is not None:
                rooms.add(room_id)
        # Only the agents of this tenant come back; the rest are another
        # tenant's to check.
        for agent_id, rooms in memberships.items():
            for room_id in sorted(claimed.get(agent_id, set()) - rooms):
                await self._release_claims(tenant_id, agent_id, room_id)
            if agent_id in kept:
                for room_id in kept[agent_id] - rooms:
                    controllers.room_left(agent_id, room_id)
                for room_id in rooms - controllers.rooms(agent_id):
                    controllers.room_joined(agent_id, room_id)

    async def release_room(self, tenant_id: str, agent_id: str, room_id: str) -> None:
        """Take a room the agent is no longer in off a controller streaming
        the agent from here, and off its connections, whichever process holds
        them. The controller first: it is this process's memory and cannot
        fail, and the claims are a write that can."""
        self.services.connections.controllers.room_left(agent_id, room_id)
        await self._release_claims(tenant_id, agent_id, room_id)

    async def _release_claims(
        self, tenant_id: str, agent_id: str, room_id: str
    ) -> None:
        """Take the room off every connection of the agent's that claims it.

        A claim outlives the membership it was checked against
        (`require_room_member` runs when the room is claimed and never again).
        Claims are recorded for every process, so this is a recorded move
        (`AgentConnectionRegistry.recorded`): the agent's claims are read
        again from the rows, the room is taken off whichever connection holds
        it, here or in another process, and the change is written and
        signalled to the process holding that connection.
        """
        connections = self.services.connections
        with tenant_scope(tenant_id):
            async with (
                connections.slots(agent_id),
                connections.recorded(agent_id),
            ):
                connections.release_room_everywhere(agent_id, room_id)

    async def remove(
        self, session: AsyncSession, *, tenant_id: str, client_id: str, room_id: str
    ) -> Removed:
        """Forget an agent's own events in a room it is being taken out of,
        in the caller's transaction, the one that removes the membership.
        Nothing to do for a client that is not an agent.

        The caller commits, then calls `Removed.committed()`.
        """
        agent_id = await session.scalar(
            select(Agent.id).where(Agent.client_id == client_id)
        )
        if agent_id is not None:
            await self.services.event_buffer.forget_room(
                session, agent_id=agent_id, room_id=room_id
            )
        return Removed(self, tenant_id=tenant_id, agent_id=agent_id, room_id=room_id)

    # ── Deciding ──────────────────────────────────────────────────────────────

    async def _decide(
        self,
        session: AsyncSession,
        reads: RoomReads,
        event: InboundEvent,
        *,
        sender_client_id: str | None,
    ) -> _Plan:
        # Nobody's own event is the row they wrote themselves.
        recipients = [
            self._recipient(reads, member)
            for member in reads.members
            if member.client_id != sender_client_id
        ]
        if isinstance(event, InboundMembership):
            return await self._decide_arrival(
                session, reads, recipients, event, sender_client_id
            )
        if isinstance(event, InboundMedia):
            return await self._decide_file(session, reads, recipients, event)
        if isinstance(event, InboundCustomEvent):
            return await self._decide_custom(recipients, event)
        assert isinstance(event, InboundMessage)
        return await self._decide_message(session, reads, recipients, event)

    async def _decide_message(
        self,
        session: AsyncSession,
        reads: RoomReads,
        recipients: list[AgentRecipient],
        event: InboundMessage,
    ) -> _Plan:
        deliveries = [
            (
                recipient,
                await _decided(
                    recipient, event, lambda: recipient.decide_message(session, event)
                ),
            )
            for recipient in recipients
        ]
        if not any(delivery.named for _, delivery in deliveries):
            # No rule named any agent in the room (no name, alias, held role
            # or direct room), so the message is the room's conversation:
            # every agent that reads the room reads it from `messages`. This
            # is the one place a message is found to address no agent by any
            # explicit rule, and so where following the conversation may
            # still hand it to one.
            return await self._follow_the_conversation(
                session, reads, recipients, event
            )
        return _Plan(deliveries=deliveries)

    async def _follow_the_conversation(
        self,
        session: AsyncSession,
        reads: RoomReads,
        recipients: list[AgentRecipient],
        event: InboundMessage,
    ) -> _Plan:
        """The agents a message that names nobody reaches anyway, by the rules
        in `delivery/conversation.py`. Most chatter is settled by `may_follow`
        without a read; past it, what the rules read is read once for the
        room and shared by every agent's decision."""
        rules = self._conversation
        meta = reads.meta
        message = ConversationMessage(
            event_id=event.event_id,
            sender=event.sender,
            body=event.body or "",
            content=event.content,
            thread_root_id=event.thread_root_id,
            # Not stamped until written (`_Unwritten`); the database stamps it
            # with its own clock a moment from now.
            sent_at=datetime.now(UTC),
        )
        if not recipients or not may_follow(
            rules.settings, channel_type=meta.channel_type, message=message
        ):
            return _Plan()
        conversation = rules.for_message(
            addressing=reads.addressing,
            room_id=reads.room_id,
            channel_type=meta.channel_type,
            follow_ups_enabled=meta.follow_ups_enabled,
            main_agent_id=meta.main_agent_id,
            message=message,
        )
        deliveries: list[tuple[AgentRecipient, Delivery]] = []
        for recipient in recipients:
            decision = await conversation.decide(
                session,
                agent=recipient.agent,
                agent_user_id=recipient.transport_user_id,
            )
            delivery = await recipient.decide_follow_up(session, event, decision)
            if delivery.own_event is not None:
                deliveries.append((recipient, delivery))
        return _Plan(deliveries=deliveries)

    async def _decide_file(
        self,
        session: AsyncSession,
        reads: RoomReads,
        recipients: list[AgentRecipient],
        event: InboundMedia,
    ) -> _Plan:
        group = parse_attachment_group(event.content)
        if group is None:
            files = [event]
            key = event.event_id
            step = None
        else:
            group_id, _, total = group
            pending = await session.get(
                PendingAttachmentGroup,
                {"room_id": reads.room_id, "group_id": group_id},
            )
            earlier = (
                []
                if pending is None
                else (await self._files_of(session, reads, group_id, pending.from_seq))[
                    0
                ]
            )
            files = [*earlier, event]
            complete = len({file_index(part) for part in files}) >= total
            step = _GroupStep(
                group_id=group_id,
                total=total,
                pending_from=pending.from_seq if pending is not None else None,
                complete=complete,
            )
            if not complete:
                return _Plan(group=step)
            key = group_id
        return _Plan(
            deliveries=await self._decide_post(
                session, recipients, files, lead=event, complete=True, key=key
            ),
            group=step,
        )

    @staticmethod
    async def _decide_post(
        session: AsyncSession,
        recipients: list[AgentRecipient],
        files: list[InboundMedia],
        *,
        lead: InboundMedia,
        complete: bool,
        key: str,
    ) -> list[tuple[AgentRecipient, Delivery]]:
        deliveries = []
        for recipient in recipients:

            async def decide(recipient: AgentRecipient = recipient) -> Delivery:
                named = False
                for part in files:
                    if await recipient.addressed_by(session, part):
                        named = True
                        break
                return await recipient.decide_post(
                    session,
                    files,
                    named=named,
                    lead=lead,
                    complete=complete,
                    message_key=key,
                )

            deliveries.append((recipient, await _decided(recipient, lead, decide)))
        return deliveries

    async def _decide_arrival(
        self,
        session: AsyncSession,
        reads: RoomReads,
        recipients: list[AgentRecipient],
        event: InboundMembership,
        sender_client_id: str | None,
    ) -> _Plan:
        plan = _Plan(
            deliveries=[
                (
                    recipient,
                    await _decided(
                        recipient,
                        event,
                        lambda: recipient.decide_arrival(session, event),
                    ),
                )
                for recipient in recipients
            ]
        )
        joining = reads.member(sender_client_id)
        if (
            joining is not None
            and event.membership == "join"
            and event.prev_membership != "join"
        ):
            plan.arrival = self._recipient(reads, joining)
        return plan

    async def _decide_custom(
        self, recipients: list[AgentRecipient], event: InboundCustomEvent
    ) -> _Plan:
        if event.event_type == _COMMAND_EVENT:
            try:
                command = command_event(event)
            except Exception:
                logger.exception(
                    "Failed to parse %s event in %s", event.event_type, event.room_id
                )
                return _Plan()
            # A command that is queued for the agent is decided here, so it
            # is numbered for the agent before anything written after it;
            # the rest are decided by their handlers once they have committed.
            return _Plan(
                deliveries=[
                    (
                        recipient,
                        await _decided(
                            recipient,
                            event,
                            lambda: recipient.decide_command(command),
                        ),
                    )
                    for recipient in recipients
                ]
            )
        kind = _TASK_EVENTS.get(event.event_type)
        if kind is None:
            return _Plan()
        try:
            typed = kind(**event.content)
        except Exception:
            logger.exception(
                "Failed to parse %s event in %s", event.event_type, event.room_id
            )
            return _Plan()
        return _Plan(
            deliveries=[
                (recipient, await _decided(recipient, event, _task(recipient, typed)))
                for recipient in recipients
            ]
        )

    def _recipient(self, reads: RoomReads, member: RoomMember) -> AgentRecipient:
        return AgentRecipient(
            services=self.services,
            member=member,
            tenant_id=reads.tenant_id,
            meta=reads.meta,
            transport_room_id=reads.transport_room_id,
            actor=self._poster(reads.tenant_id, member),
            addressing=reads.addressing,
            budget_guard=reads.budget_guard,
            clients=reads,
            cloud_waking_notices=self._cloud_waking.setdefault(member.agent.id, set()),
        )

    def _poster(self, tenant_id: str, member: RoomMember) -> AgentActor:
        """The identity the agent's replies are posted under. Connected only
        when a reply is posted (`_AfterCommit`), so deciding a row needs no
        transport at all."""
        actor = self._posters.get(member.client_id)
        if actor is None:
            actor = AgentActor(
                client_id=member.client_id,
                tenant_id=tenant_id,
                transport_user_id=member.transport_user_id,
                display_name=member.display_name,
                session_factory=self.services.session_factory,
                client_store=self._client_store,
                config=ClientConfig(),
                transport_factory=self._transport_for,
            )
            self._posters[member.client_id] = actor
        actor.set_agent(member.agent)
        actor.display_name = member.display_name
        return actor

    def _transport_for(self, actor: Actor[ClientConfig]) -> MessageTransport:
        if self._transports is None:
            raise RuntimeError(
                "The router has no transports to post agents' replies "
                "through; the client factory built with it gives them"
            )
        return self._transports(actor)

    # ── Writing the decisions ─────────────────────────────────────────────────

    async def _store_own_events(
        self,
        session: AsyncSession,
        reads: RoomReads,
        deliveries: list[tuple[AgentRecipient, Delivery]],
        row: InboundEvent,
    ) -> list[str]:
        """Store every own event decided for `row`, in the order of the
        agents' ids, and return the agents whose events were stored."""
        stored: list[str] = []
        for recipient, delivery in sorted(
            deliveries, key=lambda decided: decided[0].agent.id
        ):
            if delivery.own_event is None:
                continue
            agent_id = recipient.agent.id
            try:
                own = delivery.own_event(row)
                seq = await self.services.event_buffer.store(
                    session,
                    tenant_id=reads.tenant_id,
                    agent_id=agent_id,
                    client_id=recipient.client_id,
                    room_id=reads.room_id,
                    event=own.event,
                    room_seq=own.room_seq,
                    message_key=own.message_key,
                )
            except Exception:
                metrics().increment(ROUTING_FAILURES, {"stage": "store"})
                logger.error(
                    "Could not store agent %s's own event for row %s in room %s; "
                    "the row is written and the agent misses it",
                    recipient.agent.name,
                    row.event_id,
                    reads.room_id,
                    exc_info=True,
                )
                continue
            if seq is not None:
                stored.append(agent_id)
        return stored

    async def _step_group(
        self, session: AsyncSession, reads: RoomReads, plan: _Plan, row: InboundEvent
    ) -> float | None:
        """Bring the post `row` is a file of up to date in
        `pending_attachment_groups`, inside the room's lock.

        A file that completes its post deletes the pending row, and the post
        is decided with it. If the row is gone already, the sweep decided the
        post while this file was being written, and this file starts a new
        post of its own instead: what has gone out does not go out again. A
        file that does not complete its post leaves the pending row as it is,
        or starts one. Returns how long a pending row this started has until
        its deadline, so the writer can set its timer.
        """
        step = plan.group
        assert step is not None
        pending = and_(
            PendingAttachmentGroup.room_id == reads.room_id,
            PendingAttachmentGroup.group_id == step.group_id,
            PendingAttachmentGroup.from_seq == step.pending_from,
        )
        if step.complete:
            if step.pending_from is None:
                return None
            decided = await session.scalar(
                delete(PendingAttachmentGroup)
                .where(pending)
                .returning(PendingAttachmentGroup.group_id)
            )
            if decided is not None:
                return None
            plan.deliveries = []
            return await self._hold_group(session, reads, step, row.seq)
        if step.pending_from is not None:
            # Locks the pending row, so a sweep deciding it now is waited for
            # and its outcome seen.
            held = await session.scalar(
                update(PendingAttachmentGroup)
                .where(pending)
                .values(total=PendingAttachmentGroup.total)
                .returning(PendingAttachmentGroup.group_id)
            )
            if held is not None:
                return None
        return await self._hold_group(session, reads, step, row.seq)

    async def _hold_group(
        self, session: AsyncSession, reads: RoomReads, step: _GroupStep, from_seq: int
    ) -> float | None:
        """Record a post that has files to come, counted from `from_seq`, and
        return the seconds until its deadline; None when another writer
        recorded it first."""
        seconds = await session.scalar(
            insert(PendingAttachmentGroup)
            .values(
                tenant_id=reads.tenant_id,
                room_id=reads.room_id,
                group_id=step.group_id,
                total=step.total,
                from_seq=from_seq,
                deadline=func.now()
                + timedelta(seconds=ATTACHMENT_GROUP_TIMEOUT_SECONDS),
            )
            .on_conflict_do_nothing(
                index_elements=[
                    PendingAttachmentGroup.room_id,
                    PendingAttachmentGroup.group_id,
                ]
            )
            .returning(
                func.extract("epoch", PendingAttachmentGroup.deadline - func.now())
            )
        )
        return None if seconds is None else float(seconds)

    async def _files_of(
        self, session: AsyncSession, reads: RoomReads, group_id: str, from_seq: int
    ) -> tuple[list[InboundMedia], str | None]:
        """The files of a post written since `from_seq`, in the order they
        were written, and the client that wrote them."""
        rows = list(
            (
                await session.scalars(
                    select(Message)
                    .where(
                        Message.room_id == reads.room_id,
                        Message.seq >= from_seq,
                        Message.content[ATTACHMENT_GROUP_KEY]["id"].astext == group_id,
                    )
                    .order_by(Message.seq)
                )
            ).all()
        )
        attachments = await self._messages.attachments_for(
            session, [row.id for row in rows]
        )
        files: list[InboundMedia] = []
        for row in rows:
            inbound = to_inbound(
                row,
                attachments.get(row.id, []),
                transport_room_id=reads.transport_room_id,
            )
            if isinstance(inbound, InboundMedia):
                files.append(inbound)
        return files, rows[0].sender_client_id if rows else None

    # ── Posts given up on ─────────────────────────────────────────────────────

    def flush_groups_after(self, tenant_id: str, delay: float) -> None:
        """Decide the tenant's posts whose wait is over, `delay` seconds from
        now: the deadline of a post the caller just started."""
        loop = asyncio.get_running_loop()

        def due() -> None:
            self._timers.discard(timer)
            task = loop.create_task(
                self._flush_logged(tenant_id), context=contextvars.Context()
            )
            self._flushes.add(task)
            task.add_done_callback(self._flushes.discard)

        timer = loop.call_later(max(delay, 0.0), due)
        self._timers.add(timer)

    async def _flush_logged(self, tenant_id: str) -> None:
        try:
            await self.flush_due_groups(tenant_id)
        except Exception:
            metrics().increment(ROUTING_FAILURES, {"stage": "sweep"})
            logger.error(
                "Could not decide the multi-file posts of tenant %s whose wait "
                "is over; the next sweep tries again",
                tenant_id,
                exc_info=True,
            )

    async def flush_due_groups(self, tenant_id: str) -> int:
        """Decide every post of `tenant_id` whose wait is over with the files
        that did arrive, and return how many were decided.

        Every process runs this. Each post is claimed with `FOR UPDATE SKIP
        LOCKED` and decided in the transaction that deletes its pending row,
        so it is decided once however many processes look at the same moment,
        and the deadline is read on the database's clock, the one that set it.
        """
        decided = 0
        while (outcome := await self._flush_one(tenant_id)) is not None:
            decided += outcome
        return decided

    async def _flush_one(self, tenant_id: str) -> bool | None:
        """Decide one post whose wait is over: True when it was decided,
        False when it was put off, None when none is due.

        A post that cannot be decided is put off for another wait and logged,
        so the posts due after it, and the tenants swept after this one, are
        not held up behind it, and it is tried again once that wait is over.
        """
        async with tenant_session(self.services.session_factory, tenant_id) as session:
            due = await session.scalar(
                select(PendingAttachmentGroup)
                .where(PendingAttachmentGroup.deadline <= func.now())
                .order_by(PendingAttachmentGroup.deadline)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if due is None:
                return None
            room_id, group_id = due.room_id, due.group_id
            try:
                routed = await self._decide_due(session, tenant_id, due)
            except Exception:
                await session.rollback()
                metrics().increment(ROUTING_FAILURES, {"stage": "sweep"})
                logger.error(
                    "Could not decide multi-file post %s in room %s whose wait "
                    "is over; trying again in %ss",
                    group_id,
                    room_id,
                    ATTACHMENT_GROUP_TIMEOUT_SECONDS,
                    exc_info=True,
                )
                await session.execute(
                    update(PendingAttachmentGroup)
                    .where(
                        PendingAttachmentGroup.room_id == room_id,
                        PendingAttachmentGroup.group_id == group_id,
                    )
                    .values(
                        deadline=func.now()
                        + timedelta(seconds=ATTACHMENT_GROUP_TIMEOUT_SECONDS)
                    )
                )
                await session.commit()
                return False
        if routed is not None:
            routed.committed()
        return True

    async def _decide_due(
        self, session: AsyncSession, tenant_id: str, due: PendingAttachmentGroup
    ) -> Routed | None:
        """Decide the post `due` with the files that did arrive, delete its
        pending row and commit; None when there was nothing left to decide."""
        room_id, group_id = due.room_id, due.group_id
        total, from_seq = due.total, due.from_seq
        await session.delete(due)
        reads = await RoomReads.load(
            session,
            services=self.services,
            client_store=self._client_store,
            budget_store=self._budget_store,
            tenant_id=tenant_id,
            room_id=room_id,
        )
        files: list[InboundMedia] = []
        sender: str | None = None
        if reads is not None:
            files, sender = await self._files_of(session, reads, group_id, from_seq)
        if reads is None or not files:
            await session.commit()
            return None
        lead = files[0]
        present = len({file_index(part) for part in files})
        complete = present >= total
        if not complete:
            logger.error(
                "Attachment group %s incomplete: %d of %d parts arrived within "
                "%ss; delivering what arrived",
                group_id,
                present,
                total,
                ATTACHMENT_GROUP_TIMEOUT_SECONDS,
            )
        # Members from before the post began, as a member who joined after
        # its first file would not have been handed that file.
        began = lead.timestamp
        recipients = [
            self._recipient(reads, member)
            for member in reads.members
            if member.client_id != sender
            and int(member.joined_at.timestamp() * 1000) <= began
        ]
        plan = _Plan(
            deliveries=await self._decide_post(
                session,
                recipients,
                files,
                lead=lead,
                complete=complete,
                key=group_id,
            )
        )
        stored = await self._store_own_events(session, reads, plan.deliveries, lead)
        await session.commit()
        return Routed(
            self, reads, plan, lead, seq=lead.seq, stored=stored, deadline_in=None
        )

    # ── After the commit ──────────────────────────────────────────────────────

    def after_commit(
        self,
        tenant_id: str,
        room_id: str,
        work: list[tuple[AgentRecipient, Callable[[], Awaitable[None]]]],
    ) -> None:
        self._after.add(tenant_id, room_id, work)

    async def idle(self) -> None:
        """Wait for the replies already owed, and posts already being decided,
        to be done."""
        while True:
            await self._after.idle()
            if not self._flushes:
                return
            await asyncio.gather(*list(self._flushes), return_exceptions=True)

    def close(self) -> None:
        """Stop the timers set for posts' deadlines. The sweep in every
        process decides those posts."""
        for timer in self._timers:
            timer.cancel()
        self._timers.clear()


async def _decided(
    recipient: AgentRecipient,
    event: InboundEvent,
    decide: Callable[[], Awaitable[Delivery]],
) -> Delivery:
    """What `decide` decides for one agent, or nothing for it when deciding
    raises: a rule that cannot be applied to one agent must not fail the
    write of a row every other member is owed, nor block every later row
    that names that agent. A database error is raised all the same: the
    transaction it broke cannot write the row, and the writer tries again.
    """
    try:
        return await decide()
    except DBAPIError:
        raise
    except Exception:
        metrics().increment(ROUTING_FAILURES, {"stage": "decide"})
        logger.error(
            "Could not decide row %s in room %s for agent %s; the row is "
            "written and the agent misses it",
            event.event_id,
            event.room_id,
            recipient.agent.name,
            exc_info=True,
        )
        return NOTHING


def _task(
    recipient: AgentRecipient, event: SwitchEvent
) -> Callable[[], Awaitable[Delivery]]:
    async def decide() -> Delivery:
        return recipient.decide_task(event)

    return decide


def _unwritten(message: Message) -> _Unwritten:
    return _Unwritten(
        content=dict(message.content),
        transport_event_id=message.transport_event_id,
        sender_id=message.sender_id,
        sent_at=_NOT_STAMPED,
        event_type=message.event_type,
        seq=0,
        body=message.body,
        sender_name=message.sender_name,
        formatted_body=message.formatted_body,
        msgtype=message.msgtype,
        thread_root_event_id=message.thread_root_event_id,
    )


# The time on a row not written yet, which nothing deciding it reads.
_NOT_STAMPED = datetime.fromtimestamp(0, UTC)
