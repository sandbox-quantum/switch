"""One agent in a room, as the router decides a room row for it.

The router (`delivery/router.py`) builds an `AgentRecipient` for every agent
member of a room each time a row is written to that room, and asks it two
things. While the row's transaction is open: is this row one of the agent's
own events, and what event does the agent receive for it (`decide_*`)? Once
the transaction has committed: what does the agent have left to say in the
room, that it cannot say itself (`Delivery.after`, `greet`,
`handle_command`)? That second part is the replies Switch posts on the
agent's behalf: a refusal when the sender may not address it, a notice when
it is offline, a greeting when it arrives, a command's answer.

The rules are the ones the agent's consumer used to apply when each room row
was delivered to it, moved here unchanged. What changed is when they run and
how often: once per row, on the process that wrote it, rather than once per
row on every process that ran a consumer for the agent.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, NamedTuple, Protocol

from sqlalchemy import select

from switch_core.attachments import parse_attachment_group
from switch_core.bridges.agent.commands import (
    AGENT_GREETINGS,
    COMMANDS_BY_NAME,
    _addressed_by_name_or_role,
    dispatch_command,
)
from switch_core.bridges.agent.protocol.message_events import (
    attachment_ref,
    message_event,
    room_join_event,
)
from switch_core.bridges.agent.protocol.presence import (
    agents_present_in,
    rooms_occupied,
)
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    TaskAcceptPayload,
    TaskCancelPayload,
    TaskDelegatePayload,
    TaskFinalisePayload,
    TaskUpdatePayload,
)
from switch_core.budgets import BudgetExceeded, BudgetGuard
from switch_core.clients.admin_messages import (
    AUTO_REPLY_FLAG,
    PLATFORM_MARKER,
    platform_on_behalf_of,
    platform_replies_in_channel,
)
from switch_core.clients.mentions import (
    NAME_CHAR as _NAME_CHAR,
)
from switch_core.clients.mentions import (
    mention_regex as _mention_regex,
)
from switch_core.clients.mentions import (
    strip_emphasis as _strip_emphasis,
)
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import Agent, CloudMachine, TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import owner_stopped
from switch_core.delivery.addressing import (
    ADDRESSING_DENIED_MESSAGE,
    ADDRESSING_UNCLAIMED_MESSAGE,
    AddressingDecision,
    AddressingResolver,
    IncomingMessage,
)
from switch_core.events import (
    CommandEvent,
    SwitchEvent,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
)
from switch_core.gateway.cloud_controllers import wake_controller_machine
from switch_core.gateway.known_agents import known_agent_for
from switch_core.observability.catalogue import OBSERVER_FAILURES
from switch_core.observability.metrics import metrics
from switch_core.observability.throttle import WarningThrottle
from switch_core.transport import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    RoomRef,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.agent_connections import (
        AgentConnectionRegistry,
    )
    from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
    from switch_core.clients.actor import AgentActor
    from switch_core.db.models import Client
    from switch_core.db.stores.agent_session_store import AgentSessionStore
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.document_store import DocumentStore
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.reference_store import ReferenceStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.delivery.conversation import ConversationDecision
    from switch_core.telemetry.messages import MessageTelemetry

logger = logging.getLogger(__name__)

# One for the process rather than one per recipient: a recipient lives for one
# row, and a telemetry bug breaks the report for every agent.
_report_failures = WarningThrottle(60.0)


@dataclass(frozen=True)
class RoomMember:
    """An agent member of a room, as the router read it for one row.

    `alias` is the name the agent goes under in this room, if it has one, and
    `listening` whether it is set to receive `room_join` events here. Both come
    from the agent's `room_agents` row, read with the membership itself.
    `joined_at` is when the membership was written, on the database's clock.
    """

    agent: Agent
    client_id: str
    transport_user_id: str
    display_name: str
    alias: str | None
    listening: bool
    joined_at: datetime


class OwnEvent(NamedTuple):
    """One of an agent's own events, and the room row it comes from: its
    place in the room (`room_seq`) and the key the row is known by
    (`message_key`, the attachment group's id for a multi-file post)."""

    event: AgentEvent
    room_seq: int
    message_key: str | None


@dataclass(frozen=True)
class Delivery:
    """What was decided about one room row for one agent.

    `own_event` builds the agent's own event from the row once the row is
    written and has its place in the room, and is None when the row is not
    one of the agent's own events. `after` is what is left to do once the
    row has committed (a refusal or an offline notice to post, a report to
    make), and is None when there is nothing. Both take the row as written.

    `named` says whether a rule named the agent (its name, its alias here, a
    role it holds, a direct room), before its addressing policy and budget
    were applied: the router asks whether a message named anybody at all.
    """

    own_event: Callable[[InboundEvent], OwnEvent] | None
    after: Callable[[InboundEvent], Awaitable[None]] | None
    named: bool = False


NOTHING = Delivery(own_event=None, after=None)


@dataclass(frozen=True)
class RecipientServices:
    """What every recipient reads and writes through. One per process."""

    session_factory: async_sessionmaker[AsyncSession]
    event_buffer: EventBuffer
    agent_store: AgentStore
    room_store: RoomStore
    document_store: DocumentStore
    reference_store: ReferenceStore
    agent_session_store: AgentSessionStore
    room_role_store: RoomRoleStore
    external_user_store: ExternalUserStore
    connections: AgentConnectionRegistry
    frontend_base_url: str | None
    message_telemetry: MessageTelemetry


class ClientNames(Protocol):
    """Who a member of a room is, by the id they post under: the one read an
    arrival's own event needs, which the router makes once for every agent in
    the room."""

    async def get_by_transport_user_id(
        self, session: AsyncSession, transport_user_id: str
    ) -> Client | None: ...


_UNAVAILABLE_MESSAGES = {
    "always_on": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
    "session_addressable": (
        "I'm not in an active session right now. "
        "I'll see this when I next connect to the room."
    ),
    # auto_session with no watcher reporting in: same honest "offline" story as
    # always_on — nothing is going to spin a session up right now.
    "auto_session": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
}


# Posted on the agent's behalf when an auto_session agent is addressed in a
# room where it has no live session but its connector is actively watching:
# the connector will spin a session up on demand to handle the message.
_STARTING_SESSION_MESSAGE = "Starting a session to handle this — one moment."

# Fallback, for an agent with no known-agent spec, when it has a session bound
# to this room that is not reporting as live.
_CONNECTED_NOT_LIVE_MESSAGE = (
    "I have a session connected to this room, but it isn't reporting as live, "
    "so I'm not receiving messages — my owner may need to restart it."
)


def _offline_owner_message(owner_handle: str | None, asker_handle: str) -> str:
    """The reply for an auto_session agent addressed with nothing to start it.

    An auto_session agent is brought online by Switch Console watching on its
    owner's machine, so reaching this means the app is not running or not
    connected — the fix is for the OWNER to open it, and nobody else in the
    room can act. So the owner leads and is asked directly; the asker is named
    as the reason, not as a second person being told to do something.

    Deliberately says "online" rather than anything about sessions: which
    process is or is not attached to which room is Switch's business, not
    something to hand a reader in a chat channel.
    """
    # The owner addressing their own agent is the common case; naming them as
    # the reason they should act reads as a stutter ("@me … and @me needs me").
    needs_me = "" if owner_handle == asker_handle else f", and @{asker_handle} needs me"
    if owner_handle:
        return (
            f"@{owner_handle} — I'm not online in this room{needs_me}. "
            "Open Switch Console to bring me online here."
        )
    # No owner account on this platform to mention. Still name who has to act,
    # so the message is not read as something the room can fix.
    return (
        f"I'm not online in this room{needs_me}. **My owner needs to open "
        "Switch Console** to bring me online here."
    )


def _join_room_names(names: list[str]) -> str:
    bold = [f"**{name}**" for name in names]
    if len(bold) == 1:
        return bold[0]
    return f"{', '.join(bold[:-1])} and {bold[-1]}"


def _owner_actor(owner_handle: str | None, asker_handle: str) -> str:
    """Who to name as the person who has to act: the owner's @-mention, so the
    owner is notified; "you" when the owner is the one asking; "my owner" when
    the owner has no account on this platform to mention."""
    if owner_handle is None:
        return "my owner"
    if owner_handle == asker_handle:
        return "you"
    return f"@{owner_handle}"


def _passive_message(owner_handle: str | None, asker_handle: str) -> str:
    """The reply for a session_passive agent addressed in a room.

    Such an agent never receives room messages in real time, so it is not
    told it has no session; the owner has to trigger it to read the room, and
    is mentioned so they are notified.
    """
    actor = _owner_actor(owner_handle, asker_handle)
    verb = "have" if actor == "you" else "has"
    return (
        f"I read room messages asynchronously, not in real time — {actor} {verb} "
        "to trigger me to pull the latest messages, either from a session I "
        "already have open or by starting a new one."
    )


def _start_from_console_message(
    agent_name: str,
    owner_handle: str | None,
    asker_handle: str,
    other_room_names: list[str] | None,
    connected_not_live: bool,
) -> str:
    """The reply for an agent Switch Console runs, addressed where it has no
    live session, when the plain "I'm not online" reply does not fit: it has
    sessions in other rooms, or a session here that is not live.

    The fix is always to start or restart it from Switch Console, so that is
    what the reply says. A CLI started by hand in a terminal gets none of the
    Switch tools, which is why no terminal command is offered. The owner is
    named where the action is, and called "you" when they are the one asking.
    """
    actor = _owner_actor(owner_handle, asker_handle)
    sentence_actor = actor if actor.startswith("@") else actor.capitalize()
    console = f"opening **{agent_name}** in Switch Console"
    if connected_not_live:
        return (
            "I have a session connected to this room, but it isn't reporting as "
            "live, so I'm not receiving messages. "
            f"{sentence_actor} can restart it by {console}."
        )
    if other_room_names:
        return (
            "I don't have a session in this room right now, but I'm working in "
            f"{_join_room_names(other_room_names)}, so you can ask me there. "
            f"Or {actor} can start one here by {console}."
        )
    return (
        "I don't have a session connected to this room. "
        f"{sentence_actor} can start one by {console}."
    )


def _stopped_owner_message(owner_handle: str | None, asker_handle: str) -> str:
    """The reply for a managed agent its owner has set to stopped.

    Nothing will start a session for it until the owner sets it running
    again, and only the owner can, so it is the owner who is asked.
    """
    needs_me = "" if owner_handle == asker_handle else f", and @{asker_handle} needs me"
    if owner_handle:
        return (
            f"@{owner_handle} — you've stopped me, so I'm not running{needs_me}. "
            "Set me to running in Switch to bring me back."
        )
    return (
        f"I'm stopped, so I'm not running{needs_me}. **My owner has to set me "
        "to running** in Switch to bring me back."
    )


def _owner_ref(owner_handle: str | None) -> str:
    return f"my owner (@{owner_handle})" if owner_handle else "my owner"


def _machine_offline_message(machine: str, owner_handle: str | None) -> str:
    """A managed agent whose controller's stream is down: Core restarted, the
    machine lost its network, or it is switched off."""
    return (
        f"My machine, **{machine}**, is offline or reconnecting to Switch, so "
        "I can't answer right now. If I haven't answered once it's back, address "
        f"me again. If it stays offline, {_owner_ref(owner_handle)} needs to "
        "check it."
    )


@dataclass(frozen=True)
class CloudMachineState:
    """How a Switch cloud machine stood once a message for its agents tried to wake it."""

    state: str
    revision: int
    owner_stopped: bool

    @classmethod
    def of(cls, machine: CloudMachine) -> CloudMachineState:
        return cls(
            state=machine.state,
            revision=machine.revision,
            owner_stopped=owner_stopped(machine),
        )


def _cloud_machine_waking_message(machine: str) -> str:
    """A managed agent whose Switch cloud machine was asleep, and is starting
    for this message: Switch keeps the message until the machine is back."""
    return (
        f"My machine, **{machine}**, was asleep and is starting now. I'll pick "
        "this up as soon as it's back, usually within a few minutes."
    )


def _cloud_machine_stopped_message(machine: str, owner_handle: str | None) -> str:
    """A managed agent whose Switch cloud machine its owner stopped: a message
    does not start it again."""
    return (
        f"My machine, **{machine}**, is stopped, so I can't answer. "
        f"{_owner_ref(owner_handle).capitalize()} can start it again in Switch Console."
    )


def _machine_removed_message(machine: str, owner_handle: str | None) -> str:
    removed = (
        f"my machine, **{machine}**, has been removed from Switch, so nothing "
        "runs me. My owner has to move me to another machine to bring me back."
    )
    if owner_handle:
        return f"@{owner_handle} — {removed}"
    return removed[0].upper() + removed[1:]


# The refusal wording lives with the decision that produces it. Kept under
# these names because they are how the rest of the package and its tests refer
# to them.
_ADDRESSING_DENIED_MESSAGE = ADDRESSING_DENIED_MESSAGE
_ADDRESSING_UNCLAIMED_MESSAGE = ADDRESSING_UNCLAIMED_MESSAGE


class _GateOutcome(NamedTuple):
    """Whether a message that tags this agent really addresses it, plus the
    refusal to post when it does not. The refusal is returned rather than sent
    so the caller can close its database session before posting."""

    addressed: bool
    refusal: str | None


# Shown to an agent addressed here while it holds a role in THIS room but the
# session that assumed the role has hopped away to other room(s) (the lease
# still routes here). `room_names` lists where that session is now active.
def _elsewhere_message(room_names: list[str], holds_role_here: bool) -> str:
    where = ", ".join(f"**{name}**" for name in room_names)
    return (
        f"I hold a role in this room, but the session that assumed it is "
        f"active in {where} right now — I'll pick this up when it "
        f"reconnects here."
    )


# Single-room shorthand used by tests and callers that only have one room to
# name.
def _role_elsewhere_message(other_room_name: str) -> str:
    return _elsewhere_message([other_room_name], holds_role_here=True)


class AgentRecipient:
    """One agent member of a room, deciding one room row.

    Built by the router for a single row and dropped with it. `decide_*` run
    inside the transaction that writes the row, read through the session they
    are handed, and post nothing: what they decide is returned as a
    `Delivery`. Everything that posts runs after the commit, through `actor`,
    the agent's own identity.

    The reads that every agent in the room would otherwise repeat (the agent
    rows, aliases, role leases, the sender, budgets) go through `addressing`,
    `budget_guard` and `clients`, which the router answers from reads it made
    once for the whole room.
    """

    def __init__(
        self,
        *,
        services: RecipientServices,
        member: RoomMember,
        tenant_id: str,
        meta: RoomMeta,
        transport_room_id: str,
        actor: AgentActor,
        addressing: AddressingResolver,
        budget_guard: BudgetGuard,
        clients: ClientNames,
        cloud_waking_notices: set[tuple[str, int]],
    ) -> None:
        self.actor = actor
        self.tenant_id = tenant_id
        self.client_id = member.client_id
        self.transport_user_id = member.transport_user_id
        self.session_factory = services.session_factory
        self._member = member
        self._meta = meta
        self._room = RoomRef(room_id=transport_room_id)
        self._event_buffer = services.event_buffer
        self._agent_store = services.agent_store
        self._room_store = services.room_store
        self._document_store = services.document_store
        self._reference_store = services.reference_store
        self._agent_session_store = services.agent_session_store
        self._room_role_store = services.room_role_store
        self._external_user_store = services.external_user_store
        self._connections = services.connections
        self._message_telemetry = services.message_telemetry
        self._frontend_base_url = (
            services.frontend_base_url.rstrip("/")
            if services.frontend_base_url
            else None
        )
        self._addressing = addressing
        self._budget_guard = budget_guard
        self._clients = clients
        # The "machine is waking" notices this process has posted for the
        # agent, by room and machine start, so the messages that follow the
        # first one wait with it instead of each saying so again.
        self._cloud_waking_notices = cloud_waking_notices

    @property
    def agent(self) -> Agent:
        """The agent's row, read for this row's routing."""
        return self._member.agent

    async def _fresh_agent(self, session: AsyncSession) -> Agent:
        """The agent's row as it stands now.

        An operator can edit the agent (its `integration_profile`, its
        addressing policy) through the gateway at any time, so every branch on
        it reads the row rather than a copy kept from earlier. The router read
        it for this row, in the transaction writing the row, which is as fresh
        as it gets, so nothing is read again here.
        """
        return self.agent

    async def still_member(self) -> bool:
        """Whether the agent is a member of the room now, read when the work
        a row left it (`Delivery.after`, `greet`) is about to run.

        The row was decided from the members read before it was written, and
        a removal takes no lock of the room's, so the agent can be taken out
        of the room after that read: before the row commits, or after it and
        before this work's turn comes. Either way it keeps no own event for
        the row (`EventBuffer.store` reads the membership again, and the
        removal deletes what was stored). This asks the same question of the
        work, so an agent that has left says nothing in the room as itself (a
        refusal, an offline notice, a greeting, a command's answer), relays
        nothing to its controller and wakes no machine.

        In a session of its own, closed before the work posts anything.
        """
        room_id = self._meta.room_id
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            members = await self._room_store.member_room_ids(
                session, self.client_id, [room_id]
            )
        return room_id in members

    # ── Messages ──────────────────────────────────────────────────────────────

    async def decide_message(
        self, session: AsyncSession, event: InboundMessage
    ) -> Delivery:
        """Whether a message is one of the agent's own events.

        It is when a rule names the agent and its addressing policy and budget
        let the sender through. A sender the policy refuses, or an agent over
        its budget, gets a refusal posted once the message has committed, and
        the message stays the room's conversation.
        """
        meta = self._meta
        thread_id = event.thread_root_id
        if platform_replies_in_channel(event.content):
            # A threaded kickoff that wants its work in the channel: the agent
            # sees it as top-level, so its replies and notices go there.
            thread_id = None
            reply_thread_root = None
        else:
            reply_thread_root = thread_id if thread_id is not None else event.event_id

        named = False
        addressed = False
        refusal: str | None = None
        if self._addressed_without_lookup(event, meta) is not False:
            named = await self._compute_addressed(session, event, meta)
            if named:
                agent = await self._fresh_agent(session)
                gate = await self._gate_addressed(session, agent, event, meta)
                addressed = gate.addressed
                refusal = gate.refusal

        sender_role = (
            await self._sender_role(session, event.sender, event.content)
            if addressed
            else None
        )
        own_event = _message_own_event(
            meta, event, thread_id, self.agent.id, sender_role
        )

        async def after(row: InboundEvent) -> None:
            assert isinstance(row, InboundMessage)
            await self._after_message(
                row,
                addressed=addressed,
                refusal=refusal,
                thread_id=thread_id,
                reply_thread_root=reply_thread_root,
            )

        return Delivery(
            own_event=own_event if addressed else None,
            after=after if addressed or refusal is not None else None,
            named=named,
        )

    async def decide_follow_up(
        self,
        session: AsyncSession,
        event: InboundMessage,
        decision: ConversationDecision,
    ) -> Delivery:
        """Whether a message that names nobody is one of the agent's own events
        by following the conversation (`delivery/conversation.py`): when a rule
        chose the agent, and its addressing policy and budget let the sender
        through.

        Quieter than a mention on every other count. A sender the policy
        refuses, or an agent over its budget, gets no refusal, and an agent
        with no session gets no "unavailable" notice: the sender did not ask
        this agent for anything, so telling them so would be noise in someone
        else's conversation. Every outcome is logged, which is how each route
        can be followed in the server's log.
        """
        meta = self._meta
        outcome = "nobody"
        delivered = False
        if decision.route is not None:
            agent = await self._fresh_agent(session)
            gate = await self._gate_addressed(session, agent, event, meta)
            delivered = gate.addressed
            outcome = "delivered" if delivered else "dropped_not_permitted"
        # Every agent in the room is asked about every message that names
        # nobody, so "nobody" is the common answer: kept out of INFO, where it
        # would be a line per agent per message in a busy room.
        logger.log(
            logging.DEBUG if outcome == "nobody" else logging.INFO,
            "Follow the conversation: room=%s message=%s agent=%s route=%s "
            "outcome=%s reason=%s",
            meta.room_id,
            event.event_id,
            self.agent.name,
            decision.route or "none",
            outcome,
            decision.reason
            if outcome != "dropped_not_permitted"
            else "the sender may not instruct this agent, or it is over budget",
        )
        if not delivered:
            return NOTHING

        async def after(row: InboundEvent) -> None:
            assert isinstance(row, InboundMessage)
            await self._after_follow_up(row)

        sender_role = await self._sender_role(session, event.sender, event.content)
        return Delivery(
            own_event=_message_own_event(
                meta, event, event.thread_root_id, self.agent.id, sender_role
            ),
            after=after,
        )

    async def _after_follow_up(self, event: InboundMessage) -> None:
        """What a follow-up leaves to do once it has committed: wake the
        agent's cloud machine if it is asleep, so a session can start, and
        report that the agent was asked something. Nothing is posted."""
        meta = self._meta
        async with self.session_factory() as session:
            agent = await self._fresh_agent(session)
            agent_live = await self._is_available(session, agent, meta.room_id)
        if not agent_live:
            await self._wake_for_follow_up()
        self._report_addressed(meta, event, agent_live=agent_live, has_attachment=False)

    async def _wake_for_follow_up(self) -> None:
        """Start the cloud machine of an agent run by a controller that is
        asleep, as a mention would, without the notice a mention posts."""
        controllers = self._connections.controllers
        binding = controllers.binding(self.agent.id)
        if (
            binding is None
            or not binding.running
            or controllers.is_revoked(binding.controller_id)
            or controllers.is_live(self.agent.id)
        ):
            return
        await self._wake_cloud_machine(binding.controller_id)

    async def _after_message(
        self,
        event: InboundMessage,
        *,
        addressed: bool,
        refusal: str | None,
        thread_id: str | None,
        reply_thread_root: str | None,
    ) -> None:
        """What a message leaves the agent to say once it has committed.

        Whether the agent can take the message is read now, in a session of
        its own that is closed before anything is posted: posting is a write
        of its own, and holding a connection across it is how a pool slot
        ends up idle in a transaction.
        """
        meta = self._meta
        agent_live = False
        unavailable: str | None = None
        if addressed and not self._triggered_by_auto_reply(event):
            async with self.session_factory() as session:
                agent = await self._fresh_agent(session)
                agent_live = await self._is_available(session, agent, meta.room_id)
                if not agent_live:
                    unavailable = await self._reply_when_unavailable_here(
                        session, agent, meta, self._sender_handle(event)
                    )

        if addressed:
            self._report_addressed(
                meta, event, agent_live=agent_live, has_attachment=False
            )

        if refusal is not None:
            await self._post_auto_reply(
                self._room.room_id, event, refusal, reply_thread_root
            )
        if unavailable is not None:
            await self._post_auto_reply(
                self._room.room_id,
                event,
                unavailable,
                # Where this lands depends on whether an answer follows it.
                #
                # "Starting a session" is a preamble: the real answer arrives
                # after it, in the room the question was asked in. Threading it
                # off the trigger buries the notice away from the answer it
                # introduces, so it goes where the question was: `thread_id`,
                # which is None for a message at the root (CHOO-2173).
                #
                # Everything else here is the whole reply and nothing follows
                # it, so it threads off the triggering message: an owner mention
                # is noise in a channel for something only one person can act
                # on (CHOO-2344).
                thread_id
                if unavailable == _STARTING_SESSION_MESSAGE
                else reply_thread_root,
            )

    # ── Files ─────────────────────────────────────────────────────────────────

    async def addressed_by(self, session: AsyncSession, event: InboundMessage) -> bool:
        """Whether a rule names the agent in this row, before its policy and
        budget are applied. Reads only when the text alone cannot say."""
        decided = self._addressed_without_lookup(event, self._meta)
        if decided is not None:
            return decided
        return await self._compute_addressed(session, event, self._meta)

    async def decide_post(
        self,
        session: AsyncSession,
        files: list[InboundMedia],
        *,
        named: bool,
        lead: InboundMedia,
        complete: bool,
        message_key: str,
    ) -> Delivery:
        """Whether a post of one or more files is one of the agent's own
        events, delivered as one message carrying every file.

        `files` are the post's rows, in the order they were written; a file
        still being written is given as it will be stored, and replaced by
        the stored row when the event is built. `named` is whether any of them
        named the agent: the text and its mentions ride on the first file
        alone, so asking only the file that completed the post would say
        "not addressed" for every post not finishing on its first file.

        The message is anchored on the first file (index 0) when it arrived,
        so its id and time are the ones the sender was given, whichever file
        completed it. `lead` is the file the rest is taken from when the first
        is missing, and whose thread and sender name the message carries: the
        file that completed the post, or for a post given up on, the first of
        its files written. A post given up on (`complete` False) says in its
        body how many files arrived.
        """
        meta = self._meta
        anchor = _first_file(files) or lead
        gate = _GateOutcome(addressed=False, refusal=None)
        if named:
            agent = await self._fresh_agent(session)
            gate = await self._gate_addressed(session, agent, anchor, meta)

        sender_name = lead.sender_name
        if not sender_name:
            sender_name = lead.sender
            logger.error(
                "Media received without sender name, using the sender id: %s",
                sender_name,
            )
        thread_id = lead.thread_root_id
        group = parse_attachment_group(lead.content)
        total = group[2] if group is not None else 1

        def written(row: InboundEvent) -> list[InboundMedia]:
            return [
                row
                if isinstance(row, InboundMedia) and row.event_id == part.event_id
                else part
                for part in files
            ]

        # Read now: the event is built after the row commits, from the rows alone.
        opening = opening_message_for(meta, self.agent.id)
        sender_role = (
            await self._sender_role(session, anchor.sender, anchor.content)
            if gate.addressed
            else None
        )

        def own_event(row: InboundEvent) -> OwnEvent:
            parts = written(row)
            first = _first_file(parts)
            anchored = first or next(p for p in parts if p.event_id == lead.event_id)
            body = (first.body if first is not None else "") or anchored.body
            if not complete:
                present = len({file_index(part) for part in parts})
                notice = (
                    f"[incomplete attachment group: {present} of {total} files arrived]"
                )
                body = f"{body}\n{notice}" if body else notice
            agent_event = message_event(
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                event=anchored,
                addressed=True,
                sender_name=sender_name,
                body=body,
                thread_id=thread_id,
                attachments=[
                    attachment_ref(part) for part in sorted(parts, key=file_index)
                ],
                opening_message=opening,
                sender_role=sender_role,
            )
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(
                    "Enqueuing media event %s", agent_event.model_dump_json(indent=2)
                )
            return OwnEvent(
                agent_event,
                room_seq=max(part.seq for part in parts),
                message_key=message_key,
            )

        async def after(row: InboundEvent) -> None:
            parts = written(row)
            anchored = _first_file(parts) or next(
                p for p in parts if p.event_id == lead.event_id
            )
            await self._after_post(anchored, gate=gate, thread_id=thread_id)

        return Delivery(
            own_event=own_event if gate.addressed else None,
            after=after if named else None,
            named=named,
        )

    async def _after_post(
        self, anchor: InboundMedia, *, gate: _GateOutcome, thread_id: str | None
    ) -> None:
        """What a post leaves the agent to say once it has committed: a
        refusal, and the report that it was asked something."""
        meta = self._meta
        reply_thread_root = thread_id if thread_id is not None else anchor.event_id
        agent_live = False
        # Only the report reads this here (a post gets no offline notice), so
        # it is not worth a query while reporting is off.
        if (
            gate.addressed
            and self._message_telemetry.enabled
            and not self._triggered_by_auto_reply(anchor)
        ):
            async with self.session_factory() as session:
                agent = await self._fresh_agent(session)
                agent_live = await self._is_available(session, agent, meta.room_id)
        if gate.refusal is not None:
            await self._post_auto_reply(
                self._room.room_id, anchor, gate.refusal, reply_thread_root
            )
        if gate.addressed:
            self._report_addressed(
                meta, anchor, agent_live=agent_live, has_attachment=True
            )

    # ── Arrivals ──────────────────────────────────────────────────────────────

    async def decide_arrival(
        self, session: AsyncSession, event: InboundMembership
    ) -> Delivery:
        """Whether someone else's arrival in the room is one of the agent's
        own events: it is when the agent listens for joins in this room.

        Only a genuine join counts. A membership-preserving update (a display
        name or avatar change) re-fires the membership with `prev_membership`
        "join", and leaving is never written as a row.
        """
        if event.membership != "join" or event.prev_membership == "join":
            return NOTHING
        if not self._member.listening:
            # The agent does not listen for joins in this room, so the join
            # is not written to its own events. A reader that wants the whole
            # conversation still sees it, read from `messages`.
            return NOTHING
        meta = self._meta
        member_name = await self._member_name(session, event)

        def own_event(row: InboundEvent) -> OwnEvent:
            assert isinstance(row, InboundMembership)
            return OwnEvent(
                room_join_event(
                    room_id=meta.room_id,
                    bridge_id=meta.bridge_id,
                    channel_type=meta.channel_type,
                    member=row.state_key,
                    member_name=member_name,
                    timestamp=row.timestamp,
                    listening=True,
                ),
                room_seq=row.seq,
                message_key=row.event_id,
            )

        return Delivery(own_event=own_event, after=None)

    async def _member_name(
        self, session: AsyncSession, event: InboundMembership
    ) -> str:
        """What to call the member who just arrived.

        The name Switch knows them by, not the one on the membership event: a
        profile is set from whatever the source platform calls someone, so
        taking it makes the same person read one way when they arrive and
        another way when they speak, and the log, which records the Switch
        name, disagree with what was delivered live.
        """
        client = await self._clients.get_by_transport_user_id(session, event.state_key)
        if client is not None:
            return client.display_name
        fallback = event.display_name or event.state_key.split(":")[0].lstrip("@")
        logger.warning(
            "No Switch client owns %s; naming the arrival %r from the membership event",
            event.state_key,
            fallback,
        )
        return fallback

    async def greet(self) -> None:
        """Say hello in a room the agent has just arrived in: in the words the
        room was given for it when there are some (a Switch Console chat's
        opening message), else its usual line.

        The per-agent greeting can be switched off per bridge: on Mattermost,
        for one, whose native "X joined the channel" notice makes it
        redundant.
        """
        meta = self._meta
        name = self.agent.name
        if not meta.agent_greetings_enabled:
            logger.info(
                "Suppressing self-join greeting for %s in %s "
                "(agent greetings disabled on the room's bridge)",
                name,
                self._room.room_id,
            )
            return
        opening = opening_message_for(meta, self.agent.id)
        if opening is not None:
            greeting = opening
        elif meta.channel_type == "direct":
            greeting = f"Hi! I'm {name} — how can I help?"
        else:
            greeting = random.choice(AGENT_GREETINGS).format(name=name)
        await self.actor.send_message(
            self._room.room_id, greeting, format="markdown", metered=False
        )

    # ── Commands ──────────────────────────────────────────────────────────────

    async def decide_command(self, event: CommandEvent) -> Delivery:
        """What a room command does for the agent, decided as its row is
        written.

        A session control (`!reset`, `!compact`, `!interrupt`) is queued for
        the agent as an own event, stored with the command's row so the agent
        gets it before anything written after it; what it says in the room
        is said once it has committed. Every other command queues nothing and
        is run by its handler once it has committed (`handle_command`).
        """
        cmd = COMMANDS_BY_NAME.get(event.command)
        if cmd is None or cmd.admin_owned:
            return NOTHING
        if cmd.decide is None:

            async def run(row: InboundEvent) -> None:
                assert isinstance(row, InboundCustomEvent)
                await self.handle_command(command_event(row))

            return Delivery(own_event=None, after=run)
        meta = self._meta
        if not await cmd.addressed(self, event.args, meta.room_id):
            return NOTHING
        refusal = await self._command_refusal(self._room, event, meta)
        if refusal is not None:
            return Delivery(own_event=None, after=lambda _row: refusal())
        decision = await cmd.decide(self, self._room, event)
        answer = decision.answer
        queued = decision.queued
        own_event: Callable[[InboundEvent], OwnEvent] | None = None
        if queued is not None:

            def own_event(row: InboundEvent) -> OwnEvent:
                return OwnEvent(
                    AgentEvent(
                        type="command",
                        room_id=meta.room_id,
                        bridge_id=meta.bridge_id,
                        channel_type=meta.channel_type,
                        payload=queued,
                    ),
                    room_seq=row.seq,
                    message_key=row.event_id,
                )

        async def after(_row: InboundEvent) -> None:
            if answer is not None:
                await answer()

        return Delivery(own_event=own_event, after=after)

    async def handle_command(self, event: CommandEvent) -> None:
        """Run a room command for the agent, once the command has committed.

        Admin-owned commands (room, info, alias) are the admin client's, which
        is in every room; agents ignore them entirely.
        """
        room = self._room
        meta = self._meta
        cmd = COMMANDS_BY_NAME.get(event.command)
        if cmd is not None and cmd.admin_owned:
            return

        # Targeting is a per-command policy: each Command decides whether its
        # args address this agent (Command.addressed). The default matches our
        # @name or a role we hold; some commands (e.g. reset) override it.
        addressed = cmd.addressed if cmd is not None else _addressed_by_name_or_role
        if not await addressed(self, event.args, meta.room_id):
            return

        if not await self._gate_command(room, event, meta):
            return

        handled = await self._handle_command(room, event)
        if handled:
            return

        await self._event_buffer.enqueue(
            self.tenant_id,
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="command",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=CommandPayload(
                    command=event.command,
                    args=event.args,
                    user_id=event.user_id,
                    user_name=event.user_name,
                ),
            ),
            room_seq=event.room_seq,
            message_key=event.message_id,
        )

    async def _command_targets_me_explicitly(
        self, session: AsyncSession, args: str, room_id: str
    ) -> bool:
        """Whether the command names this agent, rather than reaching it as part
        of a room-wide fan-out (`!reset-all-agents`, or a bare command with no
        `@` token)."""
        if "@" not in args:
            return False
        if self._args_tag_my_name(args):
            return True
        if await self._text_tags_my_alias(session, args, room_id):
            return True
        return await self._text_tags_my_role(session, args, room_id)

    async def _gate_command(
        self, room: RoomRef, event: CommandEvent, meta: RoomMeta
    ) -> bool:
        """Apply the addressing policy to a command aimed at this agent.

        Commands drive the agent as surely as a message does: `!reset` wipes
        its context, `!interrupt` stops it mid-task. So a sender who may not
        address the agent may not command it either.

        A refusal is posted only when the command named this agent. A room-wide
        command (`!reset-all-agents`, or a bare one with no target) makes no
        claim about this agent in particular, and answering every one of them
        would flood a room holding several restricted agents; those are declined
        quietly, with a warning in the log.
        """
        refusal = await self._command_refusal(room, event, meta)
        if refusal is None:
            return True
        await refusal()
        return False

    async def _command_refusal(
        self, room: RoomRef, event: CommandEvent, meta: RoomMeta
    ) -> Callable[[], Awaitable[None]] | None:
        """None when the sender may command this agent, and otherwise how the
        command is declined (`_gate_command`)."""
        async with self.session_factory() as session:
            agent = await self._fresh_agent(session)
            decision = await self._addressing_allowed(
                session, agent, event.user_id, meta.room_id
            )
            if decision.allowed:
                return None
            targets_me = await self._command_targets_me_explicitly(
                session, event.args, meta.room_id
            )
        refusal = decision.refusal

        async def decline() -> None:
            if targets_me:
                await self.reply_command(
                    room.room_id,
                    refusal,
                    thread_root_id=event.thread_id,
                )
                return
            logger.warning(
                "Command %s from %s declined for %s in room %s: sender may not "
                "address this agent",
                event.command,
                event.user_id,
                self.agent.name,
                meta.room_id,
            )

        return decline

    async def _handle_command(self, room: RoomRef, event: CommandEvent) -> bool:
        is_direct = await self._is_direct_room(room.room_id)
        return await dispatch_command(self, room, event, is_direct)

    async def reply_command(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "markdown",
        thread_root_id: str | None = None,
    ) -> None:
        """Post a command result as this agent (an agent-owned command like
        `!reset` answers in the agent's own voice, not as a system message)."""
        await self.actor.send_message(
            room_id,
            body,
            format=format,
            thread_root_id=thread_root_id,
            metered=False,
        )

    async def _resolve_room_meta(self, transport_room_id: str) -> RoomMeta | None:
        """The room this recipient decides for, which the router read with the
        row. A command handler asks by the room's transport id."""
        if transport_room_id != self._room.room_id:
            logger.error(
                "Agent %s was asked about room %s while deciding a row in %s",
                self.agent.name,
                transport_room_id,
                self._room.room_id,
            )
            return None
        return self._meta

    # ── Tasks ─────────────────────────────────────────────────────────────────

    def decide_task(self, event: SwitchEvent) -> Delivery:
        """Whether a task event is one of the agent's own events: it is for
        the agent doing the task when it is delegated or cancelled, and for
        the agent that asked when it is accepted, updated or finalised."""
        meta = self._meta
        me = self.agent.id
        payload: (
            TaskDelegatePayload
            | TaskAcceptPayload
            | TaskUpdatePayload
            | TaskFinalisePayload
            | TaskCancelPayload
        )
        if isinstance(event, TaskDelegate):
            if event.performer_agent_id != me:
                return NOTHING
            kind = "task_delegate"
            payload = TaskDelegatePayload(
                task_id=event.task_id,
                requester_agent_id=event.requester_agent_id,
                performer_agent_id=event.performer_agent_id,
                summary=event.summary,
                description=event.description,
            )
        elif isinstance(event, TaskAccept):
            if event.requester_agent_id != me:
                return NOTHING
            kind = "task_accept"
            payload = TaskAcceptPayload(
                task_id=event.task_id,
                requester_agent_id=event.requester_agent_id,
                performer_agent_id=event.performer_agent_id,
            )
        elif isinstance(event, TaskUpdate):
            if event.requester_agent_id != me:
                return NOTHING
            kind = "task_update"
            payload = TaskUpdatePayload(
                task_id=event.task_id,
                requester_agent_id=event.requester_agent_id,
                performer_agent_id=event.performer_agent_id,
                update=event.update,
            )
        elif isinstance(event, TaskFinalise):
            if event.requester_agent_id != me:
                return NOTHING
            kind = "task_finalise"
            payload = TaskFinalisePayload(
                task_id=event.task_id,
                requester_agent_id=event.requester_agent_id,
                performer_agent_id=event.performer_agent_id,
                outcome=event.outcome,
            )
        elif isinstance(event, TaskCancel):
            if event.performer_agent_id != me:
                return NOTHING
            kind = "task_cancel"
            payload = TaskCancelPayload(
                task_id=event.task_id,
                requester_agent_id=event.requester_agent_id,
                performer_agent_id=event.performer_agent_id,
                reason=event.reason,
            )
        else:
            return NOTHING

        def own_event(row: InboundEvent) -> OwnEvent:
            return OwnEvent(
                AgentEvent(
                    type=kind,
                    room_id=meta.room_id,
                    bridge_id=meta.bridge_id,
                    channel_type=meta.channel_type,
                    payload=payload,
                ),
                room_seq=row.seq,
                message_key=row.event_id,
            )

        async def working_on_it(_row: InboundEvent) -> None:
            await self.actor.send_message(
                self._room.room_id, "Working on it.", format="markdown", metered=False
            )

        return Delivery(
            own_event=own_event,
            after=working_on_it if isinstance(event, TaskDelegate) else None,
        )

    # ── Offline and refusal notices ───────────────────────────────────────────

    async def _reply_when_unavailable_here(
        self, session: AsyncSession, agent: Agent, meta: RoomMeta, asker_handle: str
    ) -> str | None:
        """Message for an agent addressed here but not live in this room, or
        None when there is nothing to post.

        If the agent has live session(s) connected to OTHER rooms, name them so
        the asker knows where to find it: a session hops rooms while keeping
        its heartbeat (and any role lease) alive, so the agent is reachable
        there even though it has no session in the room it was addressed from.
        When the agent also holds a role in *this* room, the wording notes that
        the role-assuming session has stepped away. A live session in a
        genuinely different room wins, and the asker is pointed there. Sessions
        in rooms that show the SAME name as this one are NOT offered (pointing
        the asker to a room they appear to already be in is confusing and
        useless).

        session_passive agents have no heartbeat, so the elsewhere/role logic
        never applies: they get the passive reply, which says they read when
        their owner triggers them. For a session_addressable agent with a
        session bound to THIS room but not live here (and no live session in a
        distinct room), the reply says so and asks the owner to restart it.

        A controller-backed agent is answered from its controller alone, before
        anything here could promise a session: Switch does not know where its
        sessions are, so it never says one is starting.
        """
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )

        if self._connections.controllers.is_bound(self.agent.id):
            return await self._controller_unavailable_reply(
                session, agent, meta, asker_handle
            )

        # auto_session: if a connector is actively watching (global heartbeat),
        # it will spin a session up to handle this, so promise that rather than
        # the "elsewhere"/offline wording. With no watcher, fall through to the
        # generic offline reply below.
        # A live connection that declared itself spawn-capable and covers this
        # room WILL start a session, whatever the agent's configured model says.
        # Keying the promise off the observed capability rather than the enum
        # means a mis-set (or merely stale) connection_model can no longer
        # produce "my connector isn't reporting in" while a watcher is sitting
        # right there, connected, about to spawn.
        if self._connections.can_spawn_for(self.agent.id, meta.room_id):
            return _STARTING_SESSION_MESSAGE

        if connection_model == "auto_session":
            # The heartbeat arm only: a client still running the
            # /watch/heartbeat loop declares no capability, and that loop meant
            # willingness. A connection declares its own, which the check above
            # has already asked; reading a connection as willing because it
            # exists promises a session over a session worker that will never
            # spawn one, or over a controller with auto-start switched off.
            watching = await self._agent_session_store.get_live_agent_ids(
                session, [self.agent.id], None
            )
            if self.agent.id in watching:
                return _STARTING_SESSION_MESSAGE

        occupied = rooms_occupied(self.agent.id, self._connections)
        room_ids = await self._agent_session_store.live_connected_rooms(
            session, self.agent.id
        )
        # Where the agent actually is, which is not what its connections cover:
        # a shared one covers every room the agent belongs to, and offering the
        # user "it is busy in these rooms" from that names rooms nothing is in.
        room_ids = sorted(set(room_ids) | occupied)
        bound_here = (
            await self._agent_session_store.has_room_binding(
                session, self.agent.id, meta.room_id
            )
            or meta.room_id in occupied
        )
        names: list[str] = []
        holds_role_here = False
        other_room_ids = [rid for rid in room_ids if rid != meta.room_id]
        if other_room_ids:
            for rid in other_room_ids:
                room = await self._room_store.get(session, rid)
                name = room.name if room is not None else rid
                if name != meta.name:
                    names.append(name)
            holds_role_here = (
                await self._room_role_store.agent_room_role(
                    session,
                    meta.room_id,
                    self.agent.id,
                    self._connections.live_connection_ids(),
                )
                is not None
            )

        if names:
            if holds_role_here:
                return _elsewhere_message(names, holds_role_here=True)
            # No role lease here, just sessions elsewhere: the reply offers
            # "ask me there" alongside starting a session here.
            return await self._unavailable_reply(
                session, meta, agent, asker_handle, other_room_names=names
            )

        # No live session in a distinct room. A session_addressable agent bound
        # to THIS room but not live here: say a session is connected but not
        # live rather than imply there is none.
        if connection_model == "session_addressable" and bound_here:
            return await self._unavailable_reply(
                session, meta, agent, asker_handle, connected_not_live=True
            )
        return await self._unavailable_reply(session, meta, agent, asker_handle)

    async def _controller_unavailable_reply(
        self, session: AsyncSession, agent: Agent, meta: RoomMeta, asker_handle: str
    ) -> str | None:
        """Why an agent run by an agents controller cannot answer here.

        Never "open Switch Console": a managed agent
        is started by its controller, so the reply names what stands in the
        way: the owner stopped it, or its machine was removed or is offline.
        None while it is connected: the message is delivered, and any notice
        that a session is starting is the agent's own to post.
        """
        controllers = self._connections.controllers
        binding = controllers.binding(self.agent.id)
        assert binding is not None
        owner = await self.owner_handle_in(session, agent, meta.bridge_id)
        if not binding.running:
            return _stopped_owner_message(owner, asker_handle)
        if controllers.is_revoked(binding.controller_id):
            return _machine_removed_message(binding.controller_name, owner)
        if not controllers.is_live(self.agent.id):
            machine = await self._wake_cloud_machine(binding.controller_id)
            if machine is None or machine.state == "error":
                return _machine_offline_message(binding.controller_name, owner)
            if machine.owner_stopped:
                return _cloud_machine_stopped_message(binding.controller_name, owner)
            # Once per room for each start: the next messages just wait with it.
            notice = (meta.room_id, machine.revision)
            if notice in self._cloud_waking_notices:
                return None
            self._cloud_waking_notices.add(notice)
            return _cloud_machine_waking_message(binding.controller_name)
        return None

    async def _wake_cloud_machine(self, controller_id: str) -> CloudMachineState | None:
        """Starts the Switch cloud machine running `controller_id` if it is
        asleep, and says how it stands; None for a controller on no cloud
        machine, or when the machine could not be read."""
        try:
            async with (
                asyncio.timeout(5),
                tenant_session(self.session_factory, self.tenant_id) as session,
            ):
                machine = await wake_controller_machine(
                    session, controller_id, datetime.now(UTC)
                )
                state = None if machine is None else CloudMachineState.of(machine)
                await session.commit()
                return state
        except Exception:
            logger.warning(
                "Could not wake the cloud machine of controller %s",
                controller_id,
                exc_info=True,
            )
            return None

    async def owner_handle_in(
        self, session: AsyncSession, agent: Agent, bridge_id: str | None
    ) -> str | None:
        """The agent owner's account on the platform this room is bridged to,
        for @-mentioning them (CHOO-2137).

        Resolved from who owns the agent and which account that person has
        claimed on this bridge, rather than from a handle configured on the
        agent. A handle only means anything on one platform (the same person
        is one name on Slack and another on Telegram), so a single stored
        string was at best right in one room and inert everywhere else.

        None when the agent has no owner, the room has no bridge, or the owner
        has claimed nothing on it. That is a message with no mention, not a
        message withheld.
        """
        if agent.owner_id is None or bridge_id is None:
            return None
        claimed = await self._external_user_store.get_by_user(session, agent.owner_id)
        # Claiming is not exclusive and one person may hold several accounts on
        # a bridge. Sorted so a second account cannot change who gets mentioned
        # between one message and the next.
        here = sorted(u.external_username for u in claimed if u.bridge_id == bridge_id)
        return here[0] if here else None

    async def _unavailable_reply(
        self,
        session: AsyncSession,
        meta: RoomMeta,
        agent: Agent,
        asker_handle: str,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str:
        """Build the room-facing message for an addressed-but-offline agent.

        An auto_session agent with nowhere else to point the asker gets the
        owner-facing "I'm not online" reply: only its owner can act, so the
        message asks them and nobody else. A session_passive agent is never live
        in real time, so it gets `_passive_message`, which names its owner,
        rather than being told it has no session. A known agent otherwise gets
        `_start_from_console_message`, and an agent with no known-agent spec
        falls back to the static `_UNAVAILABLE_MESSAGES` text keyed by
        connection_model; `connected_not_live` selects the "bound here but not
        live" fallback, and a connection_model with no text of its own is
        treated as passive.

        `agent` is the row read for this routing, so option edits made through
        the gateway (e.g. `PATCH /agents/{id}/options`, `connection_model`)
        take effect on the next message.
        """
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        if connection_model == "session_passive":
            return _passive_message(
                await self.owner_handle_in(session, agent, meta.bridge_id),
                asker_handle,
            )
        # `other_room_names` outranks this: a live session in another room is
        # somewhere the asker can go right now, which beats asking the owner to
        # start something.
        if (
            connection_model == "auto_session"
            and not other_room_names
            and not connected_not_live
        ):
            return _offline_owner_message(
                await self.owner_handle_in(session, agent, meta.bridge_id),
                asker_handle,
            )
        if known_agent_for(agent) is not None:
            return _start_from_console_message(
                agent.name,
                await self.owner_handle_in(session, agent, meta.bridge_id),
                asker_handle,
                other_room_names,
                connected_not_live,
            )
        if connected_not_live:
            return _CONNECTED_NOT_LIVE_MESSAGE
        static = _UNAVAILABLE_MESSAGES.get(connection_model)
        if static is not None:
            return static
        return _passive_message(
            await self.owner_handle_in(session, agent, meta.bridge_id),
            asker_handle,
        )

    async def _is_available(
        self, session: AsyncSession, agent: Agent, room_id: str
    ) -> bool:
        """Return True if this agent has a live session for `room_id`.

        always_on agents heartbeat against `room_id=None`; session_addressable
        agents heartbeat against the specific room; session_passive agents
        have no heartbeat and are never considered live in real time. A
        controller-backed agent is available whenever it is connected, since
        where its sessions are is its controller's business.
        """
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        if connection_model == "session_passive":
            return False
        if self._connections.controllers.is_bound(self.agent.id):
            return self._connections.controllers.is_live(self.agent.id)
        # Union of the presence sources while every kind of client exists
        # (CHOO-1857 stage B): a client on the push transport keeps only a
        # connection, one still polling keeps only the heartbeat row, and a
        # session Switch has a record of is answered from that record.
        if connection_model == "always_on":
            if self._connections.is_live(self.agent.id):
                return True
        elif self.agent.id in agents_present_in(
            [self.agent.id], room_id, self._connections
        ):
            # A session in the room, or a claimed room slot no session of this
            # agent accounts for. Not mere coverage: an `all`-scope watcher
            # covering this room is not a session that can answer.
            return True

        heartbeat_room = None if connection_model == "always_on" else room_id
        live = await self._agent_session_store.get_live_agent_ids(
            session, [self.agent.id], heartbeat_room
        )
        return self.agent.id in live

    async def _is_direct_room(self, transport_room_id: str) -> bool:
        meta = await self._resolve_room_meta(transport_room_id)
        return meta is not None and meta.channel_type == "direct"

    # ── Mention detection ─────────────────────────────────────────────────────

    @staticmethod
    def _as_incoming(event: InboundMessage) -> IncomingMessage:
        """The parts of a bus event that addressing is decided from."""
        return IncomingMessage(
            sender=event.sender,
            body=getattr(event, "body", "") or "",
            formatted_body=getattr(event, "formatted_body", None),
            content=event.content,
        )

    def _addressed_without_lookup(
        self, event: InboundMessage, meta: RoomMeta
    ) -> bool | None:
        """The addressing answer that needs no database read, or None when the
        room's aliases and role leases have to be consulted.

        Most room chatter carries no `@` and is answered here, without asking
        the reads the router makes for the whole room.
        """
        return self._addressing.addressed_without_lookup(
            agent=self.agent,
            agent_user_id=self.transport_user_id,
            channel_type=meta.channel_type,
            message=self._as_incoming(event),
        )

    async def _compute_addressed(
        self, session: AsyncSession, event: InboundMessage, meta: RoomMeta
    ) -> bool:
        return await self._addressing.addresses(
            session,
            agent=self.agent,
            agent_user_id=self.transport_user_id,
            room_id=meta.room_id,
            channel_type=meta.channel_type,
            message=self._as_incoming(event),
        )

    async def _addressing_allowed(
        self,
        session: AsyncSession,
        agent: Agent,
        sender_user_id: str,
        room_id: str,
        content: Mapping[str, object] | None = None,
    ) -> AddressingDecision:
        """Whether `sender_user_id` may address this agent in `room_id`, per the
        agent's scoped addressing policy.

        `agent` is the row read for this routing rather than an older copy:
        the policy is the thing being enforced, and enforcing a stale copy of
        it is the one way this check can be wrong in the dangerous direction.
        `content` is the event's content when there is one: a platform message
        says there whose authority it carries.
        """
        return await self._addressing.permitted(
            session,
            agent=agent,
            room_id=room_id,
            sender=sender_user_id,
            content=content,
        )

    async def _gate_addressed(
        self,
        session: AsyncSession,
        agent: Agent,
        event: InboundMessage,
        meta: RoomMeta,
    ) -> _GateOutcome:
        """Apply the scoped addressing policy to a message that tags this agent.

        When the sender is not permitted by the agent's policy, or the agent
        has reached a budget covering it, the message is demoted to unaddressed
        room chatter and the caller is handed a refusal to post (once, guarded
        by AUTO_REPLY_FLAG so two agents can't ping-pong). Zero cost for the
        common case: only messages that already tag this agent are ever
        checked, and open policies short-circuit.
        """
        decision = await self._addressing_allowed(
            session, agent, event.sender, meta.room_id, event.content
        )
        if decision.allowed:
            try:
                await self._budget_guard.require_within(
                    session, tenant_id=self.tenant_id, agent_id=agent.id
                )
            except BudgetExceeded as exc:
                refusal = str(exc)
            else:
                return _GateOutcome(addressed=True, refusal=None)
        else:
            refusal = decision.refusal
        if self._triggered_by_auto_reply(event):
            return _GateOutcome(addressed=False, refusal=None)
        return _GateOutcome(addressed=False, refusal=refusal)

    @staticmethod
    def _triggered_by_auto_reply(event: InboundMessage) -> bool:
        return bool(event.content.get(AUTO_REPLY_FLAG))

    def _report_addressed(
        self,
        meta: RoomMeta,
        event: InboundMessage,
        *,
        agent_live: bool,
        has_attachment: bool,
    ) -> None:
        """Count a message this agent was asked to act on.

        Every message let through the addressing policy and budget, whether or
        not the agent could take it, so an offline or stopped agent is still
        asked. `agent_live` is the agent having a live session for the room.
        Not an auto-reply: Switch's notice that another agent is offline or
        refused is not someone asking this one for something. Not the files of
        a multi-file post delivered without its first part, which happens when
        a post is decided incomplete and the rest arrives later: the post is
        counted with its first part, as the transport counts it, so it is one
        request however it is split.

        Guarded like the transport's observer call, and counted the same way:
        this runs after the message has committed, and a telemetry bug must
        not cost the agent the replies that follow it.
        """
        if self._triggered_by_auto_reply(event):
            return
        group = parse_attachment_group(event.content)
        if group is not None and group[1] != 0:
            return
        try:
            self._message_telemetry.agent_addressed(
                tenant_id=self.tenant_id,
                room_id=meta.room_id,
                sender_transport_user_id=event.sender,
                from_platform=PLATFORM_MARKER in event.content,
                agent_metadata=self.agent.metadata_,
                agent_live=agent_live,
                has_attachment=has_attachment,
            )
        except Exception:
            metrics().increment(OBSERVER_FAILURES, {"actor": "agent"})
            if (failures := _report_failures.note()) is not None:
                logger.error(
                    "Could not report a message addressed to agent %s; it is "
                    "still delivered. %d failure(s) since the last error.",
                    self.agent.name,
                    failures,
                    exc_info=True,
                )

    async def _post_auto_reply(
        self,
        transport_room_id: str,
        event: InboundMessage,
        msg: str,
        thread_root_id: str | None,
    ) -> None:
        """Post a reply addressed at the sender and flagged as an auto-reply, so
        another offline agent it tags does not answer it in turn."""
        handle = self._sender_handle(event)
        already_tagged = _mention_regex(handle).search(msg) is not None
        await self.actor.send_message(
            transport_room_id,
            msg if already_tagged else f"@{handle} {msg}",
            format="markdown",
            mentions=[event.sender],
            thread_root_id=thread_root_id,
            extra_content={AUTO_REPLY_FLAG: True},
            metered=False,
        )

    def _args_tag_my_name(self, text: str) -> bool:
        """True when `text` contains our own `@name` at a full-token boundary
        (so a name that is a prefix of a longer one is not falsely matched)."""
        return _mention_regex(self.agent.name).search(_strip_emphasis(text)) is not None

    async def _text_tags_my_alias(
        self, session: AsyncSession, text: str, room_id: str
    ) -> bool:
        return await self._addressing.mentions_alias(
            session,
            agent=self.agent,
            room_id=room_id,
            message=IncomingMessage(sender="", body=text),
        )

    async def _text_tags_my_role(
        self, session: AsyncSession, text: str, room_id: str
    ) -> bool:
        return await self._addressing.mentions_role(
            session,
            agent=self.agent,
            room_id=room_id,
            message=IncomingMessage(sender="", body=text),
        )

    async def _sender_role(
        self, session: AsyncSession, sender: str, content: Mapping[str, object]
    ) -> str | None:
        """The sending person's role in this workspace, read as the message
        arrives: "owner", "admin" or "member". None for an agent, the
        platform, or a person no Switch user has claimed.

        Read fresh for every message, so an agent can rely on it over what it
        was told earlier: a role can change between two messages.
        """
        principal = await self._addressing.resolve_sender(session, sender, content)
        if principal is None or principal.kind != "user" or not principal.user_ids:
            return None
        roles = set(
            await session.scalars(
                select(TenantMember.role).where(
                    TenantMember.user_id.in_(principal.user_ids)
                )
            )
        )
        for role in ("owner", "admin", "member"):
            if role in roles:
                return role
        return None

    def _sender_handle(self, event: InboundMessage) -> str:
        """The @-handle to tag the message sender with.

        Prefers the bridge-provided `sender_name` (the external username, which
        the collaboration bridge rewrites into a real @mention on Slack /
        Mattermost); falls back to the participant id's localpart for a client with no
        bridge-provided name (paired with `mentions=[event.sender]` so the
        mention renders as a pill).
        """
        content = event.content
        person = platform_on_behalf_of(content)
        if person is not None:
            return person.name
        name = content.get("sender_name")
        if name:
            return str(name)
        return str(event.sender).split(":")[0].lstrip("@")

    def _is_mentioned(self, event: InboundMessage) -> bool:
        return self._addressing.mentions_name(
            agent=self.agent,
            agent_user_id=self.transport_user_id,
            message=self._as_incoming(event),
        )

    def _strip_mention(self, text: str) -> str:
        pattern = re.compile(
            re.escape(f"@{self.agent.name}") + rf"(?!{_NAME_CHAR}):?",
            re.IGNORECASE,
        )
        return pattern.sub("", text).strip()


def opening_message_for(meta: RoomMeta, agent_id: str) -> str | None:
    """The words the room opened with in this agent's name (its chat's
    welcome), for the agent to be told what it said; None when there are none."""
    written = meta.agent_greeting
    if written is None or written.get("agent_id") != agent_id:
        return None
    return written.get("body")


def _message_own_event(
    meta: RoomMeta,
    event: InboundMessage,
    thread_id: str | None,
    agent_id: str,
    sender_role: str | None,
) -> Callable[[InboundEvent], OwnEvent]:
    """How an agent's own event for a message is built once the message is
    written."""
    sender_name = event.sender_name
    if not sender_name:
        sender_name = event.sender
        logger.error(
            "Message received without sender name, using the sender id: %s",
            sender_name,
        )

    def own_event(row: InboundEvent) -> OwnEvent:
        assert isinstance(row, InboundMessage)
        agent_event = message_event(
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            event=row,
            addressed=True,
            sender_name=sender_name,
            body=row.body,
            thread_id=thread_id,
            opening_message=opening_message_for(meta, agent_id),
            sender_role=sender_role,
        )
        # Serialising runs once per agent per message, so only when it will
        # be seen.
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("Enqueuing event %s", agent_event.model_dump_json(indent=2))
        return OwnEvent(agent_event, room_seq=row.seq, message_key=row.event_id)

    return own_event


def file_index(part: InboundMedia) -> int:
    """A file's place in its post: its group index, or 0 for a lone file."""
    group = parse_attachment_group(part.content)
    return group[1] if group is not None else 0


def _first_file(parts: list[InboundMedia]) -> InboundMedia | None:
    """The file a post is anchored on, index 0, when it is among `parts`."""
    return next((part for part in parts if file_index(part) == 0), None)


def command_event(row: InboundCustomEvent) -> CommandEvent:
    """A command as the row it was written in reads, with the ids the row
    alone knows filled in.

    Command results reply into the command's thread. When the command was
    typed inside an existing thread the bridge relates it to that thread's
    root; that root is used so the result stays in the thread. Otherwise the
    command itself roots the thread and its own event id is used. The command
    keeps its own id as well, so two commands in one thread are distinct.
    """
    command = CommandEvent(**row.content)
    command.message_id = row.event_id
    command.thread_id = row.thread_root_id or row.event_id
    command.room_seq = row.seq
    command.source_event_id = row.event_id
    return command
