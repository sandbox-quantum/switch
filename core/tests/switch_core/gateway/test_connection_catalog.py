import json
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import ProviderConnection, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.connection_catalog import router
from switch_core.gateway.dependencies import get_session
from tests.switch_core.bridges.agent.protocol.registration_harness import KEYRING


@pytest.fixture
async def catalog_app(session_factory):
    async with session_factory() as session:
        for user_id in ("catalog-user", "other-user"):
            session.add(
                User(
                    id=user_id,
                    name=user_id,
                    email=f"{user_id}@example.com",
                    role="user",
                    password_hash="unused",
                )
            )
        await session.commit()
        user = await session.get(User, "catalog-user")

    async def sessions():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router, prefix="/gateway")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_session] = sessions
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, session_factory


async def link_github(session_factory, user_id):
    async with session_factory() as session:
        session.add(
            ProviderConnection(
                user_id=user_id,
                provider="github",
                kind="oauth",
                encrypted_credential=KEYRING.encrypt(
                    json.dumps({"access_token": "SYNTHETIC"})
                ),
                verified_at=datetime.now(UTC),
            )
        )
        await session.commit()


def statuses(response):
    assert response.status_code == 200, response.text
    return {entry["slug"]: entry["status"] for entry in response.json()["connections"]}


async def test_catalog_lists_github_and_placeholders(catalog_app):
    client, _ = catalog_app
    response = await client.get("/gateway/provider-connections/catalog")
    result = statuses(response)
    assert result.pop("github") == "not_connected"
    assert len(result) == 14
    assert set(result.values()) == {"coming_soon"}
    github = next(
        entry for entry in response.json()["connections"] if entry["slug"] == "github"
    )
    assert github == {
        "slug": "github",
        "name": "GitHub",
        "category": "Source control",
        "description": github["description"],
        "enabled": True,
        "auth_type": "oauth",
        "status": "not_connected",
    }


async def test_catalog_reports_only_the_callers_connection(catalog_app):
    client, factory = catalog_app
    await link_github(factory, "other-user")
    assert (
        statuses(await client.get("/gateway/provider-connections/catalog"))["github"]
        == "not_connected"
    )
    await link_github(factory, "catalog-user")
    assert (
        statuses(await client.get("/gateway/provider-connections/catalog"))["github"]
        == "connected"
    )
