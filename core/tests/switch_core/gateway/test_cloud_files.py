"""Your cloud files: the owner's routes to the files on their own box
(`gateway/cloud_files.py`), with a stand-in controller on this process's
socket table."""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from switch_core.db.models import (
    AgentController,
    CloudMachine,
    MachineWorkspace,
    TenantMember,
    TenantUsage,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.file_requests import file_requests
from switch_core.gateway import cloud_files
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.tenant_context import current_tenant_id
from tests.switch_core.hosted_machine_helpers import (
    add_tenant,
    link_controller,
    seed_machine,
)

HTML = b"<html><script>alert(document.cookie)</script></html>"
BIG = bytes(range(256)) * 800  # 204,800 bytes: two chunks
FILES = {
    "agent-a/report.html": HTML,
    "agent-a/notes.md": b"# Notes\n",
    "agent-a/big.bin": BIG,
    "agent-a/empty.txt": b"",
}
# A file the launcher reports as over the content route's 25 MB.
HUGE_SIZE = 30 * 1024 * 1024
ZIP_CHUNKS = [b"PK\x03\x04first", b"second", b"third"]


@dataclass
class FakeController:
    """Answers file requests as the box controller does, one reply per ask."""

    controller_id: str
    sent: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    bad_seq: bool = False
    silent: bool = False

    def send(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)
        if self.silent:
            return
        event, data = frame["event"], frame["data"]
        if event == "files.request":
            self._answer(data["id"], data, seq=0)
        elif event == "files.more":
            asked = next(f for f in self.sent if f["data"]["id"] == data["id"])
            seq = sum(
                1
                for f in self.sent
                if f["event"] == "files.more" and f["data"]["id"] == data["id"]
            )
            self._answer(data["id"], asked["data"], seq=seq)

    def _answer(self, id_: str, request: dict[str, Any], seq: int) -> None:
        reply: dict[str, Any] = {
            "type": "files.reply",
            "id": id_,
            "seq": seq,
            "last": True,
        }
        if self.bad_seq:
            reply["seq"] = seq + 5
        if self.error:
            reply["error"] = self.error
        elif request["op"] == "list":
            reply["entries"] = [
                # The launcher's real entry shape: `mtime` in epoch
                # milliseconds, and `agent` only on an agent's own folder.
                {
                    "name": "agent-a",
                    "kind": "folder",
                    "size": 0,
                    "mtime": 1793880000000,
                    "label": "Scout",
                    "agent": "agent-a",
                },
                {
                    "name": "shared",
                    "kind": "folder",
                    "size": 0,
                    "mtime": 1793880000000,
                    "label": "Shared",
                },
            ]
        elif request["op"] == "read":
            offset = request.get("offset", 0)
            if request["path"] == "agent-a/huge.bin":
                reply.update(data=base64.b64encode(b"x" * 16).decode(), size=HUGE_SIZE)
            else:
                data = FILES[request["path"]]
                part = data[offset : offset + 128 * 1024]
                reply.update(data=base64.b64encode(part).decode(), size=len(data))
        else:
            reply.update(
                data=base64.b64encode(ZIP_CHUNKS[seq]).decode(),
                last=seq == len(ZIP_CHUNKS) - 1,
            )
        file_requests.deliver(self.controller_id, reply)


@dataclass
class Box:
    client: httpx.AsyncClient
    factory: Any
    machine_id: str
    controller_id: str
    config: SimpleNamespace
    controller: FakeController

    def requests_sent(self) -> list[dict[str, Any]]:
        return [f for f in self.controller.sent if f["event"] == "files.request"]


async def _set_machine(box: Box, **values: Any) -> None:
    async with box.factory() as session:
        machine = await session.get(CloudMachine, box.machine_id)
        assert machine is not None
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


@pytest.fixture
async def box(session_factory) -> AsyncIterator[Box]:
    """The owner's running box, its controller's socket held by this process."""
    async with session_factory() as session:
        owner = User(
            name="owner", email="owner@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner.id, role="member")
        )
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.backend = "box"
        controller = await link_controller(session, machine)
        controller.connected_at = datetime.now(UTC)
        await session.commit()
        ids = (owner, machine.id, controller.id)
    config = SimpleNamespace(
        hosted_cloud_files_enabled=True, hosted_box_provisioning=True
    )
    app = FastAPI()
    app.include_router(cloud_files.router)

    async def session_dep():
        async with session_factory() as opened:
            yield opened

    app.dependency_overrides[get_session] = session_dep
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: ids[0]
    fake = FakeController(controller_id=ids[2])
    file_requests.socket_opened(ids[2], fake, fake.send)
    cloud_files.rate = cloud_files._Rate(cloud_files.RATE_PER_MINUTE)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://switch.example.com",
        ) as client:
            yield Box(client, session_factory, ids[1], ids[2], config, fake)
    finally:
        file_requests.socket_closed(ids[2], fake)


