"""The management module's own request dependencies.

Sessions and the `AgentCore` come from the door a route is mounted on
(`bridges.agent.dependencies` for controller routes, `gateway.dependencies`
for the owner's), so each route takes the tenant binding that door
established. What is here is what only management has.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.management import reason_codes
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.errors import ManagementError
from switch_core.management.service import ManagementService

_state: dict[str, Any] = {}


def init_management_dependencies(
    *,
    service: ManagementService,
    authenticator: ManagementAuthenticator,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _state["service"] = service
    _state["authenticator"] = authenticator
    _state["session_factory"] = session_factory


def get_management() -> ManagementService:
    return _state["service"]  # type: ignore[no-any-return]


def get_authenticator() -> ManagementAuthenticator:
    return _state["authenticator"]  # type: ignore[no-any-return]


def get_management_session_factory() -> async_sessionmaker[AsyncSession]:
    return _state["session_factory"]  # type: ignore[no-any-return]


def get_controller_principal(request: Request) -> ControllerPrincipal:
    """The controller the bearer middleware authenticated."""
    principal = request.scope.get("controller")
    if not isinstance(principal, ControllerPrincipal):
        raise ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "Not authenticated as a controller."
        )
    return principal


def require_controller(
    controller_id: str, principal: ControllerPrincipal
) -> ControllerPrincipal:
    """The principal, if it is the controller the path names; 403 otherwise."""
    if controller_id != principal.controller_id:
        raise ManagementError(
            403,
            reason_codes.FORBIDDEN,
            "This access token belongs to a different controller.",
        )
    return principal
