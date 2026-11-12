"""Asking whether your own account can be deleted (GET /auth/me/deletion).

Against a real database, with the app `test_admin_delete_user.py` builds: the
check runs the refusals `DELETE /auth/me` runs, and must answer with the same
sentence the deletion would refuse with, and change nothing.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, OrganizationMember, User
from tests.switch_core.accounts.test_account_deletion import ADMIN_EMAIL
from tests.switch_core.gateway.test_admin_delete_user import _app, _client, _people
from tests.switch_core.gateway.test_tenant_api_routes import _make_member


async def test_a_member_beside_another_admin_may_delete_and_nothing_changes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, member = await _people(session_factory)
    async with _client(
        _app(session_factory), member, "leaving@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    assert response.json() == {"refusal": None}
    async with session_factory() as session:
        assert await session.get(User, member) is not None


async def test_the_only_admin_of_a_shared_workspace_is_told_what_the_deletion_says(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_member(
        session_factory, name="colleague", tenant_id=TENANT_ZERO_ID, role="member"
    )
    only_admin = await _make_member(
        session_factory, name="only-admin", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    async with _client(
        _app(session_factory), only_admin, "only-admin@example.invalid"
    ) as client:
        checked = await client.get("/auth/me/deletion")
        deleted = await client.request(
            "DELETE", "/auth/me", json={"email": "only-admin@example.invalid"}
        )
    assert checked.status_code == 200, checked.text
    refusal = checked.json()["refusal"]
    assert refusal is not None and "only admin" in refusal
    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["detail"] == refusal


async def test_the_only_org_admin_is_told_while_others_are_in_the_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    org_admin = await _make_member(
        session_factory, name="org-admin", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    # Another workspace admin, so only the organization's rule refuses.
    colleague = await _make_member(
        session_factory, name="colleague", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    async with session_factory() as session:
        session.add_all(
            [
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=org_admin, role="org_admin"
                ),
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=colleague, role="member"
                ),
            ]
        )
        await session.commit()
    async with _client(
        _app(session_factory), org_admin, "org-admin@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "only organization admin" in refusal


async def test_the_operators_account_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, _ = await _people(session_factory)
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "administrator account" in refusal
