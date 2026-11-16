"""The agent rename and delete the in-room commands run, and the requests
agents make that a person confirms with one.

The admin client is registered before AgentCore exists, since AgentCore is
built with the agent bridge app that needs the client factory. This holder is
passed in at registration and bound once AgentCore is made, so the commands
reach the very same rename and delete the gateway and the agent tool use.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore


class AgentAdministration:
    def __init__(self) -> None:
        self._core: AgentCore | None = None

    def bind(self, core: AgentCore) -> None:
        self._core = core

    @property
    def core(self) -> AgentCore:
        if self._core is None:
            raise RuntimeError(
                "Agent administration was used before AgentCore was bound to it; "
                "the process wiring binds it right after creating the agent "
                "bridge app"
            )
        return self._core


# How long a request an agent makes waits for a person to confirm it.
CONFIRM_SECONDS = 120.0


@dataclass(frozen=True)
class DeletionRequest:
    requested_by: str
    expires: float


@dataclass(frozen=True)
class ChangeRequest:
    """A change to one of its owner's agents an agent asked for, or an agent it
    asked to create, held until the owner confirms it.

    `agent_id` is None for an agent to create. `fields` names what it changes
    and `summary` says it, a line per change, as the owner is shown it.
    `apply` makes it, for the owner, as the asking agent's call would have;
    it raises when it is refused, as that call would have."""

    requested_by_id: str
    requested_by: str
    owner_id: str
    agent_name: str
    agent_id: str | None
    fields: tuple[str, ...]
    summary: tuple[str, ...]
    apply: Callable[[], Awaitable[None]]


class ChangeAlreadyWaiting(ValueError):
    """Another change to the same agent is already waiting in that room."""

    def __init__(self, waiting: ChangeRequest) -> None:
        super().__init__(
            f"A change to {waiting.agent_name} that {waiting.requested_by} asked "
            "for is already waiting for its owner to confirm it in this room. "
            "Nothing was changed; ask again once it is confirmed, dropped or "
            "lapsed."
        )
        self.waiting = waiting


class AgentRequests:
    """Requests an agent has made that a person has to confirm.

    An agent may ask, never decide. A deletion waits until the agent's owner
    or a workspace admin confirms it with `!delete-agent <name> confirm` in
    the same room, which the admin client checks like any other delete. A
    change to what another agent may do on its own, or a new agent that may
    do more than usual, waits until the owner, and only the owner, confirms
    it with `!agent-change <name> confirm` there (`agent_change_requests`
    says which). Kept in memory, so a restart drops every pending request,
    which errs on the side of doing nothing.
    """

    def __init__(self) -> None:
        self._pending: dict[tuple[str, str], DeletionRequest] = {}
        # (room id, agent name lowered) -> the change and when it lapses.
        self._changes: dict[tuple[str, str], tuple[ChangeRequest, float]] = {}

    def add(self, room_id: str, agent_id: str, requested_by: str) -> None:
        self._prune()
        self._pending[(room_id, agent_id)] = DeletionRequest(
            requested_by=requested_by,
            expires=time.monotonic() + CONFIRM_SECONDS,
        )

    def take(self, room_id: str, agent_id: str) -> DeletionRequest | None:
        """The request to delete `agent_id` made in this room, if one is still
        waiting; used up either way."""
        self._prune()
        return self._pending.pop((room_id, agent_id), None)

    def hold_change(self, room_id: str, request: ChangeRequest) -> None:
        """Keep `request` until it is confirmed, dropped or lapses. Refused
        while another change to the same agent waits in the room, so what the
        owner confirms is always what they were shown."""
        self._prune()
        key = (room_id, request.agent_name.lower())
        waiting = self._changes.get(key)
        if waiting is not None:
            raise ChangeAlreadyWaiting(waiting[0])
        self._changes[key] = (request, time.monotonic() + CONFIRM_SECONDS)

    def waiting_change(self, room_id: str, agent_name: str) -> ChangeRequest | None:
        """The change to the agent named `agent_name` waiting in this room."""
        self._prune()
        waiting = self._changes.get((room_id, agent_name.lower()))
        return waiting[0] if waiting is not None else None

    def take_change(self, room_id: str, agent_name: str) -> ChangeRequest | None:
        """The change waiting in this room, if any; used up either way."""
        self._prune()
        waiting = self._changes.pop((room_id, agent_name.lower()), None)
        return waiting[0] if waiting is not None else None

    def _prune(self) -> None:
        now = time.monotonic()
        for key, request in list(self._pending.items()):
            if request.expires <= now:
                del self._pending[key]
        for change_key, (_change, expires) in list(self._changes.items()):
            if expires <= now:
                del self._changes[change_key]
