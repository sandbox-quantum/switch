"""A key is its owner's to read: nobody else may reveal it, not a workspace
admin and not the deployment operator, because whoever could reveal it could
act as them.

What a workspace's admins get is oversight: every key in it, by fingerprint
and owner (`GET /api-keys/workspace`), and deleting anyone's key for adding
agents. An agent's own key stays with its owner, and the deployment's
bootstrap key with the operator it was seeded for. `GET /api-keys` stays the
caller's own keys, which is what Console reads it as.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import _resolve_registration_user_id
from switch_core.db.models import TENANT_ZERO_ID, ApiKey, TenantMember, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway import dependencies as gw_deps
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.test_api_keys_hash_only import TEST_KEYRING, _app
from tests.switch_core.management.harness import add_member, cookies_for


@pytest.fixture(autouse=True)
def _protocol(monkeypatch: pytest.MonkeyPatch) -> None:
    # A deleted key is dropped from the protocol's cache.
    monkeypatch.setitem(
        gw_deps._state,
        "protocol",
        SimpleNamespace(
            api_key_cache=SimpleNamespace(invalidate=lambda key_hash: None)
        ),
    )


async def _admin(session_factory: async_sessionmaker[AsyncSession], who: str) -> User:
    """A workspace admin by membership, or the deployment operator."""
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
                .values(role="admin")
            )
        await session.commit()
        refreshed = await session.get(User, admin.id, populate_existing=True)
        assert refreshed is not None
        return refreshed


async def _key(
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
    *,
    token: str,
    key_type: str = "registration",
) -> ApiKey:
    async with session_factory() as session:
        key = ApiKey(
            user_id=owner.id,
            key_hash=hashlib.sha256(token.encode()).hexdigest(),
            encrypted_key=TEST_KEYRING.encrypt(token),
            label=f"{owner.name}'s {key_type}",
            type=key_type,
        )
        session.add(key)
        await session.commit()
        return key


def _client(
    session_factory: async_sessionmaker[AsyncSession], user: User
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(user),
    )


async def _exists(
    session_factory: async_sessionmaker[AsyncSession], key_id: str
) -> bool:
    async with session_factory() as session:
        return bool(await session.scalar(select(ApiKey.id).where(ApiKey.id == key_id)))


@pytest.mark.parametrize("who", ["admin", "operator"])
async def test_an_admin_sees_a_members_key_but_cannot_reveal_it(
    session_factory: async_sessionmaker[AsyncSession], who: str
) -> None:
    member = await add_member(session_factory, "keyholder")
    admin = await _admin(session_factory, who)
    key = await _key(session_factory, member, token="the-members-secret")

    async with _client(session_factory, admin) as client:
        own = await client.get("/api-keys")
        workspace = await client.get("/api-keys/workspace")
        reveal = await client.get(f"/api-keys/{key.id}/reveal")

    assert own.status_code == 200, own.text
    assert own.json() == []
    assert workspace.status_code == 200, workspace.text
    (listed,) = workspace.json()
    assert listed["id"] == key.id
    assert listed["owner_id"] == member.id
    assert listed["owner_name"] == member.name
    assert listed["key_prefix"] == key.key_hash[:12]
    assert (listed["can_reveal"], listed["can_delete"]) == (False, True)
    assert "the-members-secret" not in workspace.text
    assert reveal.status_code == 403, reveal.text
    assert "the-members-secret" not in reveal.text


async def test_a_member_cannot_list_the_workspaces_keys(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    member = await add_member(session_factory, "plain")

    async with _client(session_factory, member) as client:
        workspace = await client.get("/api-keys/workspace")

    assert workspace.status_code == 403, workspace.text


async def test_a_key_an_admin_deletes_stops_working_at_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    member = await add_member(session_factory, "keyholder")
    admin = await _admin(session_factory, "admin")
    key = await _key(session_factory, member, token="deleted-by-an-admin")
    async with session_factory() as session:
        assert (
            await _resolve_registration_user_id(
                "Bearer deleted-by-an-admin",
                session,
                ApiKeyStore(),
                protocol=SimpleNamespace(user_store=None),  # type: ignore[arg-type]
            )
            == member.id
        )

    async with _client(session_factory, admin) as client:
        deleted = await client.delete(f"/api-keys/{key.id}")

    assert deleted.status_code == 200, deleted.text
    assert not await _exists(session_factory, key.id)
    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await _resolve_registration_user_id(
                "Bearer deleted-by-an-admin",
                session,
                ApiKeyStore(),
                protocol=None,  # type: ignore[arg-type]
            )
    assert refused.value.status_code == 401


@pytest.mark.parametrize("key_type", ["agent", "bootstrap"])
async def test_an_admin_cannot_delete_someone_elses_agent_or_bootstrap_key(
    session_factory: async_sessionmaker[AsyncSession], key_type: str
) -> None:
    holder = await add_member(session_factory, "holder")
    admin = await _admin(session_factory, "admin")
    key = await _key(
        session_factory, holder, token=f"a-{key_type}-key", key_type=key_type
    )

    async with _client(session_factory, admin) as client:
        workspace = await client.get("/api-keys/workspace")
        deleted = await client.delete(f"/api-keys/{key.id}")

    assert [k["can_delete"] for k in workspace.json() if k["id"] == key.id] == [False]
    assert deleted.status_code == 403, deleted.text
    assert await _exists(session_factory, key.id)


async def test_a_member_cannot_delete_someone_elses_key(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    holder = await add_member(session_factory, "holder")
    other = await add_member(session_factory, "other")
    key = await _key(session_factory, holder, token="not-yours")

    async with _client(session_factory, other) as client:
        deleted = await client.delete(f"/api-keys/{key.id}")

    assert deleted.status_code == 403, deleted.text
    assert await _exists(session_factory, key.id)


async def test_an_agents_key_says_it_cannot_go_while_the_agent_signs_in_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Deleting it failed on the agent row's reference to it, as a server
    error; it is refused for what it is now, and offered once the agent is
    gone. It is listed under the agent's name now, not the one it registered
    under."""
    owner = await add_member(session_factory, "agent-owner")
    async with session_factory() as session:
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        agent.name = "renamed-helper"
        await session.commit()
        agent_id, agent_key_id = agent.id, agent.api_key_id
    registration = await _key(session_factory, owner, token="mine")

    async with _client(session_factory, owner) as client:
        listed = await client.get("/api-keys")
        refused = await client.delete(f"/api-keys/{agent_key_id}")
        async with session_factory() as session:
            await AgentStore().delete(session, agent_id)
            await session.commit()
        listed_after = await client.get("/api-keys")
        deleted = await client.delete(f"/api-keys/{agent_key_id}")

    def flags(response: httpx.Response) -> dict[str, tuple[str | None, bool, bool]]:
        assert response.status_code == 200, response.text
        return {
            k["id"]: (k["agent_name"], k["can_reveal"], k["can_delete"])
            for k in response.json()
        }

    assert flags(listed) == {
        agent_key_id: ("renamed-helper", True, False),
        registration.id: (None, True, True),
    }
    assert refused.status_code == 409, refused.text
    assert flags(listed_after) == {
        agent_key_id: (None, True, True),
        registration.id: (None, True, True),
    }
    assert deleted.status_code == 200, deleted.text
