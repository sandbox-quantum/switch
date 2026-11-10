"""Credentials pasted in place of an OAuth sign-in, through the broker,
against Postgres and the real OAuth adapter.

The vendor is `example` at two sites (`PASTE_ENTRY`): it signs in with
OAuth, or takes a pasted token its vendor ends, or pasted keys that never
expire. Only the vendor's HTTP side is faked: its MCP server takes pasted
credentials it knows, and its account API names their owner where the
credential may read it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ConnectionSecret, ServiceAdapter
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.broker import (
    KEY_CONSENT,
    CheckedKey,
    Principal,
    ServiceBroker,
    ServiceError,
)
from switch_core.connections.loader import CATALOG_ROOT, load_catalog
from switch_core.connections.organization_apps import OrganizationApp
from switch_core.db.models import Agent, ServiceConnection, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeSites
from tests.switch_core.connections.standing import connection_status, reconnect_reason
from tests.switch_core.connections.test_broker import (
    _issuances,
    _issue,
    _refused,
    _user,
)
from tests.switch_core.connections.test_loader import _write_example
from tests.switch_core.connections.test_loader_paste import PASTE_ENTRY
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = ServiceConnectionStore()
SITE = "eu.example.test"
TOKEN = "expat_ab12_SYNTHETICTOKENVALUE"
KEYS = ("SYNTHETIC-API-KEY", "SYNTHETIC-APP-KEY")
NEVER_EXPIRES = (
    "Example keys do not expire and only Example can revoke them, so Switch "
    "does not hand them to agents."
)


class Pasting:
    def __init__(
        self, broker: ServiceBroker, sites: FakeSites, catalog: dict, root: Path
    ) -> None:
        self.broker = broker
        self.sites = sites
        self.catalog = catalog
        self.root = root

    @property
    def vendor(self):
        return self.sites[SITE]


def _broker(
    session_factory: async_sessionmaker[AsyncSession],
    catalog: dict,
    sites: FakeSites,
    *,
    allow_non_expiring_keys: bool,
) -> ServiceBroker:
    return ServiceBroker(
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
        workspace_gate=False,
        public_url=None,
        allow_non_expiring_keys=allow_non_expiring_keys,
    )


def _pasting(
    session_factory: async_sessionmaker[AsyncSession],
    root: Path,
    *,
    allow_non_expiring_keys: bool = False,
    entry: str = PASTE_ENTRY,
) -> Pasting:
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(root, entry)
    catalog = load_catalog(root)
    sites = FakeSites("example.test", SITE)
    sites[SITE].account = {"id": "acct-eu", "email": "ada@eu.example.test"}
    broker = _broker(
        session_factory,
        catalog,
        sites,
        allow_non_expiring_keys=allow_non_expiring_keys,
    )
    return Pasting(broker, sites, catalog, root)


class _OneOrganizationApp:
    """Every workspace's organization saved one app for `example`."""

    def __init__(self, adapter: ServiceAdapter) -> None:
        self.app = OrganizationApp(
            organization_id="org-1",
            adapter=adapter,
            github_app=None,
            problem=None,
            changed_at=datetime.now(UTC),
        )

    async def for_workspace(
        self, session: AsyncSession, tenant_id: str, service: str
    ) -> OrganizationApp:
        return self.app


async def _check(
    p: Pasting, method: str, fields: dict[str, str], site: str = SITE
) -> CheckedKey:
    async with p.broker._session_factory() as session:
        return await p.broker.check_paste(
            session,
            "example",
            method,  # type: ignore[arg-type]
            fields,
            {"site": site},
        )


