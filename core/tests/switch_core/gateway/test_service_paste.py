"""Connecting an OAuth service with a pasted token or keys, through the
gateway, against Postgres.

The service is `example` at two sites (`PASTE_ENTRY`), on the real OAuth
adapter; its vendor's HTTP side is the fake one, whose MCP server takes the
pasted credentials it knows. The agent routes are mounted too, so a token
issued on a pasted connection is read as a session host reads it.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG_ROOT, load_catalog
from switch_core.db.models import ServiceConnection, User
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeSites, FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
)
from tests.switch_core.connections.test_loader import _write_example
from tests.switch_core.connections.test_loader_paste import PASTE_ENTRY
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    cookies_for,
)

SITE = "eu.example.test"
TOKEN = "expat_ab12_SYNTHETICTOKENVALUE"
KEYS = {"api_key": "SYNTHETIC-API-KEY", "application_key": "SYNTHETIC-APP-KEY"}
PASTE = "/gateway/service-connections/example/paste"
NEVER_EXPIRES = (
    "Example keys do not expire and only Example can revoke them, so Switch "
    "does not hand them to agents."
)


class World:
    def __init__(self, harness: Harness, sites: FakeSites) -> None:
        self.harness = harness
        self.sites = sites

    @property
    def vendor(self):
        return self.sites[SITE]

    async def paste(
        self,
        user: User,
        method: str,
        fields: dict[str, str],
        choices: dict[str, str] | None = None,
    ) -> httpx.Response:
        async with self.harness.client() as client:
            return await client.put(
                PASTE,
                json={
                    "method": method,
                    "fields": fields,
                    "choices": {"site": SITE} if choices is None else choices,
                },
                cookies=cookies_for(user),
            )

    async def entry(self, user: User, slug: str = "example") -> dict[str, Any]:
        async with self.harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(user)
            )
        assert listed.status_code == 200, listed.text
        return next(e for e in listed.json()["connections"] if e["slug"] == slug)


def _world(
    session_factory: async_sessionmaker[AsyncSession],
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    allow_non_expiring_keys: bool = False,
    workspace_gate: bool = False,
) -> World:
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(root, PASTE_ENTRY)
    catalog = load_catalog(root)
    # The routes answer the catalog the server loaded at import.
    monkeypatch.setattr("switch_core.gateway.service_connections.CATALOG", catalog)
    sites = FakeSites("example.test", SITE)
    sites[SITE].account = {"id": "acct-eu", "email": "ada@eu.example.test"}
    harness, _ = build_service_harness(
        session_factory, FakeVendor(), workspace_gate=workspace_gate
    )
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=catalog,
        adapters={
            "example": OAuthAdapter(
                catalog["example"].definition,
                StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
                sites.client(),
            )
        },
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=workspace_gate,
        public_url=None,
        allow_non_expiring_keys=allow_non_expiring_keys,
    )
    harness.app.state.service_broker = broker
    harness.gateway_app.state.service_broker = broker
    return World(harness, sites)


async def _connections(world: World) -> list[ServiceConnection]:
    async with world.harness.session_factory() as session:
        return list(await session.scalars(select(ServiceConnection)))


class TestList:
    async def test_offers_a_token_and_leaves_out_keys_that_never_expire(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        ada = await add_member(session_factory, "ada")

        entry = await world.entry(ada)

        assert entry["paste"] == [
            {
                "method": "token",
                "label": "Personal access token",
                "fields": [
                    {
                        "name": "pat",
                        "label": "Personal access token",
                        "secret": True,
                        "help": None,
                        "choices": None,
                    }
                ],
                "help_url": "https://docs.example.test/tokens",
                "create_url": None,
                "expires": "vendor",
                "access_note": "Reaches what your token allows.",
            }
        ]
        assert (entry["status"], entry["method"], entry["access_note"]) == (
            "not_connected",
            None,
            None,
        )
        assert (entry["reconnect_code"], entry["reconnect_reason"]) == (None, None)
        assert (await world.entry(ada, "linear"))["paste"] == []

    async def test_offers_keys_too_where_the_server_allows_them(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(
            session_factory, tmp_path / "c", monkeypatch, allow_non_expiring_keys=True
        )
        ada = await add_member(session_factory, "ada")

        paste = (await world.entry(ada))["paste"]

        assert [(m["method"], m["expires"], m["access_note"]) for m in paste] == [
            ("token", "vendor", "Reaches what your token allows."),
            ("keys", "never", "Reaches what your keys allow."),
        ]
        assert [f["name"] for f in paste[1]["fields"]] == ["api_key", "application_key"]


class TestPaste:
    async def test_a_token_its_vendor_takes_connects_at_the_write_level(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        world.vendor.pasted_tokens[TOKEN] = False
        ada = await add_member(session_factory, "ada")

        response = await world.paste(ada, "token", {"pat": TOKEN})

        assert response.status_code == 200, response.text
        assert response.json() == {
            "warning": None,
            "external_identity": "expat_ab12",
            "method": "token",
            "choices": {"site": SITE},
        }
        assert TOKEN not in response.text
        entry = await world.entry(ada)
        assert (
            entry["status"],
            entry["consent"],
            entry["method"],
            entry["choices"],
            entry["external_identity"],
            entry["access_note"],
        ) == (
            "active",
            "write",
            "token",
            {"site": SITE},
            "expat_ab12",
            "Reaches what your token allows.",
        )

    async def test_a_credential_the_vendor_refuses_is_not_stored(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        ada = await add_member(session_factory, "ada")

        response = await world.paste(ada, "token", {"pat": TOKEN})

        assert response.status_code == 422, response.text
        assert response.json() == {
            "detail": (
                "Example refused the pasted token, which may be wrong, revoked or "
                "expired."
            ),
            "code": "validation_error",
            "retryable": False,
        }
        assert await _connections(world) == []

    async def test_keys_that_never_expire_are_refused_unchecked_unless_allowed(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        world.vendor.pasted_keys[(KEYS["api_key"], KEYS["application_key"])] = True
        ada = await add_member(session_factory, "ada")

        response = await world.paste(ada, "keys", KEYS)

        assert response.status_code == 403, response.text
        assert response.json() == {
            "detail": NEVER_EXPIRES,
            "code": "forbidden",
            "retryable": False,
        }
        assert world.vendor.mcp_calls == []
        assert await _connections(world) == []

    async def test_keys_connect_where_the_server_allows_them(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(
            session_factory, tmp_path / "c", monkeypatch, allow_non_expiring_keys=True
        )
        world.vendor.pasted_keys[(KEYS["api_key"], KEYS["application_key"])] = True
        ada = await add_member(session_factory, "ada")

        response = await world.paste(ada, "keys", KEYS)

        assert response.status_code == 200, response.text
        assert response.json()["external_identity"] == "ada@eu.example.test"
        [connection] = await _connections(world)
        assert (connection.method, connection.account_id) == ("keys", "acct-eu")

    async def test_an_account_linked_to_someone_else_is_refused(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        world.vendor.pasted_tokens[TOKEN] = True
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        assert (await world.paste(ada, "token", {"pat": TOKEN})).status_code == 200

        response = await world.paste(grace, "token", {"pat": TOKEN})

        assert response.status_code == 409, response.text
        assert response.json() == {
            "detail": (
                "This Example account is already linked to another Switch user in "
                "this Switch workspace. Remove that link first."
            ),
            "code": "account_linked_elsewhere",
            "retryable": False,
        }

    async def test_a_service_that_takes_no_pasted_credential_is_not_found(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            response = await client.put(
                "/gateway/service-connections/linear/paste",
                json={"method": "token", "fields": {"pat": TOKEN}, "choices": {}},
                cookies=cookies_for(ada),
            )

        assert response.status_code == 404, response.text
        assert response.json()["detail"] == "Linear is not connected with pasted token."

    @pytest.mark.parametrize(
        "body",
        [
            {"method": "oauth", "fields": {}, "choices": {}},
            {"method": "token", "fields": {"pat": TOKEN}},
            {"method": "token", "fields": {"pat": TOKEN}, "choices": {}, "x": 1},
        ],
    )
    async def test_a_body_that_does_not_fit_is_refused(
        self, session_factory, tmp_path, monkeypatch, body
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            response = await client.put(PASTE, json=body, cookies=cookies_for(ada))

        assert response.status_code == 422, response.text
        assert world.vendor.mcp_calls == []

    async def test_a_service_the_workspace_switched_off_is_never_checked(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(
            session_factory, tmp_path / "c", monkeypatch, workspace_gate=True
        )
        world.vendor.pasted_tokens[TOKEN] = True
        ada = await add_member(session_factory, "ada")
        async with session_factory() as session:
            await WorkspaceServiceStore().set_enabled(session, "example", False, ada.id)
            await session.commit()

        response = await world.paste(ada, "token", {"pat": TOKEN})

        assert response.status_code == 403, response.text
        assert "not enabled in this workspace" in response.json()["detail"]
        assert world.vendor.mcp_calls == []


class TestUse:
    async def test_a_session_host_is_handed_it_with_no_expiry_until_it_is_refused(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _world(session_factory, tmp_path / "c", monkeypatch)
        world.vendor.pasted_tokens[TOKEN] = True
        ada = await add_member(session_factory, "ada")
        agent_id, key = await agent_with_key(session_factory, ada, "planner")
        assert (await world.paste(ada, "token", {"pat": TOKEN})).status_code == 200
        async with world.harness.client() as client:
            granted = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/example",
                json={"resources": {}},
                cookies=cookies_for(ada),
            )
            assert granted.status_code == 200, granted.text
            grants = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
            issued = await client.post(
                f"/agents/{agent_id}/service-tokens/example", headers=bearer(key)
            )

        [grant] = grants.json()["grants"]
        assert grant["mcp_servers"] == [
            {
                "name": "example",
                "url": f"https://mcp.{SITE}/v1/mcp",
                "headers": {"Authorization": "Bearer {pat}"},
            }
        ]
        assert issued.status_code == 200, issued.text
        answer = issued.json()
        assert json.loads(answer["token"]) == {
            "public": {"site": SITE},
            "secret": {"pat": TOKEN},
        }
        assert (answer["expires_at"], answer["expires_in"]) == (None, None)
        remaining = datetime.fromisoformat(answer["use_until"]) - datetime.now(UTC)
        assert timedelta(minutes=59) < remaining <= timedelta(hours=1)

        del world.vendor.pasted_tokens[TOKEN]
        async with world.harness.client() as client:
            refused = await client.post(
                f"/agents/{agent_id}/service-tokens/example", headers=bearer(key)
            )
        assert refused.status_code == 409, refused.text
        assert refused.json()["error"]["code"] == "connector_revoked"
        entry = await world.entry(ada)
        assert (
            entry["status"],
            entry["reconnect_code"],
            entry["reconnect_reason"],
        ) == (
            "needs_reauthorization",
            "token_refused",
            "Example refused the pasted token. Paste a new one.",
        )
