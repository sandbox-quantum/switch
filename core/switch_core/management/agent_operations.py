"""Management's side of the agent operations on machines and managed agents.

Implements Core's `AgentManagementPort` on top of `ManagementService`, so an
agent creating a managed agent goes through exactly the validation and
placement checks the owner's gateway route does. What is here is only what an
agent caller needs on top: finding a machine by name, shaping the answers for
an agent to read, and turning a refusal into a sentence it can relay.

Every method acts for the owner it is given, on that owner's machines alone;
another person's machine is never matched, so it reads as not existing.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_management import (
    AgentManagementRefused,
    NewManagedAgent,
)
from switch_core.db.models import AgentController
from switch_core.db.session_scope import tenant_session
from switch_core.management import reason_codes
from switch_core.management.errors import ManagementError
from switch_core.management.placement import provider_auth
from switch_core.management.schemas import (
    CreateManagedAgentRequest,
    DefinitionV1,
    agent_status_from,
    wire_time_or_none,
)
from switch_core.management.service import ManagementService

CREATED_HINT = (
    "The agent is created and its machine has been told. Its actual state "
    "appears once the machine reports, usually within a minute: check it with "
    "list_managed_agents."
)


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for error in exc.errors():
        location = ".".join(str(part) for part in error.get("loc", ()))
        parts.append(f"{location}: {error.get('msg', 'invalid')}")
    return "; ".join(parts) or "invalid request"


def _placement_sentence(code: str, machine: str, provider: str) -> str | None:
    """Why the machine cannot take the agent, in a person's terms, for the
    placement reason codes; None for any other code."""
    sentences = {
        reason_codes.CONTROLLER_REVOKED: (
            f"machine '{machine}' has been removed from Switch; pick another machine"
        ),
        reason_codes.CONTROLLER_OFFLINE: (
            f"machine '{machine}' has not reported recently (it may be asleep, "
            "off or disconnected); your owner needs to bring it back online, or "
            "pick another machine"
        ),
        reason_codes.PROVIDER_NOT_INSTALLED: (
            f"{provider} is not installed on machine '{machine}'; your owner "
            "needs to install it there, or pick another machine"
        ),
        reason_codes.PROVIDER_LOGIN_MISSING: (
            f"{provider} is not logged in on machine '{machine}'; your owner "
            "needs to log in to it there"
        ),
        reason_codes.PROVIDER_LOGIN_EXPIRED: (
            f"the {provider} login on machine '{machine}' has expired; your "
            "owner needs to log in to it again there"
        ),
    }
    return sentences.get(code)


def _machine_line(controller: AgentController, state: str) -> str:
    described = f", {controller.description}" if controller.description else ""
    return f"{controller.id} ({state}{described})"


def _agents_running(controller: AgentController) -> int | None:
    if controller.status is None:
        return None
    agents = controller.status.get("agents")
    return sum(
        1
        for entry in (agents if isinstance(agents, list) else [])
        if isinstance(entry, dict) and entry.get("process") == "running"
    )


def _providers(controller: AgentController) -> list[dict[str, Any]]:
    if controller.status is None:
        return []
    providers = controller.status.get("providers")
    return [
        {
            "provider": entry.get("provider"),
            "installed": entry.get("installed") is True,
            "version": entry.get("version"),
            "auth": provider_auth(entry),
        }
        for entry in (providers if isinstance(providers, list) else [])
        if isinstance(entry, dict)
    ]


class ManagementAgentOperations:
    """`AgentManagementPort`, served by the management service."""

    def __init__(
        self,
        *,
        service: ManagementService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._service = service
        self._session_factory = session_factory

    async def list_machines(
        self, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        async with tenant_session(self._session_factory, tenant_id) as session:
            controllers = await self._service.controllers.list_for_owner(
                session, tenant_id, owner_id
            )
        machines = []
        for controller in controllers:
            state = self._service.state_of(controller)
            if state == "revoked":
                continue
            machines.append(
                {
                    "id": controller.id,
                    "name": controller.name,
                    "description": controller.description,
                    "kind": controller.kind,
                    "state": state,
                    "last_seen_at": wire_time_or_none(controller.last_seen_at),
                    "providers": _providers(controller),
                    "agents_running": _agents_running(controller),
                }
            )
        return machines

    async def _resolve_machine(
        self, session: AsyncSession, tenant_id: str, owner_id: str, machine: str
    ) -> AgentController:
        """The owner's machine with this id, or else the one not revoked with
        this exact name."""
        controllers = await self._service.controllers.list_for_owner(
            session, tenant_id, owner_id
        )
        by_id = next((c for c in controllers if c.id == machine), None)
        if by_id is not None:
            return by_id
        named = [
            c
            for c in controllers
            if c.name == machine and self._service.state_of(c) != "revoked"
        ]
        if len(named) == 1:
            return named[0]
        if not named:
            raise AgentManagementRefused(
                reason_codes.NOT_FOUND,
                f"Nothing was created: your owner has no machine with the id or "
                f"name '{machine}'. list_machines shows the machines you can use.",
            )
        candidates = "; ".join(
            _machine_line(c, self._service.state_of(c)) for c in named
        )
        raise AgentManagementRefused(
            reason_codes.VALIDATION_ERROR,
            f"Nothing was created: your owner has {len(named)} machines named "
            f"'{machine}': {candidates}. Pass the id of the one you mean as "
            "`machine`.",
        )

    async def create_agent(
        self,
        tenant_id: str,
        owner_id: str,
        spec: NewManagedAgent,
        protocol: AgentCore,
    ) -> dict[str, Any]:
        async with tenant_session(self._session_factory, tenant_id) as session:
            controller = await self._resolve_machine(
                session, tenant_id, owner_id, spec.machine
            )
            try:
                request = CreateManagedAgentRequest(
                    name=spec.name,
                    description=spec.description,
                    display_name=spec.display_name,
                    controller_id=controller.id,
                    desired_state="running" if spec.start else "stopped",
                    definition=DefinitionV1(
                        provider=spec.provider,  # type: ignore[arg-type]
                        model=spec.model,
                        instructions=spec.instructions,
                        auto_approve=spec.auto_approve,
                        directory=spec.directory,
                    ),
                )
            except ValidationError as exc:
                raise AgentManagementRefused(
                    reason_codes.VALIDATION_ERROR,
                    f"Nothing was created: {_validation_message(exc)}.",
                ) from exc
            try:
                view = await self._service.create_managed_agent(
                    session, tenant_id, owner_id, request, protocol
                )
            except ManagementError as exc:
                sentence = _placement_sentence(exc.code, controller.name, spec.provider)
                raise AgentManagementRefused(
                    exc.code,
                    f"Nothing was created: {sentence or exc.message} ({exc.code}).",
                ) from exc
        return {
            "agent_id": view["agent_id"],
            "name": view["name"],
            "machine": {"id": controller.id, "name": controller.name},
            "desired_state": view["desired_state"],
            "hint": CREATED_HINT,
        }

    async def list_managed_agents(
        self, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        async with tenant_session(self._session_factory, tenant_id) as session:
            controllers = {
                c.id: c
                for c in await self._service.controllers.list_for_owner(
                    session, tenant_id, owner_id
                )
            }
            rows = await self._service.definitions.list_for_owner(
                session, tenant_id, owner_id
            )
        managed = []
        for row, agent in rows:
            controller = (
                controllers.get(row.controller_id) if row.controller_id else None
            )
            status = agent_status_from(controller, agent.id)
            managed.append(
                {
                    "agent_id": agent.id,
                    "name": agent.name,
                    "display_name": agent.display_name,
                    "description": agent.description,
                    "provider": row.definition.get("provider"),
                    "model": row.definition.get("model"),
                    "machine": None
                    if controller is None
                    else {
                        "id": controller.id,
                        "name": controller.name,
                        "state": self._service.state_of(controller),
                    },
                    "desired_state": row.desired_state,
                    "actual": None
                    if status is None
                    else {
                        "process": status.get("process"),
                        "reason": status.get("reason"),
                        "detail": status.get("detail"),
                        "applied_revision": status.get("applied_revision"),
                        "since": status.get("since"),
                    },
                    "revision": row.revision,
                }
            )
        return managed
