"""Creating the agents a template describes, whole or not at all.

A template that creates agents creates managed agents: Switch registers each
and places it on one of the owner's machines, whose controller runs it. A run
is checked whole before anything exists: every machine can take its agent
now, every name is free, every connection the agents are to be granted is
the owner's to grant. Only then are the agents created, one after another,
with their addressing and connections, and the rooms after them. When
anything fails past that point (a machine drops between the check and the
create, a room cannot be made), the agents the run created are deleted again,
and the refusal says so.

Switch Console and an agent running a saved template both come through here,
with the agents already resolved to what each is (`NewAgentPlan`): the
Console from its form, the server from the document (`agent_templates`).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Literal

from switch_core.addressing import AddressingRule, owner_only_policy
from switch_core.agent_refusals import AgentRefused
from switch_core.authz import Principal, can
from switch_core.bridges.agent.protocol.agent_core import VALID_AGENT_NAME_RE
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.bridges.agent.protocol.agent_management import (
    AgentManagementPort,
    AgentManagementRefused,
    CheckedPlacement,
    NewManagedAgent,
)
from switch_core.connections.broker import CheckedGrant, ServiceBroker, ServiceError
from switch_core.db.models import Agent
from switch_core.db.session_scope import tenant_session

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore

logger = logging.getLogger(__name__)

AGENTS_DIR = "{$agents_dir}"

# How long a run waits, in all, for the clients of the agents it created to
# be taking events before it makes their rooms.
LISTEN_TIMEOUT_SECONDS = 30.0
_CLIENT_POLL_SECONDS = 0.1

# How a template says who may address an agent, and the addressing choice
# each stands for.
TEMPLATE_ADDRESSING = {
    "owner": "owner_only",
    "owner-agents": "owner_and_owner_agents",
    "anyone": "anyone",
}


@dataclass(frozen=True)
class ConnectionPlan:
    """A connection an agent is to be granted: the owner's own connection to
    `service`. `repositories` (`owner/name`) is what a GitHub grant reaches;
    `access` is None for the level a new grant takes by default."""

    service: str
    access: Literal["read", "write"] | None
    repositories: list[str]


@dataclass(frozen=True)
class NewAgentPlan:
    """One agent a run creates, with every field resolved.

    `slot` is how the template names it, for messages. `machine` is the id or
    exact name of one of the owner's machines. `directory` may start with
    `{$agents_dir}`, the directory the machine keeps agents' workspaces in;
    None is the machine's own workspace for the agent. `addressing` is a
    template's word for it (`owner`, `owner-agents`, `anyone`).
    `can_manage_agents` turns on the agent's "can manage agents" capability;
    the run's owner owns every agent it creates, so it is theirs to give.
    """

    slot: str
    name: str
    description: str
    display_name: str | None
    icon_url: str | None
    instructions: str
    provider: str
    machine: str
    model: str | None
    advanced_config: dict[str, Any]
    isolation: str
    auto_mode: bool
    auto_approve: bool
    directory: str | None
    addressing: str
    can_manage_agents: bool
    connections: list[ConnectionPlan] = field(default_factory=list)
    # Rooms that already exist, by name, the agent is added to once created.
    joins: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Problem:
    """Why one agent of the run cannot be created: its slot, a reason code
    (management's, the connection broker's, or this module's) and a sentence
    to relay."""

    slot: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"slot": self.slot, "code": self.code, "message": self.message}


class AgentsNotCreated(AgentRefused):
    """The run was refused before anything was created. `problems` lists
    every reason found, not just the first."""

    def __init__(self, problems: Sequence[Problem]) -> None:
        listed = "; ".join(f"{p.slot}: {p.message} ({p.code})" for p in problems)
        super().__init__("agents_not_created", f"Nothing was created. {listed}")
        self.problems = list(problems)


class RunUndone(AgentRefused):
    """Something failed after agents were created; they were deleted again.
    `left_behind` names any that could not be."""

    def __init__(self, message: str, left_behind: list[str]) -> None:
        super().__init__("run_undone", message)
        self.left_behind = left_behind


@dataclass(frozen=True)
class CheckedAgent:
    plan: NewAgentPlan
    placement: CheckedPlacement
    directory: str | None
    addressing_policy: dict[str, Any] | None
    grants: list[CheckedGrant]
    join_room_ids: list[str]


@dataclass(frozen=True)
class CreatedAgent:
    slot: str
    agent_id: str
    name: str
    machine: dict[str, str]
    # Its client was taking events before the rooms were made, so a kickoff
    # posted into them reaches it. False when it had not started in time.
    listening: bool


def _directory(
    plan: NewAgentPlan, placement: CheckedPlacement
) -> tuple[str | None, Problem | None]:
    """The directory to define the agent with: None for the machine's own
    workspace for it, a path otherwise."""
    if plan.directory is None or plan.directory == f"{AGENTS_DIR}/{plan.name}":
        return None, None
    if AGENTS_DIR not in plan.directory:
        return plan.directory, None
    if placement.workspaces_dir is None:
        return None, Problem(
            plan.slot,
            "directory_unknown",
            f"its directory starts with {AGENTS_DIR}, and machine "
            f"'{placement.machine_name}' has not reported where it keeps agents. "
            "Bring it online once, or give the directory as a full path.",
        )
    root = placement.workspaces_dir.rstrip("/\\")
    return plan.directory.replace(AGENTS_DIR, root), None


def pending_addressing(
    plans: Sequence[NewAgentPlan],
    owner_id: str,
    room_addressing: dict[str, list[str]],
) -> dict[str, tuple[dict[str, Any] | None, str]]:
    """Each agent the run would create, by name, with the addressing policy
    it would have and its owner: what the kickoff check reads for an agent
    that does not exist yet. An agent opened to the rooms the run creates is
    read as open: its kickoff is posted in one of them, and those rooms have
    no id yet to scope a rule to."""
    return {
        plan.name: (
            None
            if room_addressing.get(plan.name)
            else addressing_policy_for(TEMPLATE_ADDRESSING[plan.addressing]),
            owner_id,
        )
        for plan in plans
        if plan.addressing in TEMPLATE_ADDRESSING
    }


def room_ids_of(result: dict[str, Any]) -> dict[str, str]:
    """The rooms a provisioning made, by name: one room's result or a
    group's."""
    if "rooms" in result:
        return {r["room_name"]: r["room_id"] for r in result["rooms"]}
    return {result["room_name"]: result["room_id"]}


class TemplateAgents:
    """Checks, creates and, when the run fails, deletes a run's agents, for
    one owner in one tenant."""

    def __init__(
        self,
        *,
        protocol: AgentCore,
        management: AgentManagementPort | None,
        broker: ServiceBroker | None,
        listen_timeout: float,
    ) -> None:
        self._protocol = protocol
        self._management = management
        self._broker = broker
        self._listen_timeout = listen_timeout

    async def check(
        self, tenant_id: str, owner_id: str, plans: Sequence[NewAgentPlan]
    ) -> list[CheckedAgent]:
        """Every agent checked, with nothing created; refused with every
        problem found when any is."""
        if not plans:
            return []
        if self._management is None:
            raise AgentsNotCreated(
                [
                    Problem(
                        plan.slot,
                        "agent_management_off",
                        "agent management is not enabled on this Switch server, "
                        "so it cannot create agents on a machine.",
                    )
                    for plan in plans
                ]
            )
        problems: list[Problem] = []
        names = [plan.name for plan in plans]
        async with tenant_session(self._protocol.session_factory, tenant_id) as session:
            taken = {
                agent.name
                for agent in await self._protocol.agent_store.get_by_names(
                    session, names
                )
            }
        seen: set[str] = set()
        checked: list[CheckedAgent] = []
        for plan in plans:
            if not VALID_AGENT_NAME_RE.match(plan.name):
                problems.append(
                    Problem(
                        plan.slot,
                        "invalid_name",
                        f"'{plan.name}' is not an agent name: use lowercase "
                        "letters, digits, '.', '-' and '_', starting with a "
                        "letter or digit.",
                    )
                )
                continue
            if plan.name in seen:
                problems.append(
                    Problem(
                        plan.slot,
                        "name_repeated",
                        f"the template creates two agents named '{plan.name}'.",
                    )
                )
                continue
            seen.add(plan.name)
            if plan.name in taken:
                problems.append(
                    Problem(
                        plan.slot,
                        "name_taken",
                        f"an agent named '{plan.name}' already exists. Choose "
                        "another name; nothing is renamed for you.",
                    )
                )
                continue
            if plan.addressing not in TEMPLATE_ADDRESSING:
                problems.append(
                    Problem(
                        plan.slot,
                        "invalid_addressing",
                        f"addressing '{plan.addressing}' is not one of "
                        f"{', '.join(TEMPLATE_ADDRESSING)}.",
                    )
                )
                continue
            try:
                placement = await self._management.check_new_agent(
                    tenant_id, owner_id, self._spec(plan, plan.machine, plan.directory)
                )
            except AgentManagementRefused as refused:
                problems.append(
                    Problem(plan.slot, refused.code, _bare(str(refused), refused.code))
                )
                continue
            directory, problem = _directory(plan, placement)
            if problem is not None:
                problems.append(problem)
                continue
            grants, grant_problems = await self._check_grants(tenant_id, owner_id, plan)
            problems.extend(grant_problems)
            join_room_ids, join_problems = await self._check_joins(
                tenant_id, owner_id, plan
            )
            problems.extend(join_problems)
            checked.append(
                CheckedAgent(
                    plan=plan,
                    placement=placement,
                    directory=directory,
                    addressing_policy=addressing_policy_for(
                        TEMPLATE_ADDRESSING[plan.addressing]
                    ),
                    grants=grants,
                    join_room_ids=join_room_ids,
                )
            )
        if problems:
            raise AgentsNotCreated(problems)
        return checked

    async def _check_joins(
        self, tenant_id: str, owner_id: str, plan: NewAgentPlan
    ) -> tuple[list[str], list[Problem]]:
        """The rooms the agent joins, by id: each must exist, be one the owner
        sees, and one the owner may add agents to."""
        if not plan.joins:
            return [], []
        async with tenant_session(self._protocol.session_factory, tenant_id) as session:
            readable = await self._protocol.room_store.list_readable(
                session, owner_id, is_admin=False
            )
        ids: list[str] = []
        problems: list[Problem] = []
        for name in plan.joins:
            matches = [room for room in readable if room.name == name]
            if not matches:
                problems.append(
                    Problem(
                        plan.slot,
                        "join_unknown_room",
                        f"it joins {name}, and no room of that name is one you can see.",
                    )
                )
            elif len(matches) > 1:
                problems.append(
                    Problem(
                        plan.slot,
                        "join_ambiguous_room",
                        f"it joins {name}, and {len(matches)} rooms have that name.",
                    )
                )
            elif not can(Principal(owner_id, False), "write", matches[0]):
                problems.append(
                    Problem(
                        plan.slot,
                        "join_not_allowed",
                        f"it joins {name}, and you may not add agents to that room.",
                    )
                )
            else:
                ids.append(matches[0].id)
        return ids, problems

    async def _check_grants(
        self, tenant_id: str, owner_id: str, plan: NewAgentPlan
    ) -> tuple[list[CheckedGrant], list[Problem]]:
        if not plan.connections:
            return [], []
        if self._broker is None:
            return [], [
                Problem(
                    plan.slot,
                    "connections_off",
                    "connections are not enabled on this Switch server, so it "
                    f"cannot be granted {', '.join(c.service for c in plan.connections)}.",
                )
            ]
        grants: list[CheckedGrant] = []
        problems: list[Problem] = []
        services = [c.service for c in plan.connections]
        for repeated in sorted({s for s in services if services.count(s) > 1}):
            problems.append(
                Problem(
                    plan.slot,
                    "connection_repeated",
                    f"it lists {repeated} twice; an agent has one grant per service.",
                )
            )
        for connection in plan.connections:
            unavailable = await self._broker.availability(connection.service)
            if unavailable is not None:
                problems.append(
                    Problem(
                        plan.slot,
                        "connection_unavailable",
                        f"{connection.service}: {unavailable}",
                    )
                )
                continue
            async with tenant_session(
                self._protocol.session_factory, tenant_id
            ) as session:
                try:
                    grants.append(
                        await self._broker.check_grant_terms(
                            session,
                            owner_id=owner_id,
                            service=connection.service,
                            access=connection.access,
                            repositories=connection.repositories,
                        )
                    )
                except ServiceError as error:
                    problems.append(
                        Problem(
                            plan.slot,
                            error.code,
                            f"{connection.service}: {error.message}",
                        )
                    )
        return grants, problems

    @staticmethod
    def _spec(
        plan: NewAgentPlan, machine: str, directory: str | None
    ) -> NewManagedAgent:
        return NewManagedAgent(
            name=plan.name,
            description=plan.description,
            display_name=plan.display_name,
            icon_url=plan.icon_url,
            machine=machine,
            provider=plan.provider,
            model=plan.model,
            advanced_config=plan.advanced_config,
            instructions=plan.instructions,
            directory=directory,
            auto_mode=plan.auto_mode,
            auto_approve=plan.auto_approve,
            isolation=plan.isolation,
            start=True,
        )

    async def create(
        self, tenant_id: str, owner_id: str, checked: Sequence[CheckedAgent]
    ) -> list[CreatedAgent]:
        """Create the checked agents with their addressing and connections.
        When one fails, the ones already created are deleted again and the
        failure is raised as `RunUndone`."""
        if not checked:
            return []
        assert self._management is not None
        created: list[CreatedAgent] = []
        for agent in checked:
            plan = agent.plan
            try:
                result = await self._management.create_agent(
                    tenant_id,
                    owner_id,
                    self._spec(plan, agent.placement.machine_id, agent.directory),
                    self._protocol,
                )
                created.append(
                    CreatedAgent(
                        slot=plan.slot,
                        agent_id=result["agent_id"],
                        name=result["name"],
                        machine=dict(result["machine"]),
                        listening=False,
                    )
                )
                await self._finish(tenant_id, owner_id, result["agent_id"], agent)
                for room_id in agent.join_room_ids:
                    await self._protocol.room_service.add_agents_to_room(
                        room_id, agent_ids=[result["agent_id"]]
                    )
            except Exception as error:
                raise await self.undone(
                    created, f"creating {plan.name} failed: {_reason(error)}"
                ) from error
        return await self._listening(created)

    async def _listening(self, created: list[CreatedAgent]) -> list[CreatedAgent]:
        """Wait, up to the listen timeout in all, for each new agent's client
        to be taking events, so the kickoff posted the moment the room is made
        reaches an agent created a moment before. An agent's client is taking
        events as soon as it exists (`AgentActor.wait_receiving`): the rows of
        its rooms are decided for it as they are written."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._listen_timeout
        out: list[CreatedAgent] = []
        for agent in created:
            actor = self._protocol.client_lifecycle.get_by_agent_id(agent.agent_id)
            while actor is None and loop.time() < deadline:
                await asyncio.sleep(_CLIENT_POLL_SECONDS)
                actor = self._protocol.client_lifecycle.get_by_agent_id(agent.agent_id)
            listening = actor is not None and await actor.wait_receiving(
                max(0.0, deadline - loop.time())
            )
            if not listening:
                logger.warning(
                    "New agent %s (%s) was not taking events within %ss of being "
                    "created; a kickoff posted now may not reach it",
                    agent.name,
                    agent.agent_id,
                    self._listen_timeout,
                )
            out.append(replace(agent, listening=listening))
        return out

    async def _finish(
        self, tenant_id: str, owner_id: str, agent_id: str, agent: CheckedAgent
    ) -> None:
        """Set what creating the managed agent does not: who may address it,
        whether it can manage agents, and the connections it is granted."""
        async with tenant_session(self._protocol.session_factory, tenant_id) as session:
            await self._protocol.agent_store.update(
                session,
                agent_id,
                addressing_policy=agent.addressing_policy,
                can_manage_agents=agent.plan.can_manage_agents,
            )
            await session.commit()
        if not agent.grants:
            return
        assert self._broker is not None
        for grant in agent.grants:
            async with tenant_session(
                self._protocol.session_factory, tenant_id
            ) as session:
                row = await session.get(Agent, agent_id)
                if row is None:
                    raise RuntimeError(f"agent {agent_id} vanished while being created")
                _, warning = await self._broker.set_grant(
                    session,
                    agent=row,
                    actor_id=owner_id,
                    service=grant.service,
                    access=grant.access,
                    tool_mode=None,
                    tools=None,
                    resources=grant.resources,
                )
                if warning:
                    logger.warning(
                        "Granting %s to new agent %s: %s",
                        grant.service,
                        agent_id,
                        warning,
                    )

    async def open_to_rooms(
        self,
        tenant_id: str,
        created: Sequence[CreatedAgent],
        room_addressing: dict[str, list[str]],
        room_ids: dict[str, str],
    ) -> None:
        """Let anyone in the named rooms address the agents opened to them,
        once those rooms exist, on top of their owner."""
        for agent in created:
            rooms = room_addressing.get(agent.name)
            if not rooms:
                continue
            missing = [r for r in rooms if r not in room_ids]
            if missing:
                raise RuntimeError(
                    f"{agent.name} is opened to {', '.join(missing)}, which "
                    "the run did not create"
                )
            policy = owner_only_policy([])
            policy.rules.append(AddressingRule(rooms=[room_ids[r] for r in rooms]))
            async with tenant_session(
                self._protocol.session_factory, tenant_id
            ) as session:
                await self._protocol.agent_store.update(
                    session, agent.agent_id, addressing_policy=policy.model_dump()
                )
                await session.commit()

    async def undone(self, created: Sequence[CreatedAgent], what: str) -> RunUndone:
        """Delete the agents a run created, and the refusal saying so. An
        agent that cannot be deleted is named, never passed over."""
        left_behind: list[str] = []
        for agent in reversed(created):
            try:
                await self._protocol.delete_agent(agent_id=agent.agent_id)
            except Exception:
                logger.exception(
                    "Could not delete agent %s (%s) while undoing a template run",
                    agent.name,
                    agent.agent_id,
                )
                left_behind.append(agent.name)
        removed = [a.name for a in created if a.name not in left_behind]
        message = f"Nothing was kept: {what}."
        if removed:
            message += (
                f" The agents this run had created ({', '.join(removed)}) were deleted."
            )
        if left_behind:
            message += (
                f" {', '.join(left_behind)} could not be deleted and still "
                "exist; delete them in Switch Console."
            )
        return RunUndone(message, left_behind)


def _bare(message: str, code: str) -> str:
    """Management's sentence without what the run's own refusal says around
    it: its "Nothing was created:" opening and its trailing reason code."""
    for opening in ("Nothing was created: ", "Nothing was created. "):
        if message.startswith(opening):
            message = message[len(opening) :]
    for ending in (f" ({code}).", f" ({code})"):
        if message.endswith(ending):
            message = message[: -len(ending)]
    return message.rstrip(".")


def _reason(error: Exception) -> str:
    if isinstance(error, ServiceError):
        return error.message
    return str(error) or type(error).__name__