async def _connected(
    session_factory: async_sessionmaker[AsyncSession],
    p: Pasting,
    method: str,
    fields: dict[str, str],
) -> tuple[User, Agent]:
    """An owner who pasted `fields` and granted an agent the service."""
    checked = await _check(p, method, fields)
    async with session_factory() as session:
        owner = await _user(session, "ada")
        agent = await add_agent(session, name="planner", owner_id=owner.id)
        await session.commit()
    async with session_factory() as session:
        warning = await p.broker.connect(
            session,
            user_id=owner.id,
            service="example",
            consent=KEY_CONSENT,
            granted_scopes=[],
            account_id=checked.account_id,
            external_identity=checked.label,
            secret=checked.secret,
            oauth_client_id=None,
            method=method,  # type: ignore[arg-type]
            choices=checked.choices,
        )
    assert warning is None
    async with session_factory() as session:
        await STORE.save_grant(
            session,
            agent_id=agent.id,
            owner_id=owner.id,
            service="example",
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id=checked.account_id,
            created_by=owner.id,
        )
        await session.commit()
    return owner, agent


async def _connection(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> ServiceConnection:
    async with session_factory() as session:
        connection = await STORE.get_connection(session, user_id, "example")
    assert connection is not None
    return connection


def _initializes(p: Pasting) -> int:
    return sum(call.get("method") == "initialize" for call in p.vendor.mcp_calls)


class TestCheck:
    async def test_a_token_that_may_read_the_account_is_named_by_it(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True

        checked = await _check(p, "token", {"pat": f"  {TOKEN} "})

        assert (checked.account_id, checked.label) == (
            "acct-eu",
            "ada@eu.example.test",
        )
        assert checked.choices == {"site": SITE}
        assert checked.secret.values == {
            "access_token": json.dumps(
                {"public": {"site": SITE}, "secret": {"pat": TOKEN}},
                separators=(",", ":"),
            ),
            "method": "token",
            "choices": {"site": SITE},
        }
        # Checked at the picked site's MCP server only.
        assert _initializes(p) == 1
        assert p.sites["example.test"].mcp_calls == []

    async def test_a_token_that_may_not_read_the_account_is_named_by_its_alias(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = False

        checked = await _check(p, "token", {"pat": TOKEN})

        assert checked.label == "expat_ab12"
        assert checked.account_id == hashlib.sha256(TOKEN.encode()).hexdigest()

    async def test_keys_that_may_not_read_the_account_are_named_by_service_and_site(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c", allow_non_expiring_keys=True)
        p.vendor.pasted_keys[KEYS] = False

        checked = await _check(
            p, "keys", {"api_key": KEYS[0], "application_key": KEYS[1]}
        )

        assert checked.label == f"Example keys · {SITE}"
        assert (
            checked.account_id == hashlib.sha256("\0".join(KEYS).encode()).hexdigest()
        )

    async def test_a_credential_the_mcp_server_refuses_is_not_taken(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")

        with pytest.raises(ServiceError) as caught:
            await _check(p, "token", {"pat": TOKEN})

        assert (caught.value.status_code, caught.value.code) == (
            422,
            "validation_error",
        )
        assert caught.value.message == (
            "Example refused the pasted token, which may be wrong, revoked or expired."
        )

    async def test_a_refused_paste_is_logged_without_the_credential(
        self, session_factory, tmp_path, caplog: pytest.LogCaptureFixture
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        caplog.set_level(logging.WARNING, logger="switch_core.connections.broker")

        with pytest.raises(ServiceError):
            await _check(p, "token", {"pat": TOKEN})

        [record] = [r for r in caplog.records if r.name.endswith(".broker")]
        assert record.levelno == logging.WARNING
        assert record.getMessage() == (
            "example paste refused: method=token reason=Example refused the "
            "pasted token, which may be wrong, revoked or expired."
        )
        assert TOKEN not in caplog.text

    async def test_a_paste_is_checked_against_the_organizations_app(
        self, session_factory, tmp_path
    ) -> None:
        """Where the workspace goes through its organization's app, the
        server's own need not be set up: that app is the one that hands the
        paste out."""
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        p.broker._organization_apps = _OneOrganizationApp(  # type: ignore[assignment]
            p.broker._adapters.pop("example")
        )

        checked = await _check(p, "token", {"pat": TOKEN})

        assert checked.account_id == "acct-eu"

    async def test_a_vendor_that_cannot_be_reached_can_be_tried_again(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.fail[p.vendor.mcp_url] = (503, {"error": "unavailable"})

        with pytest.raises(ServiceError) as caught:
            await _check(p, "token", {"pat": TOKEN})

        assert (caught.value.status_code, caught.value.retryable) == (503, True)

    @pytest.mark.parametrize(
        ("fields", "choices", "message"),
        [
            ({"pat": "two words"}, {"site": SITE}, "one line of printable"),
            ({"pat": TOKEN, "extra": "x"}, {"site": SITE}, "no field named extra"),
            ({}, {"site": SITE}, "Personal access token is required."),
            ({"pat": TOKEN}, {}, "Example site is required."),
            ({"pat": TOKEN}, {"site": "elsewhere.test"}, "must be one of"),
        ],
    )
    async def test_fields_and_choices_are_held_to_the_entry(
        self, session_factory, tmp_path, fields, choices, message
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True

        with pytest.raises(ServiceError) as caught:
            async with session_factory() as session:
                await p.broker.check_paste(session, "example", "token", fields, choices)

        assert caught.value.status_code == 422
        assert message in caught.value.message
        assert p.vendor.mcp_calls == []


class TestNonExpiringKeys:
    async def test_off_keys_are_not_offered_and_never_checked(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_keys[KEYS] = True

        assert [m.name for m in p.broker.paste_methods("example")] == ["token"]
        with pytest.raises(ServiceError) as caught:
            await _check(p, "keys", {"api_key": KEYS[0], "application_key": KEYS[1]})

        assert (caught.value.status_code, caught.value.code, caught.value.message) == (
            403,
            "forbidden",
            NEVER_EXPIRES,
        )
        assert p.vendor.mcp_calls == []

    async def test_on_keys_are_offered(self, session_factory, tmp_path) -> None:
        p = _pasting(session_factory, tmp_path / "c", allow_non_expiring_keys=True)
        assert [m.name for m in p.broker.paste_methods("example")] == [
            "token",
            "keys",
        ]

    async def test_keys_connected_while_allowed_stop_once_they_are_not(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c", allow_non_expiring_keys=True)
        p.vendor.pasted_keys[KEYS] = False
        owner, agent = await _connected(
            session_factory,
            p,
            "keys",
            {"api_key": KEYS[0], "application_key": KEYS[1]},
        )
        assert await _issue(p.broker, session_factory, agent.id, service="example")

        off = _broker(
            session_factory, p.catalog, p.sites, allow_non_expiring_keys=False
        )
        async with session_factory() as session:
            loaded = await session.get(Agent, agent.id)
            assert loaded is not None
            assert await off.grants_for(session, loaded, Principal.agent_key()) == []
        refused = await _refused(off, session_factory, agent.id, service="example")
        assert (refused.status_code, refused.code, refused.message) == (
            403,
            "forbidden",
            NEVER_EXPIRES,
        )
        connection = await _connection(session_factory, owner.id)
        assert await connection_status(off, connection) == "needs_reauthorization"
        assert await reconnect_reason(off, connection) == (
            "method_not_offered",
            NEVER_EXPIRES,
        )
        async with session_factory() as session:
            other = await add_agent(session, name="writer", owner_id=owner.id)
            await session.commit()
        with pytest.raises(ServiceError) as caught:
            async with session_factory() as session:
                await off.set_grant(
                    session,
                    agent=other,
                    actor_id=owner.id,
                    service="example",
                    access=None,
                    tool_mode=None,
                    tools=None,
                    resources={},
                )
        assert (caught.value.status_code, caught.value.message) == (
            422,
            NEVER_EXPIRES,
        )


class TestIssue:
    async def test_a_pasted_token_is_handed_out_with_no_expiry_for_the_hour(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        _, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        checks = _initializes(p)

        token = await _issue(p.broker, session_factory, agent.id, service="example")

        assert json.loads(token.token) == {
            "public": {"site": SITE},
            "secret": {"pat": TOKEN},
        }
        assert token.expires_at is None
        remaining = (token.use_until - datetime.now(UTC)).total_seconds()
        assert 59 * 60 < remaining <= 3600
        # Checked at the vendor again for the issue, and never refreshed.
        assert _initializes(p) == checks + 1
        assert p.vendor.token_requests == []
        [record] = await _issuances(session_factory)
        assert record.encrypted_token is None
        assert record.expires_at == token.use_until

    async def test_the_sign_ins_cap_does_not_bound_a_pasted_token(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(
            session_factory,
            tmp_path / "c",
            entry=PASTE_ENTRY.replace("max_lifetime: 3600", "max_lifetime: 300"),
        )
        p.vendor.pasted_tokens[TOKEN] = True
        _, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})

        token = await _issue(p.broker, session_factory, agent.id, service="example")

        assert token.expires_at is None
        assert (token.use_until - datetime.now(UTC)).total_seconds() > 59 * 60

    async def test_the_session_calls_the_sites_server_with_the_methods_headers(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c", allow_non_expiring_keys=True)
        p.vendor.pasted_keys[KEYS] = True
        _, agent = await _connected(
            session_factory,
            p,
            "keys",
            {"api_key": KEYS[0], "application_key": KEYS[1]},
        )
        async with session_factory() as session:
            loaded = await session.get(Agent, agent.id)
            assert loaded is not None
            [grant] = await p.broker.grants_for(session, loaded, Principal.agent_key())
        assert grant["mcp_servers"] == [
            {
                "name": "example",
                "url": f"https://mcp.{SITE}/v1/mcp",
                "headers": {
                    "X-Example-Api-Key": "{api_key}",
                    "X-Example-App-Key": "{application_key}",
                    "X-Example-Site": "{site}",
                },
            }
        ]

    async def test_a_token_the_vendor_now_refuses_is_logged_without_it(
        self, session_factory, tmp_path, caplog: pytest.LogCaptureFixture
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        _, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        del p.vendor.pasted_tokens[TOKEN]
        caplog.set_level(logging.WARNING, logger="switch_core.connections.broker")

        await _refused(p.broker, session_factory, agent.id, service="example")

        [record] = [r for r in caplog.records if r.name.endswith(".broker")]
        assert record.levelno == logging.WARNING
        assert record.getMessage() == (
            "example pasted credential refused at token issue: method=token "
            "reason=Example refused the pasted token, which may be wrong, "
            "revoked or expired."
        )
        assert TOKEN not in caplog.text

    async def test_a_token_the_vendor_now_refuses_needs_a_new_one(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        owner, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        del p.vendor.pasted_tokens[TOKEN]

        refused = await _refused(p.broker, session_factory, agent.id, service="example")

        assert (refused.status_code, refused.code, refused.retryable) == (
            409,
            "connector_revoked",
            False,
        )
        assert refused.message.startswith(
            "Example refused the pasted token, which may be wrong, revoked or expired."
        )
        connection = await _connection(session_factory, owner.id)
        assert (connection.status, connection.error_code) == (
            "needs_reauthorization",
            "token_refused",
        )
        assert await reconnect_reason(p.broker, connection) == (
            "token_refused",
            "Example refused the pasted token. Paste a new one.",
        )
        again = await _refused(p.broker, session_factory, agent.id, service="example")
        assert again.message == (
            "Example refused the pasted token. The agent's owner must paste a new "
            "one in Switch Console, under Connectors."
        )
        assert await _issuances(session_factory) == []

    async def test_a_vendor_that_cannot_be_reached_marks_nothing(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        owner, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        p.vendor.fail[p.vendor.mcp_url] = (502, {"error": "bad gateway"})

        refused = await _refused(p.broker, session_factory, agent.id, service="example")

        assert (refused.status_code, refused.retryable) == (503, True)
        assert (await _connection(session_factory, owner.id)).status == "active"

    async def test_pasting_again_replaces_it_in_place(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = False
        owner, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        del p.vendor.pasted_tokens[TOKEN]
        await _refused(p.broker, session_factory, agent.id, service="example")
        renewed = "expat_ab12_SYNTHETICRENEWEDVALUE"
        p.vendor.pasted_tokens[renewed] = True

        checked = await _check(p, "token", {"pat": renewed})
        async with session_factory() as session:
            warning = await p.broker.connect(
                session,
                user_id=owner.id,
                service="example",
                consent=KEY_CONSENT,
                granted_scopes=[],
                account_id=checked.account_id,
                external_identity=checked.label,
                secret=checked.secret,
                oauth_client_id=None,
                method="token",
                choices=checked.choices,
            )

        assert warning == (
            "Switch has forgotten the pasted Example token but cannot revoke it. "
            "Revoke it in Example to stop it working. "
            "Grant Example again to these agents: planner."
        )
        connection = await _connection(session_factory, owner.id)
        assert connection.status == "active"
        assert await reconnect_reason(p.broker, connection) is None
        # Named by its account now, which the grant was not made for.
        refused = await _refused(p.broker, session_factory, agent.id, service="example")
        assert refused.code == "grant_account_changed"

    async def test_pasting_again_for_the_same_account_keeps_the_grants(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        owner, agent = await _connected(session_factory, p, "token", {"pat": TOKEN})
        renewed = "expat_ab12_SYNTHETICRENEWEDVALUE"
        p.vendor.pasted_tokens[renewed] = True

        checked = await _check(p, "token", {"pat": renewed})
        async with session_factory() as session:
            warning = await p.broker.connect(
                session,
                user_id=owner.id,
                service="example",
                consent=KEY_CONSENT,
                granted_scopes=[],
                account_id=checked.account_id,
                external_identity=checked.label,
                secret=checked.secret,
                oauth_client_id=None,
                method="token",
                choices=checked.choices,
            )

        assert warning is not None
        assert "Grant Example again" not in warning
        token = await _issue(p.broker, session_factory, agent.id, service="example")
        assert json.loads(token.token)["secret"] == {"pat": renewed}


class TestDisconnect:
    async def test_a_pasted_token_is_forgotten_not_revoked(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c")
        p.vendor.pasted_tokens[TOKEN] = True
        owner, _ = await _connected(session_factory, p, "token", {"pat": TOKEN})

        async with session_factory() as session:
            warning = await p.broker.disconnect(session, owner.id, "example")

        assert warning == (
            "Switch has forgotten the pasted Example token but cannot revoke it. "
            "Revoke it in Example to stop it working."
        )
        assert p.vendor.revoked == []

    async def test_a_refused_connect_keeps_nothing_and_revokes_nothing(
        self, session_factory, tmp_path
    ) -> None:
        p = _pasting(session_factory, tmp_path / "c", allow_non_expiring_keys=True)
        p.vendor.pasted_keys[KEYS] = True
        checked = await _check(
            p, "keys", {"api_key": KEYS[0], "application_key": KEYS[1]}
        )
        off = _broker(
            session_factory, p.catalog, p.sites, allow_non_expiring_keys=False
        )
        async with session_factory() as session:
            owner = await _user(session, "ada")
            await session.commit()

        with pytest.raises(ServiceError) as caught:
            async with session_factory() as session:
                await off.connect(
                    session,
                    user_id=owner.id,
                    service="example",
                    consent=KEY_CONSENT,
                    granted_scopes=[],
                    account_id=checked.account_id,
                    external_identity=checked.label,
                    secret=ConnectionSecret(dict(checked.secret.values)),
                    oauth_client_id=None,
                    method="keys",
                    choices=checked.choices,
                )

        assert (caught.value.status_code, caught.value.message) == (
            403,
            NEVER_EXPIRES,
        )
        assert p.vendor.revoked == []
        async with session_factory() as session:
            assert await STORE.get_connection(session, owner.id, "example") is None
