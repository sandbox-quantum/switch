"""A retained worker volume's pre-cutover work, merged with Core's capture and decided once."""

from __future__ import annotations

import hashlib
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.hosted_cutover import (
    RoomMessageRecord,
    decide_room_message,
    merge_worker,
)
from switch_core.db.models import (
    HostedCutoverItem,
    HostedCutoverVolume,
    HostedWakeMailbox,
    require_tenant_id,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    controller_app,
)
from tests.switch_core.gateway.test_hosted_mailbox import (  # noqa: F401
    attach,
    mailbox_app,
    set_launch,
)
from tests.switch_core.gateway.test_hosted_workers import worker_app  # noqa: F401


def room_record(
    room_id: str,
    message_id: str,
    *,
    room_pending: bool,
    host: str | None,
    failure_notified: bool,
) -> dict[str, Any]:
    return {
        "kind": "room_message",
        "session_id": "watcher-placeholder",
        "room_id": room_id,
        "message_id": message_id,
        "thread_id": None,
        "room_pending": room_pending,
        "failure_notified": failure_notified,
        "host": host,
    }


async def core_item(app, kind: str, evidence: dict[str, Any], **columns: Any) -> None:
    """A row as the cutover-manifest revision captured it from the old session tables."""
    async with app.factory() as session:
        session.add(
            HostedCutoverItem(
                tenant_id=require_tenant_id(),
                id=str(uuid4()),
                agent_id=app.agent_id,
                launch_id=app.request_id,
                session_id="watcher-placeholder",
                kind=kind,
                evidence={"core": evidence},
                **columns,
            )
        )
        await session.commit()


async def upload(app, conn, items: list[dict[str, Any]], sha: str | None = None):
    return await app.client.post(
        f"/agents/{app.agent_id}/connection/cutover-manifest",
        json={
            "connection_id": conn.id,
            "generation": conn.stream_generation,
            "manifest_sha256": sha or hashlib.sha256(repr(items).encode()).hexdigest(),
            "items": items,
        },
    )


async def items(app) -> list[HostedCutoverItem]:
    async with app.factory() as session:
        return list(
            await session.scalars(
                select(HostedCutoverItem)
                .where(HostedCutoverItem.tenant_id == require_tenant_id())
                .order_by(HostedCutoverItem.created_at, HostedCutoverItem.kind)
            )
        )


async def mailbox(app) -> list[HostedWakeMailbox]:
    async with app.factory() as session:
        return list(
            await session.scalars(
                select(HostedWakeMailbox).where(
                    HostedWakeMailbox.tenant_id == require_tenant_id()
                )
            )
        )


async def ready(app):
    await set_launch(app, state="ready")
    await attach(app)
    (conn,) = app.service.connections.for_agent(app.agent_id)
    conn.worker_frames.drain()
    return conn


@pytest.mark.parametrize(
    ("core_status", "host", "disposition", "notices", "imported"),
    [
        ("accepted", "dispatched", "uncertain", 1, False),
        (None, "accepted", "import", 0, True),
        ("applied", None, "ran", 0, False),
        ("rejected", None, "unrecoverable", 1, False),
        ("unknown", None, "uncertain", 1, False),
    ],
)
async def test_cutover_merges_overlapping_records(
    mailbox_app,  # noqa: F811
    core_status,
    host,
    disposition,
    notices,
    imported,
):
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    if core_status is not None:
        await core_item(
            app,
            "room_message",
            {"command_id": "placeholder-command", "status": core_status, "code": None},
            room_id=room,
            message_id="$m1",
        )
    response = await upload(
        app,
        conn,
        [
            room_record(
                room, "$m1", room_pending=True, host=host, failure_notified=False
            )
        ],
    )
    assert response.status_code == 200, response.text
    (item,) = await items(app)
    assert (item.kind, item.room_id, item.message_id) == ("room_message", room, "$m1")
    assert item.disposition == disposition
    assert item.evidence["worker"]["host"] == host
    assert len(app.sent) == notices
    rows = await mailbox(app)
    if imported:
        (row,) = rows
        assert (row.room_id, row.message_id, row.origin) == (room, "$m1", "cutover")
        assert row.state == "offered"
        assert item.payload["payload"]["message_id"] == "$m1"
        (wake,) = [
            data for event, data in conn.worker_frames.drain() if event == "wake"
        ]
        assert wake["entries"][0]["origin"] == "cutover"
    else:
        assert rows == []
        assert item.payload is None


