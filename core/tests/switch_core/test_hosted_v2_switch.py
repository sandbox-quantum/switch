"""The v1/v2 switch: Core's one answer, failing closed, and the 404 on every
v2-only route while it's off (before any authentication or work)."""

from __future__ import annotations

import logging

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import ValidationError

from switch_core import hosted_v2
from switch_core.gateway.hosted_provisioner import router as hosted_provisioner_router
from switch_core.hosted_v2 import (
    hosted_v2_on,
    parse_box_provisioning,
    process_hosted_v2,
    set_process_hosted_v2,
)
from switch_core.visibility.audit_routes import router as operator_audit_router
from switch_core.visibility.hosted_access_routes import router as hosted_access_router
from switch_core.visibility.hosted_usage import router as hosted_usage_router
from switch_core.visibility.operator_action_routes import (
    router as operator_action_router,
)
from switch_core.visibility.read_views import admin_router, operator_router
from switch_core.visibility.shared_cloud_agents import router as shared_cloud_router
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.test_config_teams_app import _config


@pytest.fixture(autouse=True)
def _no_box_provisioning_in_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests build config from the environment and state each mode
    themselves: an `HOSTED_BOX_PROVISIONING` exported by the runner must not
    turn their "unset" into on."""
    monkeypatch.delenv("HOSTED_BOX_PROVISIONING", raising=False)


# Every router that is v2's alone: with v2 off each of its routes must answer
# exactly as a route that doesn't exist.
V2_ONLY_ROUTERS = (
    operator_audit_router,
    hosted_access_router,
    operator_action_router,
    hosted_usage_router,
    shared_cloud_router,
    hosted_provisioner_router,
    operator_router,
    admin_router,
)


def _v2_routes() -> list[tuple[str, str]]:
    found = [
        (method, route.path)
        for router in V2_ONLY_ROUTERS
        for route in router.routes
        if isinstance(route, APIRoute)
        for method in sorted(route.methods - {"HEAD", "OPTIONS"})
    ]
    found.append(("POST", "/hosted-controller/cluster"))
    return found


def _concrete(path: str) -> str:
    # Any value for a path parameter: the 404 comes before it is ever read.
    parts = []
    for part in path.split("/"):
        parts.append("x" if part.startswith("{") else part)
    return "/".join(parts)


# ── The one fact ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [True, "true", "TRUE", " 1 ", "yes", "on"])
def test_only_a_clear_yes_is_on(value: object) -> None:
    assert parse_box_provisioning(value) is True


@pytest.mark.parametrize("value", [False, None, "", "false", "0", "no", "off"])
def test_a_clear_no_or_nothing_is_off(value: object) -> None:
    assert parse_box_provisioning(value) is False


@pytest.mark.parametrize("value", ["ture", "enabled", "maybe", "yes please"])
def test_anything_else_is_off_with_a_warning_that_never_echoes_it(
    value: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="switch_core.hosted_v2"):
        assert parse_box_provisioning(value) is False
    message = " ".join(caplog.messages)
    assert "HOSTED_BOX_PROVISIONING" in message
    assert value not in message


def test_the_server_starts_with_a_misspelt_setting_and_reads_it_as_off() -> None:
    assert _config(hosted_box_provisioning="ture").hosted_box_provisioning is False
    assert _config(hosted_box_provisioning="true").hosted_box_provisioning is True
    assert _config().hosted_box_provisioning is False


def test_hosted_v2_on_reads_only_a_real_true() -> None:
    class Stub:
        pass

    stub = Stub()
    assert hosted_v2_on(stub) is False  # no field: a hand-built config, or none
    assert hosted_v2_on(None) is False
    stub.hosted_box_provisioning = "true"  # type: ignore[attr-defined]
    assert hosted_v2_on(stub) is False
    stub.hosted_box_provisioning = True  # type: ignore[attr-defined]
    assert hosted_v2_on(stub) is True


def test_hosted_v2_cannot_be_set_as_a_feature_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", "hosted_v2")
    with pytest.raises(ValidationError, match="hosted_v2"):
        _config()


def test_the_process_copy_is_set_at_start_and_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    with caplog.at_level(logging.INFO, logger="switch_core.hosted_v2"):
        assert set_process_hosted_v2(_config(hosted_box_provisioning=True)) is True
    assert process_hosted_v2() is True
    assert "Hosted agents v2 is on." in caplog.text
    assert set_process_hosted_v2(_config()) is False
    assert process_hosted_v2() is False


# ── The routes ────────────────────────────────────────────────────────────────


def test_the_gated_list_is_not_empty() -> None:
    # A guard on the test itself: an import that changed shape must not leave
    # the route checks below with nothing to check.
    assert len(_v2_routes()) >= 15


@pytest.mark.parametrize(("method", "path"), _v2_routes())
def test_with_v2_off_every_v2_route_answers_as_if_it_did_not_exist(
    method: str, path: str
) -> None:
    client = TestClient(_app())  # v2 off: HOSTED_BOX_PROVISIONING unset
    response = client.request(method, _concrete(path))
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


@pytest.mark.parametrize(("method", "path"), _v2_routes())
def test_a_v2_route_off_is_refused_even_with_a_bearer(method: str, path: str) -> None:
    """No credential, operator or controller bearer, opens it."""
    client = TestClient(_app())
    response = client.request(
        method, _concrete(path), headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 404


@pytest.mark.parametrize(("method", "path"), _v2_routes())
def test_with_v2_on_the_route_is_reached(method: str, path: str) -> None:
    client = TestClient(_app(hosted_box_provisioning=True))
    response = client.request(method, _concrete(path))
    # Reached: refused for want of a credential or settings, or a bad body,
    # but never the switch's "Not Found".
    assert response.json() != {"detail": "Not Found"}


def test_the_feature_flags_route_lists_hosted_v2_only_when_on() -> None:
    from switch_core.gateway.auth import get_authenticated_user_id

    for overrides, want in (({}, False), ({"hosted_box_provisioning": True}, True)):
        app = _app(**overrides)
        app.dependency_overrides[get_authenticated_user_id] = lambda: "user-1"  # type: ignore[attr-defined]
        flags = TestClient(app).get("/feature-flags").json()["flags"]
        # Listed only when on: a client reads it missing as off.
        assert ({"key": "hosted_v2", "enabled": True} in flags) is want
        assert all(flag["key"] != "hosted_v2" for flag in flags) is not want
