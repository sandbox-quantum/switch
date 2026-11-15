from __future__ import annotations

from collections import OrderedDict
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.held_rows import Entry, HeldRows, ReadTicket
from switch_core.db.room_access_notify_ddl import (
    BUDGETS_CHANGED_SIGNAL,
    ROOM_AGENT_CHANGED_SIGNAL,
    ROOM_CHANGED_SIGNAL,
)

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.types import RoomDescriptor
    from switch_core.signals import SignalBus


class RoomAccessCache(HeldRows):
    """What a post, and a context read, check before anything else.

    Every post checks that its agent is in the room, which reads the room's
    row and the agent's `room_agents` row, and that no budget covering the
    agent has run out; a controller relaying an operation checks the
    membership once more, for the room it names. These rows are read on every
    post and written rarely, so each process keeps:

    - **an agent's membership of a room**, with the room's descriptor, while
      the agent is a member;
    - **that no budget covers an agent**, which is the case unless its tenant
      has set one.

    For how long, `HeldRows` says: while the signal connection listens, until
    a trigger's signal names them (`db/room_access_notify_ddl.py`), and for
    the TTL otherwise. A refusal is never kept, so an agent that is not a
    member, a missing room, or a budget that covers the agent always reaches
    the database; and a read that straddled an invalidation stores nothing.
    """

    def __init__(self, *, ttl_seconds: float, max_entries: int) -> None:
        super().__init__(ttl_seconds=ttl_seconds)
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries!r}")
        self._max_entries = max_entries
        self._members: OrderedDict[tuple[str, str], Entry[RoomDescriptor]] = (
            OrderedDict()
        )
        self._unbudgeted: OrderedDict[str, Entry[bool]] = OrderedDict()

    def follow(self, bus: SignalBus) -> None:
        """Keep entries while `bus` listens, and drop the ones its signals
        name."""
        self.listen_on(bus)
        bus.handle(ROOM_AGENT_CHANGED_SIGNAL, self._on_room_agent_changed)
        bus.handle(ROOM_CHANGED_SIGNAL, self._on_room_changed)
        bus.handle(BUDGETS_CHANGED_SIGNAL, self._on_budgets_changed)

    def member(
        self, tenant_id: str, agent_id: str, room_id: str
    ) -> RoomDescriptor | None:
        """The room, if the agent is known to be one of its members."""
        return self.get(self._members, tenant_id, (agent_id, room_id))

    def put_member(
        self,
        tenant_id: str,
        agent_id: str,
        room: RoomDescriptor,
        ticket: ReadTicket,
    ) -> None:
        if not self.fresh(ticket):
            return
        self.put(
            self._members,
            self._max_entries,
            tenant_id,
            (agent_id, room.id),
            room,
            self.held_under(ticket),
        )

    def unbudgeted(self, tenant_id: str, agent_id: str) -> bool:
        """Whether no budget is known to cover the agent."""
        return self.get(self._unbudgeted, tenant_id, agent_id) is True

    def put_unbudgeted(self, tenant_id: str, agent_id: str, ticket: ReadTicket) -> None:
        if not self.fresh(ticket):
            return
        self.put(
            self._unbudgeted,
            self._max_entries,
            tenant_id,
            agent_id,
            True,
            self.held_under(ticket),
        )

    def invalidate_member(self, agent_id: str, room_id: str) -> None:
        self.invalidated()
        self._members.pop((agent_id, room_id), None)

    def invalidate_room(self, room_id: str) -> None:
        # A room's descriptor changes rarely (a rename, an archive), so its
        # members' entries are found by looking at all of them.
        self.invalidated()
        for key in [key for key in self._members if key[1] == room_id]:
            del self._members[key]

    def invalidate_budgets(self, tenant_id: str) -> None:
        self.invalidated()
        for key in [
            key
            for key, entry in self._unbudgeted.items()
            if entry.tenant_id == tenant_id
        ]:
            del self._unbudgeted[key]

    def clear(self) -> None:
        self.invalidated()
        self._members.clear()
        self._unbudgeted.clear()

    def _on_room_agent_changed(self, signal: dict[str, Any]) -> None:
        self.invalidate_member(signal["agent_id"], signal["room_id"])

    def _on_room_changed(self, signal: dict[str, Any]) -> None:
        self.invalidate_room(signal["room_id"])

    def _on_budgets_changed(self, signal: dict[str, Any]) -> None:
        self.invalidate_budgets(signal["tenant_id"])
