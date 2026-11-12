"""The gateway's connection and grant API, through the real app on Postgres.

Signed in with a real session cookie; the grant API reaches the broker, which
checks the grant against the owner's connection and the vendor (faked) before
saving it. Also member removal, which takes the member's connections with it.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    Agent,
    AuditEvent,
    ServiceConnection,
    TenantMember,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    RESOURCES,
    STORE,
    agent_with_key,
    bound_to,
    build_service_harness,
    connect,
    grant_directly,
    services_on_by_default,
)
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    cookies_for,
)


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> Harness:
    return build_service_harness(session_factory, vendor, workspace_gate=False)[0]


async def _put(harness: Harness, owner, agent_id: str, body: dict, service="github"):
    async with harness.client() as client:
        return await client.put(
            f"/gateway/agents/{agent_id}/service-grants/{service}",
            json=body,
            cookies=cookies_for(owner),
        )


async def _token_for(harness: Harness, agent_id: str, key: str):
    async with harness.client() as client:
        return await client.post(
            f"/agents/{agent_id}/service-tokens/github", headers=bearer(key)
        )


async def _actions(harness: Harness) -> list[str]:
    async with harness.session_factory() as session:
        return list(
            await session.scalars(
                select(AuditEvent.action).order_by(AuditEvent.occurred_at)
            )
        )


class TestConnections:
    async def test_the_list_shows_every_service_and_the_persons_connection(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        await connect(harness.session_factory, owner.id, consent="read")

        async with harness.client() as client:
            response = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )

        assert response.status_code == 200, response.text
        entries = {entry["slug"]: entry for entry in response.json()["connections"]}
        assert set(entries) == set(CATALOG)
        github = entries["github"]
        assert {
            key: github[key]
            for key in (
                "configured",
                "unavailable_reason",
                "unavailable_code",
                "status",
                "consent",
                "external_identity",
            )
        } == {
            "configured": True,
            "unavailable_reason": None,
            "unavailable_code": None,
            "status": "active",
            "consent": "read",
            "external_identity": "login-1001",
        }
        assert (github["enabled"], github["auth_type"]) == (True, "oauth")
        assert github["connectable"] is True
        assert (github["pass_through"], github["token_lifetime"]) == (False, 3600)
        assert github["loopback_ports"] is None
        assert github["publisher"] == "GitHub"
        assert github["links"]["support"] == "https://support.github.com"
        # GitHub's tool is its CLI; Atlassian's is the vendor's MCP server.
        assert github["mcp_urls"] == []
        assert entries["atlassian"]["mcp_urls"] == ["https://mcp.atlassian.com/v2/mcp"]
        # No workspace switch on this server: nobody decided, it reads as on.
        assert (github["organization_locked"], github["decided_by"]) == (False, None)
        asana = entries["asana"]
        assert (asana["pass_through"], asana["token_lifetime"]) == (False, None)
        assert asana["configured"] is False
        assert asana["unavailable_code"] == "coming_soon"
        assert asana["enabled"] is False
        assert asana["connectable"] is False
        assert asana["status"] == "not_connected"
        atlassian = entries["atlassian"]
        assert (atlassian["pass_through"], atlassian["token_lifetime"]) == (
            True,
            28800,
        )
        assert atlassian["loopback_ports"] == [39231, 39232, 39233, 39234, 39235]
        # Their own connection is theirs to disconnect; there is nothing to
        # disconnect where they have none.
        assert (github["can_revoke"], asana["can_revoke"]) == (True, False)
        assert atlassian["agent_access_note"] is None
        assert "hour after each sign-in" in entries["sentry"]["agent_access_note"]

    async def test_disconnecting_deletes_grants_and_revokes_the_sign_in(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        assert (
            await _put(harness, owner, agent_id, {"resources": RESOURCES})
        ).status_code == 200

        async with harness.client() as client:
            response = await client.delete(
                "/gateway/service-connections/github", cookies=cookies_for(owner)
            )
            again = await client.delete(
                "/gateway/service-connections/github", cookies=cookies_for(owner)
            )

        assert response.status_code == 200, response.text
        assert response.json() == {"warning": None}
        assert len(vendor.connections_revoked) == 1
        assert again.status_code == 404
        # The message where every client reads it, and the reason beside it.
        assert again.json() == {
            "detail": "GitHub is not connected.",
            "code": "connector_not_connected",
            "retryable": False,
        }
        async with harness.session_factory() as session:
            assert await STORE.list_grants(session, agent_id) == []
        assert (await _actions(harness))[-1] == AuditAction.SERVICE_DISCONNECTED


class TestGrants:
    async def test_a_new_grant_with_no_access_reads(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)

        response = await _put(harness, owner, agent_id, {"resources": RESOURCES})

        assert response.status_code == 200, response.text
        grant = response.json()["grant"]
        assert (grant["access"], grant["tool_mode"], grant["tools"]) == (
            "read",
            "allow",
            [],
        )
        assert grant["resources"] == RESOURCES
        assert grant["summary"] == "builder can read 2 repositories, as the GitHub App."
        assert vendor.checked == [("gho_access_0", RESOURCES)]
        assert (await _actions(harness))[-1] == AuditAction.SERVICE_GRANT_SET

        async with harness.client() as client:
            listed = await client.get(
                f"/gateway/agents/{agent_id}/service-grants",
                cookies=cookies_for(owner),
            )
        assert listed.status_code == 200, listed.text
        assert listed.json()["addressing_open"] is True
        assert [g["service"] for g in listed.json()["grants"]] == ["github"]

    @pytest.mark.parametrize(
        ("policy", "warned"),
        [
            (owner_only_policy([]), False),
            (owner_and_owner_agents_policy(), False),
            (AddressingPolicy(), True),
            (
                AddressingPolicy(
                    rules=[
                        *owner_only_policy([]).rules,
                        AddressingRule(rooms=["room-x"], users="*", agents=[]),
                    ]
                ),
                True,
            ),
        ],
        ids=["owner-alone", "owner-and-their-agents", "anyone", "anyone-in-one-room"],
    )
    async def test_the_warning_follows_who_else_can_address_the_agent(
        self, harness: Harness, policy: AddressingPolicy, warned: bool
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        async with harness.session_factory() as session:
            await session.execute(
                update(Agent)
                .where(Agent.id == agent_id)
                .values(addressing_policy=policy.model_dump())
            )
            await session.commit()

        async with harness.client() as client:
            listed = await client.get(
                f"/gateway/agents/{agent_id}/service-grants",
                cookies=cookies_for(owner),
            )
        assert listed.status_code == 200, listed.text
        assert listed.json()["addressing_open"] is warned

    async def test_someone_elses_agent_is_not_found(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, other.id)

        response = await _put(harness, other, agent_id, {"resources": RESOURCES})
        async with harness.client() as client:
            listed = await client.get(
                f"/gateway/agents/{agent_id}/service-grants",
                cookies=cookies_for(other),
            )

        assert response.status_code == 404
        assert listed.status_code == 404

    async def test_only_the_owners_own_connection_can_be_granted(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, other.id)

        response = await _put(harness, owner, agent_id, {"resources": RESOURCES})

        assert response.status_code == 409
        assert "Switch Console, under Connectors" in response.json()["detail"]

    async def test_write_on_a_read_only_connection(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id, consent="read")

        response = await _put(
            harness, owner, agent_id, {"access": "write", "resources": RESOURCES}
        )

        assert response.status_code == 422
        assert "only reading" in response.json()["detail"]

    async def test_an_agent_with_its_own_runtime(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(
            harness.session_factory, owner, "outsider", known_agent_type=None
        )
        await connect(harness.session_factory, owner.id)

        response = await _put(harness, owner, agent_id, {"resources": RESOURCES})

        assert response.status_code == 422
        assert "nothing would start" in response.json()["detail"]

    async def test_a_service_this_server_cannot_issue(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")

        asana = await _put(harness, owner, agent_id, {"resources": {}}, "asana")
        unknown = await _put(harness, owner, agent_id, {"resources": {}}, "nowhere")

        assert asana.status_code == 422
        assert asana.json()["detail"] == "Not available yet."
        assert unknown.status_code == 404

    async def test_tools_and_resources_outside_the_grant(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)

        tools = await _put(
            harness, owner, agent_id, {"tools": ["create_issue"], "resources": {}}
        )
        vendor.grant_error = ServiceAdapterError(
            "Your GitHub account cannot see repository 72."
        )
        resources = await _put(harness, owner, agent_id, {"resources": RESOURCES})

        assert tools.status_code == 422
        assert "create_issue" in tools.json()["detail"]
        assert resources.status_code == 422
        assert resources.json()["detail"] == (
            "Your GitHub account cannot see repository 72."
        )

    async def test_narrowing_a_grant_revokes_what_it_gave_out(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await _put(
            harness, owner, agent_id, {"access": "write", "resources": RESOURCES}
        )
        issued = (await _token_for(harness, agent_id, key)).json()["token"]

        wider = {"installation_id": 7, "repository_ids": [70, 71, 72]}
        await _put(harness, owner, agent_id, {"access": "write", "resources": wider})
        assert vendor.revoked == []

        narrower = {"installation_id": 7, "repository_ids": [70]}
        response = await _put(
            harness, owner, agent_id, {"access": "write", "resources": narrower}
        )
        assert response.status_code == 200, response.text
        assert vendor.revoked == [issued]

    async def test_a_narrowing_whose_revocation_fails_is_saved_and_says_so(
        self, harness: Harness, vendor: FakeVendor, monkeypatch
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await _put(
            harness, owner, agent_id, {"access": "write", "resources": RESOURCES}
        )
        await _token_for(harness, agent_id, key)

        async def lock_timeout(*args, **kwargs):
            raise RuntimeError("Synthetic lock timeout")

        monkeypatch.setattr(ServiceConnectionStore, "claim_revocations", lock_timeout)
        narrower = {"installation_id": 7, "repository_ids": [70]}
        response = await _put(
            harness, owner, agent_id, {"access": "write", "resources": narrower}
        )

        assert response.status_code == 200, response.text
        assert response.json()["grant"]["resources"] == narrower
        assert response.json()["warning"] is not None
        assert vendor.revoked == []

    async def test_narrowing_a_grant_that_gave_nothing_out(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await _put(
            harness, owner, agent_id, {"access": "write", "resources": RESOURCES}
        )

        response = await _put(
            harness, owner, agent_id, {"access": "read", "resources": RESOURCES}
        )

        assert response.status_code == 200, response.text
        assert response.json()["grant"]["access"] == "read"
        assert response.json()["warning"] is None
        assert vendor.revoked == []

    async def test_removing_a_grant_revokes_its_tokens(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await _put(harness, owner, agent_id, {"resources": RESOURCES})
        issued = (await _token_for(harness, agent_id, key)).json()["token"]

        async with harness.client() as client:
            response = await client.delete(
                f"/gateway/agents/{agent_id}/service-grants/github",
                cookies=cookies_for(owner),
            )
            again = await client.delete(
                f"/gateway/agents/{agent_id}/service-grants/github",
                cookies=cookies_for(owner),
            )

        assert response.status_code == 200, response.text
        assert vendor.revoked == [issued]
        assert again.status_code == 404
        assert (await _actions(harness))[-1] == AuditAction.SERVICE_GRANT_REMOVED
        fetch = await _token_for(harness, agent_id, key)
        assert fetch.json()["error"]["code"] == "grant_missing"


class TestMemberRemoval:
    async def test_removing_a_member_takes_their_connections(
        self, session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="svc-admin", tenant_id=TENANT_A, role="admin"
        )
        member_id = await _make_member(
            session_factory, name="svc-member", tenant_id=TENANT_A, role="member"
        )
        await connect(bound_to(session_factory, TENANT_A), member_id)
        app = _app(session_factory)
        app.state.service_broker = ServiceBroker(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters={"github": vendor},
            organization_apps=None,
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )

        token = _token(admin_id, "svc-admin@example.invalid", TENANT_A)
        async with _client(app, token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{member_id}")

        assert response.status_code == 200, response.text
        assert len(vendor.connections_revoked) == 1
        async with tenant_session(session_factory, TENANT_A) as session:
            assert list(await session.scalars(select(ServiceConnection))) == []
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.MEMBER_REMOVED.value
                )
            )
        assert event is not None and event.details is not None
        assert event.details["service_connections_deleted"] == 1


@pytest.fixture
def gated(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> Harness:
    """The harness with the workspace switch applying, as the flag would."""
    return build_service_harness(session_factory, vendor, workspace_gate=True)[0]


async def _switch_off(harness: Harness, service: str, admin_id: str) -> None:
    async with harness.session_factory() as session:
        await WorkspaceServiceStore().set_enabled(session, service, False, admin_id)
        await session.commit()


async def _listed(harness: Harness, user) -> dict[str, dict]:
    async with harness.client() as client:
        response = await client.get(
            "/gateway/service-connections", cookies=cookies_for(user)
        )
    assert response.status_code == 200, response.text
    return {entry["slug"]: entry for entry in response.json()["connections"]}


WORKSPACE_REFUSAL = (
    "GitHub is not enabled in this workspace. Ask a workspace admin; they "
    "switch it on under Connectors in Switch Console."
)


class TestWorkspaceSwitch:
    async def test_the_list_says_which_services_the_workspace_has_on(
        self, gated: Harness
    ) -> None:
        await services_on_by_default(gated.session_factory)
        owner = await add_member(gated.session_factory, "ada")
        await connect(gated.session_factory, owner.id, consent="read")
        await _switch_off(gated, "datadog", owner.id)

        entries = await _listed(gated, owner)

        assert entries["datadog"]["workspace_enabled"] is False
        assert {
            slug for slug, entry in entries.items() if not entry["workspace_enabled"]
        } == {"datadog"}
        assert entries["datadog"]["decided_by"] == "workspace"
        assert entries["github"]["decided_by"] == "workspace_default"
        assert entries["datadog"]["organization_locked"] is False
        assert entries["github"]["consent"] == "read"
        assert entries["atlassian"]["consent"] is None

    async def test_a_new_workspace_reads_every_service_off_until_one_is_switched_on(
        self, gated: Harness
    ) -> None:
        owner = await add_member(gated.session_factory, "ada")
        assert all(
            entry["workspace_enabled"] is False
            for entry in (await _listed(gated, owner)).values()
        )
        async with gated.session_factory() as session:
            await WorkspaceServiceStore().set_enabled(session, "github", True, owner.id)
            await session.commit()

        entries = await _listed(gated, owner)

        assert {
            slug for slug, entry in entries.items() if entry["workspace_enabled"]
        } == {"github"}

    async def test_with_the_gate_off_every_service_reads_as_on(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        await _switch_off(harness, "datadog", owner.id)

        entries = await _listed(harness, owner)

        assert all(entry["workspace_enabled"] is True for entry in entries.values())

    async def test_a_running_sessions_grants_drop_the_service_and_its_token_is_refused(
        self, gated: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(gated.session_factory, "ada")
        agent_id, key = await agent_with_key(gated.session_factory, owner, "builder")
        await connect(gated.session_factory, owner.id)
        await grant_directly(gated.session_factory, agent_id, owner.id)
        await _switch_off(gated, "github", owner.id)

        async with gated.client() as client:
            grants = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
        token = await _token_for(gated, agent_id, key)

        assert grants.status_code == 200, grants.text
        assert grants.json()["grants"] == []
        assert token.status_code == 403
        assert token.json()["error"] == {
            "code": "forbidden",
            "message": WORKSPACE_REFUSAL,
            "retryable": False,
        }
        assert vendor.issued == [] and vendor.refreshes == 0


async def _agents(harness: Harness, user, service: str = "github"):
    async with harness.client() as client:
        return await client.get(
            f"/gateway/service-connections/{service}/agents",
            cookies=cookies_for(user),
        )


async def _set_policy(
    harness: Harness, agent_id: str, policy: AddressingPolicy
) -> None:
    async with harness.session_factory() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == agent_id)
            .values(addressing_policy=policy.model_dump())
        )
        await session.commit()


class TestYourAgents:
    async def test_lists_only_the_callers_own_agents_in_this_workspace(
        self, harness: Harness, session_factory
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        granted_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        plain_id, _ = await agent_with_key(harness.session_factory, owner, "planner")
        await agent_with_key(harness.session_factory, other, "bobs-agent")
        await _make_tenant(session_factory, TENANT_A)
        elsewhere = bound_to(session_factory, TENANT_A)
        async with elsewhere() as session:
            session.add(
                TenantMember(tenant_id=TENANT_A, user_id=owner.id, role="member")
            )
            await session.commit()
        await agent_with_key(elsewhere, owner, "elsewhere")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, granted_id, owner.id)
        await _set_policy(harness, plain_id, owner_only_policy([]))

        response = await _agents(harness, owner)

        assert response.status_code == 200, response.text
        listed = response.json()
        assert [
            (a["agent_id"], a["name"], a["granted"], a["addressing_open"])
            for a in listed
        ] == [
            (granted_id, "builder", True, True),
            (plain_id, "planner", False, False),
        ]
        builder, planner = listed
        assert (builder["grant"]["access"], builder["grant"]["resources"]) == (
            "write",
            RESOURCES,
        )
        assert builder["grant"]["summary"]
        assert planner["grant"] is None
        assert (builder["grantable"], planner["grantable"]) == (True, True)

    async def test_an_agent_on_its_own_runtime_is_not_grantable(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        await agent_with_key(
            harness.session_factory, owner, "standalone", known_agent_type=None
        )

        response = await _agents(harness, owner)

        assert response.status_code == 200, response.text
        assert [a["grantable"] for a in response.json()] == [False]

    async def test_an_agent_only_its_owners_agents_can_address_is_not_open(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await _set_policy(harness, agent_id, owner_and_owner_agents_policy())

        response = await _agents(harness, owner)

        assert response.status_code == 200, response.text
        assert [(a["agent_id"], a["addressing_open"]) for a in response.json()] == [
            (agent_id, False)
        ]

    async def test_a_member_with_no_agents_gets_an_empty_list(
        self, harness: Harness
    ) -> None:
        member = await add_member(harness.session_factory, "cy")
        response = await _agents(harness, member)
        assert (response.status_code, response.json()) == (200, [])

    @pytest.mark.parametrize("service", ["nowhere", "asana"])
    async def test_an_unknown_or_placeholder_service_is_not_found(
        self, harness: Harness, service: str
    ) -> None:
        member = await add_member(harness.session_factory, "cy")
        response = await _agents(harness, member, service)
        assert response.status_code == 404
        assert response.json()["detail"] == f"No service named {service!r}."


async def _workspace_admin(harness: Harness, name: str):
    admin = await add_member(harness.session_factory, name)
    async with harness.session_factory() as session:
        await session.execute(
            update(TenantMember)
            .where(TenantMember.user_id == admin.id)
            .values(role="admin")
        )
        await session.commit()
    return admin


async def _in_workspace(harness: Harness, user, service: str = "github"):
    async with harness.client() as client:
        return await client.get(
            f"/gateway/service-connections/{service}/workspace",
            cookies=cookies_for(user),
        )


async def _revoke(harness: Harness, admin, user_id: str, service: str = "github"):
    async with harness.client() as client:
        return await client.delete(
            f"/gateway/service-connections/{service}/people/{user_id}",
            cookies=cookies_for(admin),
        )


class TestTheWorkspacesView:
    async def test_an_admin_sees_everyone_connected_and_every_agent_granted(
        self, harness: Harness
    ) -> None:
        admin = await _workspace_admin(harness, "admin")
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        builder, _ = await agent_with_key(harness.session_factory, ada, "builder")
        closed, _ = await agent_with_key(harness.session_factory, bob, "closed")
        await connect(harness.session_factory, ada.id)
        await connect(harness.session_factory, bob.id, account_id="1002")
        await grant_directly(harness.session_factory, builder, ada.id)
        await grant_directly(harness.session_factory, closed, bob.id)
        await _set_policy(harness, closed, owner_only_policy([]))

        response = await _in_workspace(harness, admin)

        assert response.status_code == 200, response.text
        body = response.json()
        assert [
            (p["user_id"], p["name"], p["status"], p["agents"]) for p in body["people"]
        ] == [(ada.id, "ada", "active", 1), (bob.id, "bob", "active", 1)]
        assert all(p["connected_at"] for p in body["people"])
        assert all(p["can_revoke"] for p in body["people"])
        agent, closed_agent = body["agents"]
        assert (agent["agent_id"], agent["name"]) == (builder, "builder")
        assert (agent["owner_id"], agent["owner_name"]) == (ada.id, "ada")
        assert agent["grant"]["access"] == "write"
        # Whether others than its owner could have it act as its owner.
        assert agent["addressing_open"] is True
        assert (closed_agent["agent_id"], closed_agent["addressing_open"]) == (
            closed,
            False,
        )

    async def test_a_member_sees_and_ends_only_their_own(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        await connect(harness.session_factory, bob.id)

        listed = await _in_workspace(harness, ada)
        revoked = await _revoke(harness, ada, bob.id)

        assert listed.status_code == 403
        assert revoked.status_code == 403
        async with harness.session_factory() as session:
            assert await STORE.get_connection(session, bob.id, "github") is not None

    async def test_an_admin_ends_someone_elses_connection(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        admin = await _workspace_admin(harness, "admin")
        ada = await add_member(harness.session_factory, "ada")
        builder, _ = await agent_with_key(harness.session_factory, ada, "builder")
        await connect(harness.session_factory, ada.id)
        await grant_directly(harness.session_factory, builder, ada.id)

        response = await _revoke(harness, admin, ada.id)

        assert response.status_code == 200, response.text
        assert response.json() == {"warning": None}
        assert len(vendor.connections_revoked) == 1
        async with harness.session_factory() as session:
            assert await STORE.get_connection(session, ada.id, "github") is None
            assert await STORE.list_grants(session, builder) == []
            event = await session.scalar(
                select(AuditEvent).order_by(AuditEvent.occurred_at.desc()).limit(1)
            )
        assert event is not None
        assert event.action == AuditAction.SERVICE_CONNECTION_REVOKED
        assert (event.actor_user_id, event.target_id) == (admin.id, ada.id)
        assert event.details == {"service": "github"}
        # What its owner sees on their own list: no longer connected.
        assert (await _listed(harness, ada))["github"]["status"] == "not_connected"

    async def test_an_admins_own_or_a_missing_connection(
        self, harness: Harness
    ) -> None:
        admin = await _workspace_admin(harness, "admin")
        ada = await add_member(harness.session_factory, "ada")
        await connect(harness.session_factory, admin.id)

        mine = (await _in_workspace(harness, admin)).json()["people"]
        own = await _revoke(harness, admin, admin.id)
        missing = await _revoke(harness, admin, ada.id)
        unknown = await _in_workspace(harness, admin, "nowhere")

        assert [(p["user_id"], p["can_revoke"]) for p in mine] == [(admin.id, False)]
        assert own.status_code == 409
        assert missing.status_code == 404
        assert missing.json()["code"] == "connector_not_connected"
        assert unknown.status_code == 404
