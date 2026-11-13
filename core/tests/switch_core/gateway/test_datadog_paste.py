"""Connecting Datadog with a pasted personal access token, or an API key and an
application key, in place of its sign-in.

The shipped catalog entry and the adapter the server builds for it run on the
real gateway with cookie sign-in and Postgres; Datadog's HTTP side is the
stand-in for each site (`fake_datadog.py`), which knows the tokens and keys
each test makes there.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from switch_core.connections.broker import Principal
from switch_core.db.models import User
from tests.switch_core.connections.fake_datadog import SITES
from tests.switch_core.gateway.test_datadog_sign_in import (
    NEVER_EXPIRES,
    World,
    _connection,
    _grant,
    _world,
)
from tests.switch_core.management.harness import add_member, cookies_for

PASTE = "/gateway/service-connections/datadog/paste"
PAT = "ddpat_ab12cd_SYNTHETICTOKENVALUE"
KEYS = {"api_key": "SYNTHETIC-API-KEY", "application_key": "SYNTHETIC-APP-KEY"}


async def _paste(
    world: World, user: User, method: str, fields: dict[str, str], site: str
) -> httpx.Response:
    async with world.harness.client() as client:
        return await client.put(
            PASTE,
            json={"method": method, "fields": fields, "choices": {"site": site}},
            cookies=cookies_for(user),
        )


async def _entry(world: World, user: User) -> dict[str, Any]:
    async with world.harness.client() as client:
        listed = await client.get(
            "/gateway/service-connections", cookies=cookies_for(user)
        )
    assert listed.status_code == 200, listed.text
    return next(e for e in listed.json()["connections"] if e["slug"] == "datadog")


class TestList:
    async def test_offers_a_token_and_keys_only_where_the_server_allows_them(
        self, session_factory
    ) -> None:
        off = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")

        assert (await _entry(off, ada))["paste"] == [
            {
                "method": "token",
                "label": "Personal access token",
                "fields": [
                    {
                        "name": "pat",
                        "label": "Personal access token",
                        "secret": True,
                        "help": (
                            "Personal Settings, Access Tokens. Scopes: mcp_read, "
                            "mcp_write for writes, the read scope of each product "
                            "agents use (monitors_read, metrics_read, "
                            "logs_read_data), user_access_read to keep grants."
                        ),
                        "choices": None,
                    }
                ],
                "help_url": (
                    "https://docs.datadoghq.com/account_management/"
                    "personal-access-tokens/"
                ),
                "create_url": None,
                "expires": "vendor",
                "access_note": "Reaches what your token allows.",
            }
        ]

        on = _world(
            session_factory, public_url=None, named=None, allow_non_expiring_keys=True
        )
        token, keys = (await _entry(on, ada))["paste"]
        assert token["method"] == "token"
        assert (keys["method"], keys["label"], keys["expires"], keys["help_url"]) == (
            "keys",
            "API and application keys",
            "never",
            "https://docs.datadoghq.com/account_management/api-app-keys/",
        )
        assert [(f["name"], f["secret"], f["help"]) for f in keys["fields"]] == [
            ("api_key", True, "Organization Settings, API Keys."),
            (
                "application_key",
                True,
                "Personal Settings, Application Keys, with mcp_read, mcp_write "
                "for writes, and the read scope of each product agents use "
                "(monitors_read, metrics_read, logs_read_data).",
            ),
        ]


class TestPaste:
    async def test_a_token_connects_at_its_site_as_the_account_it_can_read(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        us5 = world.datadog["us5.datadoghq.com"]
        us5.pats[PAT] = ["mcp_read", "mcp_write", "user_access_read"]
        ada = await add_member(session_factory, "ada")

        response = await _paste(world, ada, "token", {"pat": PAT}, us5.site)

        assert response.status_code == 200, response.text
        assert response.json() == {
            "warning": None,
            "external_identity": "ada@example.test",
            "method": "token",
            "choices": {"site": "us5.datadoghq.com"},
        }
        assert PAT not in response.text
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.method, connection.account_id, connection.consent) == (
            "token",
            "user-at-us5.datadoghq.com",
            "write",
        )
        entry = await _entry(world, ada)
        assert (
            entry["status"],
            entry["method"],
            entry["choices"],
            entry["access_note"],
        ) == (
            "active",
            "token",
            {"site": "us5.datadoghq.com"},
            "Reaches what your token allows.",
        )
        assert us5.mcp_url in us5.paths
        assert all(not world.datadog[site].paths for site in SITES if site != us5.site)

    async def test_a_token_that_cannot_read_the_account_is_named_by_its_public_part(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        world.datadog["datadoghq.com"].pats[PAT] = ["mcp_read"]
        ada = await add_member(session_factory, "ada")

        response = await _paste(world, ada, "token", {"pat": PAT}, "datadoghq.com")

        assert response.status_code == 200, response.text
        assert response.json()["external_identity"] == "ddpat_ab12cd"

    async def test_a_token_datadog_does_not_know_is_refused(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        world.datadog["datadoghq.eu"].pats[PAT] = ["mcp_read"]
        ada = await add_member(session_factory, "ada")

        # Made at another site, which is another Datadog.
        response = await _paste(world, ada, "token", {"pat": PAT}, "datadoghq.com")

        assert response.status_code == 422, response.text
        assert response.json() == {
            "detail": (
                "Datadog refused the pasted token, which may be wrong, revoked or "
                "expired."
            ),
            "code": "validation_error",
            "retryable": False,
        }
        assert await _connection(session_factory, ada.id) is None

    async def test_keys_are_refused_unchecked_unless_the_server_allows_them(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        world.datadog["datadoghq.eu"].keys.add(
            (KEYS["api_key"], KEYS["application_key"])
        )
        ada = await add_member(session_factory, "ada")

        response = await _paste(world, ada, "keys", KEYS, "datadoghq.eu")

        assert response.status_code == 403, response.text
        assert response.json() == {
            "detail": NEVER_EXPIRES,
            "code": "forbidden",
            "retryable": False,
        }
        assert all(not site.paths for site in world.datadog.sites.values())
        assert await _connection(session_factory, ada.id) is None

    async def test_keys_connect_where_the_server_allows_them(
        self, session_factory
    ) -> None:
        world = _world(
            session_factory, public_url=None, named=None, allow_non_expiring_keys=True
        )
        world.datadog["datadoghq.eu"].keys.add(
            (KEYS["api_key"], KEYS["application_key"])
        )
        ada = await add_member(session_factory, "ada")

        response = await _paste(world, ada, "keys", KEYS, "datadoghq.eu")

        assert response.status_code == 200, response.text
        # Datadog's REST API will not say whose keys these are.
        assert response.json()["external_identity"] == "Datadog keys · datadoghq.eu"
        entry = await _entry(world, ada)
        assert (entry["status"], entry["method"], entry["access_note"]) == (
            "active",
            "keys",
            "Reaches what your keys allow.",
        )


class TestUse:
    async def test_an_agent_is_handed_the_token_for_the_mcp_server_at_its_site(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        us3 = world.datadog["us3.datadoghq.com"]
        us3.pats[PAT] = ["mcp_read", "user_access_read"]
        ada = await add_member(session_factory, "ada")
        assert (
            await _paste(world, ada, "token", {"pat": PAT}, us3.site)
        ).status_code == 200
        async with session_factory() as session:
            agent = await _grant(session, ada, "user-at-us3.datadoghq.com")
            [grant] = await world.broker.grants_for(
                session, agent, Principal.agent_key()
            )
            agent_id = agent.id
        assert grant["mcp_servers"] == [
            {
                "name": "datadog",
                "url": "https://mcp.us3.datadoghq.com/v1/mcp",
                "headers": {"Authorization": "Bearer {pat}"},
            }
        ]
        async with session_factory() as session:
            issued = await world.broker.issue(
                session, agent_id, Principal.agent_key(), "datadog"
            )
        assert json.loads(issued.token) == {
            "public": {"site": "us3.datadoghq.com"},
            "secret": {"pat": PAT},
        }
        assert issued.expires_at is None

    async def test_keys_go_in_the_headers_datadogs_mcp_server_reads(
        self, session_factory
    ) -> None:
        world = _world(
            session_factory, public_url=None, named=None, allow_non_expiring_keys=True
        )
        world.datadog["ap1.datadoghq.com"].keys.add(
            (KEYS["api_key"], KEYS["application_key"])
        )
        ada = await add_member(session_factory, "ada")
        assert (
            await _paste(world, ada, "keys", KEYS, "ap1.datadoghq.com")
        ).status_code == 200
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        async with session_factory() as session:
            agent = await _grant(session, ada, connection.account_id)
            [grant] = await world.broker.grants_for(
                session, agent, Principal.agent_key()
            )
        assert grant["mcp_servers"] == [
            {
                "name": "datadog",
                "url": "https://mcp.ap1.datadoghq.com/v1/mcp",
                "headers": {
                    "DD_API_KEY": "{api_key}",
                    "DD_APPLICATION_KEY": "{application_key}",
                },
            }
        ]

    async def test_disconnecting_says_the_token_works_until_revoked_in_datadog(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        world.datadog["datadoghq.com"].pats[PAT] = ["mcp_read"]
        ada = await add_member(session_factory, "ada")
        assert (
            await _paste(world, ada, "token", {"pat": PAT}, "datadoghq.com")
        ).status_code == 200
        async with world.harness.client() as client:
            removed = await client.delete(
                "/gateway/service-connections/datadog", cookies=cookies_for(ada)
            )

        assert removed.status_code == 200, removed.text
        assert removed.json()["warning"] == (
            "Switch has forgotten the pasted Datadog token but cannot revoke it. "
            "Revoke it in Datadog to stop it working."
        )
        assert await _connection(session_factory, ada.id) is None
