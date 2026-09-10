"""`register_agent_with_token` puts the new agent in the *token's* tenant.

This is the registration path with nothing in front of it: a server-side
connector registers its discovered agents from a startup task
(`server_connectors/core.py`), where there is no request and so no bound
tenant. The HTTP path has `BearerAuthMiddleware` binding one; this one has to
bind it itself, from the same source of truth — `api_keys.tenant_id`.

Getting it wrong is not a transient mistake. The rows written here are what a
later bearer request is authenticated against, and that request reads
`api_keys.tenant_id` back to decide the tenant — so an agent registered into
tenant zero by fallback stays there, and keeps confirming itself.
"""

from __future__ import annotations

import hashlib

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Agent, ApiKey, Client, Tenant, User
from switch_core.tenant_context import current_tenant_id
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    PROFILE,
    make_service,
)

TENANT_B = "register-token-tenant-b"


async def _seed_token(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    token: str,
    tenant_id: str,
) -> None:
    async with session_factory() as session:
        if tenant_id != TENANT_ZERO_ID:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
        user = User(name="minter", email=f"minter-{tenant_id}@test", role="user")
        session.add(user)
        await session.flush()
        session.add(
            ApiKey(
                tenant_id=tenant_id,
                user_id=user.id,
                key_hash=hashlib.sha256(token.encode()).hexdigest(),
                encrypted_key="irrelevant",
                label="registration",
                type="registration",
            )
        )
        await session.commit()


class TestRegistrationTokenDecidesTheTenant:
    async def test_the_agent_and_its_credentials_land_in_the_tokens_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_token(session_factory, token="reg-tok", tenant_id=TENANT_B)
        svc = make_service(session_factory)

        result = await svc.register_agent_with_token(
            registration_token="reg-tok",
            name="connector-agent",
            description="discovered by a connector",
            connector_type="server-side:test",
            integration_profile=PROFILE,
            owner_only=False,
        )

        async with session_factory() as session:
            agent = await session.get(Agent, result.agent_id)
            assert agent is not None
            assert agent.tenant_id == TENANT_B

            key = await session.get(ApiKey, agent.api_key_id)
            assert key is not None
            assert key.tenant_id == TENANT_B

            client = await session.get(Client, agent.client_id)
            assert client is not None
            assert client.tenant_id == TENANT_B

    async def test_nothing_stays_bound_after_registration_returns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_token(session_factory, token="reg-tok", tenant_id=TENANT_B)
        svc = make_service(session_factory)

        assert current_tenant_id() is None
        await svc.register_agent_with_token(
            registration_token="reg-tok",
            name="another-agent",
            description="d",
            connector_type="server-side:test",
            integration_profile=PROFILE,
            owner_only=False,
        )
        assert current_tenant_id() is None

    async def test_no_row_falls_back_to_tenant_zero(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The failure mode this exists to prevent, stated as an assertion:
        the `TenantScoped` default silently produces tenant zero, so a
        registration that bound nothing would leave rows there and look fine.
        """
        await _seed_token(session_factory, token="reg-tok", tenant_id=TENANT_B)
        svc = make_service(session_factory)

        await svc.register_agent_with_token(
            registration_token="reg-tok",
            name="zero-check-agent",
            description="d",
            connector_type="server-side:test",
            integration_profile=PROFILE,
            owner_only=False,
        )

        async with session_factory() as session:
            stray_agents = await session.execute(
                select(Agent.name).where(Agent.tenant_id == TENANT_ZERO_ID)
            )
            stray_keys = await session.execute(
                select(ApiKey.label).where(
                    ApiKey.tenant_id == TENANT_ZERO_ID, ApiKey.type == "agent"
                )
            )
        assert stray_agents.scalars().all() == []
        assert stray_keys.scalars().all() == []
