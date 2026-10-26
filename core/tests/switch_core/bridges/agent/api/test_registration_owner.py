"""Registering over HTTP must not let a shared secret act as admin.

Before this fix, the deployment-wide AGENT_REGISTRATION_TOKEN was seeded as a
`"registration"`-type key owned by the admin user, so every agent registered
through it inherited the admin's authority (`_resolve_acting_identity` reads
the owner's `role` straight off the `User` row). A `"bootstrap"`-type key now
resolves to a dedicated, non-admin owner instead — this proves it, and that
a non-registration key (an agent's own) can no longer be replayed as one.

`_resolve_registration_user_id` is the dependency `POST /agents` resolves its
owner through; the agent is then registered for whoever it answers.
"""

from __future__ import annotations

import hashlib

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import _resolve_registration_user_id
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_TYPE,
    ensure_bootstrap_owner,
)
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_service,
    register,
)


async def _make_admin(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        admin = User(name="Admin", email="admin@test", role="admin")
        session.add(admin)
        await session.commit()
        return admin.id


async def _make_key(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    token: str,
    key_type: str,
) -> None:
    async with session_factory() as session:
        session.add(
            ApiKey(
                user_id=user_id,
                key_hash=hashlib.sha256(token.encode()).hexdigest(),
                encrypted_key="irrelevant",
                label="test key",
                type=key_type,
            )
        )
        await session.commit()


async def _owner_for(
    session_factory: async_sessionmaker[AsyncSession], svc: AgentCore, token: str
) -> str:
    async with session_factory() as session:
        return await _resolve_registration_user_id(
            authorization=f"Bearer {token}",
            session=session,
            api_key_store=ApiKeyStore(),
            protocol=svc,
        )


class TestRegistrationOwner:
    async def test_bootstrap_token_owns_the_agent_as_the_bootstrap_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        admin_id = await _make_admin(session_factory)
        async with session_factory() as session:
            bootstrap_owner = await ensure_bootstrap_owner(session, UserStore())
            await session.commit()
        await _make_key(
            session_factory,
            user_id=admin_id,
            token="shared-secret",
            key_type=BOOTSTRAP_KEY_TYPE,
        )

        owner_id = await _owner_for(session_factory, svc, "shared-secret")
        agent_id = await register(
            svc, "colleague-agent", owner_id, addressing_policy=None
        )

        async with session_factory() as session:
            agent = await svc.agent_store.get(session, agent_id)
        assert agent is not None
        assert agent.owner_id == bootstrap_owner.id
        assert agent.owner_id != admin_id

    async def test_a_plain_registration_key_still_owns_as_itself(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        async with session_factory() as session:
            owner = User(name="owner", email="owner2@test", role="user")
            session.add(owner)
            await session.commit()
            owner_id = owner.id
        await _make_key(
            session_factory, user_id=owner_id, token="personal", key_type="registration"
        )

        assert await _owner_for(session_factory, svc, "personal") == owner_id

    async def test_an_agent_key_cannot_be_replayed_as_a_registration_token(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        admin_id = await _make_admin(session_factory)
        await _make_key(
            session_factory,
            user_id=admin_id,
            token="leaked-agent-key",
            key_type="agent",
        )

        with pytest.raises(HTTPException) as refused:
            await _owner_for(session_factory, svc, "leaked-agent-key")
        assert refused.value.status_code == 401

    async def test_a_bootstrap_key_with_no_trusted_owner_is_unavailable_not_invalid(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The token is valid, so a 401 would send its holder off to fix a
        credential that is fine; what is wrong is the deployment."""
        svc = make_service(session_factory)
        admin_id = await _make_admin(session_factory)
        await _make_key(
            session_factory,
            user_id=admin_id,
            token="shared-secret",
            key_type=BOOTSTRAP_KEY_TYPE,
        )

        with pytest.raises(HTTPException) as refused:
            await _owner_for(session_factory, svc, "shared-secret")
        assert refused.value.status_code == 503
