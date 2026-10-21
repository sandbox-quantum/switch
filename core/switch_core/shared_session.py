"""Shared sessions: one session of an agent answering in several rooms.

An agent shares a session once it has a **home room** (`Agent.home_room_id`).
Its shared session is based there, and a mention in any of its other **shared**
rooms reaches that session rather than starting a new one. Whether a room is
shared is a per-room choice (`room_agents.shared_session`): a room that is not
is **isolated**, and gets its own session of the agent as any room does.

The agent carries two defaults for that choice:

- `shared_by_default`: a room it is added to is shared unless the person adding
  it chooses isolated.
- `sharing_locked`: for an agent built to work across rooms. Every room it is
  in is shared, and none can be made isolated.

Only the agent's owner or a workspace admin may change any of this (or an
agent acting for one of them). The checks for each kind of caller live where
the caller is resolved; this module holds the rules and the reads.

This module covers the settings. Routing a shared room's mentions to the home
session is built on top of `Sharing.covers`.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.room_store import RoomStore


# How an agent's session stands in one room, for showing people which agents
# share one: the room it is based in, another room sharing it, or neither.
SharingMark = Literal["home", "shared"]


class SharingRefused(ValueError):
    """A change the rules do not allow; the message says why, in words to
    relay to whoever asked."""


@dataclass(frozen=True)
class Sharing:
    """An agent's shared-session settings as stored."""

    home_room_id: str | None
    shared_by_default: bool
    locked: bool
    # Rooms marked as shared. May include the home room; `covers` treats the
    # home room as always shared.
    marked_room_ids: frozenset[str]

    @property
    def active(self) -> bool:
        """Whether the agent shares a session at all."""
        return self.home_room_id is not None

    def covers(self, room_id: str) -> bool:
        """Whether a mention in `room_id` belongs to the agent's shared session."""
        if self.home_room_id is None:
            return False
        return room_id == self.home_room_id or room_id in self.marked_room_ids

    def mark(self, room_id: str) -> SharingMark | None:
        if self.home_room_id is None:
            return None
        if room_id == self.home_room_id:
            return "home"
        return "shared" if room_id in self.marked_room_ids else None

    @property
    def other_room_ids(self) -> list[str]:
        """The shared rooms other than home, sorted for stable output."""
        if self.home_room_id is None:
            return []
        return sorted(r for r in self.marked_room_ids if r != self.home_room_id)


async def sharing_of(
    session: AsyncSession, room_store: RoomStore, agent: Agent
) -> Sharing:
    return Sharing(
        home_room_id=agent.home_room_id,
        shared_by_default=bool(agent.shared_by_default),
        locked=bool(agent.sharing_locked),
        marked_room_ids=frozenset(await room_store.shared_room_ids(session, agent.id)),
    )


def sharing_marks(
    agents: Iterable[Agent], marked_agent_ids: set[str], room_id: str
) -> dict[str, SharingMark]:
    """agent id → how its shared session covers `room_id`, for the agents in
    that room whose shared session does.

    `marked_agent_ids` is `RoomStore.sharing_agent_ids(room_id)`.
    """
    marks: dict[str, SharingMark] = {}
    for agent in agents:
        if agent.home_room_id is None:
            continue
        if agent.home_room_id == room_id:
            marks[agent.id] = "home"
        elif agent.id in marked_agent_ids:
            marks[agent.id] = "shared"
    return marks


def check_join_choice(agent: Agent, shared: bool | None) -> None:
    """Refuse adding a locked agent to a room as isolated."""
    if shared is False and agent.sharing_locked:
        raise SharingRefused(
            f"{agent.name} is locked to one shared session: every room it is "
            "in shares it, so it can't be added as isolated."
        )


async def set_home_room(
    session: AsyncSession,
    room_store: RoomStore,
    agent_store: AgentStore,
    agent: Agent,
    room_id: str | None,
) -> None:
    """Base the agent's shared session in `room_id`, or stop sharing (None).

    The home room is shared. The previous home stays shared, as one of its
    other rooms, until someone makes it isolated.
    """
    if room_id is not None:
        if agent.id not in await room_store.get_agent_ids(session, room_id):
            raise SharingRefused(
                f"{agent.name} isn't in that room. Add it to the room before "
                "making it its home room."
            )
        await room_store.set_shared(session, room_id, agent.id, True)
    await agent_store.update(session, agent.id, home_room_id=room_id)


async def set_room_shared(
    session: AsyncSession,
    room_store: RoomStore,
    agent: Agent,
    room_id: str,
    shared: bool,
) -> None:
    """Make `room_id` share the agent's session, or isolate it there."""
    if not shared:
        if agent.sharing_locked:
            raise SharingRefused(
                f"{agent.name} is locked to one shared session, so no room can "
                "be made isolated. Its owner or an admin can unlock it first."
            )
        if agent.home_room_id == room_id:
            raise SharingRefused(
                f"This is {agent.name}'s home room. Move its home to another "
                "room, or stop it sharing, before isolating this room."
            )
    try:
        await room_store.set_shared(session, room_id, agent.id, shared)
    except ValueError as exc:
        raise SharingRefused(f"{agent.name} isn't in that room.") from exc


async def set_sharing_defaults(
    session: AsyncSession,
    room_store: RoomStore,
    agent_store: AgentStore,
    agent: Agent,
    *,
    shared_by_default: bool | None = None,
    locked: bool | None = None,
) -> None:
    """Change the agent's defaults. Locking it shares every room it is in,
    since a locked agent has no isolated rooms."""
    columns: dict[str, object] = {}
    if shared_by_default is not None:
        columns["shared_by_default"] = shared_by_default
    if locked is not None:
        columns["sharing_locked"] = locked
    if not columns:
        return
    await agent_store.update(session, agent.id, **columns)
    if locked:
        await room_store.set_shared_everywhere(session, agent.id)


NOT_PERMITTED = (
    "Only the agent's owner or a workspace admin can change which rooms share "
    "its session."
)


def describe_sharing(sharing: Sharing, room_names: dict[str, str]) -> dict[str, object]:
    """The settings as the agent operations show them."""

    def room(room_id: str) -> dict[str, str]:
        return {"id": room_id, "name": room_names.get(room_id, room_id)}

    return {
        "shared": sharing.active,
        "home_room": room(sharing.home_room_id) if sharing.home_room_id else None,
        "rooms": [room(r) for r in sharing.other_room_ids],
        "shared_by_default": sharing.shared_by_default,
        "locked": sharing.locked,
    }