async def test_cutover_is_applied_once_per_manifest(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    manifest = [
        room_record(room, "$m1", room_pending=True, host=None, failure_notified=True),
        room_record(
            room, "$m2", room_pending=False, host="dispatched", failure_notified=False
        ),
    ]
    first = await upload(app, conn, manifest, sha="a" * 64)
    again = await upload(app, conn, manifest, sha="a" * 64)
    assert first.status_code == 200, first.text
    assert again.status_code == 200, again.text
    other = await upload(app, conn, manifest[:1], sha="b" * 64)
    assert other.status_code == 409
    assert other.json()["detail"]["code"] == "cutover_manifest_conflict"

    decided = {item.message_id: item.disposition for item in await items(app)}
    assert decided == {"$m1": "import", "$m2": "uncertain"}
    assert [row.message_id for row in await mailbox(app)] == ["$m1"]
    bodies = sorted(body for _, _, body in app.sent)
    assert len(bodies) == 2
    assert any("will process this message now" in body for body in bodies)
    assert any("may have been interrupted" in body for body in bodies)
    assert all(item.notice_posted_at is not None for item in await items(app))
    async with app.factory() as session:
        volume = await session.get(
            HostedCutoverVolume, (require_tenant_id(), app.request_id)
        )
        assert volume is not None
        assert (volume.preflight_state, volume.manifest_sha256) == (
            "complete",
            "a" * 64,
        )


async def test_cutover_refuses_a_message_it_cannot_rebuild(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    response = await upload(
        app,
        conn,
        [
            room_record(
                room, "$gone", room_pending=True, host=None, failure_notified=False
            )
        ],
    )
    assert response.status_code == 200, response.text
    (item,) = await items(app)
    assert item.disposition == "unrecoverable"
    assert await mailbox(app) == []
    ((_, _, body),) = app.sent
    assert "was not run" in body


async def test_cutover_decides_items_that_are_not_room_messages(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    await core_item(
        app,
        "console_command",
        {"command_id": "console-delivered", "status": "accepted"},
    )
    await core_item(
        app, "console_command", {"command_id": "console-lost", "status": "accepted"}
    )
    await core_item(
        app,
        "request_open",
        {"request_id": "request-1", "epoch": 1},
        room_id=room,
        thread_id=None,
    )
    await core_item(app, "session", {"epoch": 1})
    response = await upload(
        app,
        conn,
        [
            {
                "kind": "console_command",
                "session_id": "watcher-placeholder",
                "command_id": "console-delivered",
                "host": "accepted",
            },
            {
                "kind": "request_open",
                "session_id": "watcher-placeholder",
                "request_id": "request-1",
                "room_id": None,
                "thread_id": None,
            },
            {"kind": "reset_pending", "session_id": "watcher-placeholder"},
        ],
    )
    assert response.status_code == 200, response.text
    decided = {
        (
            item.kind,
            (item.evidence.get("core") or {}).get("command_id"),
        ): item.disposition
        for item in await items(app)
    }
    assert decided == {
        ("console_command", "console-delivered"): "settled_by_host",
        ("console_command", "console-lost"): "owner_notice",
        ("request_open", None): "interrupted",
        ("session", None): "preserved",
        ("reset_pending", None): "preserved",
    }
    ((notice_room, _, body),) = app.sent
    assert notice_room == room
    assert "approval" in body
    assert await mailbox(app) == []


def test_decide_room_message_prefers_the_strongest_evidence():
    records = [
        RoomMessageRecord(
            kind="room_message",
            session_id="a",
            room_id="!r:example.com",
            message_id="$m",
            thread_id=None,
            room_pending=True,
            failure_notified=True,
            host=None,
        ),
        RoomMessageRecord(
            kind="room_message",
            session_id="b",
            room_id="!r:example.com",
            message_id="$m",
            thread_id="$t",
            room_pending=False,
            failure_notified=False,
            host="dispatched",
        ),
    ]
    merged = merge_worker(records)
    assert merged is not None
    assert (merged.session_id, merged.host, merged.thread_id) == (
        "b",
        "dispatched",
        "$t",
    )
    assert merged.room_pending and merged.failure_notified
    assert decide_room_message("accepted", merged) == "uncertain"
    assert decide_room_message("applied", merged) == "ran"
    assert decide_room_message(None, merge_worker(records[:1])) == "import"
    assert decide_room_message("accepted", None) == "import"