async def test_the_owner_lists_a_folder_with_its_agent_labels(box: Box, caplog) -> None:
    with caplog.at_level(logging.INFO, logger="switch_core.cloud_files.audit"):
        listed = await box.client.get("/cloud-files/list", params={"path": ""})

    assert listed.status_code == 200, listed.text
    assert [(e["name"], e["label"]) for e in listed.json()["entries"]] == [
        ("agent-a", "Scout"),
        ("shared", "Shared"),
    ]
    # The stable agent key and the epoch-millisecond time pass through as sent.
    assert [e.get("agent") for e in listed.json()["entries"]] == ["agent-a", None]
    assert listed.json()["entries"][0]["mtime"] == 1793880000000
    assert listed.headers["cache-control"] == "private, no-store"
    assert listed.headers["cross-origin-resource-policy"] == "same-origin"
    assert box.requests_sent()[0]["data"]["op"] == "list"
    assert "op=list" in caplog.text and "status=200" in caplog.text


async def test_an_html_file_comes_back_as_a_sandboxed_download(
    box: Box, caplog
) -> None:
    with caplog.at_level(logging.INFO, logger="switch_core.cloud_files.audit"):
        got = await box.client.get(
            "/cloud-files/content", params={"path": "agent-a/report.html", "offset": 0}
        )

    assert got.status_code == 206, got.text
    assert got.content == HTML
    assert got.headers["content-range"] == f"bytes 0-{len(HTML) - 1}/{len(HTML)}"
    assert got.headers["content-type"] == "application/octet-stream"
    assert got.headers["content-disposition"].startswith(
        'attachment; filename="report.html";'
    )
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert got.headers["cache-control"] == "private, no-store"
    assert got.headers["cross-origin-resource-policy"] == "same-origin"
    assert box.requests_sent()[0]["data"] == {
        "id": box.requests_sent()[0]["data"]["id"],
        "op": "read",
        "path": "agent-a/report.html",
        "offset": 0,
    }
    # The audit line names the path and the size, never the bytes.
    assert "agent-a/report.html" in caplog.text and f"bytes={len(HTML)}" in caplog.text
    assert "alert" not in caplog.text


async def test_a_folder_zip_streams_one_chunk_per_pull(box: Box) -> None:
    got = await box.client.get(
        "/cloud-files/zip", params={"path": "agent-a", "caches": 0}
    )

    assert got.status_code == 200, got.text
    assert got.content == b"".join(ZIP_CHUNKS)
    assert got.headers["content-disposition"].startswith(
        'attachment; filename="agent-a.zip";'
    )
    assert got.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert got.headers["cross-origin-resource-policy"] == "same-origin"
    events = [f["event"] for f in box.controller.sent]
    assert events == ["files.request", "files.more", "files.more"]
    assert box.controller.sent[0]["data"]["caches"] is False


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",
        "../x",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        "a\\b",
        "a\x00b",
        "/".join(["p"] * 65),
        "x" * 4097,
    ],
)
async def test_a_bad_path_shape_is_refused_before_anything_goes_down(
    box: Box, path: str
) -> None:
    got = await box.client.get("/cloud-files/list", params={"path": path})

    assert got.status_code in (400, 422), got.text
    assert box.requests_sent() == []


@pytest.mark.parametrize(
    ("error", "status"),
    [
        ("outside_root", 403),
        ("denied", 403),
        ("not_found", 404),
        ("too_large", 413),
        ("not_regular", 415),
        ("failed", 500),
        ("bad_request", 400),
        ("busy", 429),
        ("timeout", 504),
    ],
)
async def test_the_launchers_codes_come_back_with_their_statuses(
    box: Box, error: str, status: int
) -> None:
    box.controller.error = error

    got = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/notes.md"}
    )

    assert got.status_code == status
    assert got.json() == {"detail": {"code": error}}


async def test_a_reply_out_of_order_fails_the_request(box: Box) -> None:
    box.controller.bad_seq = True

    got = await box.client.get("/cloud-files/list", params={"path": ""})

    assert (got.status_code, got.json()["detail"]["code"]) == (502, "bad_reply")


async def test_with_the_flag_or_v2_off_there_are_no_files(box: Box) -> None:
    box.config.hosted_cloud_files_enabled = False
    assert (await box.client.get("/cloud-files/list")).status_code == 404
    box.config.hosted_cloud_files_enabled = True
    box.config.hosted_box_provisioning = False
    assert (await box.client.get("/cloud-files/list")).status_code == 404
    assert box.requests_sent() == []


async def test_someone_with_no_box_gets_no_files(box: Box) -> None:
    async with box.factory() as session:
        stranger = User(name="s", email="s@example.com", role="user", password_hash="x")
        session.add(stranger)
        await session.commit()
    box.client._transport.app.dependency_overrides[get_current_user] = lambda: stranger  # type: ignore[attr-defined]

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (404, "no_files")
    assert box.requests_sent() == []


