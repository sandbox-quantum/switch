"""Hosted agents v2's routes, asked by every persona of a server with v2 on.

`test_role_matrix.py` asks the matrix's server, a v1 one, where these routes
are as if absent. This asks the same gateway with v2 switched on (as
HOSTED_BOX_PROVISIONING switches it on) and holds each route to
`HOSTED_V2_ROUTES`: whoever may not use it is refused by the route itself.

The server's operator list names one persona, the organization admin, chosen
because it is not a deployment admin: being on the list is what makes a Switch
operator, never an admin role.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.bridges.agent import refusals
from switch_core.bridges.agent.refusals import RefusalGuard
from switch_core.visibility.keyed_id import KeyedIdKey
from tests.switch_core.gateway.role_matrix import harness
from tests.switch_core.gateway.role_matrix.access import Expected, matches
from tests.switch_core.gateway.role_matrix.harness import (
    People,
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.routes import (
    HOSTED_V2_ROUTES,
    LISTED_OPERATOR,
    ROUTES,
)
from tests.switch_core.gateway.role_matrix.world import World


def _shown(expected: Expected) -> str:
    return str(sorted(expected)) if isinstance(expected, frozenset) else str(expected)


def test_every_v2_route_in_the_matrix_says_who_may_use_it_with_v2_on() -> None:
    assert set(HOSTED_V2_ROUTES) <= set(ROUTES)


@pytest.mark.parametrize("route", sorted(HOSTED_V2_ROUTES))
async def test_each_v2_route_answers_each_persona_as_it_should(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
) -> None:
    gateway, people = await _v2_gateway(session_factory, monkeypatch, tmp_path)

    case = HOSTED_V2_ROUTES[route]
    wrong: list[str] = []
    async with client(gateway) as http:
        for persona in Persona:
            world = World(session_factory, people, persona.value, http, gateway)
            ask = await world.fill(case.ask)
            response = await http.request(
                ask.method,
                ask.path,
                json=ask.json,
                params=ask.params,
                headers=people.headers(persona),
            )
            expected = case.expect[persona]
            if not matches(expected, response.status_code):
                wrong.append(
                    f"{persona.value}: expected {_shown(expected)}, got "
                    f"{response.status_code} {response.text[:300]}"
                )
    assert not wrong, f"{route} ({case.why or 'plain rule'}):\n" + "\n".join(wrong)


# The machine-to-machine routes and the one bearer each takes
# (`HostedControllerSettings`): the controller's own token
# (`hosted_controller.controller_session`), the box provisioner's
# (`hosted_provisioner.provisioner_session`) and the operator API's
# (`hosted_operator_bearer.require_operator_bearer`).
CONTROLLER_TOKEN = "c" * 40
PROVISIONER_TOKEN = "p" * 40
OPERATOR_TOKEN = "o" * 40
G = "/gateway"
MACHINE_ROUTES: dict[str, tuple[str, str, object, dict[str, str], str]] = {
    "GET /gateway/hosted-controller/actions": (
        "GET",
        f"{G}/hosted-controller/actions",
        None,
        {"kind": "restart"},
        OPERATOR_TOKEN,
    ),
    "POST /gateway/hosted-controller/actions/{action_id}/steps": (
        "POST",
        f"{G}/hosted-controller/actions/no-such-action/steps",
        {},
        {},
        OPERATOR_TOKEN,
    ),
    "POST /gateway/hosted-controller/cluster": (
        "POST",
        f"{G}/hosted-controller/cluster",
        {},
        {},
        CONTROLLER_TOKEN,
    ),
    "POST /gateway/hosted-provisioner/claim": (
        "POST",
        f"{G}/hosted-provisioner/claim",
        {},
        {},
        PROVISIONER_TOKEN,
    ),
    "POST /gateway/hosted-provisioner/actions/{action_id}/result": (
        "POST",
        f"{G}/hosted-provisioner/actions/no-such-action/result",
        {},
        {},
        PROVISIONER_TOKEN,
    ),
}
TOKENS = (CONTROLLER_TOKEN, PROVISIONER_TOKEN, OPERATOR_TOKEN)
REFUSED = {401, 403}


async def _v2_gateway(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    on: bool = True,
) -> tuple[FastAPI, People]:
    from switch_core.providers.hosted import HostedControllerSettings

    operators = tmp_path / "operators.json"
    operators.write_text(json.dumps({"operators": []}))
    operators.chmod(0o600)
    copied = harness.config().model_copy(
        update={
            "hosted_box_provisioning": on,
            "visibility_operators_path": str(operators),
        }
    )
    monkeypatch.setattr(harness, "config", lambda: copied)
    monkeypatch.setattr(hosted_v2, "_process_on", on)
    # A fresh lockout guard per test, as the token routes' own tests use: the
    # refusals here would otherwise add up to a 429 lockout across tests.
    monkeypatch.setattr(refusals, "_DEFAULT", RefusalGuard())
    gateway = build_gateway(session_factory)
    gateway.state.keyed_id_key = KeyedIdKey(b"m" * 32, "k1")
    gateway.state.hosted_controller_settings = HostedControllerSettings(
        allowed_tenant_ids=None,
        token=CONTROLLER_TOKEN,
        provisioner_token=PROVISIONER_TOKEN,
        operator_token=OPERATOR_TOKEN,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    people = await seed_people(session_factory)
    operators.write_text(json.dumps({"operators": [people.ids[LISTED_OPERATOR]]}))
    return gateway, people


@pytest.mark.parametrize("route", sorted(HOSTED_V2_ROUTES))
async def test_a_session_route_refuses_the_signed_out_and_every_machine_token(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
) -> None:
    """No session is 401, and a machine's bearer is never a session."""
    gateway, people = await _v2_gateway(session_factory, monkeypatch, tmp_path)
    case = HOSTED_V2_ROUTES[route]
    async with client(gateway) as http:
        # The path as the owner's world fills it; no cookie is sent with it.
        world = World(session_factory, people, Persona.OWNER.value, http, gateway)
        ask = await world.fill(case.ask)
        answers: dict[str, int] = {}
        for name in ("nobody", *TOKENS):
            headers = {} if name == "nobody" else {"authorization": f"Bearer {name}"}
            response = await http.request(
                ask.method, ask.path, json=ask.json, params=ask.params, headers=headers
            )
            answers[name[:1] if name != "nobody" else name] = response.status_code
    assert set(answers.values()) == {401}, answers


