"""Every gateway route, asked by every persona, answers as `routes.py` says.

This is the server's half of "no route relies on the UI to hide an action":
whatever a page offers or hides, the route itself refuses whoever may not use
it. The table is held to the committed route snapshot, which CI keeps equal to
the routes the server mounts (`scripts/e2e_surface.py --check`), so a route
cannot be added without saying here who may use it.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.switch_core.gateway.role_matrix.access import Expected, matches
from tests.switch_core.gateway.role_matrix.harness import (
    REPO_ROOT,
    SURFACE,
    Persona,
    build_gateway,
    client,
    seed_people,
    socket_status,
    stream_status,
)
from tests.switch_core.gateway.role_matrix.routes import (
    ROUTES,
    STREAMS,
    UNAUTHENTICATED,
)
from tests.switch_core.gateway.role_matrix.world import World

SNAPSHOT = REPO_ROOT / "console" / "tooling-e2e" / "surface" / "server-surface.json"


def _shown(expected: Expected) -> str:
    return str(sorted(expected)) if isinstance(expected, frozenset) else str(expected)


def _snapshot() -> dict[str, str]:
    routes = json.loads(SNAPSHOT.read_text())["gatewayRoutes"]
    return {route["route"]: route["auth"] for route in routes}


def test_the_table_says_who_may_use_every_route_the_server_mounts() -> None:
    snapshot = _snapshot()
    tables = (ROUTES, STREAMS, UNAUTHENTICATED)
    named = [key for table in tables for key in table]
    assert len(named) == len(set(named)), "a route is in two tables"
    assert set(named) - set(snapshot) == set(), "routes the server no longer mounts"
    assert set(snapshot) - set(named) == set(), "routes nobody said who may use"
    assert set(UNAUTHENTICATED) == {
        key for key, auth in snapshot.items() if auth != "session"
    }


async def test_the_matrix_asks_the_app_the_server_mounts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Every route in the snapshot is mounted on the app the matrix asks, so
    an answer here is the answer a deployment gives."""
    assert set(SURFACE._routes_by_key(build_gateway(session_factory))) == set(
        _snapshot()
    )


@pytest.mark.parametrize("route", sorted(ROUTES))
async def test_each_route_answers_each_persona_as_it_should(
    session_factory: async_sessionmaker[AsyncSession], route: str
) -> None:
    case = ROUTES[route]
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
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


async def test_streams_answer_whom_they_should(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The routes whose answer is a stream or a socket: each persona may open
    their own, and nobody may without a session."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    opened: dict[str, dict[str, int]] = {}
    for route, opens in (
        ("GET /gateway/chats/events", stream_status),
        ("GET /gateway/chats/activity/events", stream_status),
        ("WS /gateway/changes/ws", socket_status),
    ):
        path = STREAMS[route].ask.path
        opened[route] = {
            persona.value: await opens(gateway, path, people.headers(persona))
            for persona in Persona
        }
        opened[route]["nobody"] = await opens(gateway, path, {})
    everyone = [persona.value for persona in Persona]
    assert opened == {
        "GET /gateway/chats/events": {**dict.fromkeys(everyone, 200), "nobody": 401},
        "GET /gateway/chats/activity/events": {
            **dict.fromkeys(everyone, 200),
            "nobody": 401,
        },
        "WS /gateway/changes/ws": {**dict.fromkeys(everyone, 101), "nobody": 401},
    }


async def test_only_the_people_in_a_chat_may_upload_to_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    answers: dict[str, int] = {}
    async with client(gateway) as http:
        for persona in Persona:
            world = World(session_factory, people, persona.value, http, gateway)
            ask = await world.fill(
                STREAMS["POST /gateway/chats/{room_id}/attachments"].ask
            )
            response = await http.post(
                ask.path,
                data={"uploadId": f"{persona.value}-upload"},
                files={"file": ("note.txt", b"hello", "text/plain")},
                headers=people.headers(persona),
            )
            answers[persona.value] = response.status_code
    assert answers == {
        **dict.fromkeys(
            (
                Persona.ORG_ADMIN,
                Persona.WORKSPACE_ADMIN,
                Persona.MEMBER,
                Persona.OPERATOR,
            ),
            403,
        ),
        Persona.OWNER: 200,
    }


@pytest.mark.parametrize("route", sorted(UNAUTHENTICATED))
async def test_a_route_without_a_session_answers_everyone_alike(
    session_factory: async_sessionmaker[AsyncSession], route: str
) -> None:
    """It reads no session, so being signed in, and as whom, changes nothing."""
    method, path = route.split(" ", 1)
    path = path.replace("{service}", "github").replace(
        "{machine_id}", "no-such-machine"
    )
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        answers = {
            persona.value: (
                await http.request(method, path, headers=people.headers(persona))
            ).status_code
            for persona in Persona
        }
        nobody = (await http.request(method, path)).status_code
    assert set(answers.values()) == {nobody}, answers


@pytest.mark.parametrize("action", ["bulk-delete", "bulk-archive"])
async def test_bulk_room_actions_touch_only_rooms_the_caller_may(
    session_factory: async_sessionmaker[AsyncSession], action: str
) -> None:
    """They answer everyone, skipping each room the caller may not delete or
    change, so what each persona was let do is in the count."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    counts: dict[str, int] = {}
    async with client(gateway) as http:
        for persona in Persona:
            world = World(session_factory, people, persona.value, http, gateway)
            body: dict[str, object] = {"room_ids": [await world.room()]}
            if action == "bulk-archive":
                body["archived"] = True
            response = await http.post(
                f"/gateway/rooms/{action}", json=body, headers=people.headers(persona)
            )
            assert response.status_code == 200, response.text
            counted = response.json()
            counts[persona.value] = counted[
                "deleted" if action == "bulk-delete" else "updated"
            ]
    assert counts == {
        **dict.fromkeys(Persona, 1),
        Persona.MEMBER: 0,
    }