async def test_a_resting_box_says_so(box: Box) -> None:
    file_requests.socket_closed(box.controller_id, box.controller)
    await _set_machine(
        box, state="stopped", desired_state="stopped", stop_reason="idle"
    )

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (409, "box_resting")


async def test_a_socket_held_by_another_process_asks_the_client_to_retry(
    box: Box,
) -> None:
    file_requests.socket_closed(box.controller_id, box.controller)

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (503, "files_elsewhere")
    assert got.headers["retry-after"] == "1"


async def test_a_disconnected_controller_reads_as_resting(box: Box) -> None:
    file_requests.socket_closed(box.controller_id, box.controller)
    async with box.factory() as session:
        controller = await session.get(AgentController, box.controller_id)
        assert controller is not None
        controller.disconnected_at = datetime.now(UTC)
        await session.commit()

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (409, "box_resting")


async def test_a_user_over_the_rate_limit_is_refused(box: Box) -> None:
    cloud_files.rate = cloud_files._Rate(2)
    assert (await box.client.get("/cloud-files/list")).status_code == 200
    assert (await box.client.get("/cloud-files/list")).status_code == 200

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (429, "busy")


async def test_a_controller_that_never_answers_times_out_and_is_cancelled(
    box: Box, monkeypatch: pytest.MonkeyPatch
) -> None:
    box.controller.silent = True
    monkeypatch.setattr(cloud_files, "CHUNK_TIMEOUT", 0.05)

    got = await box.client.get("/cloud-files/zip", params={"path": "agent-a"})

    assert (got.status_code, got.json()["detail"]["code"]) == (504, "timeout")
    assert [f["event"] for f in box.controller.sent] == [
        "files.request",
        "files.cancel",
    ]


async def test_a_large_file_is_read_in_128_kib_ranges(box: Box) -> None:
    first = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/big.bin", "offset": 0}
    )
    second = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/big.bin", "offset": 131072}
    )

    assert (first.status_code, second.status_code) == (206, 206)
    assert first.headers["content-range"] == f"bytes 0-131071/{len(BIG)}"
    assert second.headers["content-range"] == f"bytes 131072-{len(BIG) - 1}/{len(BIG)}"
    assert first.content + second.content == BIG


async def test_an_offset_at_the_end_is_416_naming_the_size(box: Box) -> None:
    got = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/big.bin", "offset": len(BIG)}
    )

    assert got.status_code == 416
    assert got.headers["content-range"] == f"bytes */{len(BIG)}"
    assert got.content == b""


async def test_an_empty_file_is_an_empty_200(box: Box) -> None:
    got = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/empty.txt"}
    )

    assert (got.status_code, got.content) == (200, b"")
    assert "content-range" not in got.headers
    assert got.headers["cross-origin-resource-policy"] == "same-origin"


async def test_a_file_over_25_mb_is_too_large_before_any_bytes(box: Box) -> None:
    got = await box.client.get(
        "/cloud-files/content", params={"path": "agent-a/huge.bin"}
    )

    assert (got.status_code, got.json()) == (413, {"detail": {"code": "too_large"}})


async def test_browsing_keeps_the_box_awake_at_most_once_a_minute(box: Box) -> None:
    """A file request counts as the box being in use, as a message does."""
    long_ago = datetime(2026, 1, 1, tzinfo=UTC)
    await _set_machine(box, active_at=long_ago)

    assert (await box.client.get("/cloud-files/list")).status_code == 200
    async with box.factory() as session:
        first = (await session.get(CloudMachine, box.machine_id)).active_at  # type: ignore[union-attr]
    assert first > long_ago

    assert (await box.client.get("/cloud-files/list")).status_code == 200
    async with box.factory() as session:
        second = (await session.get(CloudMachine, box.machine_id)).active_at  # type: ignore[union-attr]
    assert second == first  # within the minute: not written again


async def test_a_resting_box_is_never_woken_by_a_file_request(box: Box) -> None:
    file_requests.socket_closed(box.controller_id, box.controller)
    await _set_machine(
        box, state="stopped", desired_state="stopped", stop_reason="idle"
    )

    assert (await box.client.get("/cloud-files/list")).status_code == 409
    async with box.factory() as session:
        machine = await session.get(CloudMachine, box.machine_id)
        assert machine is not None
        assert (machine.state, machine.desired_state) == ("stopped", "stopped")


