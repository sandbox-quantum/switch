"""A real Switch agent-bridge server on a real socket, for benchmarking.

The point of this module is what it does *not* do. It calls
`create_agent_bridge_app` with the same arguments `switch_core.main` passes, and
serves the app it gets back over uvicorn on a loopback port. Nothing is
reimplemented, stubbed or monkeypatched: routing, authentication, the session
authority, the event buffer and the SSE stream are the shipped ones, so a
measurement taken here is a measurement of the server.

Two things are added from the outside, both wrapping objects this module owns
rather than anything under `switch_core`: an ASGI layer around the returned app,
and a commit listener on the engine the fixtures built. See `instrumentation`.

A real socket rather than an in-process transport because the thing under study
is a connection model. `TestClient` and ASGI transports collapse the socket, the
event loop handoff and the keep-alive behaviour that a connection-count question
is entirely about.
"""

from __future__ import annotations

import asyncio
import socket
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Any, cast

import httpx
import uvicorn
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.engine import create_unpooled_engine
from switch_core.db.models import (
    TENANT_ZERO_ID,
    User,
)
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.main import (
    _connection_sweep_loop,
    _runtime_state_sweep_loop,
    _seed_agent_registration_bootstrap_key,
)
from switch_core.messages.notify import MessageListener
from switch_core.observability.runtime import EventLoopLag
from switch_core.provisioning import Provisioning
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.session_activity.listener import SessionActivityListener
from switch_core.session_activity.outcomes import ApprovalOutcomes
from switch_core.session_activity.service import SessionActivityService
from switch_core.sessions.contract import CommandStatus
from switch_core.sessions.service import SessionAuthority
from switch_core.tenant_context import bind_tenant_id, tenant_scope
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from tests.benchmarks.instrumentation import (
    RequestCounter,
    StallGate,
    TracingMiddleware,
    count_statements,
    trace_commits,
)
from tests.benchmarks.trace import TraceCollector
from tests.integration.conftest import (
    GATEWAY_ADMIN_EMAIL,
    SessionEnv,
    _NoBridges,
    _truncate_all,
)

