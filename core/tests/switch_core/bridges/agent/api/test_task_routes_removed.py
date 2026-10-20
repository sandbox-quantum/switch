"""The task protocol is gone from the HTTP surface: its routes, and the
operations door, answer 404."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.api import handlers, operations
from switch_core.bridges.agent.dependencies import (
    get_protocol,
    get_session_factory,
)
from switch_core.db.models import TENANT_ZERO_ID, Agent
from switch_core.tenant_context import tenant_scope

AGENT_ID = "agent-1"


class _AuthenticatedAs:
    def __init__(self, app: ASGIApp, agent: Agent) -> None:
        self.app = app
        self.agent = agent

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["agent"] = self.agent
        with tenant_scope(self.agent.tenant_id):
            await self.app(scope, receive, send)


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(handlers.router, prefix="/agents")
    app.include_router(operations.router)
    app.dependency_overrides[get_protocol] = lambda: object()
    app.dependency_overrides[get_session_factory] = lambda: object()
    agent = Agent(id=AGENT_ID, name="agent", tenant_id=TENANT_ZERO_ID)
    with TestClient(_AuthenticatedAs(app, agent)) as client:  # type: ignore[arg-type]
        yield client


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "tasks/delegate"),
        ("POST", "tasks/accept"),
        ("POST", "tasks/update"),
        ("POST", "tasks/finalise"),
        ("POST", "tasks/cancel"),
        ("GET", "tasks"),
        ("GET", "tasks/agents"),
        ("GET", "tasks/t-1"),
    ],
)
def test_former_task_routes_are_not_found(
    client: TestClient, method: str, path: str
) -> None:
    response = client.request(method, f"/agents/{AGENT_ID}/{path}", json={})
    assert response.status_code == 404


@pytest.mark.parametrize(
    "operation",
    [
        "delegate_task",
        "accept_task",
        "update_task",
        "finalise_task",
        "cancel_task",
        "list_tasks",
    ],
)
def test_task_operations_are_not_found(client: TestClient, operation: str) -> None:
    response = client.post(f"/agents/{AGENT_ID}/ops/{operation}", json={})
    assert response.status_code == 404
