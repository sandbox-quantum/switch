"""`GET /gateway/feature-flags`: the deployment's flags, read-only."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.feature_flags import ECOSYSTEM_SHOW_OWNERS
from switch_core.gateway.auth import get_authenticated_user_id
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.feature_flags import router


class _Config:
    def __init__(self, flags: dict[str, bool]) -> None:
        self.feature_flags = flags


def _client(flags: dict[str, bool]) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_authenticated_user_id] = lambda: "user-1"
    app.dependency_overrides[get_config] = lambda: _Config(flags)
    return TestClient(app)


def test_lists_every_flag_with_its_deployment_state() -> None:
    response = _client({ECOSYSTEM_SHOW_OWNERS: True}).get("/feature-flags")
    assert response.status_code == 200
    assert response.json() == {
        "flags": [{"key": ECOSYSTEM_SHOW_OWNERS, "enabled": True}]
    }


def test_there_is_no_way_to_change_a_flag() -> None:
    client = _client({ECOSYSTEM_SHOW_OWNERS: False})
    assert client.put(
        f"/feature-flags/{ECOSYSTEM_SHOW_OWNERS}", json={"enabled": True}
    ).status_code in (404, 405)
    assert client.delete(f"/feature-flags/{ECOSYSTEM_SHOW_OWNERS}").status_code in (
        404,
        405,
    )
