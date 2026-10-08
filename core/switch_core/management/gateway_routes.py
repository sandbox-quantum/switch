"""The owner's management routes, mounted on the gateway at `/management`.

Cookie-authenticated through `get_current_user`, which binds the caller's
tenant; every route then acts only on the caller's own controllers and
agents. Someone else's is answered exactly like one that does not exist, so
nothing about another person's machines is disclosed.

Failures use the same error envelope as the controller routes.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.db.models import User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_protocol, get_session
from switch_core.gateway.github_connections import (
    GitHubReconnectRequired,
    check_github_grant,
)
from switch_core.gateway.github_connections import service as github_service
from switch_core.management import reason_codes
from switch_core.management.advanced_config import advanced_config_schema
from switch_core.management.dependencies import get_management
from switch_core.management.errors import ManagementError, ManagementRoute
from switch_core.management.schemas import (
    ConnectionGrant,
    ConsoleControllerRequest,
    ControllerDescription,
    CreateManagedAgentRequest,
    CreateOperationRequest,
    PatchManagedAgentRequest,
    PutManagedAgentRequest,
    UpdateControllerRequest,
    wire_time,
)
from switch_core.management.service import (
    CheckConnections,
    ManagementService,
    placement_from,
)

router = APIRouter(route_class=ManagementRoute, tags=["agent management"])

Management = Annotated[ManagementService, Depends(get_management)]
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Protocol = Annotated[AgentCore, Depends(get_protocol)]
Config = Annotated[SwitchConfig, Depends(get_config)]


def owner_connections_check(
    request: Request, session: AsyncSession, user: User, config: SwitchConfig
) -> CheckConnections:
    """Checks the connections an owner grants against their own sign-ins."""

    async def check(grants: list[ConnectionGrant]) -> None:
        for grant in grants:
            try:
                await check_github_grant(
                    user.id,
                    session,
                    config,
                    github_service(request),
                    [
                        (installation.installation_id, installation.repositories)
                        for installation in grant.installations
                    ],
                )
            except GitHubReconnectRequired as exc:
                raise ManagementError(
                    422, reason_codes.GITHUB_RECONNECT_REQUIRED, str(exc.detail)
                ) from exc
            except HTTPException as exc:
                unavailable = exc.status_code >= 500
                raise ManagementError(
                    exc.status_code,
                    reason_codes.INTERNAL
                    if unavailable
                    else reason_codes.VALIDATION_ERROR,
                    str(exc.detail),
                    retryable=unavailable,
                ) from exc

    return check


@router.post("/enrollment-codes", status_code=201)
async def create_enrollment_code(
    session: Session, user: CurrentUser, management: Management
) -> dict[str, str | None]:
    """A one-time code, and the agent bridge's public origin a controller
    enrolls against with it (`server_url`, null when `GATEWAY_PUBLIC_URL` is
    not set: the page the owner is on is the gateway, which need not serve the
    agent bridge, so it is no stand-in)."""
    code, expires_at = await management.issue_enrollment_code(session, owner_id=user.id)
    return {
        "code": code,
        "expires_at": wire_time(expires_at),
        "server_url": management.settings.server_url,
    }


@router.post("/controllers", status_code=201)
async def enroll_console(
    body: ConsoleControllerRequest,
    session: Session,
    user: CurrentUser,
    management: Management,
) -> dict[str, str]:
    controller, credential = await management.create_controller(
        session,
        owner_id=user.id,
        description=ControllerDescription(
            kind=body.kind,
            name=body.name,
            description=body.description,
            platform=body.platform,
            version=body.version,
        ),
        public_key=body.public_key,
    )
    return {"controller_id": controller.id, "credential": credential}


@router.get("/controllers")
async def list_controllers(
    session: Session, user: CurrentUser, management: Management
) -> list[dict[str, Any]]:
    return await management.list_controllers(session, require_tenant_id(), user.id)


@router.patch("/controllers/{controller_id}")
async def update_controller(
    controller_id: str,
    body: UpdateControllerRequest,
    session: Session,
    user: CurrentUser,
    management: Management,
) -> dict[str, Any]:
    """Rename the machine and/or change its description."""
    return await management.update_controller(
        session,
        require_tenant_id(),
        user.id,
        controller_id,
        {key: getattr(body, key) for key in body.model_fields_set},
    )


@router.delete("/controllers/{controller_id}")
async def revoke_controller(
    controller_id: str, session: Session, user: CurrentUser, management: Management
) -> dict[str, bool]:
    await management.revoke_controller(
        session, require_tenant_id(), user.id, controller_id
    )
    return {"ok": True}


@router.get("/advanced-config")
async def get_advanced_config(user: CurrentUser) -> dict[str, Any]:
    """Each provider's advanced-configuration fields, which a definition's
    `advanced_config` is checked against."""
    return advanced_config_schema()


@router.get("/agents")
async def list_managed_agents(
    session: Session, user: CurrentUser, management: Management
) -> list[dict[str, Any]]:
    return await management.list_managed_agents(session, require_tenant_id(), user.id)


@router.get("/agents/{agent_id}")
async def get_managed_agent(
    agent_id: str, session: Session, user: CurrentUser, management: Management
) -> dict[str, Any]:
    return await management.get_managed_agent(
        session, require_tenant_id(), user.id, agent_id
    )


@router.post("/agents", status_code=201)
async def create_managed_agent(
    body: CreateManagedAgentRequest,
    request: Request,
    session: Session,
    user: CurrentUser,
    management: Management,
    protocol: Protocol,
    config: Config,
) -> dict[str, Any]:
    return await management.create_managed_agent(
        session,
        require_tenant_id(),
        user.id,
        body,
        protocol,
        owner_connections_check(request, session, user, config),
    )


@router.put("/agents/{agent_id}")
async def put_managed_agent(
    agent_id: str,
    body: PutManagedAgentRequest,
    request: Request,
    session: Session,
    user: CurrentUser,
    management: Management,
    protocol: Protocol,
    config: Config,
) -> dict[str, Any]:
    return await management.put_managed_agent(
        session,
        require_tenant_id(),
        user.id,
        agent_id,
        placement_from(body.controller_id, body.desired_state, body.definition),
        protocol,
        owner_connections_check(request, session, user, config),
    )


@router.patch("/agents/{agent_id}")
async def patch_managed_agent(
    agent_id: str,
    body: PatchManagedAgentRequest,
    request: Request,
    session: Session,
    user: CurrentUser,
    management: Management,
    protocol: Protocol,
    config: Config,
) -> dict[str, Any]:
    return await management.patch_managed_agent(
        session,
        require_tenant_id(),
        user.id,
        agent_id,
        definition=body.definition,
        desired_state=body.desired_state,
        controller_id=body.controller_id,
        controller_id_given="controller_id" in body.model_fields_set,
        protocol=protocol,
        check_connections=owner_connections_check(request, session, user, config),
    )


@router.delete("/agents/{agent_id}")
async def delete_managed_agent(
    agent_id: str, session: Session, user: CurrentUser, management: Management
) -> dict[str, bool]:
    await management.delete_managed_agent(
        session, require_tenant_id(), user.id, agent_id
    )
    return {"ok": True}


@router.post("/operations", status_code=201)
async def create_operation(
    body: CreateOperationRequest,
    session: Session,
    user: CurrentUser,
    management: Management,
) -> dict[str, Any]:
    return await management.create_operation(
        session,
        require_tenant_id(),
        user.id,
        controller_id=body.controller_id,
        agent_id=body.agent_id,
        kind=body.kind,
        params=body.params,
    )


@router.get("/operations")
async def list_operations(
    session: Session,
    user: CurrentUser,
    management: Management,
    controller_id: str | None = None,
) -> list[dict[str, Any]]:
    return await management.list_operations(
        session, require_tenant_id(), user.id, controller_id
    )
