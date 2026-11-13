"""Signing in to a service connector is reported: each attempt as it
starts, and each that ends without a connection, with where and why.

The services here are a test catalog's, not the shipped one, so they report
as `unknown`: a slug outside the catalog is never sent.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.gateway import service_flows as service_flows_routes
from tests.switch_core.gateway.test_service_flows import (
    FLOWS,
    PUBLIC,
    Console,
    _loopback_code,
    _loopback_connect,
    _switch,
    _world,
)
from tests.switch_core.management.harness import add_member
from tests.telemetry_records import RecordingSink, recording_telemetry


def _recording(monkeypatch: pytest.MonkeyPatch) -> RecordingSink:
    telemetry, sink = recording_telemetry()
    monkeypatch.setattr(service_flows_routes, "current_telemetry", lambda: telemetry)
    return sink


async def test_a_sign_in_starts_and_one_taken_by_someone_else_fails(
    session_factory: async_sessionmaker[AsyncSession],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sink = _recording(monkeypatch)
    world = _world(session_factory, tmp_path / "catalog")
    ada = await add_member(session_factory, "ada")
    grace = await add_member(session_factory, "grace")
    async with world.harness.client() as client:
        await _loopback_connect(world, Console(client, ada))
        second = Console(client, grace)
        refused = await second.complete(await _loopback_code(world, second))
    assert refused.status_code == 409

    assert sink.events("service_connection_started") == [
        {"service": "unknown", "auth_kind": "oauth"},
        {"service": "unknown", "auth_kind": "oauth"},
    ]
    assert sink.events("service_connection_failed") == [
        {
            "service": "unknown",
            "stage": "complete",
            "reason": "account_linked_elsewhere",
        }
    ]


async def test_a_service_switched_off_is_refused_at_the_start(
    session_factory: async_sessionmaker[AsyncSession],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sink = _recording(monkeypatch)
    world = _world(session_factory, tmp_path / "catalog", workspace_gate=True)
    ada = await add_member(session_factory, "ada")
    await _switch(session_factory, False, ada)
    async with world.harness.client() as client:
        refused = await Console(client, ada).start()
    assert refused.status_code == 403

    assert sink.events("service_connection_started") == []
    assert sink.events("service_connection_failed") == [
        {"service": "unknown", "stage": "start", "reason": "refused"}
    ]


async def test_a_cancelled_sign_in_is_reported_once_however_often_the_page_loads(
    session_factory: async_sessionmaker[AsyncSession],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The vendor sends the browser back with no code: the sign-in ended. A
    reload, or a browser that did not leave through Switch, ends nothing."""
    sink = _recording(monkeypatch)
    world = _world(
        session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
    )
    ada = await add_member(session_factory, "ada")
    async with world.harness.client() as client:
        console = Console(client, ada)
        started = await console.start()
        assert started.status_code == 200, started.text
        left = await client.get(started.json()["url"].removeprefix(PUBLIC))
        cookie = {
            f"switch_service_{console.state}": left.cookies[
                f"switch_service_{console.state}"
            ]
        }
        cancelled = f"{FLOWS}/callback?state={console.state}&code="

        stranger = await client.get(cancelled)
        ended = await client.get(cancelled, cookies=cookie)
        reloaded = await client.get(cancelled, cookies=cookie)

    assert (stranger.status_code, ended.status_code, reloaded.status_code) == (
        400,
        400,
        400,
    )
    assert sink.events("service_connection_failed") == [
        {"service": "unknown", "stage": "vendor", "reason": "cancelled"}
    ]


async def test_a_code_sent_back_twice_is_not_a_failure(
    session_factory: async_sessionmaker[AsyncSession],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sink = _recording(monkeypatch)
    world = _world(
        session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
    )
    ada = await add_member(session_factory, "ada")
    async with world.harness.client() as client:
        console = Console(client, ada)
        started = await console.start()
        left = await client.get(started.json()["url"].removeprefix(PUBLIC))
        back = urlsplit(world.vendor.authorize(left.headers["location"]))
        code = parse_qs(back.query)["code"][0]
        cookie = {
            f"switch_service_{console.state}": left.cookies[
                f"switch_service_{console.state}"
            ]
        }
        path = f"{back.path}?{back.query}"
        assert (await client.get(path, cookies=cookie)).status_code == 303
        assert (await client.get(path, cookies=cookie)).status_code == 400
        assert (await console.complete(code)).status_code == 200
        assert (await console.complete(code)).status_code == 400

    assert sink.events("service_connection_failed") == []
