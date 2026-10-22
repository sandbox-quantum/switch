"""Decision routing: the decision service picks who answers a message that no
rule delivered to anyone.

In a room with automatic routing on (`!auto-route on`, on a server with the
`decision_routing` feature and a `DECISION_ENDPOINT_URL`), a person's text
message that names nobody and that no follow-up or assigned agent took is
marked undecided as it is written (`MessageRouter._follow_the_conversation`).
It passed the same filters as a follow-up (`may_follow`): a person sent it, it
has no `@` in it, it is not Switch's own or another app's, it is not in a
direct room, and it is not thanks or praise (`is_small_talk`).

Once the message has committed, the router asks the decision service about
it, in the room's after-commit queue (`_AfterCommit`), so a slow or failed
decision never holds up the write, and decisions in a room are made in the
order of its messages:

1. The candidates are the room's agents other than the sender whose
   addressing policy and budget let the sender through, as for a mention,
   but without a refusal. With none, the service is not asked.
2. The service is sent the room's context (`decision_request`), read in a
   session closed before the call.
3. When it names a candidate, the agent is checked once more, after the
   call: still in the room, its policy and budget still letting the sender
   through. Then the person's own message is stored as the agent's own event,
   addressed and marked `routed`, under the message's key and place in the
   room, as if the agent had been tagged; so the channel follow-up carries on
   after the agent answers.

Nobody receives the message when the service names nobody, when it cannot be
asked (a timeout, a connection error, an error response or a malformed one:
logged as a warning), or when it names an agent that was not a candidate
(logged as an error). Every decision is logged at INFO.

The queue is in memory, so a decision still waiting when the process stops
is not made.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from sqlalchemy import select

from switch_core.clients.admin_messages import PLATFORM_MARKER, platform_on_behalf_of
from switch_core.db.models import Client, ClientRoom, ExternalUser
from switch_core.decision.client import (
    ContextMessage,
    DecisionAgent,
    DecisionMessage,
    DecisionRequest,
    DecisionRoom,
)
from switch_core.delivery.conversation import (
    CHANNEL_LOOKBACK,
    is_automatic,
    mentioned_names,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Message, Room
    from switch_core.delivery.conversation import RoomConversation
    from switch_core.delivery.recipient import AgentRecipient, RoomMember
    from switch_core.transport.types import InboundMessage

# The most of a thread's latest messages, and of the room's latest top-level
# messages, sent as context: enough to see who is talking to whom, and short
# enough to keep the decision quick.
THREAD_CONTEXT = 30
RECENT_CONTEXT = CHANNEL_LOOKBACK


async def decision_request(
    session: AsyncSession,
    *,
    room: Room,
    members: list[RoomMember],
    roles: Mapping[str, str],
    conversation: RoomConversation,
    message: InboundMessage,
    candidates: list[AgentRecipient],
) -> DecisionRequest:
    """What the decision service is sent about `message`.

    `members` are the room's agents and `roles` the role each live-holds
    here, by agent id. The thread and the recent messages are the ones the
    follow-up rules read (`conversation`), as they stood when the message was
    written: anything written after it is left out.
    """
    names = _Names(members, roles, await _people(session, room.id))
    thread = await _context(
        session, conversation, names, await conversation.thread(session), message
    )
    recent = await _context(
        session, conversation, names, await conversation.channel(session), message
    )
    return DecisionRequest(
        room=DecisionRoom(name=room.name, instructions=room.instructions),
        message=DecisionMessage(
            sender=_person_name(message.content, message.sender_name, message.sender),
            text=message.body,
            thread_id=message.thread_root_id,
        ),
        agents=[
            DecisionAgent(
                name=candidate.agent.name,
                description=candidate.agent.description,
                role=roles.get(candidate.agent.id),
            )
            for candidate in candidates
        ],
        thread=thread[-THREAD_CONTEXT:],
        recent=recent[-RECENT_CONTEXT:],
    )


class _Names:
    """Who the room's messages come from and whom they address, by name."""

    def __init__(
        self,
        members: list[RoomMember],
        roles: Mapping[str, str],
        people: set[str],
    ) -> None:
        self._agents = {
            member.transport_user_id: member.agent.name for member in members
        }
        # Every handle that reaches an agent here, lowercased, to the agent's
        # name: its name, its alias and the role it holds.
        self._handles: dict[str, str] = {}
        for member in members:
            name = member.agent.name
            self._handles[name.lower()] = name
            if member.alias:
                self._handles[member.alias.lower()] = name
            role = roles.get(member.agent.id)
            if role:
                self._handles[role.lower()] = name
        self._people = {person.lower(): person for person in people}

    def agent(self, transport_user_id: str) -> str | None:
        return self._agents.get(transport_user_id)

    def addressed(self, body: str) -> list[str]:
        """The room members `body` @-mentions, by name, in a stable order."""
        found: set[str] = set()
        for handle in mentioned_names(body):
            if handle in self._handles:
                found.add(self._handles[handle])
            elif handle in self._people:
                found.add(self._people[handle])
        return sorted(found)


