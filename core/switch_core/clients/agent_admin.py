"""The agent rename and delete the in-room commands run.

The admin client is registered before AgentCore exists, since AgentCore is
built with the agent bridge app that needs the client factory. This holder is
passed in at registration and bound once AgentCore is made, so the commands
reach the very same rename and delete the gateway and the agent tool use.
"""

from __future__ import annotations

import time
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


# How long a deletion waits for a person to confirm it.
DELETE_CONFIRM_SECONDS = 120.0


@dataclass(frozen=True)
class DeletionRequest:
    requested_by: str
    expires: float


class AgentDeletionRequests:
    """Deletions an agent has asked for, waiting for a person to confirm.

    An agent may ask, never decide: the request sits here until the agent's
    owner or a workspace admin confirms it with `!delete-agent <name> confirm`
    in the same room, which the admin client checks like any other delete.
    Kept in memory, so a restart drops every pending request, which errs on
    the side of not deleting.
    """

    def __init__(self) -> None:
        self._pending: dict[tuple[str, str], DeletionRequest] = {}

    def add(self, room_id: str, agent_id: str, requested_by: str) -> None:
        self._prune()
        self._pending[(room_id, agent_id)] = DeletionRequest(
            requested_by=requested_by,
            expires=time.monotonic() + DELETE_CONFIRM_SECONDS,
        )

    def take(self, room_id: str, agent_id: str) -> DeletionRequest | None:
        """The request to delete `agent_id` made in this room, if one is still
        waiting; used up either way."""
        self._prune()
        return self._pending.pop((room_id, agent_id), None)

    def _prune(self) -> None:
        now = time.monotonic()
        for key, request in list(self._pending.items()):
            if request.expires <= now:
                del self._pending[key]
