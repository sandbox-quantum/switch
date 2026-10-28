"""Nobody but a key's owner may list, reveal or delete it through the key
routes: not a workspace owner or admin, and not the deployment operator.

An admin's power over the workspace stops at the keys, because a key is a
credential the owner can reveal and an admin who could reveal it could act as
them. Removing the member, or deleting the account, still deletes the keys
(`tenants.remove_member`, `accounts/deletion.py`); nothing reads them.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, ApiKey, TenantMember, User
from tests.switch_core.gateway.test_api_keys_hash_only import TEST_KEYRING, _app
from tests.switch_core.management.harness import add_member, cookies_for


@pytest.mark.parametrize("who", ["owner", "admin", "operator"])
async def test_an_admin_cannot_list_reveal_or_delete_a_members_key(
    session_factory: async_sessionmaker[AsyncSession], who: str
) -> None:
    member = await add_member(session_factory, "keyholder")
    admin = await add_member(session_factory, f"ws-{who}")
    async with session_factory() as session:
        if who == "operator":
            await session.execute(
                update(User).where(User.id == admin.id).values(role="admin")
            )
        else:
            await session.execute(
                update(TenantMember)
                .where(
                    TenantMember.tenant_id == TENANT_ZERO_ID,
                    TenantMember.user_id == admin.id,
                )
                .values(role=who)
            )
        key = ApiKey(
            user_id=member.id,
            key_hash="members-key",
            encrypted_key=TEST_KEYRING.encrypt("secret"),
            label="theirs",
            type="registration",
        )
        session.add(key)
        await session.commit()
        refreshed = await session.get(User, admin.id, populate_existing=True)
        assert refreshed is not None
        admin = refreshed

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(admin),
    ) as client:
        listed = await client.get("/api-keys")
        reveal = await client.get(f"/api-keys/{key.id}/reveal")
        deleted = await client.delete(f"/api-keys/{key.id}")

    assert listed.status_code == 200, listed.text
    assert listed.json() == []
    assert reveal.status_code == 403, reveal.text
    assert "secret" not in reveal.text
    assert deleted.status_code == 403, deleted.text
    async with session_factory() as session:
        assert await session.scalar(select(ApiKey.id).where(ApiKey.id == key.id))
