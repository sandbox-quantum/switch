"""An account with no tenant membership can get back in (CHOO-2623).

`gateway/auth.py` refuses to guess a tenant for a user who has none and
answers 403. That is the right call — picking one would place a person in
somebody else's data — but it means a membership-less account is not degraded,
it is locked out, on every route, permanently.

Nothing in the product repaired one except an OIDC login (`UserStore.
_link_identity`). A password account had no way back in at all: no endpoint
writes a membership, and every endpoint that could is behind the 403. The
remedy was `INSERT INTO tenant_members` by hand on the box.

The state is reachable. The migration backfilled every account that existed
when it ran, and `UserStore.create` has written one ever since — but only
since the commit that added it, and a deployment tracking this stack ran the
migration several commits earlier. Every account created in that window has
none. So does one whose membership is later removed.

Startup seeding is the repair: it already looks the configured admin up by
email on every boot, it is the one path that runs before anyone has to be
able to sign in, and a restart is something an operator can do without a
database client.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, TenantMember, User
from switch_core.db.stores.tenant_member_store import (
    TenantMembershipError,
    TenantMemberStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import hash_password
from switch_core.main import _seed_admin_user
from switch_core.tenant_context import tenant_scope

pytestmark = pytest.mark.no_ambient_tenant

ADMIN_EMAIL = "admin@switch.local"


def _config() -> SwitchConfig:
    return SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        matrix_server_name="test",
        agent_registration_token="unused",
        jwt_secret_key="test-jwt-secret",
        gateway_admin_email=ADMIN_EMAIL,
        gateway_admin_password="hunter2",
    )


async def _memberships(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> list[tuple[str, str]]:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(TenantMember.tenant_id, TenantMember.role).where(
                    TenantMember.user_id == user_id
                )
            )
        ).all()
    return [(t, r) for t, r in rows]


async def _admin_id(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        return (
            await session.execute(select(User.id).where(User.email == ADMIN_EMAIL))
        ).scalar_one()


async def _strand_the_admin(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    """Reproduce the state a mid-stack deployment leaves behind: the account
    exists, with a password, and has no membership."""
    async with session_factory() as session:
        await session.execute(
            delete(TenantMember).where(TenantMember.user_id == user_id)
        )
        await session.commit()


class TestSeedingRepairsTheAdmin:
    async def test_a_fresh_database_gets_an_admin_with_a_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_admin_user(session_factory, UserStore(), _config())

        user_id = await _admin_id(session_factory)
        assert await _memberships(session_factory, user_id) == [
            (TENANT_ZERO_ID, "owner")
        ]

    async def test_a_stranded_admin_is_rejoined_on_the_next_boot(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The whole point. Before this, the existing-admin branch returned
        without looking, so no number of restarts made any difference."""
        await _seed_admin_user(session_factory, UserStore(), _config())
        user_id = await _admin_id(session_factory)
        await _strand_the_admin(session_factory, user_id)
        assert await _memberships(session_factory, user_id) == []

        await _seed_admin_user(session_factory, UserStore(), _config())

        assert await _memberships(session_factory, user_id) == [
            (TENANT_ZERO_ID, "owner")
        ]

    async def test_the_repair_is_reported_loudly(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """An account that could not sign in until this boot is not routine
        news, so it is a warning naming the address — and the ordinary case
        stays at `info` so the warning means something."""
        await _seed_admin_user(session_factory, UserStore(), _config())
        user_id = await _admin_id(session_factory)
        await _strand_the_admin(session_factory, user_id)

        with caplog.at_level(logging.INFO, logger="switch_core.main"):
            await _seed_admin_user(session_factory, UserStore(), _config())
            repaired = [r for r in caplog.records if r.levelname == "WARNING"]
            caplog.clear()
            await _seed_admin_user(session_factory, UserStore(), _config())
            settled = [r for r in caplog.records if r.levelname == "WARNING"]

        assert [ADMIN_EMAIL in r.getMessage() for r in repaired] == [True]
        assert settled == []

    async def test_an_admin_that_already_belongs_somewhere_is_left_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two memberships fail resolution exactly as hard as none do, so a
        repair that added one unconditionally would break the accounts it was
        meant to fix."""
        await _seed_admin_user(session_factory, UserStore(), _config())
        user_id = await _admin_id(session_factory)

        await _seed_admin_user(session_factory, UserStore(), _config())

        assert await _memberships(session_factory, user_id) == [
            (TENANT_ZERO_ID, "owner")
        ]


class TestWhatBeingStrandedCosts:
    """Why the repair is worth having, stated as the failure it prevents."""

    async def test_no_membership_means_no_tenant_and_so_no_access(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with tenant_scope(TENANT_ZERO_ID):
                user = User(
                    name="Nobody",
                    email="nobody@switch.local",
                    role="user",
                    password_hash=hash_password("pw"),
                )
                session.add(user)
                await session.flush()
                user_id = user.id
            await session.commit()
        await _strand_the_admin(session_factory, user_id)

        with pytest.raises(TenantMembershipError):
            await TenantMemberStore().get_sole_tenant_id(session_factory, user_id)

    async def test_creating_a_user_still_writes_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The forward fix, kept honest alongside the repair: every path that
        makes a user leaves exactly one membership, so the repair is for
        history rather than for today's writes."""
        async with session_factory() as session:
            with tenant_scope(TENANT_ZERO_ID):
                user = User(name="New", email="new@switch.local", role="user")
                await UserStore().create(session, user)
                user_id = user.id
            await session.commit()

        assert await _memberships(session_factory, user_id) == [
            (TENANT_ZERO_ID, "member")
        ]


def test_the_membership_store_offers_no_second_way_to_write_one() -> None:
    """`TenantMemberStore.create` existed and nothing called it.

    Removed rather than wired up: "exactly one membership per account" holds
    because a single idempotent function writes them all, and an unguarded
    `create(tenant_id=…, user_id=…, role=…)` beside it is an invitation to
    write a second — which `get_sole_tenant_id` rejects just as firmly as it
    rejects none.
    """
    assert not hasattr(TenantMemberStore, "create")
