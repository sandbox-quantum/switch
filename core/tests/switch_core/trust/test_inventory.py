"""The agent inventory Switch sends Switch Trust: what one workspace's
snapshot says about its agents, read from the real tables, and when the sync
sends it, and where: each organization's workspaces to the Switch Trust its
own policy names. The sync runs through the role row-level security applies
to, as in a deployment.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentDefinition,
    ApiKey,
    Client,
    Organization,
    OrganizationTrustSettings,
    ServiceConnection,
    ServiceGrant,
    Tenant,
    Tool,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.trust_inventory_store import (
    InventoryFenceLost,
    TrustInventoryStore,
)
from switch_core.ownership import Fence
from switch_core.process_lease import LEASE_TTL
from switch_core.tenant_context import no_tenant
from switch_core.trust.identity import agent_fingerprint
from switch_core.trust.inventory import (
    MAX_AGENTS,
    MAX_DESCRIPTION_BYTES,
    MAX_PARAMETERS_BYTES,
    REFRESH_EVERY_SECONDS,
    SYNC_INTERVAL_SECONDS,
    SYNC_KEY,
    SYNC_KIND,
    InventorySync,
    InventorySyncError,
    InventoryTarget,
    ServerIdentity,
    build_snapshot,
    over_limits,
    post_snapshot,
    retry_delay,
    target_id,
)
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.ownership import process_lease_on

SERVER = ServerIdentity(id="srv-1", name="switch.example", version="1.2.3")


async def _user(session: AsyncSession, name: str) -> User:
    suffix = uuid.uuid4().hex[:12]
    user = User(name=name, email=f"{suffix}@test.local", role="user")
    session.add(user)
    await session.flush()
    return user


async def _agent(
    session: AsyncSession,
    *,
    name: str,
    owner: User | None,
    description: str = "",
    display_name: str | None = None,
    metadata: dict[str, Any] | None = None,
    addressing_policy: dict[str, Any] | None = None,
) -> Agent:
    suffix = uuid.uuid4().hex[:12]
    key_owner = owner if owner is not None else await _user(session, "keys")
    api_key = ApiKey(
        user_id=key_owner.id,
        key_hash=f"hash-{suffix}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        transport_user_id=f"@{suffix}:test.local", display_name=name, type="agent"
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        display_name=display_name,
        description=description,
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner.id if owner is not None else None,
        metadata_=metadata,
        addressing_policy=addressing_policy,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _managed_agent(session: AsyncSession, owner: User) -> Agent:
    agent = await _agent(
        session,
        name="reviewer",
        display_name="Code Reviewer",
        description="Reviews pull requests",
        owner=owner,
        metadata={"known_agent_type": "claude-code"},
        addressing_policy=owner_only_policy([]).model_dump(mode="json"),
    )
    session.add(
        AgentDefinition(
            agent_id=agent.id,
            owner_id=owner.id,
            revision=1,
            desired_state="running",
            definition={
                "provider": "claude",
                "model": "opus",
                "instructions": "Review every pull request for security issues.",
                "auto_mode": True,
                "auto_approve": False,
                "advanced_config": {"permissionMode": "acceptEdits"},
                "directory": "/work",
                "isolation": "shared",
            },
        )
    )
    session.add(
        Tool(
            agent_id=agent.id,
            name="lint",
            description="Runs the linter",
            args_schema=LINT_SCHEMA,
        )
    )
    session.add(
        ServiceConnection(
            user_id=owner.id,
            service="github",
            status="active",
            consent="write",
            granted_scopes=[],
            account_id="1001",
            external_identity="ada",
            encrypted_secret=TEST_KEYRING.encrypt("service-secret"),
            secret_revision=1,
        )
    )
    await session.flush()
    session.add(
        ServiceGrant(
            agent_id=agent.id,
            owner_id=owner.id,
            service="github",
            access="read",
            tool_mode="allow",
            tools=[],
            resources={},
            account_id="1001",
            created_by=owner.id,
        )
    )
    await session.flush()
    return agent


LINT_SCHEMA = {
    "type": "object",
    "properties": {"path": {"type": "string"}},
    "required": ["path"],
}


def _by_name(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["name"]: a for a in snapshot["agents"]}


class TestBuildSnapshot:
    async def test_describes_a_managed_and_a_registered_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            owner = await _user(session, "Ada Lovelace")
            managed = await _managed_agent(session, owner)
            registered = await _agent(session, name="helper", owner=None)
            await session.commit()

            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        assert snapshot["server"] == {
            "id": "srv-1",
            "name": "switch.example",
            "version": "1.2.3",
        }
        assert snapshot["tenant"] == {"id": TENANT_ZERO_ID, "name": "Default"}
        agents = _by_name(snapshot)
        assert set(agents) == {"reviewer", "helper"}

        reviewer = agents["reviewer"]
        assert reviewer["id"] == managed.id
        assert reviewer["display_name"] == "Code Reviewer"
        assert reviewer["description"] == "Reviews pull requests"
        assert reviewer["kind"] == "managed"
        assert reviewer["runtime"] == "claude-code"
        assert reviewer["model"] == "opus"
        assert reviewer["auto_mode"] is True
        assert reviewer["auto_approve"] is False
        assert reviewer["permission_mode"] == "acceptEdits"
        assert reviewer["addressing"] == "owner_only"
        assert reviewer["owner"] == "Ada Lovelace"
        assert "instructions" not in reviewer
        tool_names = [t["name"] for t in reviewer["tools"]]
        # The provider's own tools, then the ones the agent declared.
        assert "Bash" in tool_names
        assert tool_names[-1] == "lint"
        assert len(tool_names) == len(set(tool_names))
        # A declared schema is sent, so the tool matches the same tool in
        # checked traffic; a built-in declared by name only has none.
        assert reviewer["tools"][-1]["parameters"] == LINT_SCHEMA
        assert "parameters" not in reviewer["tools"][0]
        assert reviewer["mcp_servers"] == [{"name": "github", "access": "read"}]

        helper = agents["helper"]
        assert helper["id"] == registered.id
        assert helper["kind"] == "registered"
        assert helper["addressing"] == "anyone"
        for absent in (
            "model",
            "auto_mode",
            "auto_approve",
            "instructions",
            "owner",
            "tools",
            "mcp_servers",
            "runtime",
        ):
            assert absent not in helper

    async def test_instructions_are_sent_only_when_sharing_is_on(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            owner = await _user(session, "Ada Lovelace")
            await _managed_agent(session, owner)
            await session.commit()

            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=True,
            )

        assert _by_name(snapshot)["reviewer"]["instructions"] == (
            "Review every pull request for security issues."
        )

    async def test_lists_only_the_bound_tenants_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            session.add(Tenant(id="ten-other", slug="ten-other", name="Other"))
            await session.commit()
        async with tenant_session(session_factory, "ten-other") as session:
            await _agent(session, name="elsewhere", owner=None)
            await session.commit()
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="here", owner=None)
            await session.commit()
            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        assert set(_by_name(snapshot)) == {"here"}

    async def test_names_an_agent_as_its_checks_do(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="padded", owner=None, display_name="  Bot  ")
            await _agent(session, name="blank", owner=None, display_name="   ")
            await session.commit()
            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        agents = _by_name(snapshot)
        assert agents["padded"]["display_name"] == "Bot"
        assert "display_name" not in agents["blank"]

    async def test_a_definition_without_a_provider_still_lists_its_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            owner = await _user(session, "Ada")
            agent = await _agent(session, name="old", owner=owner)
            session.add(
                AgentDefinition(
                    agent_id=agent.id,
                    owner_id=owner.id,
                    revision=1,
                    desired_state="running",
                    definition={"model": "opus"},
                )
            )
            await session.commit()
            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        old = _by_name(snapshot)["old"]
        assert old["kind"] == "managed"
        assert old["model"] == "opus"
        assert "tools" not in old

    async def test_an_oversized_tool_schema_is_sent_by_name_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        huge = {"type": "object", "description": "x" * MAX_PARAMETERS_BYTES}
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            agent = await _agent(session, name="bulky", owner=None)
            session.add(
                Tool(
                    agent_id=agent.id,
                    name="dump",
                    description="Dumps everything",
                    args_schema=huge,
                )
            )
            await session.commit()
            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        assert _by_name(snapshot)["bulky"]["tools"] == [
            {"name": "dump", "description": "Dumps everything"}
        ]

    async def test_a_long_description_is_cut_to_fit(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="wordy", owner=None, description="é" * 5000)
            await session.commit()
            snapshot = await build_snapshot(
                session,
                server=SERVER,
                tenant_id=TENANT_ZERO_ID,
                share_instructions=False,
            )

        description = _by_name(snapshot)["wordy"]["description"]
        assert len(description.encode()) <= MAX_DESCRIPTION_BYTES
        assert description == "é" * (MAX_DESCRIPTION_BYTES // 2)


def test_over_limits_names_what_would_be_refused() -> None:
    agent = {"id": "a1", "name": "a1", "kind": "registered"}
    assert over_limits({"agents": [agent]}) is None
    assert "agents" in (over_limits({"agents": [agent] * (MAX_AGENTS + 1)}) or "")
    many_tools = {**agent, "tools": [{"name": f"t{i}"} for i in range(201)]}
    assert "tools" in (over_limits({"agents": [many_tools]}) or "")


def _answer(snapshot: dict[str, Any]) -> dict[str, Any]:
    """What Switch Trust answers a snapshot with."""
    server, tenant = snapshot["server"]["id"], snapshot["tenant"]["id"]
    return {
        "slot_id": "slot",
        "session_id": "session",
        "agents": [
            {"id": a["id"], "fingerprint": agent_fingerprint(server, tenant, a["id"])}
            for a in snapshot["agents"]
        ],
    }


_TARGET = InventoryTarget(endpoint="https://trust.example", api_key="sk_test")
_SNAPSHOT = {
    "server": {"id": "srv-1", "name": "switch.example"},
    "tenant": {"id": "ten-1"},
    "agents": [{"id": "a1", "name": "a1", "kind": "registered"}],
}


class TestPostSnapshot:
    async def test_posts_under_the_api_key(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=_answer(_SNAPSHOT))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await post_snapshot(client, target=_TARGET, snapshot=_SNAPSHOT)

        assert seen["url"] == (
            "https://trust.example/integrations/switch-rooms/agents/sync"
        )
        assert seen["auth"] == "ApiKey sk_test"
        assert seen["body"] == _SNAPSHOT

    async def test_a_refusal_is_an_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"error": "agents[0].name: required"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(InventorySyncError, match="400"):
                await post_snapshot(client, target=_TARGET, snapshot=_SNAPSHOT)

    async def test_a_fingerprint_checks_would_not_carry_is_an_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"agents": [{"id": "a1", "fingerprint": "agn_other"}]}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(InventorySyncError, match="agn_other"):
                await post_snapshot(client, target=_TARGET, snapshot=_SNAPSHOT)


class _Recorder:
    def __init__(self) -> None:
        self.snapshots: list[dict[str, Any]] = []
        self.keys: dict[str, str | None] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        snapshot = json.loads(request.content)
        self.snapshots.append(snapshot)
        self.keys[snapshot["tenant"]["id"]] = request.headers.get("authorization")
        return httpx.Response(200, json=_answer(snapshot))


@pytest.fixture
async def harness(
    session_factory: async_sessionmaker[AsyncSession], rls_harness: RLSHarness
) -> RLSHarness:
    """Both ways into the database, emptied once: fixtures are written as
    the owner, and the sync reads and writes through the restricted role."""
    return rls_harness


async def _connect(
    harness: RLSHarness,
    *,
    organization_id: str = TENANT_ZERO_ID,
    endpoint: str = "https://trust.example",
    api_key: str = "sk_test",
) -> None:
    async with harness.owner() as session:
        await session.merge(
            OrganizationTrustSettings(
                organization_id=organization_id,
                endpoint=endpoint,
                policy_id="pol_1",
                api_key_encrypted=TEST_KEYRING.encrypt(api_key),
            )
        )
        await session.commit()


async def _share(harness: RLSHarness, organization_id: str, share: bool) -> None:
    async with harness.owner() as session:
        await OrganizationTrustSettingsStore().set_share_agent_instructions(
            session, organization_id, share
        )
        await session.commit()


async def _disconnect(harness: RLSHarness, organization_id: str) -> None:
    async with harness.owner() as session:
        await OrganizationTrustSettingsStore().clear(session, organization_id)
        await session.commit()


async def _add_organization(harness: RLSHarness, organization_id: str) -> None:
    async with harness.owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="Org"))
        await session.commit()


async def _add_tenant(
    harness: RLSHarness, tenant_id: str, organization_id: str = TENANT_ZERO_ID
) -> None:
    async with harness.owner() as session:
        session.add(
            Tenant(
                id=tenant_id,
                slug=tenant_id,
                name=tenant_id,
                organization_id=organization_id,
            )
        )
        await session.commit()


async def _delete_tenant(harness: RLSHarness, tenant_id: str) -> None:
    async with harness.owner() as session:
        await session.delete(await session.get_one(Tenant, tenant_id))
        await session.commit()


def _sync(
    harness: RLSHarness, handler: Callable[[httpx.Request], httpx.Response]
) -> InventorySync:
    return InventorySync(
        session_factory=harness.restricted,
        store=OrganizationTrustSettingsStore(),
        keyring=TEST_KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        server=SERVER,
    )


@pytest.fixture
async def fence(harness: RLSHarness) -> Fence:
    """The sync's lease, held by a test process as `own_inventory_sync`'s
    process would hold it."""
    lease = process_lease_on(harness.restricted)
    with no_tenant():
        await lease.renew()
        async with harness.restricted() as session:
            claimed = await OwnershipLeaseStore().claim(
                session,
                kind=SYNC_KIND,
                keys=[SYNC_KEY],
                process_id=lease.process_id,
                lease_ttl=LEASE_TTL,
            )
            await session.commit()
    return Fence(
        kind=SYNC_KIND,
        key=SYNC_KEY,
        process_id=lease.process_id,
        token=claimed[SYNC_KEY],
    )


def _held() -> bool:
    return True


async def _pass(sync: InventorySync, fence: Fence) -> None:
    with no_tenant():
        await sync.sync_once(fence, _held)


async def _targets(harness: RLSHarness) -> list[str]:
    async with harness.owner() as session:
        return sorted(t.endpoint for t in await TrustInventoryStore().targets(session))


def _empty(tenant_id: str) -> dict[str, Any]:
    return {
        "server": {"id": "srv-1", "name": "switch.example", "version": "1.2.3"},
        "tenant": {"id": tenant_id},
        "agents": [],
    }


class TestInventorySync:
    async def test_an_organization_with_no_policy_sends_nothing(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        recorder = _Recorder()

        await _pass(_sync(harness, recorder), fence)

        assert recorder.snapshots == []

    async def test_sends_each_workspace_once_until_something_changes(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        harness: RLSHarness,
        fence: Fence,
    ) -> None:
        await _connect(harness)
        await _add_tenant(harness, "ten-other")
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="first", owner=None)
            await session.commit()
        recorder = _Recorder()

        await _pass(_sync(harness, recorder), fence)
        assert sorted(s["tenant"]["id"] for s in recorder.snapshots) == sorted(
            [TENANT_ZERO_ID, "ten-other"]
        )

        # What was sent is stored: a restarted process sends nothing again.
        recorder.snapshots.clear()
        await _pass(_sync(harness, recorder), fence)
        assert recorder.snapshots == []

        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="second", owner=None)
            await session.commit()
        await _pass(_sync(harness, recorder), fence)
        [changed] = recorder.snapshots
        assert changed["tenant"]["id"] == TENANT_ZERO_ID
        assert {a["name"] for a in changed["agents"]} == {"first", "second"}

    async def test_each_organizations_workspaces_go_to_its_own_switch_trust(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _add_organization(harness, "org-acme")
        await _add_tenant(harness, "ten-acme", "org-acme")
        await _add_organization(harness, "org-none")
        await _add_tenant(harness, "ten-none", "org-none")
        await _connect(harness)
        await _connect(harness, organization_id="org-acme", api_key="sk_acme")
        recorder = _Recorder()

        await _pass(_sync(harness, recorder), fence)

        assert recorder.keys == {
            TENANT_ZERO_ID: "ApiKey sk_test",
            "ten-acme": "ApiKey sk_acme",
        }

    async def test_two_organizations_under_one_key_share_its_target(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _add_organization(harness, "org-acme")
        await _add_tenant(harness, "ten-acme", "org-acme")
        await _connect(harness)
        await _connect(harness, organization_id="org-acme")
        recorder = _Recorder()
        sync = _sync(harness, recorder)
        await _pass(sync, fence)

        # One of them leaving takes only its own workspaces out.
        await _disconnect(harness, "org-acme")
        recorder.snapshots.clear()
        await _pass(sync, fence)

        assert recorder.snapshots == [_empty("ten-acme")]
        assert await _targets(harness) == ["https://trust.example"]

    async def test_sharing_is_each_organizations_own(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        harness: RLSHarness,
        fence: Fence,
    ) -> None:
        await _add_organization(harness, "org-acme")
        await _add_tenant(harness, "ten-acme", "org-acme")
        await _connect(harness)
        await _connect(harness, organization_id="org-acme", api_key="sk_acme")
        for tenant_id in (TENANT_ZERO_ID, "ten-acme"):
            async with tenant_session(session_factory, tenant_id) as session:
                await _managed_agent(session, await _user(session, "Ada"))
                await session.commit()
        recorder = _Recorder()
        sync = _sync(harness, recorder)
        await _pass(sync, fence)
        assert all(
            "instructions" not in _by_name(s)["reviewer"] for s in recorder.snapshots
        )

        await _share(harness, "org-acme", True)
        recorder.snapshots.clear()
        await _pass(sync, fence)

        [resent] = recorder.snapshots
        assert resent["tenant"]["id"] == "ten-acme"
        assert "instructions" in _by_name(resent)["reviewer"]

    async def test_a_workspace_deleted_across_a_restart_is_sent_once_with_no_agents(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _connect(harness)
        await _add_tenant(harness, "ten-gone")
        recorder = _Recorder()
        await _pass(_sync(harness, recorder), fence)

        await _delete_tenant(harness, "ten-gone")
        recorder.snapshots.clear()
        await _pass(_sync(harness, recorder), fence)
        await _pass(_sync(harness, recorder), fence)

        assert recorder.snapshots == [_empty("ten-gone")]

    async def test_a_refused_snapshot_is_held_off_until_it_changes(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        harness: RLSHarness,
        fence: Fence,
    ) -> None:
        await _connect(harness)
        posted: list[dict[str, Any]] = []

        def refuse(request: httpx.Request) -> httpx.Response:
            posted.append(json.loads(request.content))
            return httpx.Response(400, json={"error": "agents[0].name: required"})

        sync = _sync(harness, refuse)
        await _pass(sync, fence)
        assert len(posted) == 1
        await _pass(sync, fence)
        assert len(posted) == 1

        async with harness.owner() as session:
            [row] = (
                await TrustInventoryStore().sent(
                    session, target_id("https://trust.example", "sk_test")
                )
            ).values()
        assert row.failures == 1
        assert row.digest is None

        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="new", owner=None)
            await session.commit()
        await _pass(sync, fence)
        assert len(posted) == 2

    async def test_one_workspaces_failure_does_not_stop_the_others(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _connect(harness)
        await _add_tenant(harness, "ten-other")
        sent: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            snapshot = json.loads(request.content)
            if snapshot["tenant"]["id"] == TENANT_ZERO_ID:
                return httpx.Response(502, json={"error": "ingestion failed"})
            sent.append(snapshot["tenant"]["id"])
            return httpx.Response(200, json=_answer(snapshot))

        await _pass(_sync(harness, handler), fence)

        assert sent == ["ten-other"]

    async def test_disconnecting_empties_the_switch_trust_it_named(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _connect(harness)
        await _add_tenant(harness, "ten-other")
        recorder = _Recorder()
        sync = _sync(harness, recorder)
        await _pass(sync, fence)

        await _disconnect(harness, TENANT_ZERO_ID)
        recorder.snapshots.clear()
        recorder.keys.clear()
        await _pass(sync, fence)

        assert sorted(recorder.snapshots, key=lambda s: s["tenant"]["id"]) == [
            _empty(t) for t in sorted([TENANT_ZERO_ID, "ten-other"])
        ]
        assert set(recorder.keys.values()) == {"ApiKey sk_test"}
        assert await _targets(harness) == []

        recorder.snapshots.clear()
        await _pass(sync, fence)
        assert recorder.snapshots == []

    async def test_a_new_key_gets_everything_and_the_old_one_is_emptied(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        harness: RLSHarness,
        fence: Fence,
    ) -> None:
        await _connect(harness)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await _agent(session, name="kept", owner=None)
            await session.commit()
        seen: list[tuple[str, dict[str, Any]]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            snapshot = json.loads(request.content)
            seen.append((request.url.host, snapshot))
            return httpx.Response(200, json=_answer(snapshot))

        sync = _sync(harness, handler)
        await _pass(sync, fence)
        await _connect(
            harness, endpoint="https://other-trust.example", api_key="sk_other"
        )
        seen.clear()
        await _pass(sync, fence)

        by_host = dict(seen)
        assert by_host["trust.example"] == _empty(TENANT_ZERO_ID)
        assert {a["name"] for a in by_host["other-trust.example"]["agents"]} == {"kept"}

    async def test_nothing_is_withdrawn_while_a_key_cannot_be_read(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _add_organization(harness, "org-acme")
        await _add_tenant(harness, "ten-acme", "org-acme")
        await _connect(harness)
        await _connect(harness, organization_id="org-acme", api_key="sk_acme")
        recorder = _Recorder()
        sync = _sync(harness, recorder)
        await _pass(sync, fence)

        async with harness.owner() as session:
            settings = await session.get_one(OrganizationTrustSettings, "org-acme")
            settings.api_key_encrypted = "not-under-any-key"
            await session.commit()
        recorder.snapshots.clear()
        await _pass(sync, fence)

        # Its workspace reads as gone, but it has not left.
        assert recorder.snapshots == []
        assert await _targets(harness) == [
            "https://trust.example",
            "https://trust.example",
        ]

    async def test_a_process_that_lost_the_sync_sends_nothing(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _connect(harness)
        recorder = _Recorder()

        with no_tenant(), pytest.raises(InventoryFenceLost):
            await _sync(harness, recorder).sync_once(fence, lambda: False)

        assert recorder.snapshots == []

    async def test_a_stale_fence_writes_nothing(
        self, harness: RLSHarness, fence: Fence
    ) -> None:
        await _connect(harness)
        stale = Fence(
            kind=fence.kind,
            key=fence.key,
            process_id=fence.process_id,
            token=fence.token - 1,
        )

        with pytest.raises(InventoryFenceLost):
            await _pass(_sync(harness, _Recorder()), stale)

        assert await _targets(harness) == []


def test_a_refused_snapshot_waits_longer_each_time_up_to_the_refresh() -> None:
    assert retry_delay(1) == timedelta(seconds=SYNC_INTERVAL_SECONDS)
    assert retry_delay(2) == timedelta(seconds=2 * SYNC_INTERVAL_SECONDS)
    assert retry_delay(100) == timedelta(seconds=REFRESH_EVERY_SECONDS)
