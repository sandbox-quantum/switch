"""The provider list and advanced-configuration fields are served on a
gateway that runs no agent management, since Switch Console builds the form
of the agents it runs itself from them too."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI

from switch_core.gateway.auth import get_current_user
from switch_core.gateway.providers import router as providers_router
from switch_core.providers.schema import advanced_config_schema, providers_schema


async def test_they_are_served_without_agent_management() -> None:
    gateway_app = FastAPI()
    gateway_app.include_router(providers_router)
    gateway_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="u")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gateway_app), base_url="http://test"
    ) as client:
        providers = await client.get("/management/providers")
        advanced = await client.get("/management/advanced-config")
        agents = await client.get("/management/agents")
    assert providers.status_code == 200, providers.text
    assert providers.json() == providers_schema()
    assert advanced.status_code == 200, advanced.text
    assert advanced.json() == advanced_config_schema()
    assert agents.status_code == 404
