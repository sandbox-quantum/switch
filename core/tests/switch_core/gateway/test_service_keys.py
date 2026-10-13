"""Connecting a service with a pasted key, and using it, against Postgres.

Datadog, the shipped entry, is the service: its API key is checked with the
vendor (a stand-in transport here) before anything is stored, the connection
keeps the fields as the token a session host is handed, and a grant hands that
token out like any pass-through one.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.models import ServiceConnection
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
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
    harness, broker = build_service_harness(session_factory, FakeVendor())
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


class TestConnect:
    async def test_the_list_offers_the_key_form(self, service) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
        entry = next(e for e in listed.json()["connections"] if e["slug"] == "datadog")
        assert entry["connectable"] is True
        assert entry["auth_type"] == "api_key"
        form = entry["key"]
        assert [(f["name"], f["secret"]) for f in form["fields"]] == [
            ("api_key", True),
            ("application_key", True),
            ("site", False),
        ]
        assert "datadoghq.eu" in form["fields"][2]["choices"]
        assert form["help_url"].startswith("https://docs.datadoghq.com/")
        github = next(e for e in listed.json()["connections"] if e["slug"] == "github")
        assert github["key"] is None

    async def test_a_key_the_vendor_accepts_is_stored_and_never_sent_back(
        self, service, datadog: DatadogStandIn
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")

        response = await _connect(harness, owner, KEYS)

        assert response.status_code == 200, response.text
        assert response.json()["external_identity"] == "Datadog key · datadoghq.eu"
        assert KEYS["api_key"] not in response.text
        [request] = datadog.requests
        assert str(request.url) == "https://api.datadoghq.eu/api/v1/validate"
        assert request.headers["DD-API-KEY"] == KEYS["api_key"]
        [connection] = await _connections(harness)
        assert (connection.service, connection.consent, connection.status) == (
            "datadog",
            "write",
            "active",
        )
        assert KEYS["api_key"] not in connection.encrypted_secret
        stored = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert json.loads(stored["access_token"]) == {
            "secret": {
                "api_key": KEYS["api_key"],
                "application_key": KEYS["application_key"],
            },
            "public": {"site": "datadoghq.eu"},
        }

    async def test_a_refused_key_is_not_stored(
        self, service, datadog: DatadogStandIn
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")

        response = await _connect(harness, owner, {**KEYS, "api_key": "WRONG-KEY"})

        assert response.status_code == 422, response.text
        assert "refused the key" in response.json()["detail"]
        assert await _connections(harness) == []

    @pytest.mark.parametrize(
        ("fields", "message"),
        [
            ({**KEYS, "site": "evil.example"}, "must be one of"),
            ({**KEYS, "api_key": "has a space"}, "without spaces"),
            ({k: v for k, v in KEYS.items() if k != "application_key"}, "required"),
            ({**KEYS, "extra": "x"}, "takes no field named extra"),
        ],
        ids=["site-not-offered", "space", "missing", "unknown"],
    )
    async def test_malformed_fields_are_refused_before_the_vendor_is_asked(
        self, service, datadog: DatadogStandIn, fields, message
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")

        response = await _connect(harness, owner, fields)

        assert response.status_code == 422, response.text
        assert message in response.json()["detail"]
        assert datadog.requests == []

    async def test_a_key_someone_else_linked_is_refused(self, service) -> None:
        harness, _ = service
        ada = await add_member(harness.session_factory, "ada")
        grace = await add_member(harness.session_factory, "grace")
        assert (await _connect(harness, ada, KEYS)).status_code == 200

        response = await _connect(harness, grace, KEYS)

        assert response.status_code == 409, response.text
        assert response.json()["code"] == "account_linked_elsewhere"

    async def test_disconnecting_says_the_key_still_works_at_the_vendor(
        self, service
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        await _connect(harness, owner, KEYS)

        async with harness.client() as client:
            response = await client.delete(
                "/gateway/service-connections/datadog", cookies=cookies_for(owner)
            )

        assert response.status_code == 200, response.text
        assert "cannot revoke it" in response.json()["warning"]
        assert await _connections(harness) == []


class TestUse:
    async def test_a_granted_agent_is_handed_the_fields_for_an_hour(
        self, service
    ) -> None:
        harness, _ = service
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "sre")
        await _connect(harness, owner, KEYS)
        async with harness.client() as client:
            granted = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/datadog",
                json={"resources": {}},
                cookies=cookies_for(owner),
            )
            assert granted.status_code == 200, granted.text
            assert granted.json()["grant"]["access"] == "write"
            grants = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
            token = await client.post(
                f"/agents/{agent_id}/service-tokens/datadog", headers=bearer(key)
            )

        assert token.status_code == 200, token.text
        body = token.json()
        assert json.loads(body["token"])["secret"]["api_key"] == KEYS["api_key"]
        expires_at = datetime.fromisoformat(body["expires_at"])
        assert expires_at <= datetime.now(UTC) + timedelta(hours=1, minutes=1)
        [grant] = grants.json()["grants"]
        assert grant["mcp_servers"] == [
            {
                "name": "datadog",
                "url": "https://mcp.{site}/api/unstable/mcp-server/mcp",
                "headers": {
                    "DD_API_KEY": "{api_key}",
                    "DD_APPLICATION_KEY": "{application_key}",
                },
            }
        ]
