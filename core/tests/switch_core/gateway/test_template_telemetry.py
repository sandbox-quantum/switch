"""Saving, changing and removing templates in the gateway is reported.

Who wrote a template (a person here, an agent through its tools) and which
template that comes with Switch an admin took off their workspace. Never a
saved template's name or document.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.gateway import templates as gateway_templates
from tests.switch_core.gateway.test_template_http import _client, _upload, users
from tests.telemetry_records import recording_telemetry

__all__ = ["users"]


async def test_saving_and_changing_say_a_person_did(
    session_factory: async_sessionmaker[AsyncSession],
    users: dict[str, User],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    telemetry, sink = recording_telemetry()
    monkeypatch.setattr(gateway_templates, "current_telemetry", lambda: telemetry)
    client = _client(session_factory, users["alice"])

    created = await _upload(client, kind="room")
    changed = await client.patch(
        f"/templates/{created['id']}", json={"description": "now with more"}
    )
    unchanged = await client.patch(
        f"/templates/{created['id']}", json={"description": "now with more"}
    )
    empty = await client.patch(f"/templates/{created['id']}", json={})

    assert changed.status_code == 200, changed.text
    assert unchanged.status_code == 200, unchanged.text
    assert empty.status_code == 200, empty.text
    assert sink.events("template_created") == [
        {"template_kind": "room", "author": "person"}
    ]
    [updated] = sink.events("template_updated")
    assert (updated["template_kind"], updated["author"]) == ("room", "person")
    assert updated["age_days"] >= 0


async def test_an_official_template_taken_off_a_workspace_is_reported_once(
    session_factory: async_sessionmaker[AsyncSession],
    users: dict[str, User],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    telemetry, sink = recording_telemetry()
    monkeypatch.setattr(gateway_templates, "current_telemetry", lambda: telemetry)
    async with session_factory() as session:
        admin = User(name="root", email="root@test", role="admin", password_hash="x")
        session.add(admin)
        await session.commit()
    as_admin = _client(session_factory, admin)

    for _ in range(2):
        removed = await as_admin.delete("/templates/official:incident-war-room")
        assert removed.status_code == 200, removed.text

    assert sink.events("official_template_hidden") == [
        {"official_slug": "incident-war-room"}
    ]
