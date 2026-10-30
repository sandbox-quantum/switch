"""A service connected with a pasted key, against Postgres.

Datadog, the shipped entry, is the service. Its keys do not expire and only
Datadog can revoke them, so Switch never hands one to an agent: a key is
neither checked nor stored, nothing can be granted, and a connection and grant
made before that rule are refused at issue time rather than dropped. The
connection can still be disconnected.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.models import ServiceConnection, ServiceTokenIssuance
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    cookies_for,
)

KEYS = {
    "api_key": "api-key-xxxxxxxx",
    "application_key": "app-key-xxxxxxxx",
    "site": "datadoghq.eu",
}
NEVER_EXPIRES = (
    "Datadog keys do not expire and only Datadog can revoke them, so Switch "
    "does not hand them to agents."
)


class DatadogStandIn:
    """Answers `/api/v1/validate` as Datadog does: 200 for the known key."""

    def __init__(self) -> None:
        self.valid_keys = {KEYS["api_key"]}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path != "/api/v1/validate":
            return httpx.Response(404)
        if request.headers.get("DD-API-KEY") not in self.valid_keys:
            return httpx.Response(403, json={"errors": ["Forbidden"]})
        return httpx.Response(200, json={"valid": True})


@pytest.fixture
def datadog() -> DatadogStandIn:
    return DatadogStandIn()


@pytest.fixture
def service(
    session_factory: async_sessionmaker[AsyncSession], datadog: DatadogStandIn
) -> tuple[Harness, ServiceBroker]:
    harness, broker = build_service_harness(
        session_factory, FakeVendor(), workspace_gate=False
    )
    broker._adapters["datadog"] = ApiKeyAdapter(
        CATALOG["datadog"].definition,
        httpx.AsyncClient(transport=httpx.MockTransport(datadog)),
    )
    return harness, broker


async def _connect(harness: Harness, owner, fields: dict[str, str]):
    async with harness.client() as client:
        return await client.put(
            "/gateway/service-connections/datadog/key",
            json={"fields": fields},
            cookies=cookies_for(owner),
        )


async def _connections(harness: Harness) -> list[ServiceConnection]:
    async with harness.session_factory() as session:
        return list(await session.scalars(select(ServiceConnection)))


async def _connected_before(
    session_factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    agent_id: str,
) -> None:
    """A Datadog connection and grant as a server before the rule left them."""
    token = json.dumps(
        {
            "secret": {
                "api_key": KEYS["api_key"],
                "application_key": KEYS["application_key"],
            },
            "public": {"site": KEYS["site"]},
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=owner_id,
            service="datadog",
            consent="write",
            granted_scopes=[],
            account_id="dd-key",
            external_identity="Datadog key · datadoghq.eu",
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps({"access_token": token, "expires_at": time.time()})
            ),
            oauth_client_id=None,
            method="keys",
            choices={},
        )
        await STORE.save_grant(
            session,
            agent_id=agent_id,
            owner_id=owner_id,
            service="datadog",
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id="dd-key",
            created_by=owner_id,
        )
        await session.commit()


class TestConnect:
    async def test_the_list_says_why_it_cannot_be_connected(self, service) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
        entry = next(e for e in listed.json()["connections"] if e["slug"] == "datadog")
        assert entry["connectable"] is False
        assert entry["auth_type"] == "api_key"
        assert (entry["unavailable_code"], entry["unavailable_reason"]) == (
            "key_never_expires",
            NEVER_EXPIRES,
        )
        assert entry["token_lifetime"] is None

    async def test_a_key_is_neither_checked_nor_stored(
        self, service, datadog: DatadogStandIn
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")

        response = await _connect(harness, owner, KEYS)

        assert response.status_code == 403, response.text
        assert response.json() == {
            "detail": NEVER_EXPIRES,
            "code": "forbidden",
            "retryable": False,
        }
        assert datadog.requests == []
        assert await _connections(harness) == []

    async def test_a_key_connected_before_can_still_be_disconnected(
        self, service
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "sre")
        await _connected_before(harness.session_factory, owner.id, agent_id)

        async with harness.client() as client:
            response = await client.delete(
                "/gateway/service-connections/datadog", cookies=cookies_for(owner)
            )

        assert response.status_code == 200, response.text
        assert "cannot revoke it" in response.json()["warning"]
        assert await _connections(harness) == []


class TestUse:
    async def test_a_grant_made_before_is_left_out_and_refused_at_issue(
        self, service
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "sre")
        await _connected_before(harness.session_factory, owner.id, agent_id)
        async with harness.client() as client:
            grants = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
            token = await client.post(
                f"/agents/{agent_id}/service-tokens/datadog", headers=bearer(key)
            )

        # Left out of what a session starts with, as a switched-off service is:
        # it would be refused every token anyway.
        assert grants.json()["grants"] == []
        assert token.status_code == 403, token.text
        assert token.json()["error"] == {
            "code": "forbidden",
            "message": NEVER_EXPIRES,
            "retryable": False,
        }
        assert KEYS["api_key"] not in token.text
        async with harness.session_factory() as session:
            assert list(await session.scalars(select(ServiceTokenIssuance))) == []

    async def test_a_new_grant_is_refused(self, service) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "sre")
        other_id, _ = await agent_with_key(harness.session_factory, owner, "ops")
        await _connected_before(harness.session_factory, owner.id, other_id)
        async with harness.client() as client:
            granted = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/datadog",
                json={"resources": {}},
                cookies=cookies_for(owner),
            )

        assert granted.status_code == 422, granted.text
        assert granted.json()["detail"] == NEVER_EXPIRES


class TestWorkspaceSwitch:
    async def test_a_key_for_a_service_the_workspace_switched_off_is_never_checked(
        self, session_factory, datadog: DatadogStandIn
    ) -> None:
        harness, broker = build_service_harness(
            session_factory, FakeVendor(), workspace_gate=True
        )
        broker._adapters["datadog"] = ApiKeyAdapter(
            CATALOG["datadog"].definition,
            httpx.AsyncClient(transport=httpx.MockTransport(datadog)),
        )
        owner = await add_member(harness.session_factory, "ada")
        async with harness.session_factory() as session:
            await WorkspaceServiceStore().set_enabled(
                session, "datadog", False, owner.id
            )
            await session.commit()

        response = await _connect(harness, owner, KEYS)

        assert response.status_code == 403
        assert response.json() == {
            "detail": (
                "Datadog is not enabled in this workspace. Ask a workspace admin; "
                "they switch it on under Connectors in Switch Console."
            ),
            "code": "forbidden",
            "retryable": False,
        }
        assert datadog.requests == []
        assert await _connections(harness) == []
