"""PagerDuty obeys the existing non-expiring-key policy at the HTTP boundary."""

from __future__ import annotations

import json
import time

import httpx
from sqlalchemy import select

from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.loader import CATALOG
from switch_core.db.models import ServiceConnection, ServiceTokenIssuance
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
)
from tests.switch_core.management.harness import add_member, bearer, cookies_for

FIELDS = {"api_key": "SYNTHETIC-PAGERDUTY-USER-KEY", "region": "eu.pagerduty.com"}


async def test_pagerduty_cannot_be_connected_or_granted_and_never_sends_the_key(
    session_factory,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"user": {"id": "SYNTHETIC-USER"}})

    harness, broker = build_service_harness(
        session_factory, FakeVendor(), workspace_gate=False
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        broker._adapters["pagerduty"] = ApiKeyAdapter(
            CATALOG["pagerduty"].definition, http
        )
        owner = await add_member(session_factory, "owner")
        agent_id, _ = await agent_with_key(session_factory, owner, "responder")
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
            entry = next(
                e for e in listed.json()["connections"] if e["slug"] == "pagerduty"
            )
            assert entry["auth_type"] == "api_key"
            assert entry["connectable"] is False
            assert entry["unavailable_code"] == "key_never_expires"
            assert entry["token_lifetime"] is None
            connected = await client.put(
                "/gateway/service-connections/pagerduty/key",
                json={"fields": FIELDS},
                cookies=cookies_for(owner),
            )
            granted = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/pagerduty",
                json={"resources": {}},
                cookies=cookies_for(owner),
            )
        assert connected.status_code == 403
        assert connected.json()["code"] == "forbidden"
        assert granted.status_code == 422
        assert "keys do not expire" in granted.json()["detail"]
        assert FIELDS["api_key"] not in connected.text + granted.text + listed.text
        assert requests == []
        async with session_factory() as session:
            assert list(await session.scalars(select(ServiceConnection))) == []


async def test_legacy_pagerduty_secret_stays_encrypted_is_not_issued_and_can_be_removed(
    session_factory,
) -> None:
    harness, broker = build_service_harness(
        session_factory, FakeVendor(), workspace_gate=False
    )
    async with httpx.AsyncClient() as http:
        adapter = ApiKeyAdapter(CATALOG["pagerduty"].definition, http)
        broker._adapters["pagerduty"] = adapter
        owner = await add_member(session_factory, "owner")
        agent_id, key = await agent_with_key(session_factory, owner, "responder")
        encrypted = TEST_KEYRING.encrypt(
            json.dumps(
                {
                    "access_token": adapter.secret(FIELDS).access_token,
                    "expires_at": time.time(),
                }
            )
        )
        assert FIELDS["api_key"] not in encrypted
        # Simulate an existing connection; the current connect route refuses keys.
        async with session_factory() as session:
            await STORE.save_connection(
                session,
                user_id=owner.id,
                service="pagerduty",
                consent="write",
                granted_scopes=[],
                account_id="SYNTHETIC-USER",
                external_identity="oncall@example.test",
                encrypted_secret=encrypted,
                oauth_client_id=None,
            )
            await STORE.save_grant(
                session,
                agent_id=agent_id,
                owner_id=owner.id,
                service="pagerduty",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={},
                account_id="SYNTHETIC-USER",
                created_by=owner.id,
            )
            await session.commit()
        async with harness.client() as client:
            grants = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
            issued = await client.post(
                f"/agents/{agent_id}/service-tokens/pagerduty", headers=bearer(key)
            )
            removed = await client.delete(
                "/gateway/service-connections/pagerduty", cookies=cookies_for(owner)
            )
        assert grants.json()["grants"] == []
        assert issued.status_code == 403
        assert issued.json()["error"]["code"] == "forbidden"
        assert FIELDS["api_key"] not in issued.text + grants.text + removed.text
        assert removed.status_code == 200
        assert "cannot revoke it" in removed.json()["warning"]
        assert "Revoke it in PagerDuty" in removed.json()["warning"]
        async with session_factory() as session:
            assert list(await session.scalars(select(ServiceTokenIssuance))) == []
            assert list(await session.scalars(select(ServiceConnection))) == []
