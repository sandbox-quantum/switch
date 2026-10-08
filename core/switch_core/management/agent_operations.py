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
    ManagedAgentChanges,
    NewManagedAgent,
)
from switch_core.db.models import Agent, AgentController
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.session_scope import tenant_session
from switch_core.management import reason_codes
from switch_core.management.advanced_config import provider_fields
from switch_core.management.errors import ManagementError
from switch_core.management.placement import is_revoked, provider_auth
from switch_core.management.process_lease import ProcessLeases
from switch_core.management.schemas import (
    CreateManagedAgentRequest,
    DefinitionV1,
    PatchManagedAgentRequest,
    agent_status_from,
    wire_time_or_none,
)
from switch_core.management.service import ManagementService

NOTHING_CREATED = "Nothing was created"
NOTHING_CHANGED = "Nothing was changed"

CREATED_HINT = (
    "The agent is created and its machine has been told. Check it with "
    "list_managed_agents straight away; while its `actual` is still null, "
    "pending or starting, check again every 2 seconds, for at most a minute."
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
            f"machine '{machine}' is not connected to Switch or has not reported "
            "recently (it may be asleep, off or disconnected); your owner needs "
            "to bring it back online, or pick another machine"
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
            leases = await self._service.leases(session)
        machines = []
        for controller in controllers:
            state = self._service.state_of(controller, leases)
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

    def advanced_config_fields(self, provider: str) -> list[dict[str, Any]]:
        try:
            return provider_fields(provider)
        except ValueError as exc:
            raise AgentManagementRefused(
                reason_codes.VALIDATION_ERROR, str(exc)
            ) from exc

    async def _resolve_machine(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        machine: str,
        nothing_done: str,
    ) -> AgentController:
        """The owner's machine with this id, or else the one not revoked with
        this exact name. `nothing_done` opens a refusal ("Nothing was
        created")."""
        controllers = await self._service.controllers.list_for_owner(
            session, tenant_id, owner_id
        )
        by_id = next((c for c in controllers if c.id == machine), None)
        if by_id is not None:
            return by_id
        named = [c for c in controllers if c.name == machine and not is_revoked(c)]
        if len(named) == 1:
            return named[0]
        if not named:
            raise AgentManagementRefused(
                reason_codes.NOT_FOUND,
                f"{nothing_done}: your owner has no machine with the id or "
                f"name '{machine}'. list_machines shows the machines you can use.",
            )
        leases = await self._service.leases(session)
        candidates = "; ".join(
            _machine_line(c, self._service.state_of(c, leases)) for c in named
        )
        raise AgentManagementRefused(
            reason_codes.VALIDATION_ERROR,
            f"{nothing_done}: your owner has {len(named)} machines named "
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
                session, tenant_id, owner_id, spec.machine, NOTHING_CREATED
            )
            try:
                request = CreateManagedAgentRequest(
                    name=spec.name,
                    description=spec.description,
                    display_name=spec.display_name,
                    icon_url=spec.icon_url,
                    controller_id=controller.id,
                    desired_state="running" if spec.start else "stopped",
                    definition=DefinitionV1(
                        provider=spec.provider,  # type: ignore[arg-type]
                        model=spec.model,
                        advanced_config=spec.advanced_config,
                        instructions=spec.instructions,
                        auto_approve=spec.auto_approve,
                        directory=spec.directory,
                    ),
                )
            except ValidationError as exc:
                raise AgentManagementRefused(
                    reason_codes.VALIDATION_ERROR,
                    f"{NOTHING_CREATED}: {_validation_message(exc)}.",
                ) from exc
            try:
                view = await self._service.create_managed_agent(
                    session, tenant_id, owner_id, request, protocol
                )
            except ManagementError as exc:
                sentence = _placement_sentence(exc.code, controller.name, spec.provider)
                raise AgentManagementRefused(
                    exc.code,
                    f"{NOTHING_CREATED}: {sentence or exc.message} ({exc.code}).",
                ) from exc
        return {
            "agent_id": view["agent_id"],
            "name": view["name"],
            "machine": {"id": controller.id, "name": controller.name},
            "desired_state": view["desired_state"],
            "hint": CREATED_HINT,
        }

    def _managed_entry(
        self,
        row: AgentDefinitionRow,
        agent: Agent,
        controller: AgentController | None,
        leases: ProcessLeases,
    ) -> dict[str, Any]:
        status = agent_status_from(controller, agent.id)
        return {
            "agent_id": agent.id,
            "name": agent.name,
            "display_name": agent.display_name,
            "description": agent.description,
            "provider": row.definition.get("provider"),
            "model": row.definition.get("model"),
            "advanced_config": row.definition.get("advanced_config", {}),
            "directory": row.definition.get("directory"),
            "machine": None
            if controller is None
            else {
                "id": controller.id,
                "name": controller.name,
                "state": self._service.state_of(controller, leases),
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
                "directory": status.get("directory"),
            },
            "revision": row.revision,
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
            leases = await self._service.leases(session)
        return [
            self._managed_entry(
                row,
                agent,
                controllers.get(row.controller_id) if row.controller_id else None,
                leases,
            )
            for row, agent in rows
        ]

    async def managed_agent(
        self, tenant_id: str, owner_id: str, agent_id: str
    ) -> dict[str, Any] | None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            return await self._owned_entry(session, tenant_id, owner_id, agent_id)

    async def _owned_entry(
        self, session: AsyncSession, tenant_id: str, owner_id: str, agent_id: str
    ) -> dict[str, Any] | None:
        agent = await self._service.agents.get(session, agent_id)
        if agent is None or agent.owner_id != owner_id:
            return None
        row = await self._service.definitions.get_for_agent(
            session, tenant_id, agent_id
        )
        if row is None:
            return None
        controller = (
            await self._service.controllers.get(session, tenant_id, row.controller_id)
            if row.controller_id is not None
            else None
        )
        return self._managed_entry(
            row, agent, controller, await self._service.leases(session)
        )

    async def update_managed_agent(
        self,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
        changes: ManagedAgentChanges,
        protocol: AgentCore,
    ) -> dict[str, Any]:
        async with tenant_session(self._session_factory, tenant_id) as session:
            agent = await self._service.agents.get(session, agent_id)
            row = await self._service.definitions.get_for_agent(
                session, tenant_id, agent_id
            )
            if agent is None or agent.owner_id != owner_id or row is None:
                raise AgentManagementRefused(
                    reason_codes.NOT_FOUND,
                    f"{NOTHING_CHANGED}: agent {agent_id} is not one of your "
                    "owner's managed agents, so it has no provider, model, "
                    "machine or run state Switch can set. Only its name-level "
                    "settings (description, display name, icon, addressing) "
                    "can be changed here.",
                )
            controller: AgentController | None = None
            if changes.machine is not None:
                controller = await self._resolve_machine(
                    session, tenant_id, owner_id, changes.machine, NOTHING_CHANGED
                )
            elif row.controller_id is not None:
                controller = await self._service.controllers.get(
                    session, tenant_id, row.controller_id
                )
            definition_changes = changes.definition_changes()
            body: dict[str, Any] = {}
            if definition_changes:
                body["definition"] = {**row.definition, **definition_changes}
            if changes.desired_state is not None:
                body["desired_state"] = changes.desired_state
            if changes.machine is not None:
                assert controller is not None
                body["controller_id"] = controller.id
            try:
                request = PatchManagedAgentRequest.model_validate(body)
            except ValidationError as exc:
                raise AgentManagementRefused(
                    reason_codes.VALIDATION_ERROR,
                    f"{NOTHING_CHANGED}: {_validation_message(exc)}.",
                ) from exc
            provider = (
                request.definition.provider
                if request.definition is not None
                else str(row.definition.get("provider"))
            )
            try:
                await self._service.patch_managed_agent(
                    session,
                    tenant_id,
                    owner_id,
                    agent_id,
                    definition=request.definition,
                    desired_state=request.desired_state,
                    controller_id=request.controller_id,
                    controller_id_given="controller_id" in request.model_fields_set,
                    protocol=protocol,
                )
            except ManagementError as exc:
                machine = controller.name if controller is not None else "(none)"
                sentence = _placement_sentence(exc.code, machine, provider)
                raise AgentManagementRefused(
                    exc.code,
                    f"{NOTHING_CHANGED}: {sentence or exc.message} ({exc.code}).",
                ) from exc
            entry = await self._owned_entry(session, tenant_id, owner_id, agent_id)
        if entry is None:
            raise RuntimeError(f"managed agent {agent_id} vanished while updating it")
        return entry