async def _people(session: AsyncSession, room_id: str) -> set[str]:
    """The names the room's other members go by and are tagged with: their
    display names, and a platform user's username there."""
    rows = (
        await session.execute(
            select(Client.display_name, ExternalUser.external_username)
            .select_from(ClientRoom)
            .join(Client, Client.id == ClientRoom.client_id)
            .outerjoin(ExternalUser, ExternalUser.client_id == Client.id)
            .where(ClientRoom.room_id == room_id, Client.type != "agent")
        )
    ).all()
    return {name for row in rows for name in row if name}


async def _context(
    session: AsyncSession,
    conversation: RoomConversation,
    names: _Names,
    rows: list[Message],
    message: InboundMessage,
) -> list[ContextMessage]:
    """`rows` (newest first) as context for the decision, oldest first: the
    messages people and agents wrote before `message`. Switch's own notices,
    automatic replies and anything that is not a text message are left out."""
    context: list[ContextMessage] = []
    for row in rows:
        if (
            row.seq >= message.seq
            or row.event_type != "m.room.message"
            or not (row.body or "").strip()
            or is_automatic(row)
        ):
            continue
        said = await _said_by(session, conversation, names, row)
        if said is None:
            continue
        sender, kind = said
        context.append(
            ContextMessage(
                sender=sender,
                sender_kind=kind,
                text=row.body or "",
                addressed=names.addressed(row.body or ""),
            )
        )
    context.reverse()
    return context


async def _said_by(
    session: AsyncSession,
    conversation: RoomConversation,
    names: _Names,
    row: Message,
) -> tuple[str, Literal["person", "agent"]] | None:
    """Who wrote `row` and whether a person or an agent; None for Switch's
    own messages, and for a sender that is neither."""
    content = row.content or {}
    if PLATFORM_MARKER in content:
        # Switch's app speaking for someone, whom the marker names.
        speaker = platform_on_behalf_of(content)
        if speaker is None:
            return None
        return speaker.name, "agent" if speaker.agent_id is not None else "person"
    kind = await conversation.sender_kind(session, row)
    if kind == "agent":
        return names.agent(row.sender_id) or row.sender_name or row.sender_id, "agent"
    if kind == "user":
        return _person_name(content, row.sender_name, row.sender_id), "person"
    return None


def _person_name(
    content: Mapping[str, object], sender_name: str | None, sender: str
) -> str:
    """The name a person goes by in the room: the person a platform message
    speaks for, else the name their message carries, else their id's
    localpart."""
    speaker = platform_on_behalf_of(content)
    if speaker is not None:
        return speaker.name
    named = content.get("sender_name") or sender_name
    if named:
        return str(named)
    return sender.split(":")[0].lstrip("@")
