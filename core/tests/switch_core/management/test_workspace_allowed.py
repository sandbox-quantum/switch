"""The hosted config's `management_tenant_ids` (before dev).

When the list is set, agent management refuses a workspace that isn't on it: every route under /v1/management and
/v1/controllers, and the Console-side /gateway/management routes, with 403 `workspace_not_enabled`. The rule is
`tenant_allowed`, shared with the cloud-machine list; the management authenticator applies it where a caller's
workspace becomes known (its access token, or the enrollment code or credential on the two public routes), and the
Console-side routes ask it once sign-in has bound the workspace. No route carries a copy.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.management.auth import WORKSPACE_NOT_ENABLED_MESSAGE
from switch_core.providers.hosted import tenant_allowed
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_daemon,
    fixture,
)

REFUSED = {
    "error": {
        "code": "workspace_not_enabled",
        "message": WORKSPACE_NOT_ENABLED_MESSAGE,
        "retryable": False,
    }
}


class Allowed:
    """A `management_tenant_ids` a test can change, read through the real shared rule."""

    def __init__(self, tenants: list[str] | None) -> None:
        self.tenants = tenants

    def __call__(self, tenant_id: str) -> bool:
        return tenant_allowed(self.tenants, tenant_id)


@pytest.fixture
def allowed() -> Allowed:
    return Allowed([TENANT_ZERO_ID])


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], allowed: Allowed
) -> Harness:
    return build_harness(session_factory, workspace_allowed=allowed)


def test_the_shared_rule():
    assert tenant_allowed(None, "t1")  # unset: every workspace, as today
    assert tenant_allowed(["t1"], "t1")
    assert not tenant_allowed(["t2"], "t1")
    assert not tenant_allowed([], "t1")


async def test_a_listed_workspace_uses_the_management_and_controller_routes(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_daemon(
            harness, client, owner
        )  # enroll and token exchange, both public
        assignment = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
        opened = await client.post(
            f"/v1/controllers/{controller.controller_id}/connection",
            json={"cursors": {}},
            headers=controller.headers,
        )
    assert assignment.status_code == 200, assignment.text
    assert opened.status_code == 201, opened.text


async def test_an_unlisted_workspace_is_refused_on_a_management_and_a_controller_route(
    harness: Harness, allowed: Allowed
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_daemon(harness, client, owner)
        # Used once while listed, so its principal sits in the auth cache.
        warm = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
        assert warm.status_code == 200, warm.text
        allowed.tenants = ["another-workspace"]
        assignment = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
        opened = await client.post(
            f"/v1/controllers/{controller.controller_id}/connection",
            json={"cursors": {}},
            headers=controller.headers,
        )
    for refused in (assignment, opened):
        assert refused.status_code == 403, refused.text
        assert refused.json() == REFUSED


async def test_an_unlisted_workspace_can_neither_enroll_nor_exchange_a_credential(
    harness: Harness, allowed: Allowed
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_daemon(harness, client, owner)
        code = await client.post(
            "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
        )
        assert code.status_code == 201, code.text
        allowed.tenants = []
        body = fixture("enroll_request.json")
        body["proof"]["code"] = code.json()["code"]
        enrolled = await client.post("/v1/management/controllers/enroll", json=body)
        token = await client.post(
            f"/v1/management/controllers/{controller.controller_id}/token",
            json={"credential": controller.credential},
        )
    for refused in (enrolled, token):
        assert refused.status_code == 403, refused.text
        assert refused.json() == REFUSED


async def test_no_list_changes_nothing(harness: Harness, allowed: Allowed) -> None:
    allowed.tenants = None
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_daemon(harness, client, owner)
        assignment = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
    assert assignment.status_code == 200, assignment.text


async def test_a_bad_secret_is_still_invalid_not_refused(
    harness: Harness, allowed: Allowed
) -> None:
    """The refusal applies to a workspace the secret proves; an unknown secret proves none."""
    allowed.tenants = []
    body = fixture("enroll_request.json")
    body["proof"]["code"] = "swce_not-a-real-code"
    async with harness.client() as client:
        enrolled = await client.post("/v1/management/controllers/enroll", json=body)
    assert enrolled.status_code == 401
    assert enrolled.json()["error"]["code"] == "enrollment_code_invalid"


def _wire(monkeypatch, tmp_path, tenants_json: str | None):
    """create_management, as main calls it, with build_management captured: what workspace rule it hands down."""
    from types import SimpleNamespace

    from switch_core.management import wiring

    captured: dict = {}
    monkeypatch.setattr(
        wiring, "build_management", lambda **kwargs: captured.update(kwargs) or "built"
    )
    path = None
    if tenants_json is not None:
        file = tmp_path / "controller.json"
        file.write_text(
            json.dumps(
                {
                    "allowed_tenant_ids": None,
                    "management_tenant_ids": json.loads(tenants_json),
                    "token": "x" * 32,
                    "agent_api_endpoint": "https://switch.example.com/api/agent",
                }
            )
        )
        path = str(file)
    config = SimpleNamespace(
        agent_management_enabled=True,
        controller_token_secret="s" * 40,
        controller_status_interval_seconds=30,
        gateway_public_url=None,
        third_party_avatars_enabled=False,
        controller_release=None,
        agent_auth_cache_ttl_seconds=1,
        agent_auth_cache_max_entries=16,
        controller_auth_cache_max_agents=16,
        hosted_controller_config_path=path,
        hosted_wait_limit_minutes=10,  # the agents view's wait limit, sent in every status answer
    )
    assert (
        wiring.create_management(
            config, object(), object(), object(), object(), object()
        )
        == "built"
    )  # type: ignore[arg-type]
    return captured


def test_main_wires_the_hosted_config_s_list_into_the_controller_routes(
    monkeypatch, tmp_path
):
    wired = _wire(monkeypatch, tmp_path, '["t1"]')
    assert wired["workspace_allowed"]("t1") and not wired["workspace_allowed"]("t2")
    assert (
        wired["workspace_restricted"] is True
    )  # so a call with no workspace bound fails closed


def test_main_narrows_nothing_with_no_list_or_no_hosted_config(monkeypatch, tmp_path):
    for tenants_json in ("null", None):
        wired = _wire(monkeypatch, tmp_path, tenants_json)
        assert wired["workspace_allowed"]("any")
        assert wired["workspace_restricted"] is False


async def test_an_unlisted_workspace_is_refused_on_the_console_side_routes(
    harness: Harness, allowed: Allowed
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    allowed.tenants = ["another-workspace"]
    async with harness.client() as client:
        code = await client.post(
            "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
        )
        listed = await client.get(
            "/gateway/management/controllers", cookies=cookies_for(owner)
        )
    for refused in (code, listed):
        assert refused.status_code == 403, refused.text
        assert refused.json() == REFUSED
    allowed.tenants = [TENANT_ZERO_ID]
    async with harness.client() as client:
        listed = await client.get(
            "/gateway/management/controllers", cookies=cookies_for(owner)
        )
    assert listed.status_code == 200, listed.text


def test_the_cloud_machine_list_never_narrows_agent_management(monkeypatch, tmp_path):
    """`allowed_tenant_ids` keeps meaning "who may have cloud machines": with it set and `management_tenant_ids`
    unset, every workspace's own computers still reach agent management."""
    from types import SimpleNamespace

    from switch_core.management import wiring

    captured: dict = {}
    monkeypatch.setattr(
        wiring, "build_management", lambda **kwargs: captured.update(kwargs) or "built"
    )
    file = tmp_path / "controller.json"
    file.write_text(
        json.dumps(
            {
                "allowed_tenant_ids": ["t1"],
                "token": "x" * 32,
                "agent_api_endpoint": "https://switch.example.com/api/agent",
            }
        )
    )
    config = SimpleNamespace(
        agent_management_enabled=True,
        controller_token_secret="s" * 40,
        controller_status_interval_seconds=30,
        gateway_public_url=None,
        third_party_avatars_enabled=False,
        controller_release=None,
        agent_auth_cache_ttl_seconds=1,
        agent_auth_cache_max_entries=16,
        controller_auth_cache_max_agents=16,
        hosted_controller_config_path=str(file),
        hosted_wait_limit_minutes=10,  # the agents view's wait limit, sent in every status answer
    )
    wiring.create_management(config, object(), object(), object(), object(), object())  # type: ignore[arg-type]
    assert captured["workspace_allowed"]("t2")


async def test_an_agent_s_management_tools_are_refused_in_an_unlisted_workspace(
    harness: Harness, allowed: Allowed
) -> None:
    """Security (workspace gates v3): the agent-side tools go through `management_permission()`, which now refuses a
    workspace management isn't on for, with the same sentence, even for an agent its owner lets manage agents."""
    from switch_core.bridges.agent.operations import context as op_context
    from tests.switch_core.management.test_agent_operations import (
        _agent_with_key,
        _call,
    )

    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    try:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        async with harness.client() as client:
            allowed.tenants = [TENANT_ZERO_ID]
            listed = await _call(
                client, agent_id, "list_machines", {"Authorization": f"Bearer {key}"}
            )
            allowed.tenants = ["another-workspace"]
            refused = await _call(
                client, agent_id, "list_machines", {"Authorization": f"Bearer {key}"}
            )
    finally:
        op_context._protocol = previous
    assert listed.status_code == 200, listed.text
    assert refused.status_code == 403, refused.text
    assert WORKSPACE_NOT_ENABLED_MESSAGE in refused.json()["detail"]
