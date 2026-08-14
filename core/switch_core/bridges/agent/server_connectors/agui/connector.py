"""The AG-UI server-side connector.

Switch drives a framework agent that is an HTTP server: a room message becomes
a run, the run's output becomes room messages, and the tools the agent calls
are Switch's own operations.

**Runs happen in a background task, and that is the one place this connector
deliberately departs from the OpenCode reference.** `ConnectorCore` awaits each
handler inline in a single per-agent poll loop, and an agent's heartbeat only
fires when that loop re-enters `poll_events`. The poll timeout is 30s against a
90s liveness TTL, so a handler that blocks for ninety seconds makes the agent
show as `DISCONNECTED` while it is actively working — and an LLM run with a
tool-call loop routinely takes longer than that. Returning `None` immediately
and reporting through the reporter keeps the poll loop free.

That trade has a cost, paid here: backgrounding gives up the serialisation the
inline await provided, so this connector keeps its own lock per (agent, room)
and bounds how many turns may queue behind one another.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

from pydantic import Field, field_validator

from switch_core.bridges.agent.api.operations import call_operation
from switch_core.bridges.agent.operations.context import get_protocol
from switch_core.bridges.agent.operations.definitions import (
    bind_room_for_connectionless_caller,
)
from switch_core.bridges.agent.protocol.types import (
    CommandCapabilities,
    CommandPayload,
    IntegrationProfile,
    MessagePayload,
    TaskDelegatePayload,
    TaskProtocolConfig,
)
from switch_core.bridges.agent.server_connectors.agui.assembly import (
    AgentToolResult,
    StateOutput,
    StatusOutput,
    TextOutput,
)
from switch_core.bridges.agent.server_connectors.agui.client import (
    DEFAULT_READ_TIMEOUT_SECONDS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    AgUiClient,
    build_http_client,
)
from switch_core.bridges.agent.server_connectors.agui.events import AgUiProtocolError
from switch_core.bridges.agent.server_connectors.agui.history import (
    DEFAULT_HISTORY_LIMIT,
    build_context,
    build_messages,
)
from switch_core.bridges.agent.server_connectors.agui.request import UserMessage
from switch_core.bridges.agent.server_connectors.agui.run_loop import (
    DEFAULT_MAX_ITERATIONS,
    AgUiRunLoop,
)
from switch_core.bridges.agent.server_connectors.agui.tools import room_scoped_tools
from switch_core.bridges.agent.server_connectors.base import (
    ConnectorReporter,
    DiscoveredAgent,
    ServerSideConnector,
    ServerSideConnectorConfig,
)

logger = logging.getLogger(__name__)

MAX_QUEUED_TURNS_PER_ROOM = 2
"""How many turns may wait on a room's in-flight run before Switch says no.

