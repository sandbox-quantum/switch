"""Names people type are refused, as a 422 that says why, when they hold a
character that changes how they read without showing; and a workspace's or
an organization's name is held to rename's rules when it is made too."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.switch_core.gateway.role_matrix.harness import (
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.routes import Ask
from tests.switch_core.gateway.role_matrix.world import World

G = "/gateway"

# Where the name goes in a body.
NAME = "<the name>"

# Each route that takes a name, as whoever may use it.
NAMED: dict[str, tuple[Persona, Ask]] = {
    "create a room": (
        Persona.OWNER,
        Ask(
            "POST",
            f"{G}/rooms",
            {"name": NAME, "description": "", "agent_ids": ["{agent}"]},
        ),
    ),
    "rename a room": (
        Persona.OWNER,
        Ask("PATCH", f"{G}/rooms/{{room}}", {"name": NAME}),
    ),
    "create a room group": (
        Persona.WORKSPACE_ADMIN,
        Ask("POST", f"{G}/room-groups", {"name": NAME}),
    ),
    "rename a room group": (
        Persona.WORKSPACE_ADMIN,
        Ask("PATCH", f"{G}/room-groups/{{room_group}}", {"name": NAME}),
    ),
    "create a reference": (
        Persona.OWNER,
        Ask(
            "POST",
            f"{G}/references",
            {
                "type": "github",
                "name": NAME,
                "description": "",
                "instructions": "",
                "value": {"urls": ["https://github.com/example/project"]},
            },
        ),
    ),
    "rename a reference": (
        Persona.OWNER,
        Ask("PATCH", f"{G}/references/{{reference}}", {"name": NAME}),
    ),
    "create a document": (
        Persona.OWNER,
        Ask(
            "POST",
            f"{G}/documents",
            {"name": NAME, "description": "", "instructions": "", "content": ""},
        ),
    ),
    "rename a document": (
        Persona.OWNER,
        Ask("PATCH", f"{G}/documents/{{document}}", {"name": NAME}),
    ),
    "create a package": (
        Persona.OWNER,
        Ask(
            "POST",
            f"{G}/packages",
            {"name": NAME, "description": "", "instructions": ""},
        ),
    ),
    "rename a package": (
        Persona.OWNER,
        Ask("PATCH", f"{G}/packages/{{package}}", {"name": NAME}),
    ),
    "create an organization": (
        Persona.MEMBER,
        Ask("POST", f"{G}/organizations", {"name": NAME}),
    ),
    "create a workspace": (
        Persona.ORG_ADMIN,
        Ask("POST", f"{G}/organizations/current/workspaces", {"name": NAME}),
    ),
    "create a workspace by its old route": (
        Persona.MEMBER,
        Ask("POST", f"{G}/tenants", {"name": NAME}),
    ),
    "rename a workspace": (
        Persona.WORKSPACE_ADMIN,
        Ask("PATCH", f"{G}/tenants/{{tenant}}", {"name": NAME}),
    ),
    "rename an organization": (
        Persona.ORG_ADMIN,
        Ask("PATCH", f"{G}/organizations/current", {"name": NAME}),
    ),
    "rename yourself": (
        Persona.MEMBER,
        Ask("PATCH", f"{G}/auth/me", {"name": NAME}),
    ),
    "create an account as the operator": (
        Persona.OPERATOR,
        Ask(
            "POST",
            f"{G}/users",
            {
                "name": NAME,
                "email": "made-by-the-operator@example.invalid",
                "password": "correct-horse-battery-staple",
            },
        ),
    ),
}

# Made and renamed only, as the rest are made by the matrix's own people.
WORKSPACE_AND_ORGANIZATION = (
    "create an organization",
    "create a workspace",
    "create a workspace by its old route",
)


def _with_name(value: Any, name: str) -> Any:
    if value == NAME:
        return name
    if isinstance(value, dict):
        return {key: _with_name(item, name) for key, item in value.items()}
    return value


async def _ask(
    session_factory: async_sessionmaker[AsyncSession], route: str, name: str
) -> tuple[int, str]:
    persona, ask = NAMED[route]
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, persona.value, http, gateway)
        filled = await world.fill(ask)
        response = await http.request(
            filled.method,
            filled.path,
            json=_with_name(filled.json, name),
            headers=people.headers(persona),
        )
    return response.status_code, response.text


@pytest.mark.parametrize("route", sorted(NAMED))
@pytest.mark.parametrize(
    ("name", "named"),
    [
        ("fe-rtl \u202eslrep.exe", "U+202E (RIGHT-TO-LEFT OVERRIDE)"),
        ("plan\u2066b", "U+2066 (LEFT-TO-RIGHT ISOLATE)"),
        ("ops\u200bteam", "U+200B (ZERO WIDTH SPACE)"),
        ("\ufeffops", "U+FEFF (ZERO WIDTH NO-BREAK SPACE)"),
        ("ops\u2060", "U+2060 (WORD JOINER)"),
    ],
)
async def test_a_name_with_a_hidden_character_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
    route: str,
    name: str,
    named: str,
) -> None:
    status, text = await _ask(session_factory, route, name)
    assert status == 422, text
    assert named in text
    assert "changes how the name reads without showing" in text


@pytest.mark.parametrize("route", sorted(NAMED))
async def test_a_name_in_any_script_is_kept(
    session_factory: async_sessionmaker[AsyncSession], route: str
) -> None:
    status, text = await _ask(session_factory, route, "Équipe 東京 فريق עברית 🚀")
    # 418 is the matrix's stand-in for a workspace's provisioning, reached
    # only once the body is taken.
    assert status < 300 or (route in WORKSPACE_AND_ORGANIZATION and status == 418), text


@pytest.mark.parametrize("route", WORKSPACE_AND_ORGANIZATION)
@pytest.mark.parametrize(
    "name",
    ["x" * 256, "a" * 200_000, "line one\nline two", "tab\there", "   "],
    ids=["256 characters", "200 KB", "two lines", "a tab", "blank"],
)
async def test_making_a_workspace_or_organization_keeps_renames_rules(
    session_factory: async_sessionmaker[AsyncSession], route: str, name: str
) -> None:
    status, text = await _ask(session_factory, route, name)
    assert status == 422, text


async def test_an_organizations_first_workspace_name_is_held_to_them_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        response = await http.post(
            f"{G}/organizations",
            json={"name": "Acme two", "workspace_name": "first\nsecond"},
            headers=people.headers(Persona.MEMBER),
        )
    assert response.status_code == 422, response.text
    assert "line break" in response.text
