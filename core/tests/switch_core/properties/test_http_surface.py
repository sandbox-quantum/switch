"""The gateway's HTTP surface, fuzzed from its OpenAPI schema by Schemathesis.

Two workspaces on one database, the real gateway app (the role matrix's, whose
stand-ins answer 418 where a route reaches a messaging platform or a vendor)
served over HTTP as the database role row-level security applies to. A person in
the second workspace is asked first, so it has objects; then a person in the
first, whose requests name the second's ids as often as they name anything. No request may be answered with a 5xx or with a
body that breaks the schema, and no response to the first workspace may contain
an id of the second (`properties/http/hooks.py`).

Run on a schedule (`-m schemathesis`), not on a pull request: it takes minutes.
`properties/http/baseline.json` holds the failures accepted for now; a failure
not in it fails the run.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import uvicorn
from fastapi import FastAPI
from sqlalchemy import String, Text, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.base import Base
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.gateway.auth import create_jwt
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.gateway.role_matrix.harness import (
    REPO_ROOT,
    TENANT,
    Persona,
    build_gateway,
    config,
    seed_people,
)

OTHER_TENANT = "other-workspace"
BASELINE = REPO_ROOT / "properties" / "http" / "baseline.json"
CHECKS = "not_a_server_error,response_schema_conformance,no_foreign_ids"

# What would end the session the run asks as, after which every request is a
# 401 and nothing more is tested: deleting or re-keying the person, signing
# out, revoking sessions.
ENDS_THE_SESSION = (
    r"^/auth/(me|me/password|logout|sessions/revoke)$"
    r"|^/users/\{user_id\}/sessions/revoke$"
)

# Examples for each operation, and the whole run's budget; the nightly
# workflow raises them.
EXAMPLES = int(os.environ.get("SCHEMATHESIS_EXAMPLES", "25"))
MAX_SECONDS = int(os.environ.get("SCHEMATHESIS_MAX_SECONDS", "600"))

# Where each run's whole output is kept, for the workflow to upload.
LOGS = Path(
    os.environ.get("SCHEMATHESIS_LOGS", REPO_ROOT / "build" / "properties" / "http")
)

# The most a run may be refused (401) before it is read as having lost its
# session and tested nothing past that point.
MOST_UNAUTHENTICATED = 0.5

# How long the server may take to start listening.
STARTUP_SECONDS = 30


async def _seed_other_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[dict[str, str], str]:
    """A second workspace in an organization of its own, with an admin: the
    session cookie they would send, and their id."""
    user_id = f"other-{uuid.uuid4().hex[:6]}"
    email = "admin@other.example.invalid"
    with tenant_scope(OTHER_TENANT):
        async with session_factory() as session:
            session.add(Organization(id=OTHER_TENANT, slug=OTHER_TENANT, name="Other"))
            await session.flush()
            session.add(
                Tenant(
                    id=OTHER_TENANT,
                    slug=OTHER_TENANT,
                    name=OTHER_TENANT,
                    organization_id=OTHER_TENANT,
                )
            )
            await session.flush()
            session.add(User(id=user_id, name="admin", email=email, role="user"))
            await session.flush()
            session.add(
                TenantMember(tenant_id=OTHER_TENANT, user_id=user_id, role="admin")
            )
            session.add(
                OrganizationMember(
                    organization_id=OTHER_TENANT, user_id=user_id, role="org_admin"
                )
            )
            await session.commit()
    token = create_jwt(
        user_id,
        email,
        "user",
        config().keyring,
        OTHER_TENANT,
        session_version=0,
        auth_time=datetime.now(UTC),
    )
    return {"cookie": f"switch_auth={token}"}, user_id


async def _keys_of(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> set[str]:
    """The text primary keys of every row a workspace has, in every table that
    carries a `tenant_id`: its rooms, agents and the rest, whatever they are
    called."""
    found: set[str] = set()
    async with session_factory() as session:
        for table in Base.metadata.sorted_tables:
            if "tenant_id" not in table.c:
                continue
            for column in table.primary_key.columns:
                if column.name == "tenant_id" or not isinstance(
                    column.type, String | Text
                ):
                    continue
                rows = await session.execute(
                    text(
                        f'SELECT "{column.name}" FROM "{table.name}" '
                        "WHERE tenant_id = :tenant"
                    ),
                    {"tenant": tenant_id},
                )
                found.update(rows.scalars().all())
    return found


async def _foreign_ids(
    session_factory: async_sessionmaker[AsyncSession], other_user_id: str
) -> list[str]:
    """What names the other workspace's objects and no one else's: its keys
    that the first workspace has none of, which the fuzzer's own choices (the
    same string made in both) are not; and its admin."""
    mine = await _keys_of(session_factory, TENANT)
    theirs = await _keys_of(session_factory, OTHER_TENANT)
    return sorted(
        {key for key in theirs - mine if len(key) >= 8} | {other_user_id, OTHER_TENANT}
    )


def _listening_socket() -> socket.socket:
    """A socket already bound, which uvicorn is handed rather than a port
    another process could take before it binds."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    return listener