# Agents driven by a host process, which is what the benchmark spawns. The
# profile has to say so: `session_passive` would suppress the addressed
# delivery the whole measurement is built on.
BENCH_PROFILE = IntegrationProfile(
    connection_model="always_on",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class _BenchBridges(_NoBridges):
    """`_NoBridges`, plus the one call the admission path makes.

    With no collaboration bridge registered the real
    `CollaborationBridgeLifecycleService.refresh_sdk_session` iterates an empty
    set of bridges, so doing nothing here is what the real service does — not a
    shortcut past behaviour the benchmark should be paying for. A benchmark run
    measures the agent connection model; bridge fan-out is a separate cost and
    is deliberately not in these numbers.
    """

    async def refresh_sdk_session(self, session_id: str) -> None:
        return None


@dataclass(frozen=True, slots=True)
class SessionSelector:
    """What a caller sends to act as one session of an agent: the session, and
    the agent connection it calls over."""

    session_id: str
    connection_id: str

    def headers(self) -> dict[str, str]:
        return {
            "X-Switch-Session-Id": self.session_id,
            "X-Switch-Connection-Id": self.connection_id,
        }


@dataclass(frozen=True, slots=True)
class BenchAgent:
    agent_id: str
    name: str
    api_key: str


class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:
        """Leave the test runner's signal handling alone.

        uvicorn replaces SIGINT and SIGTERM on `serve()`. In-process that would
        take Ctrl-C away from pytest for the rest of the run.
        """
        return


class BenchServer:
    """A running agent bridge, plus the few setup operations a run needs."""

    def __init__(
        self,
        *,
        base_url: str,
        port: int,
        protocol: ProtocolService,
        room_service: RoomService,
        client_lifecycle: ClientLifecycleService,
        event_buffer: EventBuffer,
        connections: ConnectionRegistry,
        collector: TraceCollector,
        stalls: StallGate,
        requests: RequestCounter,
        statements: Counter[str],
        owner_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        agents: tuple[BenchAgent, ...],
    ) -> None:
        self.base_url = base_url
        self.port = port
        self.protocol = protocol
        self.room_service = room_service
        self.client_lifecycle = client_lifecycle
        self.event_buffer = event_buffer
        self.connections = connections
        self.collector = collector
        self.stalls = stalls
        self.requests = requests
        self.statements = statements
        self.owner_id = owner_id
        self._session_factory = session_factory
        self._agents: list[BenchAgent] = list(agents)

    @property
    def agents(self) -> tuple[BenchAgent, ...]:
        """The agents registered here, for a Core that takes this one's place.

        Their keys are held by host processes that outlive a restart, so a
        replacement adopts them rather than registering the agents again.
        """
        return tuple(self._agents)

    def placed_sessions(
        self, agent_id: str, room_ids: list[str]
    ) -> dict[str, str | None]:
        """Per room, the session of this agent Switch has working in it."""
        return {
            room_id: self.connections.session_in_room(agent_id, room_id)
            for room_id in room_ids
        }

    async def connect_session_to_room(
        self, *, agent: BenchAgent, selector: SessionSelector, room_id: str
    ) -> dict[str, Any]:
        """Call `connect_to_room` over the agent door, as one named session.

        The same request the agent runtime makes when a session's own agent
        asks to work in a room: the shipped operation, over the socket, with
        the session selector the runtime sends. The benchmark provider never
        calls a tool, so this is the only way a scenario reaches the door a
        room move actually comes through.
        """
        async with httpx.AsyncClient(base_url=self.base_url, timeout=30.0) as client:
            response = await client.post(
                f"/agents/{agent.agent_id}/ops/connect_to_room",
                json={"room_id": room_id, "include_general_instructions": False},
                headers={
                    "Authorization": f"Bearer {agent.api_key}",
                    **selector.headers(),
                },
            )
        response.raise_for_status()
        return cast("dict[str, Any]", response.json()["result"])

    async def room_control(
        self, *, agent_id: str, room_id: str, action: str, message_id: str
    ) -> CommandStatus:
        """Submit a room control command the way a room command arrives.

        The authority's own entry point, so the command is admitted, fenced
        against the session that holds the room and ordered with everything
        else that session has been given — not a queue entry written past it.
        """
        receipt = await SessionAuthority(self._session_factory).submit_room_control(
            agent_id,
            room_id,
            action,
            self.owner_id,
            message_id,
            None,
            self.connections,
        )
        if receipt is None:
            raise RuntimeError(f"agent {agent_id} has no session to control")
        return receipt

    async def control_outcome(self, *, session_id: str, command_id: str) -> str:
        """What became of a submitted command, as the server records it."""
        status = await SessionAuthority(self._session_factory).command_status(
            session_id, command_id, self.owner_id
        )
        return status.status

    async def register_agent(self, name: str) -> BenchAgent:
        result = await self.protocol.register_agent(
            name=name,
            description=f"benchmark agent {name}",
            connector_type="claude-code",
            integration_profile=BENCH_PROFILE,
            owner_id=self.owner_id,
            overwrite=True,
            owner_only=False,
        )
        agent = BenchAgent(agent_id=result.agent_id, name=name, api_key=result.api_key)
        self._agents.append(agent)
        return agent

    async def start_clients(self, timeout: float) -> None:
        await self.client_lifecycle.start_all()
        deadline = asyncio.get_event_loop().time() + timeout
        for agent in self._agents:
            client = await self._await_client(agent.agent_id, deadline)
            await client.wait_ready()

    async def _await_client(self, agent_id: str, deadline: float) -> AgentClient:
        while asyncio.get_event_loop().time() < deadline:
            client = self.client_lifecycle.get_by_agent_id(agent_id)
            if client is not None:
                return client  # type: ignore[return-value]
            await asyncio.sleep(0.05)
        raise RuntimeError(f"agent {agent_id} never started a client")

    async def create_room(self, name: str, agent_ids: list[str]) -> str:
        result = await self.room_service.create_room(
            RoomCreateConfig(
                name=name,
                description="connection-model baseline benchmark room",
                agent_ids=agent_ids,
            )
        )
        return result.room.id

    async def address(
        self, *, sender: BenchAgent, room_id: str, target: str, body: str
    ) -> str:
        """Post a message addressed to `target`, returning its message id.

        The message id is half the correlation every trace point is keyed on,
        so a caller that drops it cannot score the event it just created.
        """
        result = await self.protocol.send_targeted_message(
            sender.agent_id, room_id, [target], body
        )
        return result.event_id


@asynccontextmanager
async def bench_server(
    session_env: SessionEnv, collector: TraceCollector
) -> AsyncIterator[BenchServer]:
    """Boot the agent bridge on a loopback port for the life of the block."""
    owner_id = await _prepare(session_env)
    async with _serve(
        session_env=session_env,
        collector=collector,
        owner_id=owner_id,
        port=0,
        agents=(),
    ) as server:
        yield server


class BenchCore:
    """A bench server that can be stopped and started again on its own database.

    Restarting is the whole point of it. The agent bridge holds the replay
    buffer and the connection registry in memory, so a Core that comes back is
    one whose buffer is gone while every row it wrote is still there — the state
    a delivery reserved before the restart has to survive on.

    The port is kept across the restart. Hosts that outlived the Core were
    pointed at an address and go on retrying it, as they would against a
    restarted server at a fixed address; moving the port would make the
    scenario measure reconfiguration instead of recovery.
    """

    def __init__(
        self,
        *,
        session_env: SessionEnv,
        collector: TraceCollector,
        owner_id: str,
        server: BenchServer,
        running: AbstractAsyncContextManager[BenchServer],
    ) -> None:
        self._session_env = session_env
        self._collector = collector
        self._owner_id = owner_id
        self._server = server
        self._running = running

    @property
    def server(self) -> BenchServer:
        """The Core that is serving now, which a restart replaces."""
        return self._server

    async def restart(self) -> None:
        port, agents = self._server.port, self._server.agents
        await self._running.__aexit__(None, None, None)
        self._running = _serve(
            session_env=self._session_env,
            collector=self._collector,
            owner_id=self._owner_id,
            port=port,
            agents=agents,
        )
        self._server = await self._running.__aenter__()

    async def aclose(self) -> None:
        await self._running.__aexit__(None, None, None)


@asynccontextmanager
async def restartable_bench_server(
    session_env: SessionEnv, collector: TraceCollector
) -> AsyncIterator[BenchCore]:
    """The same server, wrapped so a scenario can restart it mid-run."""
    owner_id = await _prepare(session_env)
    running = _serve(
        session_env=session_env,
        collector=collector,
        owner_id=owner_id,
        port=0,
        agents=(),
    )
    core = BenchCore(
        session_env=session_env,
        collector=collector,
        owner_id=owner_id,
        server=await running.__aenter__(),
        running=running,
    )
    try:
        yield core
    finally:
        await core.aclose()


async def _prepare(session_env: SessionEnv) -> str:
    """Empty the database and seed what a Core needs before it serves.

    Separate from serving because a Core that replaces another one must not do
    it: the agents, rooms and sessions in that database are exactly what the
    restart is supposed to come back to.
    """
    await _truncate_all(session_env.owner_engine)
    session_factory = cast(
        "async_sessionmaker[AsyncSession]", session_env.session_factory
    )
    with tenant_scope(TENANT_ZERO_ID):
        owner = User(name="Admin", email=GATEWAY_ADMIN_EMAIL, role="admin")
        async with session_factory() as session:
            await session_env.user_store.create(session, owner)
            await session.commit()
        await _seed_agent_registration_bootstrap_key(
            session_factory,
            session_env.user_store,
            session_env.api_key_store,
            session_env.agent_store,
            session_env.config,
        )
    return owner.id


@asynccontextmanager
async def _serve(
    *,
    session_env: SessionEnv,
    collector: TraceCollector,
    owner_id: str,
    port: int,
    agents: tuple[BenchAgent, ...],
) -> AsyncIterator[BenchServer]:
    """Serve the agent bridge until the block ends.

    Only one may run per process: `init_dependencies` stores the wiring in a
    module-level dict that the HTTP routes resolve against, so a second server
    would silently repoint the first one's routes at its own stores. One after
    another is what a restart is, and is fine.

    `port` is 0 for a free port, or the port a previous Core was serving on.
    `agents` are the ones already registered in the database, whose keys the
    hosts still hold.
    """
    config = session_env.config
    # The fixture types this as `object`; every consumer below needs the real
    # signature, so narrow it once here rather than at each call.
    session_factory = cast(
        "async_sessionmaker[AsyncSession]", session_env.session_factory
    )

    # Bound rather than scoped, and deliberately never unbound: a benchmark
    # process serves one tenant, and a Core that replaces another is entered
    # and left from different asyncio contexts, where resetting the token
    # raises instead of unbinding.
    bind_tenant_id(TENANT_ZERO_ID)
    event_buffer = EventBuffer()
    connections = ConnectionRegistry()
    collab_lifecycle = _BenchBridges()

    message_listener = MessageListener(lambda: create_unpooled_engine(config))
    await message_listener.start()
    invites = InviteBus()
    ephemeral = EphemeralBus()

    resource_service = ResourceService(
        reference_store=session_env.reference_store,
        reference_type_store=session_env.reference_type_store,
        document_store=session_env.document_store,
        package_store=session_env.package_store,
        room_link_store=session_env.room_link_store,
        session_factory=session_factory,
    )

    provisioning: Provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=session_env.room_store,
        client_store=session_env.client_store,
        message_store=session_env.message_store,
        invites=invites,
    )

    client_factory = ClientFactory(
        client_store=session_env.client_store,
        session_factory=session_factory,
        config=config,
        room_store=session_env.room_store,
        message_store=session_env.message_store,
        media_store=session_env.media_store,
        listener=message_listener,
        invites=invites,
        ephemeral=ephemeral,
    )
    client_factory.register(
        "agent",
        AgentClient,
        event_buffer=event_buffer,
        agent_store=session_env.agent_store,
        room_store=session_env.room_store,
        bridge_store=session_env.bridge_store,
        document_store=session_env.document_store,
        reference_store=session_env.reference_store,
        agent_session_store=session_env.agent_session_store,
        room_role_store=session_env.room_role_store,
        external_user_store=session_env.external_user_store,
        connections=connections,
        frontend_base_url=config.frontend_base_url,
    )
    client_factory.register("user", ClientBase)
    client_factory.register("bridge", ClientBase)

    client_lifecycle = ClientLifecycleService(
        matrix_admin=provisioning,
        client_store=session_env.client_store,
        tenant_store=TenantStore(),
        client_factory=client_factory,
        session_factory=session_factory,
        config=config,
    )

    room_service = RoomService(
        matrix_admin=provisioning,
        room_store=session_env.room_store,
        agent_store=session_env.agent_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,  # type: ignore[arg-type]
        collab_bridge_store=session_env.bridge_store,
        resource_service=resource_service,
        session_factory=session_factory,
    )

    app, protocol = create_agent_bridge_app(
        agent_store=session_env.agent_store,
        agent_session_store=session_env.agent_session_store,
        room_store=session_env.room_store,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,  # type: ignore[arg-type]
        event_buffer=event_buffer,
        task_store=session_env.task_store,
        resource_service=resource_service,
        api_key_store=session_env.api_key_store,
        external_user_store=session_env.external_user_store,
        bridge_store=session_env.bridge_store,
        session_factory=session_factory,
        config=config,
        # Never started: the benchmark measures room delivery, not approvals.
        approval_outcomes=ApprovalOutcomes(
            SessionActivityListener(lambda: session_env.engine),
            SessionActivityService(session_factory),
        ),
        connections=connections,
    )

    detach_commits = trace_commits(session_env.engine, collector)
    statements, detach_statements = count_statements(session_env.engine)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(2048)
    served_port = sock.getsockname()[1]

    stalls = StallGate(app)
    requests = RequestCounter(TracingMiddleware(stalls, collector))

    server = _Server(
        uvicorn.Config(
            requests,
            log_level="warning",
            access_log=False,
            lifespan="on",
            # The agent protocol's own liveness is the heartbeat; a
            # keep-alive timeout shorter than an idle stream's keepalive
            # interval would close streams the server considers healthy and
            # show up as reconnect churn that the code under study did not
            # cause.
            timeout_keep_alive=120,
        )
    )
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    await _await_started(server, serving)

    # The background sweeps live in `switch_core.main`'s lifespan rather
    # than in the app factory, so a server assembled from the factory alone
    # never reaps a connection whose client stopped beating. The real
    # functions are started here, not copies of them: without the
    # connection sweep a host killed mid-run keeps its stream slot for
    # ever, the server goes on routing that room to a process that is gone,
    # and both the connection count and the recovery case measure a
    # harness defect instead of the topology.
    sweeps = [
        asyncio.create_task(_connection_sweep_loop(protocol, EventLoopLag())),
        asyncio.create_task(_runtime_state_sweep_loop(protocol)),
    ]

    bench = BenchServer(
        base_url=f"http://127.0.0.1:{served_port}",
        port=served_port,
        protocol=protocol,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        event_buffer=event_buffer,
        connections=connections,
        collector=collector,
        stalls=stalls,
        requests=requests,
        statements=statements,
        owner_id=owner_id,
        session_factory=session_factory,
        agents=agents,
    )
    try:
        yield bench
    finally:
        for sweep in sweeps:
            sweep.cancel()
        await asyncio.gather(*sweeps, return_exceptions=True)
        server.should_exit = True
        await serving
        detach_commits()
        detach_statements()
        await client_lifecycle.stop_all()
        await message_listener.stop()
        await provisioning.close()


async def _await_started(server: _Server, serving: asyncio.Task[None]) -> None:
    deadline = asyncio.get_event_loop().time() + 30.0
    while not server.started:
        if serving.done():
            # Surfaces the startup exception rather than timing out on it.
            serving.result()
            raise RuntimeError("the benchmark server exited before it started")
        if asyncio.get_event_loop().time() > deadline:
            raise RuntimeError("the benchmark server did not start within 30s")
        await asyncio.sleep(0.01)
