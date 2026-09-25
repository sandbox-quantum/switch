"""A retained worker volume's pre-cutover work, merged with Core's capture and decided once."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from switch_core.bridges.agent.hosted_cutover import (
    CutoverConflict,
    CutoverManifest,
    RoomMessageRecord,
    apply_manifest,
    decide_room_message,
    merge_worker,
    record_blocked,
)
from switch_core.bridges.agent.hosted_mailbox import mailbox_upkeep
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


async def volume(app) -> None:
    """The row the cutover-manifest revision makes for the launch."""
    async with app.factory() as session:
        await session.execute(
            insert(HostedCutoverVolume)
            .values(tenant_id=require_tenant_id(), launch_id=app.request_id)
            .on_conflict_do_nothing()
        )
        await session.commit()


async def record(
    app, items: list[dict[str, Any]], sha: str | None = None
) -> CutoverManifest:
    """`hosted-cutover-upgrade record` with the manifest a preflight check answered."""
    manifest = CutoverManifest.model_validate(
        {
            "manifest_sha256": sha or hashlib.sha256(repr(items).encode()).hexdigest(),
            "items": items,
        }
    )
    await volume(app)
    async with app.factory() as session:
        await apply_manifest(
            session, agent_id=app.agent_id, launch_id=app.request_id, manifest=manifest
        )
        await session.commit()
    return manifest


async def confirm(app, conn, manifest: CutoverManifest):
    """The worker's upload of the manifest its first boot wrote."""
    return await app.client.post(
        f"/agents/{app.agent_id}/connection/cutover-manifest",
        json={
            "connection_id": conn.id,
            "generation": conn.stream_generation,
            **manifest.model_dump(mode="json"),
        },
    )


async def upload(app, conn, items: list[dict[str, Any]], sha: str | None = None):
    return await confirm(app, conn, await record(app, items, sha))


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
    with pytest.raises(CutoverConflict, match="a" * 64):
        await record(app, manifest[:1], sha="b" * 64)
    other = await confirm(
        app,
        conn,
        CutoverManifest.model_validate(
            {"manifest_sha256": "b" * 64, "items": manifest[:1]}
        ),
    )
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


async def test_an_import_into_a_session_awaiting_a_reset_says_it_waits(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    elsewhere = {
        **room_record(room, "$m3", room_pending=True, host=None, failure_notified=True),
        "session_id": "other-session",
    }
    response = await upload(
        app,
        conn,
        [
            {"kind": "reset_pending", "session_id": "watcher-placeholder"},
            room_record(
                room, "$m1", room_pending=True, host=None, failure_notified=True
            ),
            room_record(
                room, "$m2", room_pending=True, host=None, failure_notified=False
            ),
            elsewhere,
        ],
    )
    assert response.status_code == 200, response.text

    decided = {
        item.message_id: item.disposition
        for item in await items(app)
        if item.kind == "room_message"
    }
    assert decided == {"$m1": "import", "$m2": "import", "$m3": "import"}
    bodies = sorted(body for _, _, body in app.sent)
    assert len(bodies) == 3
    waiting = [body for body in bodies if "cannot continue" in body]
    assert len(waiting) == 2
    assert all("!reset @" in body for body in waiting)
    assert sum("will process this message now" in body for body in bodies) == 1


async def test_cutover_refuses_a_manifest_recorded_for_no_volume(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    conn = await ready(app)
    manifest = CutoverManifest.model_validate(
        {
            "manifest_sha256": "c" * 64,
            "items": [
                room_record(
                    room, "$m1", room_pending=True, host=None, failure_notified=False
                )
            ],
        }
    )
    missing = await confirm(app, conn, manifest)
    assert missing.status_code == 409
    assert missing.json()["detail"]["code"] == "cutover_manifest_unrecorded"
    await volume(app)
    pending = await confirm(app, conn, manifest)
    assert pending.status_code == 409
    assert "preflight pending" in pending.json()["detail"]["message"]
    assert await items(app) == []
    assert await mailbox(app) == []


async def test_a_blocked_volume_completes_once_it_checks_clean(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    await volume(app)
    async with app.factory() as session:
        await record_blocked(session, app.request_id, "sessions at events.jsonl:3: bad")
        await session.commit()
    async with app.factory() as session:
        blocked = await session.get(
            HostedCutoverVolume, (require_tenant_id(), app.request_id)
        )
        assert blocked is not None
        assert (blocked.preflight_state, blocked.blocked_reason) == (
            "blocked",
            "sessions at events.jsonl:3: bad",
        )
    await record(
        app,
        [
            room_record(
                room, "$m1", room_pending=True, host=None, failure_notified=False
            )
        ],
        sha="d" * 64,
    )
    async with app.factory() as session:
        complete = await session.get(
            HostedCutoverVolume,
            (require_tenant_id(), app.request_id),
            populate_existing=True,
        )
        assert complete is not None
        assert (complete.preflight_state, complete.blocked_reason) == (
            "complete",
            None,
        )
        with pytest.raises(CutoverConflict):
            await record_blocked(session, app.request_id, "late")


async def test_upkeep_posts_the_notices_a_recorded_volume_owes(mailbox_app):  # noqa: F811
    app = mailbox_app
    room = app.rooms[0]
    await record(
        app,
        [
            room_record(
                room,
                "$m2",
                room_pending=False,
                host="dispatched",
                failure_notified=False,
            )
        ],
    )
    assert app.sent == []
    await mailbox_upkeep(app.service, datetime.now(UTC))
    ((notice_room, _, body),) = app.sent
    assert notice_room == room
    assert "may have been interrupted" in body
    (item,) = await items(app)
    assert item.notice_posted_at is not None
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert len(app.sent) == 1


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