Small on purpose: a room where turns are piling up needs to be told, not to
accumulate a backlog the humans in it cannot see."""

_INTEGRATION_PROFILE = IntegrationProfile(
    # "always reachable", not "always speaking" — an AG-UI agent can only ever
    # answer a run Switch started, so it never initiates. Stage C of the agent
    # protocol replaces this with a connection scope.
    connection_model="always_on",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
    command_capabilities=CommandCapabilities(
        reset="always",
        compact="unsupported",
        interrupt="unsupported",
    ),
)


class AgUiConnectionConfig(ServerSideConnectorConfig):
    """What an operator supplies to connect one framework agent.

    The bearer token is stored in `connection_config`, which is plain JSONB —
    the same treatment the OpenCode connector's password gets, and write-only
    over the gateway API. It is *not* encrypted at rest. Doing that properly
    means teaching the shared connector lifecycle to encrypt declared secret
    fields, which would change how every connector's stored config is read;
    that is a change worth making, and worth making deliberately rather than
    as a side effect of adding AG-UI.
    """

    endpoint_url: str = Field(
        title="Endpoint URL",
        description="The agent's AG-UI endpoint, e.g. https://host/agui",
    )
    agent_name: str = Field(
        title="Agent name",
        description="The name this agent appears under in Switch rooms.",
    )
    description: str = Field(
        default="A framework-built agent that speaks the AG-UI protocol.",
        title="Description",
    )
    bearer_token: str = Field(
        default="",
        title="Bearer token",
        description="Sent as Authorization on every run. Leave blank if the endpoint is unauthenticated.",
        json_schema_extra={"format": "password"},
    )
    history_limit: int = Field(
        default=DEFAULT_HISTORY_LIMIT,
        title="History messages",
        description="How many recent room messages each run carries.",
    )
    max_iterations: int = Field(
        default=DEFAULT_MAX_ITERATIONS,
        title="Max tool iterations",
        description="How many times one turn may call tools before being abandoned.",
    )
    read_timeout_seconds: float = Field(
        default=DEFAULT_READ_TIMEOUT_SECONDS, title="Read timeout (s)"
    )
    run_timeout_seconds: float = Field(
        default=DEFAULT_RUN_TIMEOUT_SECONDS, title="Run timeout (s)"
    )

    @field_validator("endpoint_url")
    @classmethod
    def _validate_endpoint(cls, value: str) -> str:
        """Reject an endpoint Switch should not be dialling.

        Switch making outbound HTTP to an operator-supplied address is new
        attack surface, so the shape is checked at registration rather than
        discovered at the first run. Private and loopback addresses are
        deliberately *allowed* — an agent running beside Switch is the ordinary
        development case — which means the network boundary, not this
        validator, is what confines where Switch can reach.
        """
        parsed = urlparse(value.strip())

        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"endpoint URL must be http or https, got {parsed.scheme or 'nothing'!r}"
            )
        if not parsed.hostname:
            raise ValueError("endpoint URL has no host")
        if parsed.username or parsed.password:
            raise ValueError(
                "endpoint URL must not embed credentials; use the bearer token field"
            )
        return value.strip()

    @field_validator("history_limit", "max_iterations")
    @classmethod
    def _must_be_positive(cls, value: int) -> int:
        if value < 1:
            raise ValueError("must be at least 1")
        return value


class AgUiConnector(ServerSideConnector):
    """One configured AG-UI endpoint, as a Switch agent."""

    def __init__(self, config: AgUiConnectionConfig) -> None:
        self._config = config
        self._client: AgUiClient | None = None
        self._http: Any = None
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._queued: dict[tuple[str, str], int] = {}
        self._runs: set[asyncio.Task[None]] = set()
        self._agent_ids: dict[str, str] = {}
        self._state: dict[tuple[str, str], Any] = {}

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._http = build_http_client(self._config.read_timeout_seconds)
        self._client = AgUiClient(
            endpoint_url=self._config.endpoint_url,
            bearer_token=self._config.bearer_token or None,
            http=self._http,
            run_timeout_seconds=self._config.run_timeout_seconds,
        )

    async def stop(self) -> None:
        for task in list(self._runs):
            task.cancel()
        self._runs.clear()
        if self._http is not None:
            await self._http.aclose()
        self._http = None
        self._client = None
        self._locks.clear()
        self._queued.clear()

    async def discover_agents(self) -> list[DiscoveredAgent]:
        """One endpoint, one agent.

        AG-UI has no discovery: no well-known URL, no agent card, and the
        reference client does not implement capability negotiation. So there is
        nothing to enumerate — the agent is whatever the operator configured.
        """
        return [
            DiscoveredAgent(
                name=self._config.agent_name,
                description=self._config.description,
                integration_profile=_INTEGRATION_PROFILE,
            )
        ]

    # ── Events from the room ─────────────────────────────────────────────────

    async def handle_message(
        self,
        agent_name: str,
        room_id: str,
        message: MessagePayload,
        reporter: ConnectorReporter,
    ) -> str | None:
        """Start the turn and get out of the poll loop's way.

        Returning `None` tells the core that the response is the reporter's
        job. See the module docstring for why this cannot simply be awaited.
        """
        key = (agent_name, room_id)
        if self._queued.get(key, 0) >= MAX_QUEUED_TURNS_PER_ROOM:
            await reporter.send_message(
                room_id,
                "I'm still working through earlier messages in this room and "
                "have too many queued to take another. Please try again shortly.",
            )
            return None

        self._queued[key] = self._queued.get(key, 0) + 1
        task = asyncio.create_task(
            self._run_turn(agent_name, room_id, message, reporter)
        )
        self._runs.add(task)
        task.add_done_callback(self._runs.discard)
        return None

    async def handle_command(
        self, agent_name: str, room_id: str, command: CommandPayload
    ) -> None:
        if command.command == "reset":
            self._state.pop((agent_name, room_id), None)

    async def handle_task_delegate(
        self, agent_name: str, room_id: str, task: TaskDelegatePayload
    ) -> str:
        """Tasks run inline, because the core finalises on this return value.

        A delegated task is not subject to the heartbeat problem in the same
        way — the core's own accept/finalise wrapper owns the lifecycle — so
        this stays synchronous rather than inventing a second reporting path.
        """
        return await self._collect_turn(
            agent_name,
            room_id,
            prompt=f"{task.summary}\n\n{task.description}",
            reporter=None,
        )

    # ── Running a turn ───────────────────────────────────────────────────────

    async def _run_turn(
        self,
        agent_name: str,
        room_id: str,
        message: MessagePayload,
        reporter: ConnectorReporter,
    ) -> None:
        key = (agent_name, room_id)
        lock = self._locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                await reporter.set_typing(room_id, True)
                try:
                    await self._drive(agent_name, room_id, message.body, reporter)
                finally:
                    await reporter.set_typing(room_id, False)
        except asyncio.CancelledError:
            raise
        except AgUiProtocolError as exc:
            logger.warning("AG-UI turn failed in room %s: %s", room_id, exc)
            await self._report_failure(reporter, room_id, str(exc))
        except Exception as exc:
            logger.exception("AG-UI turn raised in room %s", room_id)
            await self._report_failure(
                reporter, room_id, f"{type(exc).__name__}: {exc}"
            )
        finally:
            self._queued[key] = max(0, self._queued.get(key, 1) - 1)

    async def _collect_turn(
        self,
        agent_name: str,
        room_id: str,
        prompt: str,
        reporter: ConnectorReporter | None,
    ) -> str:
        collected: list[str] = []
        await self._drive(agent_name, room_id, prompt, reporter, collect=collected)
        return "\n\n".join(collected) or "The agent produced no output."

    async def _drive(
        self,
        agent_name: str,
        room_id: str,
        prompt: str,
        reporter: ConnectorReporter | None,
        collect: list[str] | None = None,
    ) -> None:
        if self._client is None:
            raise RuntimeError("Connector not started — call start() first")

        agent_id = await self._resolve_agent_id(agent_name)
        session_key = _session_key(agent_id, room_id)
        await self._bind_room(agent_id, session_key, room_id)

        timeline = await call_operation(
            operation="read_context",
            arguments={"limit": self._config.history_limit},
            agent_id=agent_id,
            connection_id=session_key,
        )

        messages = build_messages(
            timeline, own_agent_name=agent_name, limit=self._config.history_limit
        )
        messages.append(UserMessage(id=f"turn-{room_id}", content=prompt))

        loop = AgUiRunLoop(
            client=self._client,
            tools=room_scoped_tools(),
            agent_id=agent_id,
            session_key=session_key,
            max_iterations=self._config.max_iterations,
        )

        async for output in loop.run(
            thread_id=_thread_id(room_id),
            messages=messages,
            context=build_context(
                timeline, room_name=room_id, limit=self._config.history_limit
            ),
            state=self._state.get((agent_name, room_id)),
        ):
            await self._emit(output, room_id, reporter, collect)

        self._state[(agent_name, room_id)] = loop.latest_state

    async def _emit(
        self,
        output: Any,
        room_id: str,
        reporter: ConnectorReporter | None,
        collect: list[str] | None,
    ) -> None:
        if isinstance(output, TextOutput):
            if collect is not None:
                collect.append(output.content)
            elif reporter is not None:
                await reporter.send_message(room_id, output.content)
        elif isinstance(output, StatusOutput) and reporter is not None:
            await reporter.send_status(room_id, output.detail)
        elif isinstance(output, (AgentToolResult, StateOutput)):
            logger.debug("AG-UI produced %s in room %s", type(output).__name__, room_id)

    async def _report_failure(
        self, reporter: ConnectorReporter | None, room_id: str, detail: str
    ) -> None:
        """Say what went wrong in the room rather than going quiet.

        A turn that fails silently is indistinguishable from an agent that
        decided not to answer, which is precisely the confusion this connector
        exists to avoid inheriting.
        """
        if reporter is None:
            return
        await reporter.send_message(room_id, f"I could not complete that: {detail}")

    # ── Identity and room binding ────────────────────────────────────────────

    async def _resolve_agent_id(self, agent_name: str) -> str:
        cached = self._agent_ids.get(agent_name)
        if cached is not None:
            return cached

        protocol = get_protocol()
        async with protocol.session_factory() as session:
            agent = await protocol.agent_store.get_by_name(session, agent_name)
        if agent is None:
            raise RuntimeError(f"AG-UI agent {agent_name!r} is not registered")

        self._agent_ids[agent_name] = agent.id
        return agent.id

    async def _bind_room(self, agent_id: str, session_key: str, room_id: str) -> None:
        """Give the run a session key that resolves to this room.

        Room-scoped operations find their room from the caller's binding, and a
        Switch-driven run has no agent-held session to supply one — so Switch
        mints a stable key per (agent, room) and records the binding itself.
        """
        await bind_room_for_connectionless_caller(
            get_protocol(),
            agent_id=agent_id,
            connection_id=session_key,
            room_id=room_id,
            connection_model=_INTEGRATION_PROFILE.connection_model,
        )


def _session_key(agent_id: str, room_id: str) -> str:
    """Stable per (agent, room), so the binding is reused rather than rewritten."""
    return f"agui:{agent_id}:{room_id}"


def _thread_id(room_id: str) -> str:
    return f"switch-room-{room_id}"