def _fuzz(
    *,
    schema: Path,
    url: str,
    cookie: str,
    foreign_ids: Path | None,
    work: Path,
    label: str,
) -> tuple[int, str, dict[str, int]]:
    """One run of the Schemathesis CLI: its exit status, everything it said,
    and the status codes it was answered with. Both runs share the baseline:
    updating it from the second cannot drop what the first recorded, as
    updating only adds."""
    counts = work / f"{label}-statuses.json"
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(REPO_ROOT), os.environ.get("PYTHONPATH", "")]
        ),
        "SCHEMATHESIS_HOOKS": "properties.http.hooks",
        "SWITCH_STATUS_COUNTS": str(counts),
    }
    if foreign_ids is not None:
        env["SWITCH_FOREIGN_IDS"] = str(foreign_ids)
    command = [
        sys.executable,
        "-m",
        "schemathesis.cli",
        "run",
        str(schema),
        "--url",
        url,
        "--header",
        f"cookie: {cookie}",
        "--checks",
        CHECKS,
        "--max-examples",
        str(EXAMPLES),
        "--max-time",
        str(MAX_SECONDS),
        "--exclude-path-regex",
        ENDS_THE_SESSION,
        # A NUL in a string makes many routes answer 500 (the login among
        # them), because Postgres cannot store one; with it, every run is that
        # one bug on route after route. Left out until that is fixed.
        "--generation-allow-x00",
        "false",
        "--continue-on-failure",
        "--report",
        "junit",
        "--report-dir",
        str(work / label),
    ]
    if os.environ.get("SCHEMATHESIS_BASELINE_UPDATE"):
        command += ["--baseline", str(BASELINE), "--baseline-update"]
    elif BASELINE.exists():
        command += ["--baseline", str(BASELINE)]
    # The budget is for the run, so a run that hangs is the CLI's, not the
    # job's: a minute or three past it is long enough to wind down.
    ran = subprocess.run(
        command,
        env=env,
        capture_output=True,
        text=True,
        cwd=work,
        timeout=MAX_SECONDS + 180,
    )
    said = ran.stdout + ran.stderr
    LOGS.mkdir(parents=True, exist_ok=True)
    (LOGS / f"{label}.txt").write_text(said)
    statuses = json.loads(counts.read_text()) if counts.exists() else {}
    return ran.returncode, said, statuses


def _failures_in(said: str) -> str:
    """What Schemathesis printed about each failure, which comes before its
    warnings and summary, so that a new one is not cut off behind the accepted
    ones' neighbours."""
    start = said.find(" FAILURES ")
    end = said.find(" WARNINGS ", start)
    if start < 0:
        return said[-6000:]
    return said[start : end if end > start else None][:60000]


def _unauthenticated_share(statuses: dict[str, int]) -> float:
    total = sum(statuses.values())
    return statuses.get("401", 0) / total if total else 1.0


