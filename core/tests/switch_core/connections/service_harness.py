"""The management harness with the service routes on it, and rows they need.

`tests/switch_core/management/harness.py` wires the agent bridge behind the
real bearer middleware and controller authenticator, with the gateway mounted
at `/gateway` behind real cookie sign-in. This adds the service-token agent
routes and the gateway's connection and grant API, on a broker whose only
adapter is a fake vendor standing in for GitHub.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.service_routes import router as service_router
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.models import Agent, ApiKey, Client, ServiceGrant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    build_harness,
    cookies_for,
    definition,
    provider,
    report_status,
)

STORE = ServiceConnectionStore()
RESOURCES = {"installation_id": 7, "repository_ids": [70, 71]}


def build_service_harness(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> tuple[Harness, ServiceBroker]:
    harness = build_harness(session_factory)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"github": vendor},
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
    )
    harness.app.include_router(service_router, prefix="/agents")
    harness.gateway_app.include_router(service_connections_router)
    harness.app.state.service_broker = broker
    harness.gateway_app.state.service_broker = broker
    return harness, broker


async def agent_with_key(
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
    name: str,
    *,
    known_agent_type: str | None = "claude-code",
) -> tuple[str, str]:
    """An agent with a real API key, run by Console unless told otherwise.
    Returns its id and the key."""
    key = secrets.token_urlsafe(32)
    async with session_factory() as session:
        client = Client(
            type="agent", transport_user_id=f"@{name}:test", display_name=name
        )
        api_key = ApiKey(
            type="agent",
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            encrypted_key="",
            label=name,
            user_id=owner.id,
        )
        session.add_all([client, api_key])
        await session.flush()
        agent = Agent(
            name=name,
            description=f"{name} desc",
            agent_type="auto_session",
            connector_type="claude_code",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner.id,
            metadata_=(
                None
                if known_agent_type is None
                else {"known_agent_type": known_agent_type}
            ),
        )
        session.add(agent)
        await session.commit()
        return agent.id, key


async def connect(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    *,
    account_id: str = "1001",
    consent: str = "write",
) -> None:
    """A connection as phase 2's connect flow will leave it."""
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=user_id,
            service="github",
            consent=consent,
            granted_scopes=[],
            account_id=account_id,
            external_identity=f"login-{account_id}",
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps(
                    {
                        "access_token": "gho_access_0",
                        "expires_at": time.time() + 3600,
                        "refresh_token": "ghr_refresh_0",
                        "refresh_expires_at": time.time() + 180 * 86400,
                    }
                )
            ),
        )
        await session.commit()


async def grant_directly(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    owner_id: str,
    *,
    access: str = "write",
) -> ServiceGrant:
    """A grant row written straight to the database, past the grant API."""
    async with session_factory() as session:
        grant = await STORE.save_grant(
            session,
            agent_id=agent_id,
            owner_id=owner_id,
            service="github",
            access=access,
            tool_mode="deny",
            tools=[],
            resources=RESOURCES,
            account_id="1001",
            created_by=owner_id,
        )
        await session.commit()
        return grant


async def adopt(
    harness: Harness, owner: User, controller: EnrolledController, agent_id: str
) -> None:
    """Put an existing agent on `controller`, binding it there."""
    async with harness.client() as client:
        await report_status(client, controller, 1, providers=[provider("claude")])
        adopted = await client.put(
            f"/gateway/management/agents/{agent_id}",
            json={
                "controller_id": controller.controller_id,
                "desired_state": "running",
                "definition": definition(),
            },
            cookies=cookies_for(owner),
        )
    assert adopted.status_code == 200, adopted.text


def code(response: httpx.Response) -> tuple[int, Any]:
    """The status and the contract envelope's reason code."""
    return response.status_code, response.json().get("error", {}).get("code")


def bound_to(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> async_sessionmaker[AsyncSession]:
    """Sessions bound to `tenant_id`, for the helpers above to write into it."""

    class _Bound:
        def __call__(self) -> Any:
            return tenant_session(session_factory, tenant_id)

    return _Bound()  # type: ignore[return-value]