@pytest.mark.parametrize("route", sorted(MACHINE_ROUTES))
async def test_a_machine_route_takes_its_own_token_and_nothing_else(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
) -> None:
    """Every persona's session is refused like no credential at all, so is
    every other machine's token, and the route's own token gets past the check."""
    gateway, people = await _v2_gateway(session_factory, monkeypatch, tmp_path)
    method, path, body, params, own = MACHINE_ROUTES[route]
    async with client(gateway) as http:

        async def ask(headers: dict[str, str]) -> int:
            response = await http.request(
                method, path, json=body, params=params, headers=headers
            )
            return response.status_code

        nobody = await ask({})
        sessions = {p.value: await ask(people.headers(p)) for p in Persona}
        others = {
            t[:1]: await ask({"authorization": f"Bearer {t}"})
            for t in TOKENS
            if t != own
        }
        accepted = await ask({"authorization": f"Bearer {own}"})
    assert nobody in REFUSED, nobody
    assert set(sessions.values()) == {nobody}, sessions
    assert set(others.values()) == {nobody}, others
    assert accepted not in REFUSED, accepted


@pytest.mark.parametrize("route", sorted(MACHINE_ROUTES))
async def test_a_machine_route_is_absent_with_v2_off_even_to_its_own_token(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
) -> None:
    """With v2 off, `hosted_v2.require_hosted_v2` (on the router, or on
    `/cluster` itself) answers 404 before any credential check: the route's own
    token, with the token settings wired, finds nothing, as no credential does."""
    gateway, _ = await _v2_gateway(session_factory, monkeypatch, tmp_path, on=False)
    method, path, body, params, own = MACHINE_ROUTES[route]
    async with client(gateway) as http:
        answers = {
            name: (
                await http.request(
                    method, path, json=body, params=params, headers=headers
                )
            ).status_code
            for name, headers in (
                ("nobody", {}),
                ("own token", {"authorization": f"Bearer {own}"}),
            )
        }
    assert answers == {"nobody": 404, "own token": 404}, answers


@pytest.mark.parametrize(
    ("method", "path", "body", "refused"),
    [
        ("GET", "/gateway/tenants/another-workspace/hosted-people", None, 403),
        ("GET", "/gateway/tenants/another-workspace/hosted-usage", None, 403),
        (
            "PUT",
            "/gateway/tenants/another-workspace/hosted-people/{member}",
            {"enabled": False, "reason": "role matrix"},
            404,
        ),
    ],
)
async def test_a_workspace_admin_is_refused_another_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    method: str,
    path: str,
    body: object,
    refused: int,
) -> None:
    """The admin check is for the workspace the session is bound to: a path
    naming any other is refused (`read_views.workspace_hosted_people`,
    `hosted_usage.workspace_hosted_usage`, `hosted_access_routes.set_member_hosted`)."""
    from tests.switch_core.gateway.role_matrix.routes import Ask

    gateway, people = await _v2_gateway(session_factory, monkeypatch, tmp_path)
    async with client(gateway) as http:
        world = World(
            session_factory, people, Persona.WORKSPACE_ADMIN.value, http, gateway
        )
        ask = await world.fill(Ask(method, path, json=body))
        response = await http.request(
            ask.method,
            ask.path,
            json=ask.json,
            headers=people.headers(Persona.WORKSPACE_ADMIN),
        )
    assert response.status_code == refused, response.text