async def test_a_long_zip_keeps_the_box_awake_pull_by_pull(
    box: Box, monkeypatch: pytest.MonkeyPatch
) -> None:
    marked: list[str] = []
    original = cloud_files._mark_active

    async def spy(session, machine_id: str) -> None:
        marked.append(machine_id)
        await original(session, machine_id)

    monkeypatch.setattr(cloud_files, "_mark_active", spy)
    monkeypatch.setattr(cloud_files, "ACTIVE_EVERY", timedelta(0))

    got = await box.client.get("/cloud-files/zip", params={"path": "agent-a"})

    assert got.status_code == 200
    # Once when the request is served, then before each of the two pulls.
    assert marked == [box.machine_id] * 3


async def test_browsing_adds_no_awake_time_to_the_budget(box: Box) -> None:
    """Awake time is counted from the box's status reports of awake agent
    sessions (`visibility/awake_usage.py`), never from browsing: a file request
    keeps the box itself from idling, but writes no usage of its own."""
    await _set_machine(box, active_at=datetime(2026, 1, 1, tzinfo=UTC))
    for path in ("", "agent-a"):
        listed = await box.client.get("/cloud-files/list", params={"path": path})
        assert listed.status_code == 200
    zipped = await box.client.get("/cloud-files/zip", params={"path": "agent-a"})
    assert zipped.status_code == 200

    async with tenant_session(box.factory, require_tenant_id()) as session:
        rows = await session.scalar(select(func.count()).select_from(TenantUsage))
    assert rows == 0


@pytest.mark.parametrize(
    ("route", "params"),
    [
        ("/cloud-files/list", {"path": ""}),
        ("/cloud-files/content", {"path": "agent-a/report.html", "offset": 0}),
        ("/cloud-files/zip", {"path": "agent-a"}),
    ],
)
async def test_another_workspaces_box_files_are_never_read_from_this_one(
    box: Box, route: str, params: dict[str, Any]
) -> None:
    """The user's box serves another workspace only, through a
    controller enrolled there that is connected, its socket held by this
    process. A request bound to this workspace reaches none of its files, on
    any route, and nothing goes down either socket."""
    async with box.factory() as session:
        await add_tenant(session, "elsewhere")
        await session.commit()
    async with tenant_session(box.factory, "elsewhere") as session:
        machine = await session.get(CloudMachine, box.machine_id)
        assert machine is not None
        there = AgentController(
            tenant_id="elsewhere",
            owner_id=machine.owner_id,
            name="Switch cloud",
            kind="ec2",
            connected_at=datetime.now(UTC),
        )
        session.add(there)
        await session.commit()
        there_id = there.id
    async with box.factory() as session:
        rows = (
            await session.scalars(
                select(MachineWorkspace).where(
                    MachineWorkspace.machine_id == box.machine_id
                )
            )
        ).all()
        for row in rows:
            # One UPDATE moves the row and its controller together, as the
            # workspace's controller key requires.
            row.tenant_id, row.controller_id = "elsewhere", there_id
        await session.commit()
    elsewhere = FakeController(controller_id=there_id)
    file_requests.socket_opened(there_id, elsewhere, elsewhere.send)
    try:
        got = await box.client.get(route, params=params)
    finally:
        file_requests.socket_closed(there_id, elsewhere)

    assert (got.status_code, got.json()["detail"]["code"]) == (404, "no_files")
    assert box.requests_sent() == []
    assert elsewhere.sent == []


async def test_a_long_zip_marks_the_box_in_the_requests_own_workspace(
    box: Box, monkeypatch
) -> None:
    """The zip streams after its route returns, so each "still in use" mark
    opens its own session: bound to the workspace the request was in, never a
    bare one with nothing bound."""
    monkeypatch.setattr(cloud_files, "ACTIVE_EVERY", timedelta(0))
    marked_in: list[str | None] = []
    mark = cloud_files._mark_active

    async def recording(session, machine_id):
        marked_in.append(current_tenant_id())
        await mark(session, machine_id)

    monkeypatch.setattr(cloud_files, "_mark_active", recording)
    workspace = require_tenant_id()

    got = await box.client.get("/cloud-files/zip", params={"path": "agent-a"})

    assert got.status_code == 200, got.text
    # The route's own check marks once, then each pull after the first chunk.
    assert len(marked_in) >= 2
    assert set(marked_in) == {workspace}


async def test_a_box_not_serving_the_current_workspace_gives_no_files(box: Box) -> None:
    """Bound to the workspace the request is in: the user's
    box is found, but only its row for this workspace counts."""
    async with box.factory() as session:
        await add_tenant(session, "elsewhere")
        rows = (
            await session.scalars(
                select(MachineWorkspace).where(
                    MachineWorkspace.machine_id == box.machine_id
                )
            )
        ).all()
        for row in rows:
            row.controller_id = None
            row.tenant_id = "elsewhere"
        await session.commit()

    got = await box.client.get("/cloud-files/list")

    assert (got.status_code, got.json()["detail"]["code"]) == (404, "no_files")
    assert box.requests_sent() == []
