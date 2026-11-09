"""Revoking a person's access in a workspace while their agents stay.

`keep_agent_keys` keeps whatever key an agent's row still points at: the
agent's own, or one retired while the agent stays (a server-side connector's
agent, after the connectors were dropped). Deleting either would fail on the
agent's reference, so only `agent`-typed keys being kept made removing such a
member a server error.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApiKey
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.workspace_access import revoke_workspace_access
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.test_api_keys_hash_only import TEST_KEYRING
from tests.switch_core.management.harness import add_member


async def _nothing(*_args: Any) -> list[Any]:
    return []


async def test_keys_agents_still_hold_are_kept_retired_or_not(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    owner = await add_member(session_factory, "leaving")
    async with session_factory() as session:
        working = await add_agent(session, name="working", owner_id=owner.id)
        stranded = await add_agent(session, name="stranded", owner_id=owner.id)
        await session.execute(
            update(ApiKey)
            .where(ApiKey.id == stranded.api_key_id)
            .values(type="retired")
        )
        personal = ApiKey(
            user_id=owner.id,
            key_hash="personal-registration-key",
            encrypted_key=TEST_KEYRING.encrypt("secret"),
            label="mine",
            type="registration",
        )
        session.add(personal)
        await session.commit()
        kept = {working.api_key_id, stranded.api_key_id}

    async with session_factory() as session:
        revoked = await revoke_workspace_access(
            session,
            owner.id,
            api_key_store=ApiKeyStore(),
            broker=SimpleNamespace(remove_connections=_nothing),  # type: ignore[arg-type]
            sign_in_flows=SimpleNamespace(discard_for_user=_nothing),  # type: ignore[arg-type]
            keep_agent_keys=True,
        )
        await session.commit()

    async with session_factory() as session:
        left = set(
            await session.scalars(select(ApiKey.id).where(ApiKey.user_id == owner.id))
        )
    assert left == kept
    assert revoked.key_hashes == ["personal-registration-key"]
