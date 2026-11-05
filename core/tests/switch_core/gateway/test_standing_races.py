"""A key made while someone's standing is being taken away does not outlive it.

A bearer key resolves its workspace from its own row and never consults
membership again, so ending someone's standing deletes their keys there
(`gateway/workspace_access.py`). The request that makes a key checks standing
once, when it authenticates. These pin the races between the two: a key
committed while the standing was being ended is removed with the rest, and one
written after it ended is refused.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApiKey, TenantMember, User
from switch_core.db.standing import lock_for_ending_standing
from switch_core.gateway import organizations as organizations_module
from switch_core.gateway.api_keys import router as api_keys_router
from tests.switch_core.gateway.test_organization_routes import (
    _KEYRING,
    _client,
    _key_exists,
    _name,
    _personal_key,
    _second_workspace,
    _workspace,
)
from tests.switch_core.gateway.test_organization_routes import _app as _org_app


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = _org_app(session_factory)
    app.include_router(api_keys_router, prefix="/api-keys")
    return app


async def _keys_of(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> list[str]:
    async with session_factory() as session:
        return list(
            await session.scalars(select(ApiKey.id).where(ApiKey.user_id == user_id))
        )


async def _waiting_on_lock(
    session_factory: async_sessionmaker[AsyncSession], timeout: float = 5.0
) -> None:
    """Until some other backend is waiting on a row lock."""

    async def wait() -> None:
        while True:
            async with session_factory() as session:
                waiting = await session.scalar(
                    text(
                        "select count(*) from pg_stat_activity "
                        "where wait_event_type = 'Lock' and pid <> pg_backend_pid()"
                    )
                )
            if waiting:
                return
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait(), timeout)


async def test_a_key_made_while_an_org_admin_is_demoted_goes_with_the_rest(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The demotion removes their keys workspace by workspace, calling each
    vendor as it goes, and only then takes the role away. A key they made in
    that time, in a workspace already done, was left behind."""
    ada, bob = _name("ada"), _name("bob")
    first = await _workspace(
        session_factory, {ada: ("owner", "org_admin"), bob: ("member", "org_admin")}
    )
    second = await _second_workspace(session_factory, first)
    await _personal_key(session_factory, second, bob)
    late: list[str] = []
    finish = organizations_module.finish_revocation

    async def finish_then_mint(*args: object, **kwargs: object) -> str | None:
        warning = await finish(*args, **kwargs)  # type: ignore[arg-type]
        # Still `org_admin` here: the role has not been taken away yet.
        late.append(await _personal_key(session_factory, second, bob))
        return warning

    monkeypatch.setattr(organizations_module, "finish_revocation", finish_then_mint)

    async with _client(_app(session_factory), ada, first) as client:
        response = await client.patch(
            f"/organizations/current/members/{bob}", json={"role": "member"}
        )

    assert response.status_code == 200, response.text
    assert late, "the demotion revoked nothing to make a key after"
    assert not await _key_exists(session_factory, late[0]), (
        "a key made while the demotion was under way outlived it"
    )


async def test_a_key_requested_as_the_standing_ends_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The request authenticated while they were a member and writes after
    the removal committed: it waits on the removal, and is refused."""
    ada, bob = _name("ada"), _name("bob")
    tenant_id = await _workspace(
        session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
    )

    async with session_factory() as removal:
        await lock_for_ending_standing(removal, bob)
        async with _client(_app(session_factory), bob, tenant_id) as client:
            minting = asyncio.create_task(
                client.post("/api-keys", json={"label": "late"})
            )
            await _waiting_on_lock(session_factory)
            await removal.execute(
                delete(TenantMember).where(
                    TenantMember.tenant_id == tenant_id, TenantMember.user_id == bob
                )
            )
            await removal.commit()
            response = await minting

    assert response.status_code == 403, response.text
    assert await _keys_of(session_factory, bob) == []


async def test_a_key_being_written_as_a_member_is_removed_is_removed_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The key's transaction is open when the removal starts: the removal
    waits for it, and then removes it with the rest."""
    ada, bob = _name("ada"), _name("bob")
    tenant_id = await _workspace(
        session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
    )

    async with session_factory() as minting:
        minting.add(
            ApiKey(
                tenant_id=tenant_id,
                user_id=bob,
                key_hash="in-flight",
                encrypted_key=_KEYRING.encrypt("secret"),
                label="in flight",
                type="registration",
            )
        )
        await minting.flush()
        async with _client(_app(session_factory), ada, tenant_id) as client:
            removing = asyncio.create_task(
                client.delete(f"/tenants/{tenant_id}/members/{bob}")
            )
            await _waiting_on_lock(session_factory)
            await minting.commit()
            response = await removing

    assert response.status_code == 200, response.text
    assert not await _key_exists(session_factory, "in-flight")


async def test_the_platform_operator_still_makes_keys_where_they_hold_no_role(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The operator binds any workspace without a membership, and the check
    after writing must not take that away."""
    ada, op = _name("ada"), _name("op")
    tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
    async with session_factory() as session:
        session.add(User(id=op, name=op, email=f"{op}@example.invalid", role="admin"))
        await session.commit()

    async with _client(_app(session_factory), op, tenant_id) as client:
        response = await client.post("/api-keys", json={"label": "operator"})

    assert response.status_code == 200, response.text
