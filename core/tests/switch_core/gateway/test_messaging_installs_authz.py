"""Installing a messaging app is workspace administration.

An install lands a bridge in one tenant and nowhere else, so the person who
may do it is that workspace's owner or admin — not only the deployment
operator. On a server where people sign themselves up, the operator bit is
held by nobody who runs a workspace, so gating these routes on it would leave
the Slack button unreachable to exactly the people it is for.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Tenant, TenantMember, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, require_admin, require_tenant_admin
from switch_core.gateway.messaging_installs import router

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_TENANT = "messaging-installs-authz"


def _dependency_calls(dependant: object) -> list[object]:
    """All dependency callables reachable from a route, recursively."""
    calls = [dependant.call]  # type: ignore[attr-defined]
    for sub in dependant.dependencies:  # type: ignore[attr-defined]
        calls.extend(_dependency_calls(sub))
    return calls


def test_every_route_requires_a_tenant_admin_and_not_the_operator() -> None:
    routes = [route for route in router.routes if hasattr(route, "dependant")]
    assert len(routes) == 4
    for route in routes:
        calls = _dependency_calls(route.dependant)  # type: ignore[attr-defined]
        assert require_tenant_admin in calls, route.path  # type: ignore[attr-defined]
        assert require_admin not in calls, route.path  # type: ignore[attr-defined]


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router, prefix="/messaging-apps")
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_install_service] = lambda: None
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET, gateway_tenant_choice_enabled=False
    )
    return app


async def _member(
    session_factory: async_sessionmaker[AsyncSession], *, name: str, role: str
) -> str:
    async with session_factory() as session:
        if await session.get(Tenant, _TENANT) is None:
            session.add(Tenant(id=_TENANT, slug=_TENANT, name=_TENANT))
            await session.flush()
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=_TENANT, user_id=user.id, role=role))
        await session.commit()
        return user.id


async def _list_installs(
    session_factory: async_sessionmaker[AsyncSession], user_id: str, name: str
) -> httpx.Response:
    token = create_jwt(user_id, f"{name}@example.invalid", "user", _SECRET, _TENANT)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies={"switch_auth": token},
    ) as client:
        return await client.get("/messaging-apps/installs")


class TestWhoMayManageInstalls:
    async def test_a_workspace_owner_who_is_not_an_operator_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _member(session_factory, name="owner", role="owner")
        response = await _list_installs(session_factory, user_id, "owner")
        assert response.status_code == 200, response.text
        assert response.json() == {"installs": []}

    async def test_a_workspace_admin_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _member(session_factory, name="wsadmin", role="admin")
        response = await _list_installs(session_factory, user_id, "wsadmin")
        assert response.status_code == 200, response.text

    async def test_a_plain_member_may_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _member(session_factory, name="plain", role="member")
        response = await _list_installs(session_factory, user_id, "plain")
        assert response.status_code == 403
