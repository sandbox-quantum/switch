from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING

from switch_core.bridges.agent.protocol.types import (
    CommandPayload,
    LlmCallReport,
    MessagePayload,
    TaskCancelPayload,
    TaskDelegatePayload,
    TaskFinalisePayload,
    TaskUpdatePayload,
    ToolCallReport,
)
from switch_core.bridges.agent.server_connectors.base import (
    ConnectorReporter,
    DiscoveredAgent,
    ServerSideConnector,
)

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.service import ProtocolService

logger = logging.getLogger(__name__)

# Long-poll timeout for the per-agent poll loop. This is the upper bound on
# how long an idle agent goes between heartbeats (touch_heartbeat fires when
# poll_events is (re)entered), so AgentSessionStore.HEARTBEAT_TTL must stay
# comfortably above it or healthy agents flap to "disconnected" between polls.
CONNECTOR_POLL_TIMEOUT_SECONDS = 30


class _AgentHandle:
    def __init__(self, agent_id: str, agent_name: str) -> None:
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.task: asyncio.Task[None] | None = None


class _ProtocolReporter(ConnectorReporter):
    """Reporter implementation backed by an in-process ProtocolService call."""

    def __init__(self, protocol: ProtocolService, handle: _AgentHandle) -> None:
        self._protocol = protocol
        self._handle = handle

    async def send_message(self, room_id: str, content: str) -> None:
        await self._protocol.send_message(self._handle.agent_id, room_id, content)

    async def report_events(
        self, room_id: str, events: Sequence[ToolCallReport | LlmCallReport]
    ) -> None:
        await self._protocol.report_events(self._handle.agent_id, room_id, list(events))

    async def send_status(self, room_id: str, detail: str) -> None:
        await self._protocol.update_status(self._handle.agent_id, room_id, detail)

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        await self._protocol.set_typing(self._handle.agent_id, room_id, is_typing)


