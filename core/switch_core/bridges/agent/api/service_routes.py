"""Service grants and tokens, on the agent routes (contract §5).

The agent's own key, or a controller access token acting as an agent bound to
it: the bearer middleware has checked the binding, refused a bound agent's own
key, and left the agent in `scope["agent"]` and the controller, if any, in
`scope["controller"]`. Every refusal is in the contract's envelope,
`{"error": {"code", "message", "retryable"}}`.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import ControllerPrincipal, get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session
from switch_core.connections.broker import (
    FORBIDDEN,
    Principal,
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.db.models import Agent

NO_STORE = {"Cache-Control": "no-store"}


class ServiceRoute(APIRoute):
    """An APIRoute that answers a `ServiceError` in the contract's envelope."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def envelope(request: Request) -> Response:
            try:
                return await handler(request)
            except ServiceError as error:
                return JSONResponse(
                    error.body(), status_code=error.status_code, headers=NO_STORE
                )

        return envelope


router = APIRouter(route_class=ServiceRoute)


def _principal(request: Request) -> Principal:
    controller = request.scope.get("controller")
    if isinstance(controller, ControllerPrincipal):
        return Principal.controller(controller.controller_id, controller.owner_id)
    return Principal.agent_key()


def _require_path_agent(agent: Agent, agent_id: str) -> None:
    if agent.id != agent_id:
        raise ServiceError(
            403,
            FORBIDDEN,
            f"Authenticated as agent {agent.id}, not {agent_id}.",
            retryable=False,
        )


@router.get("/{agent_id}/service-grants")
async def service_grants(
    agent_id: str,
    request: Request,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """The agent's grants and their skills, read when a session starts."""
    _require_path_agent(agent, agent_id)
    return {"grants": await broker.grants_for(session, agent, _principal(request))}


@router.post("/{agent_id}/service-tokens/{service}")
async def service_token(
    agent_id: str,
    service: str,
    request: Request,
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """A token for `service`, to use until `use_until`, at most an hour away.
    Each call issues one.

    `expires_in` is the token's remaining life in seconds as Core counts it,
    so the holder can time its cache from when the answer arrived rather than
    compare `expires_at` with a clock of its own.
    """
    response.headers.update(NO_STORE)
    _require_path_agent(agent, agent_id)
    token = await broker.issue(session, agent_id, _principal(request), service)
    now = datetime.now(UTC)
    return {
        "token": token.token,
        "expires_at": token.expires_at.isoformat(),
        "expires_in": max(0, int((token.expires_at - now).total_seconds())),
        "use_until": token.use_until.isoformat(),
        "resources": token.resources,
    }
