"""GitHub's one-time move onto service connections, against Postgres.

Rows are seeded the way the previous build left them: a GitHub connection in
`provider_connections`, cloud launches, and installation tokens in
`github_issued_tokens`. The move must copy what it can read, skip what it
cannot (loudly), and never run twice in a tenant: a later boot would
otherwise undo what people changed on the new build.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections import github_move
from switch_core.connections.github_move import MOVE, move_github_connections
from switch_core.db.models import (
    TENANT_ZERO_ID,
    GitHubIssuedToken,
    ProviderConnection,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    Tenant,
    TenantDataMove,
    User,
)
from switch_core.db.session_scope import tenant_session
from tests.conftest import TEST_KEYRING
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine

SPEC = {"installation_id": 123, "repository_id": 456}


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    return user


def _credential(**values: object) -> str:
    return TEST_KEYRING.encrypt(
        json.dumps(
            {
                "access_token": "SYNTHETIC-ACCESS",
                "refresh_token": "SYNTHETIC-REFRESH",
                "expires_at": 4e9,
                "refresh_expires_at": 4e9,
                "login": "ada-gh",
                "user_id": 1001,
                **values,
            }
        )
    )


async def _old_world(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    credential: str,
    launch_state: str = "ready",
    desired_state: str = "running",
    token_revision: int = 1,
) -> dict[str, str]:
    """A GitHub connection, a cloud launch with its agent, and a live token."""
    async with session_factory() as session:
        owner = await _user(session, "ada")
        session.add(
            ProviderConnection(
                user_id=owner.id,
                provider="github",
                kind="oauth",
                encrypted_credential=credential,
                verified_at=datetime.now(UTC),
            )
        )
        agent = await add_agent(session, name="cloud-helper", owner_id=owner.id)
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            slot_id="slot-a",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        launch = await seed_launch(
            session,
            machine=machine,
            request_id=str(uuid.uuid4()),
            name="cloud-helper",
            state=launch_state,
            desired_state=desired_state,
            revision=1,
            agent_id=agent.id,
            spec=SPEC,
        )
        token = GitHubIssuedToken(
            id=str(uuid.uuid4()),
            owner_id=owner.id,
            launch_id=launch.id,
            launch_revision=token_revision,
            encrypted_token=TEST_KEYRING.encrypt("SYNTHETIC-INSTALLATION"),
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
            revoke_requested=False,
            attempts=0,
        )
        expired = GitHubIssuedToken(
            id=str(uuid.uuid4()),
            owner_id=owner.id,
            launch_id=launch.id,
            launch_revision=1,
            encrypted_token=TEST_KEYRING.encrypt("SYNTHETIC-EXPIRED"),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
            revoke_requested=False,
            attempts=0,
        )
        session.add_all([token, expired])
        await session.commit()
        return {"owner": owner.id, "agent": agent.id, "launch": launch.id}


async def _move(session_factory: async_sessionmaker[AsyncSession]) -> None:
    await move_github_connections(session_factory, TEST_KEYRING, [TENANT_ZERO_ID])


async def _rows(session_factory, model) -> list:
    async with session_factory() as session:
        return list(await session.scalars(select(model)))


async def test_moves_the_connection_the_launch_grant_and_the_live_token(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    credential = _credential()
    world = await _old_world(session_factory, credential=credential)
    await _move(session_factory)

    [connection] = await _rows(session_factory, ServiceConnection)
    assert connection.user_id == world["owner"]
    assert connection.encrypted_secret == credential
    assert (connection.account_id, connection.external_identity) == ("1001", "ada-gh")
    assert (connection.status, connection.consent) == ("active", "write")

    [grant] = await _rows(session_factory, ServiceGrant)
    assert (grant.agent_id, grant.owner_id, grant.access) == (
        world["agent"],
        world["owner"],
        "write",
    )
    assert grant.resources == {"installation_id": 123, "repository_ids": [456]}
    assert grant.account_id == "1001"

    [issued] = await _rows(session_factory, ServiceTokenIssuance)
    assert (issued.grant_id, issued.agent_id) == (grant.id, world["agent"])
    assert issued.token_sha256 == hashlib.sha256(b"SYNTHETIC-INSTALLATION").hexdigest()
    assert issued.encrypted_token is not None and not issued.revoke_requested
    assert issued.permissions == {
        "permissions": {"contents": "write", "pull_requests": "write"}
    }

    [marker] = await _rows(session_factory, TenantDataMove)
    assert marker.name == MOVE
    assert marker.details == {
        "connections": 1,
        "connections_skipped": 0,
        "grants": 1,
        "grants_skipped": 0,
        "tokens": 1,
        "tokens_queued": 0,
        "tokens_skipped": 0,
    }
    # The old rows stay, for the build that can still be rolled back to.
    assert len(await _rows(session_factory, ProviderConnection)) == 1


@pytest.mark.parametrize(
    ("launch_state", "desired_state", "token_revision"),
    [("ready", "stopped", 1), ("error", "running", 1), ("ready", "running", 0)],
    ids=["stopped", "error", "older-revision"],
)
async def test_a_token_todays_rules_no_longer_accept_arrives_queued(
    session_factory, launch_state, desired_state, token_revision
) -> None:
    await _old_world(
        session_factory,
        credential=_credential(),
        launch_state=launch_state,
        desired_state=desired_state,
        token_revision=token_revision,
    )
    await _move(session_factory)
    [issued] = await _rows(session_factory, ServiceTokenIssuance)
    assert issued.revoke_requested and issued.encrypted_token is not None


async def test_it_runs_once_so_later_changes_stand(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _old_world(session_factory, credential=_credential())
    await _move(session_factory)
    async with session_factory() as session:
        await session.execute(delete(ServiceGrant))
        await session.execute(
            delete(ServiceConnection).where(ServiceConnection.user_id == world["owner"])
        )
        await session.commit()

    await _move(session_factory)

    assert await _rows(session_factory, ServiceConnection) == []
    assert await _rows(session_factory, ServiceGrant) == []
    assert len(await _rows(session_factory, ServiceTokenIssuance)) == 1


@pytest.mark.parametrize(
    "credential",
    [
        "new:not-a-real-ciphertext",
        _credential(user_id=None),
        _credential(login=""),
        TEST_KEYRING.encrypt("not json"),
    ],
    ids=["undecryptable", "no-account-id", "no-login", "not-json"],
)
async def test_an_unreadable_connection_is_skipped_loudly(
    session_factory, caplog, credential
) -> None:
    caplog.set_level(logging.WARNING)
    world = await _old_world(session_factory, credential=credential)
    await _move(session_factory)

    assert await _rows(session_factory, ServiceConnection) == []
    assert await _rows(session_factory, ServiceGrant) == []
    [issued] = await _rows(session_factory, ServiceTokenIssuance)
    assert issued.revoke_requested
    [marker] = await _rows(session_factory, TenantDataMove)
    assert marker.details["connections_skipped"] == 1
    assert marker.details["grants_skipped"] == 1
    assert world["owner"] in caplog.text
    assert "SYNTHETIC" not in caplog.text
    # Untouched, and not tried again on the next boot.
    assert len(await _rows(session_factory, ProviderConnection)) == 1
    await _move(session_factory)
    assert len(await _rows(session_factory, TenantDataMove)) == 1


async def test_each_tenant_is_moved_on_its_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _old_world(session_factory, credential=_credential())
    async with session_factory() as session:
        session.add(Tenant(id="tenant-b", slug="tenant-b", name="B"))
        await session.commit()
    async with tenant_session(session_factory, "tenant-b") as session:
        session.add(TenantDataMove(tenant_id="tenant-b", name=MOVE, details={}))
        await session.commit()

    await move_github_connections(
        session_factory, TEST_KEYRING, [TENANT_ZERO_ID, "tenant-b"]
    )

    assert len(await _rows(session_factory, ServiceConnection)) == 1
    markers = {
        m.tenant_id: m.details for m in await _rows(session_factory, TenantDataMove)
    }
    assert markers["tenant-b"] == {}
    assert markers[TENANT_ZERO_ID]["connections"] == 1


async def test_a_rerun_keeps_the_rows_already_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The marker gone (a downgrade of its table) while the moved rows stayed."""
    await _old_world(session_factory, credential=_credential())
    await _move(session_factory)
    async with session_factory() as session:
        await session.execute(delete(TenantDataMove))
        await session.commit()

    await _move(session_factory)

    assert len(await _rows(session_factory, ServiceConnection)) == 1
    assert len(await _rows(session_factory, ServiceGrant)) == 1
    assert len(await _rows(session_factory, ServiceTokenIssuance)) == 1
    [marker] = await _rows(session_factory, TenantDataMove)
    assert marker.details["connections"] == 0
    assert marker.details["connections_skipped"] == 1
    assert marker.details["grants_skipped"] == 1
    assert marker.details["tokens_skipped"] == 1


