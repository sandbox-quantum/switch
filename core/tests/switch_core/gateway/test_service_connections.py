"""The gateway's connection and grant API, through the real app on Postgres.

Signed in with a real session cookie; the grant API reaches the broker, which
checks the grant against the owner's connection and the vendor (faked) before
saving it. Also member removal, which takes the member's connections with it.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
)
from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    Agent,
    AuditEvent,
    HostedLaunch,
    ServiceConnection,
    ServiceGrant,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    RESOURCES,
    STORE,
    agent_with_key,
    bound_to,
    build_service_harness,
    connect,
)
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine
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
    return build_service_harness(session_factory, vendor)[0]


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
                "status",
                "consent",
                "external_identity",
            )
        } == {
            "configured": True,
            "unavailable_reason": None,
            "status": "active",
            "consent": "read",
            "external_identity": "login-1001",
        }
        assert (github["enabled"], github["auth_type"]) == (True, "oauth")
        assert github["connectable"] is True
        assert entries["jira"]["configured"] is False
        assert entries["jira"]["enabled"] is False
        assert entries["jira"]["connectable"] is False
        assert entries["jira"]["status"] == "not_connected"

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
            (owner_and_owner_agents_policy(), False),
            (
                AddressingPolicy(
                    rules=[
                        *owner_and_owner_agents_policy().rules,
                        AddressingRule(rooms=["room-x"], users="*", agents=[]),
                    ]
                ),
                True,
            ),
        ],
        ids=["owner-and-their-agents", "anyone-in-one-room"],
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

    async def test_a_cloud_agent_without_its_repository_grant_is_shown_it(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "cloud")
        await connect(harness.session_factory, owner.id)
        async with harness.session_factory() as session:
            machine = await seed_machine(
                session,
                owner_id=owner.id,
                slot_id="slot-a",
                state="ready",
                desired_state="running",
                stop_reason=None,
                revision=1,
                generation=1,
            )
            launch = await seed_launch(
                session,
                machine=machine,
                request_id="launch-1",
                name="cloud",
                state="ready",
                desired_state="running",
                revision=1,
                agent_id=agent_id,
                spec={"installation_id": 7, "repository_id": 70},
            )
            launch.repository = "example/project"
            agent = await session.get(Agent, agent_id)
            agent.metadata_ = {**(agent.metadata_ or {}), "hosted_launch_id": launch.id}
            await session.commit()

        async def listed() -> dict:
            async with harness.client() as client:
                response = await client.get(
                    f"/gateway/agents/{agent_id}/service-grants",
                    cookies=cookies_for(owner),
                )
            assert response.status_code == 200, response.text
            return response.json()

        [missing] = (await listed())["missing"]
        assert missing["service"] == "github"
        assert "example/project" in missing["reason"]
        assert (missing["access"], missing["resources"]) == (
            "write",
            {"installation_id": 7, "repository_ids": [70]},
        )

        granted = await _put(harness, owner, agent_id, {"resources": RESOURCES})
        assert granted.status_code == 200, granted.text
        assert (await listed())["missing"] == []

        # A launch on its way out needs nothing.
        async with harness.session_factory() as session:
            await session.execute(
                delete(ServiceGrant).where(ServiceGrant.agent_id == agent_id)
            )
            await session.execute(
                update(HostedLaunch)
                .where(HostedLaunch.id == "launch-1")
                .values(state="deleting", desired_state="deleted")
            )
            await session.commit()
        assert (await listed())["missing"] == []

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
        assert "Settings, Connections" in response.json()["detail"]

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

        jira = await _put(harness, owner, agent_id, {"resources": {}}, "jira")
        unknown = await _put(harness, owner, agent_id, {"resources": {}}, "nowhere")

        assert jira.status_code == 422
        assert jira.json()["detail"] == "Not available yet."
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
            session_factory, name="svc-admin", tenant_id=TENANT_A, role="owner"
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
            store=STORE,
            token_retention=timedelta(days=30),
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
