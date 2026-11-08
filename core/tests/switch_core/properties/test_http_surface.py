"""The gateway's HTTP surface, fuzzed from its OpenAPI schema by Schemathesis.

Two workspaces on one database, the real gateway app (the role matrix's, whose
stand-ins answer 418 where a route reaches a messaging platform or a vendor)
served over HTTP as the database role row-level security applies to. A person in the second workspace is asked first, so it has
objects; then a person in the first, whose requests name the second's ids as
often as they name anything. No request may be answered with a 5xx or with a
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
import re
import socket
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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
    Persona,
    build_gateway,
    config,
    seed_people,
)

OTHER_TENANT = "other-workspace"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
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


async def _seed_other_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, str]:
    """A second workspace in an organization of its own, with an admin; the
    session cookie they would send."""
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
    return {"cookie": f"switch_auth={token}"}


async def _ids_of(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> list[str]:
    """Every id a workspace's rows carry that the server made: a UUID. A value
    the fuzzer chose can be the same in both workspaces."""
    found: set[str] = set()
    async with session_factory() as session:
        tables = (
            (
                await session.execute(
                    text(
                        "SELECT table_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND column_name = 'tenant_id' "
                        "AND table_name IN (SELECT table_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND column_name = 'id')"
                    )
                )
            )
            .scalars()
            .all()
        )
        for table in tables:
            rows = await session.execute(
                text(f'SELECT id::text FROM "{table}" WHERE tenant_id = :tenant'),
                {"tenant": tenant_id},
            )
            found.update(value for value in rows.scalars() if UUID.fullmatch(value))
    return sorted(found)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _fuzz(
    *,
    schema: Path,
    url: str,
    cookie: str,
    foreign_ids: Path | None,
    work: Path,
    label: str,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(REPO_ROOT), os.environ.get("PYTHONPATH", "")]
        ),
        "SCHEMATHESIS_HOOKS": "properties.http.hooks",
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
    return subprocess.run(command, env=env, capture_output=True, text=True, cwd=work)


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
    other = await _seed_other_workspace(session_factory)
    root = FastAPI()
    root.mount("/gateway", gateway)

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(root, host="127.0.0.1", port=port, log_level="warning")
    )
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    schema = tmp_path / "openapi.json"
    schema.write_text(json.dumps(gateway.openapi()))
    url = f"http://127.0.0.1:{port}/gateway"

    try:
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
        foreign = tmp_path / "foreign-ids.json"
        foreign.write_text(json.dumps(await _ids_of(session_factory, OTHER_TENANT)))
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
        server.should_exit = True
        await serving

    ids = json.loads(foreign.read_text())
    report = (
        f"the other workspace had {len(ids)} ids\n"
        f"--- the other workspace's run (exit {filled.returncode})\n{filled.stdout[-3000:]}\n"
        f"--- the first workspace's run (exit {asked.returncode})\n{asked.stdout[-6000:]}"
    )
    print(report)
    if logs := os.environ.get("SCHEMATHESIS_LOGS"):
        Path(logs, "other.txt").write_text(filled.stdout + filled.stderr)
        Path(logs, "first.txt").write_text(asked.stdout + asked.stderr)
    assert ids, "the other workspace has no ids, so nothing could leak\n" + report
    assert filled.returncode == 0 and asked.returncode == 0, report
