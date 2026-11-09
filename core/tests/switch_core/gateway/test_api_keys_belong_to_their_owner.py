"""Nobody but a key's owner may list, reveal or delete it through the key
routes: not a workspace admin, and not the deployment operator.

An admin's power over the workspace stops at the keys, because a key is a
credential the owner can reveal and an admin who could reveal it could act as
them. Removing the member, or deleting the account, still deletes the keys
(`tenants.remove_member`, `accounts/deletion.py`); nothing reads them.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, ApiKey, TenantMember, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway import dependencies as gw_deps
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.test_api_keys_hash_only import TEST_KEYRING, _app
from tests.switch_core.management.harness import add_member, cookies_for


@pytest.mark.parametrize("who", ["admin", "operator"])
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


async def test_an_agents_key_says_it_cannot_go_while_the_agent_signs_in_with_it(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting it failed on the agent row's reference to it, as a server
    error; it is refused for what it is now, and offered once the agent is
    gone."""
    # A deleted key is dropped from the protocol's cache.
    monkeypatch.setitem(
        gw_deps._state,
        "protocol",
        SimpleNamespace(
            api_key_cache=SimpleNamespace(invalidate=lambda key_hash: None)
        ),
    )
    owner = await add_member(session_factory, "agent-owner")
    async with session_factory() as session:
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        registration = ApiKey(
            user_id=owner.id,
            key_hash="registration-key",
            encrypted_key=TEST_KEYRING.encrypt("secret"),
            label="mine",
            type="registration",
        )
        session.add(registration)
        await session.commit()
        agent_id, agent_key_id = agent.id, agent.api_key_id

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(owner),
    ) as client:
        listed = await client.get("/api-keys")
        refused = await client.delete(f"/api-keys/{agent_key_id}")
        async with session_factory() as session:
            await AgentStore().delete(session, agent_id)
            await session.commit()
        listed_after = await client.get("/api-keys")
        deleted = await client.delete(f"/api-keys/{agent_key_id}")

    def flags(response: httpx.Response) -> dict[str, tuple[bool, bool]]:
        assert response.status_code == 200, response.text
        return {k["label"]: (k["can_reveal"], k["can_delete"]) for k in response.json()}

    assert flags(listed) == {"helper": (True, False), "mine": (True, True)}
    assert refused.status_code == 409, refused.text
    assert flags(listed_after) == {"helper": (True, True), "mine": (True, True)}
    assert deleted.status_code == 200, deleted.text


async def test_a_retired_key_offers_nothing_to_copy_and_goes_after_its_agent(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A retired key authenticates as nothing, so it is never revealed. One an
    agent still holds can't be deleted under it, and the refusal says so; once
    the agent is gone it can go."""
    monkeypatch.setitem(
        gw_deps._state,
        "protocol",
        SimpleNamespace(
            api_key_cache=SimpleNamespace(invalidate=lambda key_hash: None)
        ),
    )
    owner = await add_member(session_factory, "retired-owner")
    async with session_factory() as session:
        agent = await add_agent(session, name="stranded", owner_id=owner.id)
        await session.execute(
            update(ApiKey).where(ApiKey.id == agent.api_key_id).values(type="retired")
        )
        orphan = ApiKey(
            user_id=owner.id,
            key_hash="retired-registration-key",
            encrypted_key=TEST_KEYRING.encrypt("secret"),
            label="server-connector:gone",
            type="retired",
        )
        session.add(orphan)
        await session.commit()
        agent_id, agent_key_id = agent.id, agent.api_key_id

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(owner),
    ) as client:
        listed = await client.get("/api-keys")
        revealed = await client.get(f"/api-keys/{orphan.id}/reveal")
        refused = await client.delete(f"/api-keys/{agent_key_id}")
        async with session_factory() as session:
            await AgentStore().delete(session, agent_id)
            await session.commit()
        listed_after = await client.get("/api-keys")
        deleted = await client.delete(f"/api-keys/{agent_key_id}")

    def flags(response: httpx.Response) -> dict[str, tuple[bool, bool]]:
        assert response.status_code == 200, response.text
        return {k["label"]: (k["can_reveal"], k["can_delete"]) for k in response.json()}

    assert flags(listed) == {
        "stranded": (False, False),
        "server-connector:gone": (False, True),
    }
    assert revealed.status_code == 409, revealed.text
    assert "secret" not in revealed.text
    assert refused.status_code == 409, refused.text
    assert "belongs to an agent" in refused.json()["detail"]
    assert flags(listed_after)["stranded"] == (False, True)
    assert deleted.status_code == 200, deleted.text