async def _serve(root: FastAPI, listener: socket.socket) -> tuple[uvicorn.Server, Any]:
    server = uvicorn.Server(uvicorn.Config(root, log_level="warning"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    deadline = time.monotonic() + STARTUP_SECONDS
    while not server.started:
        if serving.done():
            serving.result()
            raise RuntimeError("the server stopped before it started listening")
        if time.monotonic() > deadline:
            server.should_exit = True
            await serving
            raise TimeoutError(
                f"the server was not listening after {STARTUP_SECONDS} seconds"
            )
        await asyncio.sleep(0.05)
    return server, serving


@pytest.mark.schemathesis
@pytest.mark.property("api.no-5xx")
@pytest.mark.property("tenancy.no-cross-tenant-ids")
async def test_the_gateway_survives_fuzzing_and_keeps_workspaces_apart(
    rls_harness: RLSHarness, tmp_path: Path
) -> None:
    # Seeded as the owner, served as the role row-level security applies to,
    # which is how a deployment runs: as the owner nothing would separate the
    # workspaces but the routes' own filters.
    session_factory = rls_harness.owner
    gateway = build_gateway(rls_harness.restricted)
    people = await seed_people(session_factory)
    other, other_user_id = await _seed_other_workspace(session_factory)
    root = FastAPI()
    root.mount("/gateway", gateway)

    listener = _listening_socket()
    port = listener.getsockname()[1]
    schema = tmp_path / "openapi.json"
    schema.write_text(json.dumps(gateway.openapi()))
    url = f"http://127.0.0.1:{port}/gateway"
    foreign = tmp_path / "foreign-ids.json"

    server: uvicorn.Server | None = None
    serving: Any = None
    try:
        server, serving = await _serve(root, listener)
        # The other workspace first, so it has objects to be asked about.
        filled = await asyncio.to_thread(
            _fuzz,
            schema=schema,
            url=url,
            cookie=other["cookie"],
            foreign_ids=None,
            work=tmp_path,
            label="other",
        )
        foreign.write_text(
            json.dumps(await _foreign_ids(session_factory, other_user_id))
        )
        asked = await asyncio.to_thread(
            _fuzz,
            schema=schema,
            url=url,
            cookie=people.headers(Persona.WORKSPACE_ADMIN)["cookie"],
            foreign_ids=foreign,
            work=tmp_path,
            label="first",
        )
    finally:
        if server is not None:
            server.should_exit = True
            await serving
        listener.close()

    ids = json.loads(foreign.read_text())
    filled_code, filled_said, filled_statuses = filled
    asked_code, asked_said, asked_statuses = asked
    report = (
        f"the other workspace had {len(ids)} ids\n"
        f"--- the other workspace's run (exit {filled_code}), "
        f"{_unauthenticated_share(filled_statuses):.0%} refused with 401\n"
        f"{_failures_in(filled_said)}\n"
        f"--- the first workspace's run (exit {asked_code}), "
        f"{_unauthenticated_share(asked_statuses):.0%} refused with 401\n"
        f"{_failures_in(asked_said)}"
    )
    print(report)

    # The leak first: a failure of the other run must not hide it.
    assert "`no_foreign_ids`" not in asked_said, report
    if os.environ.get("SCHEMATHESIS_BASELINE_UPDATE"):
        recorded = json.loads(BASELINE.read_text())
        leaks = [e for e in recorded["entries"] if e["check"] == "no_foreign_ids"]
        recorded["entries"] = [
            e for e in recorded["entries"] if e["check"] != "no_foreign_ids"
        ]
        BASELINE.write_text(json.dumps(recorded, indent=2) + "\n")
        assert not leaks, f"a leak was about to be accepted as known: {leaks}"
    assert len(ids) > 2, (
        "the other workspace has no objects, so nothing could leak\n" + report
    )
    for name, statuses in (("other", filled_statuses), ("first", asked_statuses)):
        assert _unauthenticated_share(statuses) < MOST_UNAUTHENTICATED, (
            f"the {name} run was refused with 401 on most requests: it lost "
            f"its session, so most of the surface went untested\n" + report
        )
    assert filled_code == 0 and asked_code == 0, report