class ConnectorCore:
    """Runtime orchestrator for a single server-side connector.

    Discovers agents on the external platform, registers them through the
    in-process ProtocolService, and runs per-agent poll loops that forward
    messages and tasks between the connector and Switch.

    Server-side connectors live in the same process as Switch core, so they
    do not need HTTP — they call ``ProtocolService`` directly. (External
    agent integrations are the ones that go over the HTTP agent bridge.)
    """

    def __init__(
        self,
        *,
        connector_id: str,
        connector_type: str,
        connector: ServerSideConnector,
        registration_token: str,
        protocol: ProtocolService,
    ) -> None:
        self._connector_id = connector_id
        self._connector_type = connector_type
        self._connector = connector
        self._registration_token = registration_token
        self._protocol = protocol
        self._agents: dict[str, _AgentHandle] = {}

    @property
    def connector(self) -> ServerSideConnector:
        return self._connector

    async def start(self) -> None:
        await self._connector.start()

        discovered = await self._connector.discover_agents()
        logger.info(
            "Connector %s discovered %d agents",
            self._connector_id,
            len(discovered),
        )

        for agent in discovered:
            await self._register_agent(agent)

        logger.info("Started connector core %s", self._connector_id)

    async def stop(self) -> None:
        for handle in self._agents.values():
            if handle.task and not handle.task.done():
                handle.task.cancel()

        await self._connector.stop()
        logger.info("Stopped connector core %s", self._connector_id)

    async def delete_agents(self) -> None:
        for handle in self._agents.values():
            try:
                await self._protocol.delete_agent(agent_id=handle.agent_id)
            except Exception:
                logger.exception(
                    "Failed to delete agent %s during connector removal",
                    handle.agent_id,
                )

    def get_agent_names(self) -> list[str]:
        return [h.agent_name for h in self._agents.values()]

    # ── internal ─────────────────────────────────────────────────────────

    async def _register_agent(self, agent: DiscoveredAgent) -> None:
        try:
            result = await self._protocol.register_agent_with_token(
                registration_token=self._registration_token,
                name=agent.name,
                description=agent.description,
                connector_type=f"server-side:{self._connector_type}",
                integration_profile=agent.integration_profile,
                tools=agent.tools,
                models=agent.models,
                metadata={"server_connector_id": self._connector_id},
                overwrite=True,
                # A server-side connector agent is a service the deployment
                # offers everyone, not one person's assistant; it is owned by
                # whoever holds the registration token only in the bookkeeping
                # sense. Owner-only would make it answer to that account alone.
                owner_only=False,
            )
        except Exception:
            logger.exception(
                "Failed to register agent %s from connector %s",
                agent.name,
                self._connector_id,
            )
            return

        handle = _AgentHandle(result.agent_id, agent.name)
        handle.task = asyncio.create_task(self._poll_loop(handle))
        self._agents[result.agent_id] = handle
        logger.info(
            "Registered agent %s (%s) from connector %s",
            agent.name,
            result.agent_id,
            self._connector_id,
        )

    def _reporter(self, handle: _AgentHandle) -> _ProtocolReporter:
        return _ProtocolReporter(self._protocol, handle)

    async def _poll_loop(self, handle: _AgentHandle) -> None:
        logger.info(
            "Starting poll loop for agent %s (%s)",
            handle.agent_name,
            handle.agent_id,
        )

        while True:
            try:
                events = await self._protocol.poll_events(
                    handle.agent_id, timeout=CONNECTOR_POLL_TIMEOUT_SECONDS
                )
                for event in events:
                    payload = event.payload

                    if isinstance(payload, MessagePayload):
                        await self._handle_message(handle, event.room_id, payload)
                    elif isinstance(payload, CommandPayload):
                        await self._handle_command(handle, event.room_id, payload)
                    elif isinstance(payload, TaskDelegatePayload):
                        await self._handle_task_delegate(handle, event.room_id, payload)
                    elif isinstance(payload, TaskUpdatePayload):
                        await self._handle_task_update(handle, event.room_id, payload)
                    elif isinstance(payload, TaskFinalisePayload):
                        await self._handle_task_finalise(handle, event.room_id, payload)
                    elif isinstance(payload, TaskCancelPayload):
                        await self._handle_task_cancel(handle, event.room_id, payload)
            except asyncio.CancelledError:
                logger.info("Poll loop cancelled for agent %s", handle.agent_name)
                return
            except Exception:
                logger.exception(
                    "Error in poll loop for agent %s (%s)",
                    handle.agent_name,
                    handle.agent_id,
                )
                await asyncio.sleep(5)

    async def _handle_message(
        self,
        handle: _AgentHandle,
        room_id: str,
        payload: MessagePayload,
    ) -> None:
        if not payload.addressed:
            try:
                await self._connector.handle_context(
                    handle.agent_name, room_id, payload
                )
            except Exception:
                logger.exception(
                    "Connector failed to handle context for agent %s",
                    handle.agent_name,
                )
            return

        logger.debug(
            "Handling message for agent %s in room %s", handle.agent_name, room_id
        )

        reporter = self._reporter(handle)

        try:
            response = await self._connector.handle_message(
                handle.agent_name, room_id, payload, reporter
            )
        except Exception:
            logger.exception(
                "Connector failed to handle message for agent %s", handle.agent_name
            )
            response = "Sorry, I encountered an error processing your request."

        if response is not None:
            try:
                await self._protocol.send_message(handle.agent_id, room_id, response)
            except Exception:
                logger.exception(
                    "Failed to send response for agent %s in room %s",
                    handle.agent_name,
                    room_id,
                )

    async def _handle_command(
        self, handle: _AgentHandle, room_id: str, payload: CommandPayload
    ) -> None:
        await self._connector.handle_command(handle.agent_name, room_id, payload)

    async def _handle_task_delegate(
        self, handle: _AgentHandle, room_id: str, payload: TaskDelegatePayload
    ) -> None:
        logger.debug(
            "Handling task_delegate for agent %s, task %s",
            handle.agent_name,
            payload.task_id,
        )

        try:
            await self._protocol.accept_task(handle.agent_id, payload.task_id)

            result = await self._connector.handle_task_delegate(
                handle.agent_name, room_id, payload
            )

            outcome = result if result else "Task failed"
            await self._protocol.finalise_task(
                handle.agent_id, payload.task_id, outcome
            )
        except Exception:
            logger.exception(
                "Failed to handle task_delegate for agent %s, task %s",
                handle.agent_name,
                payload.task_id,
            )
            try:
                await self._protocol.finalise_task(
                    handle.agent_id,
                    payload.task_id,
                    "Connector failed to process task",
                )
            except Exception:
                logger.exception(
                    "Failed to report task failure for task %s", payload.task_id
                )

    async def _handle_task_update(
        self, handle: _AgentHandle, room_id: str, payload: TaskUpdatePayload
    ) -> None:
        await self._connector.handle_task_update(handle.agent_name, room_id, payload)

    async def _handle_task_finalise(
        self, handle: _AgentHandle, room_id: str, payload: TaskFinalisePayload
    ) -> None:
        await self._connector.handle_task_finalise(handle.agent_name, room_id, payload)

    async def _handle_task_cancel(
        self, handle: _AgentHandle, room_id: str, payload: TaskCancelPayload
    ) -> None:
        await self._connector.handle_task_cancel(handle.agent_name, room_id, payload)
