"""Someone an admin removed can't walk straight back in through their e-mail
domain.

Against real Postgres, with the app `test_tenant_api_routes.py` builds. A
workspace open to a domain lets anyone at it join; once an admin removes
someone, that way back is closed to them until they are invited again. Who
removed whom comes from the workspace's audit log.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)

DOMAIN = "acme.test"


async def _open_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    """Workspace A, open to `DOMAIN`, with an admin and a member there."""
    await _make_tenant(session_factory, TENANT_A)
    admin = await _make_member(
        session_factory,
        name="admin",
        tenant_id=TENANT_A,
        role="admin",
        email=f"admin@{DOMAIN}",
    )
    person = await _make_member(
        session_factory,
        name="person",
        tenant_id=TENANT_A,
        role="member",
        email=f"person@{DOMAIN}",
    )
    async with tenant_session(session_factory, TENANT_A) as session:
        await JoinDomainStore().add(session, domain=DOMAIN, created_by=admin)
        await session.commit()
    return admin, person


async def _is_member(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> bool:
    async with session_factory() as session:
        return await session.get(TenantMember, (TENANT_A, user_id)) is not None


async def test_someone_an_admin_removed_is_not_let_back_in_by_their_domain(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin, person = await _open_workspace(session_factory)
    app = _app(session_factory)
    async with _client(app, _token(admin, f"admin@{DOMAIN}", TENANT_A)) as client:
        removed = await client.delete(f"/tenants/{TENANT_A}/members/{person}")

    async with _client(app, _token(person, f"person@{DOMAIN}", None)) as client:
        offered = await client.get("/joinable-tenants")
        joined = await client.post(f"/joinable-tenants/{TENANT_A}/join")

    assert removed.status_code == 200, removed.text
    assert offered.status_code == 200, offered.text
    assert offered.json() == []
    assert joined.status_code == 403, joined.text
    assert "invite you" in joined.json()["detail"]
    assert not await _is_member(session_factory, person)


async def test_an_invitation_lets_them_back_and_leaving_on_their_own_keeps_the_domain(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin, person = await _open_workspace(session_factory)
    app = _app(session_factory)
    async with _client(app, _token(admin, f"admin@{DOMAIN}", TENANT_A)) as client:
        assert (
            await client.delete(f"/tenants/{TENANT_A}/members/{person}")
        ).status_code == 200
    async with tenant_session(session_factory, TENANT_A) as session:
        # As an admin, who may leave on their own while another remains.
        _, link = await InvitationStore().create(
            session,
            role="admin",
            email=None,
            expires_at=datetime.now(UTC) + timedelta(days=1),
            uses_remaining=1,
            created_by=admin,
        )
        await session.commit()

    async with _client(app, _token(person, f"person@{DOMAIN}", None)) as client:
        invited = await client.post("/invitations/accept", json={"token": link})
    async with _client(app, _token(person, f"person@{DOMAIN}", TENANT_A)) as client:
        left = await client.delete(f"/tenants/{TENANT_A}/members/{person}")
    async with _client(app, _token(person, f"person@{DOMAIN}", None)) as client:
        offered = await client.get("/joinable-tenants")
        joined = await client.post(f"/joinable-tenants/{TENANT_A}/join")

    assert invited.status_code == 200, invited.text
    assert left.status_code == 200, left.text
    assert [t["tenant_id"] for t in offered.json()] == [TENANT_A]
    assert joined.status_code == 200, joined.text
    assert await _is_member(session_factory, person)
