"""The agent inventory Switch sends Switch Trust: what one tenant's snapshot
says about its agents, read from the real tables, and when the sync sends it.
"""

from __future__ import annotations

import json
import uuid
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
    ServiceConnection,
    ServiceGrant,
    Tenant,
    Tool,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.tenant_context import no_tenant
from switch_core.trust.identity import agent_fingerprint
from switch_core.trust.inventory import (
    MAX_AGENTS,
    MAX_DESCRIPTION_BYTES,
    InventorySync,
    InventorySyncError,
    InventoryTarget,
    ServerIdentity,
    build_snapshot,
    over_limits,
    post_snapshot,
)
from tests.conftest import TEST_KEYRING

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
    session.add(Tool(agent_id=agent.id, name="lint", description="Runs the linter"))
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


_TARGET = InventoryTarget(
    endpoint="https://trust.example", api_key="sk_test", share_instructions=False
)
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

    def __call__(self, request: httpx.Request) -> httpx.Response:
        snapshot = json.loads(request.content)
        self.snapshots.append(snapshot)
        return httpx.Response(200, json=_answer(snapshot))


async def _configure(
    session_factory: async_sessionmaker[AsyncSession], *, with_key: bool
) -> None:
    async with session_factory() as session:
        await TrustSettingsStore().upsert(
            session,
            endpoint="https://trust.example",
            policy_id=None,
            api_key_encrypted=TEST_KEYRING.encrypt("sk_test") if with_key else None,
            share_agent_instructions=None,
        )
        await session.commit()


def _sync(
    session_factory: async_sessionmaker[AsyncSession], recorder: _Recorder
) -> InventorySync:
    return InventorySync(
        session_factory=session_factory,
        store=TrustSettingsStore(),
        keyring=TEST_KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
        server=SERVER,
    )


class TestInventorySync:
    async def test_sends_nothing_without_an_api_key(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _configure(session_factory, with_key=False)
        recorder = _Recorder()

        with no_tenant():
            await _sync(session_factory, recorder).sync_once()

        assert recorder.snapshots == []

    async def test_sends_each_tenant_once_until_something_changes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _configure(session_factory, with_key=True)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            session.add(Tenant(id="ten-other", slug="ten-other", name="Other"))
            await _agent(session, name="first", owner=None)
            await session.commit()
        recorder = _Recorder()
        sync = _sync(session_factory, recorder)

        with no_tenant():
            await sync.sync_once()
            assert sorted(s["tenant"]["id"] for s in recorder.snapshots) == sorted(
                [TENANT_ZERO_ID, "ten-other"]
            )

            recorder.snapshots.clear()
            await sync.sync_once()
            assert recorder.snapshots == []

            async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
                await _agent(session, name="second", owner=None)
                await session.commit()
            await sync.sync_once()
            [changed] = recorder.snapshots
            assert changed["tenant"]["id"] == TENANT_ZERO_ID
            assert {a["name"] for a in changed["agents"]} == {"first", "second"}

            recorder.snapshots.clear()
            sync.forget()
            await sync.sync_once()
            assert len(recorder.snapshots) == 2

    async def test_a_tenant_that_is_gone_is_sent_once_with_no_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _configure(session_factory, with_key=True)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            session.add(Tenant(id="ten-gone", slug="ten-gone", name="Gone"))
            await session.commit()
        recorder = _Recorder()
        sync = _sync(session_factory, recorder)

        with no_tenant():
            await sync.sync_once()
            async with tenant_session(session_factory, "ten-gone") as session:
                await session.delete(await session.get_one(Tenant, "ten-gone"))
                await session.commit()
            recorder.snapshots.clear()
            await sync.sync_once()
            await sync.sync_once()

        assert recorder.snapshots == [
            {
                "server": {
                    "id": "srv-1",
                    "name": "switch.example",
                    "version": "1.2.3",
                },
                "tenant": {"id": "ten-gone"},
                "agents": [],
            }
        ]

    async def test_one_tenants_failure_does_not_stop_the_others(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _configure(session_factory, with_key=True)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            session.add(Tenant(id="ten-other", slug="ten-other", name="Other"))
            await session.commit()
        sent: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            snapshot = json.loads(request.content)
            if snapshot["tenant"]["id"] == TENANT_ZERO_ID:
                return httpx.Response(502, json={"error": "ingestion failed"})
            sent.append(snapshot["tenant"]["id"])
            return httpx.Response(200, json=_answer(snapshot))

        sync = InventorySync(
            session_factory=session_factory,
            store=TrustSettingsStore(),
            keyring=TEST_KEYRING,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            server=SERVER,
        )
        with no_tenant():
            await sync.sync_once()

        assert sent == ["ten-other"]
