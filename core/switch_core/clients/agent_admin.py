"""The agent rename and delete the in-room commands run.

The admin client is registered before AgentCore exists, since AgentCore is
built with the agent bridge app that needs the client factory. This holder is
passed in at registration and bound once AgentCore is made, so the commands
reach the very same rename and delete the gateway and the agent tool use.
"""

from __future__ import annotations

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
