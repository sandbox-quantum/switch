"""Following the conversation: when a message that mentions nobody is for an agent.

Addressing (`delivery/addressing.py`) answers "did this message ask this agent
for something?" from the message alone: a name, an alias, a role, a direct
chat. A person in a conversation does not repeat a name on every message, so
three rules extend it, each decided from the room's history:

- **Thread follow-up.** A reply in a thread reaches the agent that owns it:
  of the agents in the thread, the one that spoke most recently, or that a
  person tagged most recently (all of them, when one message tagged several,
  until one answers).
- **Channel follow-up.** A top-level message reaches the agent the sender is
  in an unbroken exchange with: the sender addressed the agent (or, in a room
  routing by decision, the decision service gave the agent the sender's
  message), the agent has answered since, nobody else has posted in between,
  the agent's last answer is within the window, and no gap between messages
  is longer than it.
- **Main agent.** In a room whose main agent is set (`!assign-agent`), every
  message reaches it.

A room can turn the two follow-up rules off with `!follow-ups off`; the main
agent rule is separate and unaffected. A room with automatic routing on
(`!auto-route on`, `delivery/decision.py`) skips the thread follow-up: the
decision service, which sees the whole thread, decides thread replies instead.
These settings live in the room's `metadata` (`db/stores/room_store.py`).

The rules only ever consider a person's text message that has no `@` in it
at all: a mention always wins, and a message from an agent, an app or Switch
itself never reaches anyone by these rules, so agents cannot set each other
off. Permissions are not decided here; the caller applies the agent's policy
afterwards, as it does for a mention.

The router (`delivery/router.py`) asks these rules about a message that no
explicit rule named anyone in, before the message is written. What they read
about the room (the thread, the channel's latest messages, the handles that
reach an agent) is read once for the message and shared by every agent in
the room (`RoomConversation`), so the cost does not grow with the number of
agents. Every delivery, and every one the agent's policy refused, is logged
at INFO with the rule and the reason, so each route can be followed in the
server's log; an agent no rule chose is logged at DEBUG.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    AUTO_REPLY_FLAG,
    PLATFORM_MARKER,
    SENDER_IS_APP_MARKER,
)
from switch_core.clients.mentions import NAME_CHAR
from switch_core.db.models import AgentEventRow
from switch_core.delivery.addressing import IncomingMessage

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.config import SwitchConfig
    from switch_core.db.models import Agent, Message
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.message_store import MessageStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.delivery.addressing import AddressingResolver


# How many of a thread's most recent messages are read when looking for the
# agent that spoke or was tagged last.
THREAD_LOOKBACK = 200

# How many of the channel's earlier top-level messages one walk reads. An
# exchange longer than this still continues: see `_channel_follow_up`.
CHANNEL_LOOKBACK = 20

# Thanks and praise: they close an exchange rather than continue it, so they
# never wake an agent through a follow-up. Answers are deliberately absent:
# "yes", "ok", "+1" or a thumbs-up may be the reply to an agent's question.
_SMALL_TALK = frozenset(
    {
        "thanks",
        "thank you",
        "thanks a lot",
        "thank you very much",
        "many thanks",
        "thx",
        "ty",
        "cheers",
        "great",
        "nice",
        "cool",
        "perfect",
        "awesome",
        "brilliant",
    }
)

_TRAILING_PUNCTUATION = re.compile(r"[\s.!?,;:]+$")

# A mention-shaped token: an `@` that starts a word, followed by name
# characters. An email address (`ops@example.com`) is not one.
_MENTION = re.compile(rf"(?<!{NAME_CHAR})@({NAME_CHAR}+)")


def is_small_talk(body: str) -> bool:
    """True for thanks or praise ("thanks!", "great"), which ends an exchange
    rather than continuing it."""
    return _TRAILING_PUNCTUATION.sub("", body.strip().lower()) in _SMALL_TALK


def mentioned_names(body: str) -> set[str]:
    """The names @-mentioned in the text, lowercased."""
    return {name.lower() for name in _MENTION.findall(body)}


def mentions_anyone(body: str) -> bool:
    """Whether the text @-mentions anyone, by the same token rule mentions use.
    A mention always wins, so the rules stand aside."""
    return _MENTION.search(body) is not None


NOT_TAKING_PART = "the agent is not taking part in this thread"
# A thread belongs to the agent that spoke or was tagged most recently in it.
ANOTHER_AGENT_SPOKE = "another agent spoke more recently in this thread"
ANOTHER_AGENT_TAGGED = "another agent was tagged more recently in this thread"


class ConversationRoute(StrEnum):
    THREAD_FOLLOW_UP = "thread_follow_up"
    CHANNEL_FOLLOW_UP = "channel_follow_up"
    MAIN_AGENT = "main_agent"


@dataclass(frozen=True)
class ConversationDecision:
    """Which rule, if any, delivers the message to the agent, and why."""

    route: ConversationRoute | None
    reason: str


@dataclass(frozen=True)
class ConversationSettings:
    """The deployment's settings for the rules, parsed once at startup."""

    enabled: bool
    window_seconds: int

    @classmethod
    def from_config(cls, config: SwitchConfig) -> ConversationSettings:
        return cls(
            enabled=config.follow_the_conversation_enabled,
            window_seconds=config.follow_the_conversation_window_seconds,
        )


