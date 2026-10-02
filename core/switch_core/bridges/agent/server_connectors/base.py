from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from typing import TYPE_CHECKING

from pydantic import BaseModel

from switch_core.bridges.agent.protocol.types import (
    CommandPayload,
    IntegrationProfile,
    MessagePayload,
    ModelSpec,
    TaskCancelPayload,
    TaskDelegatePayload,
    TaskFinalisePayload,
    TaskUpdatePayload,
    ToolSpec,
)

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.types import LlmCallReport, ToolCallReport


class ConnectorReporter:
    """Callback interface for connectors to send messages and report events.

    Injected by the core per agent handle, keeping connectors
    decoupled from the bridge API client.
    """

    async def send_message(self, room_id: str, content: str) -> None:
        raise NotImplementedError

    async def report_events(
        self, room_id: str, events: Sequence[ToolCallReport | LlmCallReport]
    ) -> None:
        raise NotImplementedError

    async def send_status(self, room_id: str, detail: str) -> None:
        raise NotImplementedError

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        raise NotImplementedError


class ServerSideConnectorConfig(BaseModel):
    """Base configuration for server-side connectors. Subclassed per connector type."""


class DiscoveredAgent(BaseModel):
    """An agent discovered from an external platform."""

    name: str
    description: str
    integration_profile: IntegrationProfile
    tools: list[ToolSpec] = []
    models: list[ModelSpec] = []


class ServerSideConnector(ABC):
    """Base class for server-side agent connectors.

    Subclasses implement the external-platform-specific logic:
    discovering agents, forwarding messages, and managing sessions.
    The lifecycle service handles all Switch API communication.
    """

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        """The URLs in this config that Switch connects to.

        Checked against the deployment's `OutboundPolicy` when the connector is
        registered and each time it starts.
        """
        return []

    @abstractmethod
    async def start(self) -> None:
        """Initialize connection to the external platform."""

    @abstractmethod
    async def stop(self) -> None:
        """Clean up connection to the external platform."""

    @abstractmethod
    async def discover_agents(self) -> list[DiscoveredAgent]:
        """Discover available agents on the external platform."""

    @abstractmethod
    async def handle_message(
        self,
        agent_name: str,
        room_id: str,
        message: MessagePayload,
        reporter: ConnectorReporter,
    ) -> str | None:
        """Handle an addressed message. Return response text, or None if
        the connector already sent the response via the reporter."""

    async def handle_context(
        self, agent_name: str, room_id: str, message: MessagePayload
    ) -> None:
        """Inject an unaddressed message as context (no response expected)."""

    @abstractmethod
    async def handle_command(
        self, agent_name: str, room_id: str, command: CommandPayload
    ) -> None:
        """Handle a command event."""

    async def handle_task_delegate(
        self, agent_name: str, room_id: str, task: TaskDelegatePayload
    ) -> str:
        """Handle a delegated task. Returns the result text."""
        return ""

    async def handle_task_update(
        self, agent_name: str, room_id: str, task: TaskUpdatePayload
    ) -> None:
        """Handle a task progress update notification."""

    async def handle_task_finalise(
        self, agent_name: str, room_id: str, task: TaskFinalisePayload
    ) -> None:
        """Handle a task finalise notification."""

    async def handle_task_cancel(
        self, agent_name: str, room_id: str, task: TaskCancelPayload
    ) -> None:
        """Handle a task cancellation."""