async def test_a_second_person_on_the_same_github_account_is_skipped_loudly(
    session_factory: async_sessionmaker[AsyncSession], caplog
) -> None:
    caplog.set_level(logging.WARNING)
    world = await _old_world(session_factory, credential=_credential())
    async with session_factory() as session:
        other = await _user(session, "grace")
        session.add(
            ProviderConnection(
                user_id=other.id,
                provider="github",
                kind="oauth",
                encrypted_credential=_credential(),
                verified_at=datetime.now(UTC),
            )
        )
        await session.commit()

    await _move(session_factory)

    connections = await _rows(session_factory, ServiceConnection)
    assert len(connections) == 1
    assert connections[0].user_id in (world["owner"], other.id)
    [marker] = await _rows(session_factory, TenantDataMove)
    assert marker.details["connections_skipped"] == 1
    assert "already has" in caplog.text


async def test_a_failing_tenant_does_not_stop_the_others(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch, caplog
) -> None:
    await _old_world(session_factory, credential=_credential())
    async with session_factory() as session:
        session.add(Tenant(id="tenant-b", slug="tenant-b", name="B"))
        await session.commit()
    real = github_move._move

    async def failing(session, keyring, tenant_id):
        if tenant_id == "tenant-b":
            raise RuntimeError("synthetic failure")
        return await real(session, keyring, tenant_id)

    monkeypatch.setattr(github_move, "_move", failing)
    caplog.set_level(logging.ERROR)

    await move_github_connections(
        session_factory, TEST_KEYRING, ["tenant-b", TENANT_ZERO_ID]
    )

    assert len(await _rows(session_factory, ServiceConnection)) == 1
    markers = {m.tenant_id for m in await _rows(session_factory, TenantDataMove)}
    assert markers == {TENANT_ZERO_ID}
    assert "tenant-b" in caplog.text
