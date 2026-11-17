"""`switch-connector-apps`: the dashboard's save and removal, from where
switch-core runs, against Postgres and the fake vendors the routes' tests use.
Nothing it prints or refuses with carries a secret."""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_signals import CONNECTOR_APP_CHANGED_SIGNAL
from switch_core.connector_apps_admin import (
    list_apps,
    parse_save,
    print_apps,
    remove_app,
    set_app,
)
from switch_core.db.models import ServerAuditEvent, ServiceAppCredential, User
from switch_core.operator_commands import CommandRefused
from tests.switch_core.connections.fake_vendor import (
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
)
from tests.switch_core.gateway.test_connector_apps import GOOGLE, PUBLIC, World

ADMIN_EMAIL = "admin@example.invalid"
COMMAND = {"platform_operator_command": True}


class _Bus:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []

    def publish(self, kind: str, **fields: Any) -> None:
        self.published.append((kind, fields))


async def _administrator(session_factory: async_sessionmaker[AsyncSession]) -> User:
    async with session_factory() as session:
        user = User(name="Administrator", email=ADMIN_EMAIL, role="admin")
        session.add(user)
        await session.commit()
        return user


async def _audit(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServerAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
            )
        )


def _body(**overrides: object) -> str:
    return json.dumps(
        {
            "client_id": STATIC_CLIENT_ID,
            "client_secret": STATIC_CLIENT_SECRET,
            "replace": False,
            **overrides,
        }
    )


async def test_a_save_is_checked_stored_audited_and_announced(
    session_factory: async_sessionmaker[AsyncSession],
    capsys: pytest.CaptureFixture[str],
) -> None:
    world = World(session_factory, PUBLIC)
    apps = await world.install()
    administrator = await _administrator(session_factory)
    bus = _Bus()

    result = await set_app(
        apps,
        session_factory,
        bus,  # type: ignore[arg-type]
        service=GOOGLE,
        body=parse_save(_body()),
        admin_email=ADMIN_EMAIL,
    )

    assert result.ok
    async with session_factory() as session:
        [row] = await session.scalars(select(ServiceAppCredential))
    assert (row.service, row.client_id, row.updated_by) == (
        GOOGLE,
        STATIC_CLIENT_ID,
        administrator.id,
    )
    [event] = await _audit(session_factory)
    assert (event.action, event.actor_user_id) == ("connector_app.saved", None)
    assert event.details == {
        "service": GOOGLE,
        "fields_changed": ["client_id", "client_secret"],
        "client_id": STATIC_CLIENT_ID,
        **COMMAND,
    }
    assert bus.published == [(CONNECTOR_APP_CHANGED_SIGNAL, {"service": GOOGLE})]

    print_apps(await list_apps(apps, session_factory))
    printed = capsys.readouterr().out
    assert STATIC_CLIENT_SECRET not in printed
    assert f"{GOOGLE} (" in printed and "client_secret set" in printed


async def test_a_save_the_vendor_refuses_stores_nothing_and_names_no_secret(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = World(session_factory, PUBLIC)
    apps = await world.install()
    await _administrator(session_factory)
    bus = _Bus()
    wrong = "not-the-secret-at-all-0000"

    with pytest.raises(CommandRefused, match="vendor refused") as refused:
        await set_app(
            apps,
            session_factory,
            bus,  # type: ignore[arg-type]
            service=GOOGLE,
            body=parse_save(_body(client_secret=wrong)),
            admin_email=ADMIN_EMAIL,
        )

    assert wrong not in str(refused.value)
    async with session_factory() as session:
        assert list(await session.scalars(select(ServiceAppCredential))) == []
    assert await _audit(session_factory) == []
    assert bus.published == []


def test_a_file_that_wont_do_names_the_field_not_the_secret() -> None:
    secret = "x" * 5000

    with pytest.raises(CommandRefused, match="client_secret") as refused:
        parse_save(_body(client_secret=secret, extra="field"))

    assert secret not in str(refused.value)
    assert "extra" in str(refused.value)


async def test_an_unknown_service_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = World(session_factory, PUBLIC)
    apps = await world.install()
    await _administrator(session_factory)

    with pytest.raises(CommandRefused, match="no app to set up"):
        await set_app(
            apps,
            session_factory,
            _Bus(),  # type: ignore[arg-type]
            service="no-such-service",
            body=parse_save(_body()),
            admin_email=ADMIN_EMAIL,
        )


async def test_removing_a_saved_app_audited_and_announced(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = World(session_factory, PUBLIC)
    apps = await world.install()
    await _administrator(session_factory)
    bus = _Bus()
    await set_app(
        apps,
        session_factory,
        bus,  # type: ignore[arg-type]
        service=GOOGLE,
        body=parse_save(_body()),
        admin_email=ADMIN_EMAIL,
    )

    client_id = await remove_app(
        apps,
        session_factory,
        bus,  # type: ignore[arg-type]
        service=GOOGLE,
    )

    assert client_id == STATIC_CLIENT_ID
    async with session_factory() as session:
        assert list(await session.scalars(select(ServiceAppCredential))) == []
    removed = (await _audit(session_factory))[-1]
    assert (removed.action, removed.actor_user_id) == ("connector_app.removed", None)
    assert removed.details == {
        "service": GOOGLE,
        "client_id": STATIC_CLIENT_ID,
        **COMMAND,
    }
    assert len(bus.published) == 2
    with pytest.raises(CommandRefused, match="no saved app"):
        await remove_app(
            apps,
            session_factory,
            bus,  # type: ignore[arg-type]
            service=GOOGLE,
        )
