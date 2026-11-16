"""`GET /gateway/feature-flags`: the deployment's flags, read-only."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.feature_flags import ECOSYSTEM_SHOW_OWNERS, HOSTED_AWAKE_BUDGETS
from switch_core.gateway.auth import get_authenticated_user_id
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.feature_flags import router


class _Config:
    def __init__(self, flags: dict[str, bool], *, v2: bool = False) -> None:
        self.feature_flags = flags
        self.hosted_box_provisioning = v2


def _client(flags: dict[str, bool], *, v2: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_authenticated_user_id] = lambda: "user-1"
    app.dependency_overrides[get_config] = lambda: _Config(flags, v2=v2)
    return TestClient(app)


def test_lists_every_flag_with_its_deployment_state() -> None:
    response = _client({ECOSYSTEM_SHOW_OWNERS: True}).get("/feature-flags")
    assert response.status_code == 200
    # With hosted agents v2 off (no box provisioning): upstream's list exactly.
    assert response.json() == {
        "flags": [{"key": ECOSYSTEM_SHOW_OWNERS, "enabled": True}]
    }


def test_with_v2_off_its_own_flags_are_left_out_even_when_set() -> None:
    """`hosted_v2` and `hosted_awake_budgets` are
    absent with the switch off, so the answer is upstream's byte for byte."""
    response = _client({ECOSYSTEM_SHOW_OWNERS: False, HOSTED_AWAKE_BUDGETS: True}).get(
        "/feature-flags"
    )
    assert response.json() == {
        "flags": [{"key": ECOSYSTEM_SHOW_OWNERS, "enabled": False}]
    }


def test_with_v2_on_both_are_listed() -> None:
    response = _client(
        {ECOSYSTEM_SHOW_OWNERS: False, HOSTED_AWAKE_BUDGETS: True}, v2=True
    ).get("/feature-flags")
    assert response.json() == {
        "flags": [
            {"key": ECOSYSTEM_SHOW_OWNERS, "enabled": False},
            {"key": HOSTED_AWAKE_BUDGETS, "enabled": True},
            {"key": "hosted_v2", "enabled": True},
        ]
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
