"""Who may take an account out of every room or freeze a room: a workspace
admin or the server's operator (`require_tenant_admin`), and never anyone
else, room admins and room owners included. What the routes then do is
`test_room_moderation.py`'s."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import TENANT_ZERO_ID, User
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.moderation import get_account_removal
from switch_core.gateway.moderation import router as moderation_router
from switch_core.gateway.rooms import get_room_freeze
from switch_core.gateway.rooms import router as rooms_router
from switch_core.room_moderation import (
    ModerationTargetNotFound,
    RemovedFromRooms,
    RoomRef,
)
from switch_core.tenant_context import tenant_scope


class _Removal:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def remove_agent(
        self, tenant_id: str, agent_id: str, **kw: Any
    ) -> RemovedFromRooms:
        if agent_id == "missing":
            raise ModerationTargetNotFound("No agent missing in this workspace.")
        self.calls.append(("agent", tenant_id, {"agent_id": agent_id, **kw}))
        return RemovedFromRooms(
            target_type="agent", target_id=agent_id, rooms=[RoomRef("r1", "one")]
        )

    async def remove_person(
        self, tenant_id: str, user_id: str, **kw: Any
    ) -> RemovedFromRooms:
        self.calls.append(("user", tenant_id, {"user_id": user_id, **kw}))
        return RemovedFromRooms(target_type="user", target_id=user_id)


class _Freeze:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def freeze(self, *args: Any, **kw: Any) -> None:
        self.calls.append("freeze")

    async def unfreeze(self, *args: Any, **kw: Any) -> None:
        self.calls.append("unfreeze")


def _app(*, is_admin: bool) -> tuple[FastAPI, _Removal, _Freeze]:
    app = FastAPI()
    app.include_router(rooms_router, prefix="/rooms")
    app.include_router(moderation_router)
    user = User(id="u-1", name="secops", email="secops@test.local", role="user")

    async def current_user() -> AsyncIterator[User]:
        with tenant_scope(TENANT_ZERO_ID):
            yield user

    removal = _Removal()
    freeze = _Freeze()
    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_tenant_is_admin] = lambda: is_admin
    app.dependency_overrides[get_account_removal] = lambda: removal
    app.dependency_overrides[get_room_freeze] = lambda: freeze
    return app, removal, freeze


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/moderation/agents/a-1/remove-from-all-rooms", {}),
        ("/moderation/people/p-1/remove-from-all-rooms", {"include_agents": True}),
        ("/rooms/r-1/freeze", {"reason": "INC-1"}),
        ("/rooms/r-1/unfreeze", None),
    ],
)
async def test_only_a_workspace_admin_may(path: str, body: Any) -> None:
    app, removal, freeze = _app(is_admin=False)
    async with _client(app) as client:
        response = await client.post(path, json=body)

    assert response.status_code == 403
    assert removal.calls == [] and freeze.calls == []


async def test_an_admin_removes_an_agent_from_every_room() -> None:
    app, removal, _ = _app(is_admin=True)
    async with _client(app) as client:
        response = await client.post(
            "/moderation/agents/a-1/remove-from-all-rooms", json={"request": "INC-2"}
        )

    assert response.status_code == 200
    assert response.json() == {
        "target_type": "agent",
        "target_id": "a-1",
        "rooms": [{"id": "r1", "name": "one"}],
        "agents": {},
    }
    [(kind, tenant_id, call)] = removal.calls
    assert (kind, tenant_id) == ("agent", TENANT_ZERO_ID)
    assert call["actor_user_id"] == "u-1"
    assert call["request"] == "INC-2"


async def test_a_person_removal_says_whether_their_agents_go_too() -> None:
    app, removal, _ = _app(is_admin=True)
    async with _client(app) as client:
        refused = await client.post(
            "/moderation/people/p-1/remove-from-all-rooms", json={}
        )
        done = await client.post(
            "/moderation/people/p-1/remove-from-all-rooms",
            json={"include_agents": False},
        )

    assert refused.status_code == 422
    assert done.status_code == 200
    [(_, _, call)] = removal.calls
    assert call["include_agents"] is False


async def test_an_account_not_in_the_workspace_is_404() -> None:
    app, _, _ = _app(is_admin=True)
    async with _client(app) as client:
        response = await client.post(
            "/moderation/agents/missing/remove-from-all-rooms", json={}
        )

    assert response.status_code == 404
