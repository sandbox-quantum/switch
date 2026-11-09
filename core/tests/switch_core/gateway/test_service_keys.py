"""A service connected with a pasted key, against Postgres.

`example`, an api_key entry, is the service. Its keys do not expire and only
Example can revoke them, so Switch never hands one to an agent: a key is
neither checked nor stored, nothing can be granted, and a connection and grant
made before that rule are refused at issue time rather than dropped. The
connection can still be disconnected.
"""

from __future__ import annotations

import json
import shutil
import time
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.broker import CheckedKey, ServiceBroker
from switch_core.connections.loader import (
    CATALOG,
    CATALOG_ROOT,
    Connection,
    load_catalog,
)
from switch_core.db.models import ServiceConnection, ServiceTokenIssuance
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
)
from tests.switch_core.connections.test_loader import API_KEY_ENTRY, _write_example
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    cookies_for,
)

KEYS = {"api_key": "api-key-xxxxxxxx", "region": "eu.example.test"}
NEVER_EXPIRES = (
    "Example keys are long-lived and only Example can revoke them, so Switch "
    "does not hand them to agents."
)


class KeyVendor:
    """Answers `/me` as a vendor checking a key does: 200 for the known key."""

    def __init__(self) -> None:
        self.valid_keys = {KEYS["api_key"]}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path != "/me":
            return httpx.Response(404)
        if request.headers.get("X-Key") not in self.valid_keys:
            return httpx.Response(403, json={"errors": ["Forbidden"]})
        return httpx.Response(
            200, json={"account": {"id": "acct-1", "email": "ada@example.test"}}
        )


@pytest.fixture
def vendor() -> KeyVendor:
    return KeyVendor()


@pytest.fixture
def catalog(tmp_path: Path, monkeypatch) -> dict[str, Connection]:
    """The shipped catalog and `example`, connected with a key. The gateway's
    routes answer the catalog the server loaded at import."""
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(root, API_KEY_ENTRY)
    loaded = load_catalog(root)
    monkeypatch.setattr("switch_core.gateway.service_connections.CATALOG", loaded)
    return loaded


def _keyed(
    session_factory: async_sessionmaker[AsyncSession],
    catalog: dict[str, Connection],
    vendor: KeyVendor,
    *,
    workspace_gate: bool,
) -> tuple[Harness, ServiceBroker]:
    harness, _ = build_service_harness(
        session_factory, FakeVendor(), workspace_gate=workspace_gate
    )
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=catalog,
        adapters={
            "example": ApiKeyAdapter(
                catalog["example"].definition,
                httpx.AsyncClient(transport=httpx.MockTransport(vendor)),
            )
        },
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=workspace_gate,
        public_url=None,
        allow_non_expiring_keys=False,
    )
    harness.app.state.service_broker = broker
    harness.gateway_app.state.service_broker = broker
    return harness, broker


@pytest.fixture
def service(
    session_factory: async_sessionmaker[AsyncSession],
    catalog: dict[str, Connection],
    vendor: KeyVendor,
) -> tuple[Harness, ServiceBroker]:
    return _keyed(session_factory, catalog, vendor, workspace_gate=False)


