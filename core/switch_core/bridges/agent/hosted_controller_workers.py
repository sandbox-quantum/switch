"""Cloud agent workers that attach through their machine's agents controller.

A cloud agent placed on its machine's controller holds no connection of its
own: its worker opens its stream on the controller's local relay, and the
relay asks Core to admit it here, on the controller's open connection. The
admission is the one a worker opening its own stream gets
(`hosted_worker_routes.admit_worker`); what differs is where the worker is
recorded (`ControllerPresence.attach_worker`) and how its frames reach it
(the controller's stream, as `agent.worker`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from switch_core.bridges.agent.api.hosted_worker_routes import (
    admit_worker,
    hosted_worker_only,
    refusal,
)
from switch_core.bridges.agent.hosted_mailbox import deliver_on_attach
from switch_core.bridges.agent.protocol.agent_connections import ClientDeclaration
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
)
from switch_core.bridges.agent.protocol.hosted_workers import hosted_launch_of
from switch_core.config import SwitchConfig
from switch_core.db.models import Agent, HostedLaunch, require_tenant_id
from switch_core.db.session_scope import tenant_session


@dataclass(frozen=True, slots=True)
class ControllerWorkerIdentity:
    """What a worker stated opening its stream on the relay, as the relay
    passes it on."""

    connection_id: str
    generation: int
    spawn_capable: bool
    protocol: int | None
    protocol_accepts: int | None
    capability: str | None
    boot_id: str | None
    instance_id: str | None
    state_version: int | None


async def attach_controller_worker(
    *,
    protocol: AgentCore,
    config: SwitchConfig,
    conn: ControllerConnection,
    agent_id: str,
    identity: ControllerWorkerIdentity,
) -> dict[str, Any]:
    """Admit a cloud agent's worker that opened its stream on its controller's relay.

    The same admission as a worker opening its own stream (`admit_worker`:
    the capability for the launch's current revision, protocol 7, the state
    version, the host identity), under the launch lock, with the attach
    keyed on the controller connection instead of a connection of the
    agent's own. Returns the `worker_attached` payload, which the relay
    writes first on the worker's stream; what is owed afterwards (the wake
    mailbox's offers first) goes out on the controller's stream as
    `agent.worker` frames.
    """
    presence = protocol.connections.controllers
    async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
        agent = await db.get(Agent, agent_id)
        if agent is None:
            raise refusal(404, "not_found", f"agent {agent_id} does not exist")
        launch_id = hosted_launch_of(agent.metadata_)
        if launch_id is None:
            raise hosted_worker_only()
        attach = await admit_worker(
            session=db,
            registry=protocol.connections,
            config=config,
            agent=agent,
            launch_id=launch_id,
            connection_id=identity.connection_id,
            declaration=ClientDeclaration(
                speaks=identity.protocol, accepts=identity.protocol_accepts
            ),
            capability=identity.capability,
            boot_id=identity.boot_id,
            instance_id=identity.instance_id,
            state_version=identity.state_version,
        )
        presence.attach_worker(
            conn,
            agent.id,
            connection_id=identity.connection_id,
            generation=identity.generation,
            spawn_capable=identity.spawn_capable,
            binding=attach.binding,
        )
        launch = await db.get(HostedLaunch, (require_tenant_id(), launch_id))
        assert launch is not None
        await deliver_on_attach(db, protocol, launch)
    return attach.attached
