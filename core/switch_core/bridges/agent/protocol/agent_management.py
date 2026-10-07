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
    icon_url: str | None
    machine: str
    provider: str
    model: str | None
    advanced_config: dict[str, Any]
    instructions: str
    directory: str | None
    auto_approve: bool
    start: bool


@dataclass(frozen=True)
class ManagedAgentChanges:
    """What an agent asks to change in a managed agent's definition and
    placement. None leaves a field as it is; for `model` and `directory` an
    empty string clears it (provider default, fresh workspace). `machine` is
    resolved as for `NewManagedAgent`. `advanced_config` replaces the stored
    one whole; {} clears it."""

    provider: str | None
    model: str | None
    advanced_config: dict[str, Any] | None
    instructions: str | None
    auto_approve: bool | None
    directory: str | None
    isolation: str | None
    machine: str | None
    desired_state: str | None

    def definition_changes(self) -> dict[str, Any]:
        """The definition fields given, with their stored values."""
        given: dict[str, Any] = {
            "provider": self.provider,
            "model": self.model,
            "advanced_config": self.advanced_config,
            "instructions": self.instructions,
            "auto_approve": self.auto_approve,
            "directory": self.directory,
            "isolation": self.isolation,
        }
        changes = {key: value for key, value in given.items() if value is not None}
        for clearable in ("model", "directory"):
            if changes.get(clearable) == "":
                changes[clearable] = None
        return changes

    def is_empty(self) -> bool:
        return (
            not self.definition_changes()
            and self.machine is None
            and self.desired_state is None
        )


class AgentManagementPort(Protocol):
    async def list_machines(
        self, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        """The owner's machines that are not revoked."""
        ...

    def advanced_config_fields(self, provider: str) -> list[dict[str, Any]]:
        """The provider's advanced-configuration fields, as the gateway serves
        them. Refused for a provider Switch does not run."""
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

    async def managed_agent(
        self, tenant_id: str, owner_id: str, agent_id: str
    ) -> dict[str, Any] | None:
        """One of the owner's managed agents as `list_managed_agents` shows it,
        or None when the agent is not managed."""
        ...

    async def update_managed_agent(
        self,
        tenant_id: str,
        owner_id: str,
        caller_agent_id: str,
        agent_id: str,
        changes: ManagedAgentChanges,
        protocol: AgentCore,
    ) -> dict[str, Any]:
        """Change a managed agent's definition, machine or desired state, as
        the owner's gateway PATCH would; returns it as `managed_agent` does.
        Refused when `caller_agent_id` is `agent_id`: an agent never changes
        its own definition, which would let it widen its own permissions."""
        ...