async def _connect(harness: Harness, owner, fields: dict[str, str]):
    async with harness.client() as client:
        return await client.put(
            "/gateway/service-connections/example/key",
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
    """A key connection and grant as a server before the rule left them."""
    token = json.dumps(
        {"secret": {"api_key": KEYS["api_key"]}, "public": {"region": KEYS["region"]}},
        separators=(",", ":"),
        sort_keys=True,
    )
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=owner_id,
            service="example",
            consent="write",
            granted_scopes=[],
            account_id="acct-1",
            external_identity="ada@example.test",
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
            service="example",
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id="acct-1",
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
        entry = next(e for e in listed.json()["connections"] if e["slug"] == "example")
        assert entry["connectable"] is False
        assert entry["auth_type"] == "api_key"
        assert (entry["unavailable_code"], entry["unavailable_reason"]) == (
            "key_never_expires",
            NEVER_EXPIRES,
        )
        assert entry["token_lifetime"] is None

    async def test_the_list_says_a_connection_made_before_pasted_keys(
        self, service
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await _connected_before(harness.session_factory, owner.id, agent_id)
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
        entry = next(e for e in listed.json()["connections"] if e["slug"] == "example")
        assert (entry["method"], entry["choices"]) == ("keys", {})
        # A key connection has no sign-in level, so nothing is said in its place.
        assert entry["access_note"] is None

    async def test_snowflake_says_why_and_never_checks_a_token(self, service) -> None:
        harness, broker = service
        snowflake: list[httpx.Request] = []
        broker._adapters["snowflake"] = ApiKeyAdapter(
            CATALOG["snowflake"].definition,
            httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda request: snowflake.append(request) or httpx.Response(200)
                )
            ),
        )
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
            response = await client.put(
                "/gateway/service-connections/snowflake/key",
                json={
                    "fields": {
                        "account": "exampleorg-example1",
                        "database": "SALES",
                        "schema": "MCP",
                        "server": "ANALYTICS_MCP",
                        "pat": "SYNTHETIC-SNOWFLAKE-TOKEN",
                    }
                },
                cookies=cookies_for(owner),
            )

        reason = (
            "Snowflake keys are long-lived and only Snowflake can revoke them, so "
            "Switch does not hand them to agents."
        )
        entry = next(
            e for e in listed.json()["connections"] if e["slug"] == "snowflake"
        )
        assert entry["connectable"] is False
        assert entry["auth_type"] == "api_key"
        assert (entry["unavailable_code"], entry["unavailable_reason"]) == (
            "key_never_expires",
            reason,
        )
        assert response.status_code == 403, response.text
        assert response.json()["detail"] == reason
        assert snowflake == []
        assert await _connections(harness) == []

    async def test_a_key_is_neither_checked_nor_stored(
        self, service, vendor: KeyVendor
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
        assert vendor.requests == []
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
                "/gateway/service-connections/example", cookies=cookies_for(owner)
            )

        assert response.status_code == 200, response.text
        assert "cannot revoke it" in response.json()["warning"]
        assert await _connections(harness) == []

    async def test_a_key_for_an_account_linked_to_someone_else_is_refused(
        self, service, monkeypatch
    ) -> None:
        harness, broker = service
        ada = await add_member(harness.session_factory, "ada")
        grace = await add_member(harness.session_factory, "grace")
        agent_id, _ = await agent_with_key(harness.session_factory, ada, "sre")
        await _connected_before(harness.session_factory, ada.id, agent_id)
        # Example keys are refused before this check; the stand-in accepts one.
        monkeypatch.setattr(
            broker,
            "check_key",
            AsyncMock(
                return_value=CheckedKey(
                    account_id="acct-1",
                    label="ada@example.test",
                    secret=ConnectionSecret({"access_token": "unused"}),
                    choices={"region": KEYS["region"]},
                )
            ),
        )

        response = await _connect(harness, grace, KEYS)

        assert response.status_code == 409, response.text
        assert response.json() == {
            "detail": (
                "This Example key's account is already linked to another Switch "
                "user in this Switch workspace. Remove that link first."
            ),
            "code": "account_linked_elsewhere",
            "retryable": False,
        }


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
                f"/agents/{agent_id}/service-tokens/example", headers=bearer(key)
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
                f"/gateway/agents/{agent_id}/service-grants/example",
                json={"resources": {}},
                cookies=cookies_for(owner),
            )

        assert granted.status_code == 422, granted.text
        assert granted.json()["detail"] == NEVER_EXPIRES


class TestWorkspaceSwitch:
    async def test_a_key_for_a_service_the_workspace_switched_off_is_never_checked(
        self, session_factory, catalog, vendor: KeyVendor
    ) -> None:
        harness, _ = _keyed(session_factory, catalog, vendor, workspace_gate=True)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.session_factory() as session:
            await WorkspaceServiceStore().set_enabled(
                session, "example", False, owner.id
            )
            await session.commit()

        response = await _connect(harness, owner, KEYS)

        assert response.status_code == 403
        assert response.json() == {
            "detail": (
                "Example is not enabled in this workspace. Ask a workspace admin; "
                "they switch it on under Connectors in Switch Console."
            ),
            "code": "forbidden",
            "retryable": False,
        }
        assert vendor.requests == []
        assert await _connections(harness) == []