@dataclass(frozen=True)
class ConversationMessage:
    """The message being decided: what addressing knows, plus where it sits
    and when it was sent. It is decided before it is written, so `sent_at` is
    the time it is being written, not a time read back from its row."""

    event_id: str
    sender: str
    body: str
    content: Mapping[str, object]
    thread_root_id: str | None
    sent_at: datetime


def may_follow(
    settings: ConversationSettings,
    *,
    channel_type: str | None,
    message: ConversationMessage,
) -> bool:
    """The checks that need no database read. False means no rule can apply.

    Most room chatter is settled here, before a pool slot is taken.
    """
    if not settings.enabled:
        return False
    if channel_type == "direct":
        return False
    if mentions_anyone(message.body):
        return False
    content = message.content
    return not any(
        marker in content
        for marker in (
            ADMIN_MARKER,
            AUTO_REPLY_FLAG,
            PLATFORM_MARKER,
            SENDER_IS_APP_MARKER,
        )
    )


def _as_incoming(row: Message) -> IncomingMessage:
    return IncomingMessage(
        sender=row.sender_id,
        body=row.body or "",
        formatted_body=row.formatted_body,
        content=dict(row.content or {}),
    )


def is_automatic(row: Message) -> bool:
    """Switch's own notices and the automatic replies an agent's client posts
    ("Starting a session…"): neither is anyone taking part."""
    content = row.content or {}
    return AUTO_REPLY_FLAG in content or ADMIN_MARKER in content


class ConversationRules:
    """The rules, one per process. `for_message` gives one message's view of
    its room, which decides the message for each agent in turn."""

    def __init__(
        self,
        *,
        settings: ConversationSettings,
        message_store: MessageStore,
        room_store: RoomStore,
        agent_store: AgentStore,
        room_role_store: RoomRoleStore,
    ) -> None:
        self._settings = settings
        self.message_store = message_store
        self.room_store = room_store
        self.agent_store = agent_store
        self.room_role_store = room_role_store

    @property
    def settings(self) -> ConversationSettings:
        return self._settings

    def for_message(
        self,
        *,
        addressing: AddressingResolver,
        room_id: str,
        channel_type: str | None,
        follow_ups_enabled: bool,
        main_agent_id: str | None,
        auto_route_on: bool,
        message: ConversationMessage,
    ) -> RoomConversation:
        """`message`'s room as the rules see it, for a message that has passed
        `may_follow`. `follow_ups_enabled` and `main_agent_id` are the room's
        settings, read with the room; `auto_route_on` is whether automatic
        routing is on in it, and can act on this server."""
        return RoomConversation(
            rules=self,
            addressing=addressing,
            room_id=room_id,
            channel_type=channel_type,
            follow_ups_enabled=follow_ups_enabled,
            main_agent_id=main_agent_id,
            auto_route_on=auto_route_on,
            message=message,
        )


