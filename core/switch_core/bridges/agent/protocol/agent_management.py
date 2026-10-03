"""What the agent operations need from agent management, and nothing more.

Agent management (`switch_core.management`) is behind its own flag, and Core
must not import it. The agent operations that let an agent act on its owner's
machines (`operations/agent_management.py`) are written against this port
instead; management implements it and the process wiring hands the
implementation over, which is also what makes those operations exist at all.

Every method acts for one owner in one tenant and sees only that owner's
machines and managed agents: someone else's machine is answered exactly as one
that does not exist. A refusal is an `AgentManagementRefused`, carrying a
reason code and a sentence the agent can relay to a person as it is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore


class AgentManagementRefused(ValueError):
    """Management said no: a machine that is not the owner's, a placement it
    refuses, a definition that does not validate. A ValueError, so it reaches
    the agent the way every other operation error does; `code` is the
    management reason code (`controller_offline`, `provider_not_installed`,
    `not_found`, ...)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class NewManagedAgent:
    """A managed agent an agent asks to have created for its owner.

    `machine` is the machine's id, or its exact name among the owner's
    machines that are not revoked."""

    name: str
    description: str
    display_name: str | None
    machine: str
    provider: str
    model: str | None
    instructions: str
    directory: str | None
    auto_approve: bool
    start: bool


class AgentManagementPort(Protocol):
    async def list_machines(
        self, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        """The owner's machines that are not revoked."""
        ...

    async def create_agent(
        self,
        tenant_id: str,
        owner_id: str,
        spec: NewManagedAgent,
        protocol: AgentCore,
    ) -> dict[str, Any]:
        """Create and place a managed agent owned by `owner_id`."""
        ...

    async def list_managed_agents(
        self, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        """The owner's managed agents, with where each runs and how it is doing."""
        ...