class RoomConversation:
    """One message's room, as the rules read it: read the first time an
    agent's decision asks, and kept for the other agents in the room.

    The message itself may already be a row (a test writes it first); it is
    left out of everything read, so the rules see only what came before it.
    """

    def __init__(
        self,
        *,
        rules: ConversationRules,
        addressing: AddressingResolver,
        room_id: str,
        channel_type: str | None,
        follow_ups_enabled: bool,
        main_agent_id: str | None,
        auto_route_on: bool,
        message: ConversationMessage,
    ) -> None:
        self._rules = rules
        self._settings = rules.settings
        self._addressing = addressing
        self._room_id = room_id
        self._channel_type = channel_type
        self._follow_ups_enabled = follow_ups_enabled
        self._main_agent_id = main_agent_id
        self._auto_route_on = auto_route_on
        self._message = message
        self._sent_by_person: bool | None = None
        self._sender_kinds: dict[str, str | None] = {}
        self._thread_rows: list[Message] | None = None
        self._channel_rows: list[Message] | None = None
        self._agent_names: set[str] | None = None
        self._routed: dict[str, set[str | None]] = {}

    async def decide(
        self, session: AsyncSession, *, agent: Agent, agent_user_id: str
    ) -> ConversationDecision:
        """Which rule delivers the message to `agent`, if any."""
        message = self._message
        is_main_agent = self._main_agent_id == agent.id
        if not self._follow_ups_enabled and not is_main_agent:
            # Settled from the room's settings alone: nothing to read.
            return ConversationDecision(
                None, "follow-ups are switched off in this room"
            )
        if not await self.from_a_person(session):
            return ConversationDecision(None, "not sent by a person")

        follow_up: ConversationDecision
        if not self._follow_ups_enabled:
            follow_up = ConversationDecision(
                None, "follow-ups are switched off in this room"
            )
        elif is_small_talk(message.body):
            follow_up = ConversationDecision(None, "small talk")
        elif message.thread_root_id is not None and self._auto_route_on:
            follow_up = ConversationDecision(
                None, "thread follow-ups are off while automatic routing is on"
            )
        elif message.thread_root_id is not None:
            follow_up = await self._thread_follow_up(
                session,
                agent=agent,
                agent_user_id=agent_user_id,
                thread_root_id=message.thread_root_id,
            )
        else:
            follow_up = await self._channel_follow_up(
                session, agent=agent, agent_user_id=agent_user_id
            )
        if follow_up.route is not None:
            return follow_up
        if is_main_agent:
            return ConversationDecision(
                ConversationRoute.MAIN_AGENT, "the room's main agent"
            )
        return follow_up

    @property
    def message(self) -> ConversationMessage:
        return self._message

    async def from_a_person(self, session: AsyncSession) -> bool:
        """Whether the message was sent by a person, rather than an agent, an
        app or Switch itself."""
        if self._sent_by_person is None:
            message = self._message
            principal = await self._addressing.resolve_sender(
                session, message.sender, message.content
            )
            self._sent_by_person = principal is not None and principal.kind == "user"
        return self._sent_by_person

    async def sender_kind(self, session: AsyncSession, row: Message) -> str | None:
        """The kind of principal that sent `row` (`SenderPrincipal.kind`)."""
        if row.sender_id not in self._sender_kinds:
            principal = await self._addressing.resolve_sender(
                session, row.sender_id, row.content or {}
            )
            self._sender_kinds[row.sender_id] = principal.kind if principal else None
        return self._sender_kinds[row.sender_id]

    async def thread(self, session: AsyncSession) -> list[Message]:
        """The messages of the thread the message replies in, newest first and
        up to `THREAD_LOOKBACK`; none for a top-level message."""
        thread_root_id = self._message.thread_root_id
        if thread_root_id is None:
            return []
        return await self._thread(session, thread_root_id)

    async def channel(self, session: AsyncSession) -> list[Message]:
        """The room's latest top-level messages, newest first and up to
        `CHANNEL_LOOKBACK`."""
        return await self._channel(session)

    def _before_message(self, rows: list[Message], limit: int) -> list[Message]:
        event_id = self._message.event_id
        return [row for row in rows if row.transport_event_id != event_id][:limit]

    async def _thread(
        self, session: AsyncSession, thread_root_id: str
    ) -> list[Message]:
        if self._thread_rows is None:
            rows = await self._rules.message_store.list_thread_newest_first(
                session,
                self._room_id,
                thread_root_event_id=thread_root_id,
                limit=THREAD_LOOKBACK + 1,
            )
            self._thread_rows = self._before_message(rows, THREAD_LOOKBACK)
        return self._thread_rows

    async def _channel(self, session: AsyncSession) -> list[Message]:
        if self._channel_rows is None:
            rows = await self._rules.message_store.list_top_level_newest_first(
                session, self._room_id, limit=CHANNEL_LOOKBACK + 1
            )
            self._channel_rows = self._before_message(rows, CHANNEL_LOOKBACK)
        return self._channel_rows

    async def _addressed_agent(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        row: Message,
    ) -> bool:
        return await self._addressing.addresses(
            session,
            agent=agent,
            agent_user_id=agent_user_id,
            room_id=self._room_id,
            channel_type=self._channel_type,
            message=_as_incoming(row),
        )

    async def _routed_to(
        self, session: AsyncSession, *, agent: Agent, row: Message
    ) -> bool:
        """Whether the decision service gave `row` to `agent`, which in a room
        routing by decision counts as the sender addressing it: the agent was
        given the person's message as if it had been tagged. Read once per
        agent, for the channel messages the walk reads."""
        if not self._auto_route_on:
            return False
        if agent.id not in self._routed:
            rows = await self._channel(session)
            self._routed[agent.id] = set(
                (
                    await session.scalars(
                        select(AgentEventRow.message_key).where(
                            AgentEventRow.agent_id == agent.id,
                            AgentEventRow.room_id == self._room_id,
                            AgentEventRow.room_seq.in_([r.seq for r in rows]),
                            AgentEventRow.payload["payload"]["routed"].as_boolean(),
                        )
                    )
                ).all()
            )
        return row.transport_event_id in self._routed[agent.id]

    async def _thread_follow_up(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_user_id: str,
        thread_root_id: str,
    ) -> ConversationDecision:
        """Whether this agent owns the thread: it spoke most recently, or a
        person tagged it most recently, of all the agents in the thread.

        Walks back from the reply, newest first, to the first message that is
        an agent's post or a person tagging an agent. A message tagging several
        agents gives the thread to all of them until one answers. A person
        tagging another person doesn't move it.
        """
        for row in await self._thread(session, thread_root_id):
            if is_automatic(row):
                continue
            if row.sender_id == agent_user_id:
                return ConversationDecision(
                    ConversationRoute.THREAD_FOLLOW_UP,
                    "the agent spoke most recently in this thread",
                )
            if await self.sender_kind(session, row) == "agent":
                return ConversationDecision(None, ANOTHER_AGENT_SPOKE)
            if await self._addressed_agent(
                session, agent=agent, agent_user_id=agent_user_id, row=row
            ):
                return ConversationDecision(
                    ConversationRoute.THREAD_FOLLOW_UP,
                    "the agent was tagged most recently in this thread",
                )
            names = mentioned_names(row.body or "")
            if names and names & await self._room_agent_names(session):
                return ConversationDecision(None, ANOTHER_AGENT_TAGGED)
        return ConversationDecision(None, NOT_TAKING_PART)

    async def _room_agent_names(self, session: AsyncSession) -> set[str]:
        """Every handle that reaches an agent in this room, lowercased: names,
        room aliases and room roles."""
        if self._agent_names is not None:
            return self._agent_names
        rules = self._rules
        names: set[str] = set()
        for agent_id in await rules.room_store.get_agent_ids(session, self._room_id):
            agent = await rules.agent_store.get(session, agent_id)
            if agent is not None:
                names.add(agent.name.lower())
        names.update(
            alias.lower()
            for alias in (
                await rules.room_store.list_aliases(session, self._room_id)
            ).values()
        )
        names.update(
            role.name.lower()
            for role in await rules.room_role_store.list_roles(session, self._room_id)
        )
        self._agent_names = names
        return names

    async def _channel_follow_up(
        self, session: AsyncSession, *, agent: Agent, agent_user_id: str
    ) -> ConversationDecision:
        """Walk back through the channel's top-level messages for an unbroken
        exchange between the sender and this agent.

        It must have started with the sender addressing the agent, unless it
        runs past the lookback: a run that long with only the two of them in
        it, each gap inside the window, can only be an exchange already under
        way. Anyone else posting ends it, and so does the sender turning to
        someone else with a mention.
        """
        message = self._message
        window = self._settings.window_seconds
        rows = await self._channel(session)
        later_sent_at = message.sent_at
        agent_answered = False
        for index, row in enumerate(rows):
            if is_automatic(row):
                continue
            gap = (later_sent_at - row.sent_at).total_seconds()  # type: ignore[operator]
            if gap > window:
                return ConversationDecision(None, "too long since the last message")
            later_sent_at = row.sent_at  # type: ignore[assignment]
            if row.sender_id == agent_user_id:
                if not agent_answered:
                    since_answer = (message.sent_at - row.sent_at).total_seconds()  # type: ignore[operator]
                    if since_answer > window:
                        return ConversationDecision(
                            None, "too long since the agent's last answer"
                        )
                agent_answered = True
                continue
            if row.sender_id != message.sender:
                if agent_answered or any(
                    earlier.sender_id == agent_user_id and not is_automatic(earlier)
                    for earlier in rows[index + 1 :]
                ):
                    return ConversationDecision(
                        None, "someone else posted after the agent's last answer"
                    )
                return ConversationDecision(None, "no recent exchange with this agent")
            if await self._addressed_agent(
                session, agent=agent, agent_user_id=agent_user_id, row=row
            ) or await self._routed_to(session, agent=agent, row=row):
                if agent_answered:
                    return ConversationDecision(
                        ConversationRoute.CHANNEL_FOLLOW_UP,
                        "continues an exchange the agent has just answered",
                    )
                return ConversationDecision(None, "the agent has not answered yet")
            if mentions_anyone(row.body or ""):
                return ConversationDecision(
                    None, "the sender turned to someone else since"
                )
        if agent_answered and len(rows) == CHANNEL_LOOKBACK:
            return ConversationDecision(
                ConversationRoute.CHANNEL_FOLLOW_UP,
                "continues a long exchange the agent is answering",
            )
        return ConversationDecision(None, "no recent exchange with this agent")
