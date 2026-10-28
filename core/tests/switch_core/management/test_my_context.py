"""`get_my_context`: what an agent learns about the person it works for, and
how their Switch is set up; and `set_agent_service` / `remove_agent_service`,
an agent giving its owner's other agents services or taking them away. Through the real bearer middleware and operations
door, against Postgres; the bridges and the messaging apps the server offers
are stand-ins.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    MessagingInstall,
    ServiceGrant,
    TenantMember,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.feature_flags import KNOWN_FEATURE_FLAGS, SWITCH_CLOUD
from tests.switch_core.connections.github_seed import (
    INSTALLATION_ID,
    REPOSITORY_ID,
    connect_github,
)
from tests.switch_core.management.harness import (
    TEST_KEYRING,
    Harness,
    add_member,
    bearer,
    build_harness,
)


class _Lifecycle:
    def get_registered_types(self) -> list[str]:
        return ["discord", "slack"]


class _Installer:
    installs_by_claim = False


class _Installs:
    """This server offers the Switch app for Slack, and nothing else."""

    def platforms(self) -> list[str]:
        return ["slack"]

    def installer(self, _platform: str) -> _Installer:
        return _Installer()


def _config(
    *, cloud: bool = False, managed_by_console: bool = False
) -> SimpleNamespace:
    return SimpleNamespace(
        keyring=TEST_KEYRING,
        third_party_avatars_enabled=True,
        feature_flags={
            key: key == SWITCH_CLOUD and cloud for key in KNOWN_FEATURE_FLAGS
        },
        managed_by_console=managed_by_console,
    )


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Harness]:
    harness = build_harness(session_factory)
    protocol = harness.protocol
    protocol.config = _config()  # type: ignore[assignment]
    protocol.collab_lifecycle = _Lifecycle()  # type: ignore[assignment]
    protocol.bridge_store = CollaborationBridgeStore()
    protocol.external_user_store = ExternalUserStore()
    protocol.install_service = _Installs()  # type: ignore[assignment]
    previous = op_context._protocol
    op_context.init_operations_protocol(protocol)
    try:
        yield harness
    finally:
        op_context._protocol = previous


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    async with harness.client() as client:
        yield client


async def _agent(
    session: AsyncSession,
    owner: User,
    name: str,
    *,
    can_manage_agents: bool = False,
    addressing: str = "owner_only",
    known_agent_type: str | None = "claude-code",
) -> tuple[Agent, str]:
    key = secrets.token_urlsafe(32)
    client = Client(type="agent", transport_user_id=f"@{name}:test", display_name=name)
    api_key = ApiKey(
        type="agent",
        key_hash=hashlib.sha256(key.encode()).hexdigest(),
        encrypted_key="",
        label=name,
        user_id=owner.id,
    )
    session.add_all([client, api_key])
    await session.flush()
    agent = Agent(
        name=name,
        description=name,
        agent_type="auto_session",
        connector_type="claude_code",
        integration_profile={"connection_model": "auto_session"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner.id,
        can_manage_agents=can_manage_agents,
        addressing_policy=addressing_policy_for(addressing),
        metadata_={"known_agent_type": known_agent_type} if known_agent_type else {},
    )
    session.add(agent)
    await session.flush()
    return agent, key


async def _context(
    client: httpx.AsyncClient, agent_id: str, key: str
) -> dict[str, Any]:
    response = await client.post(
        f"/agents/{agent_id}/ops/get_my_context", json={}, headers=bearer(key)
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


async def _setup(harness: Harness) -> tuple[str, str, str]:
    """Ada, a member, with her buddy and a reviewer; a Slack workspace added
    with the Switch app, her account on it linked; a Discord server someone
    pasted tokens for. Returns the buddy's id and key, and Ada's id."""
    ada = await add_member(harness.session_factory, "ada")
    async with harness.session_factory() as session:
        buddy, key = await _agent(
            session, ada, "switch-buddy-ada", can_manage_agents=True
        )
        await _agent(session, ada, "reviewer", addressing="anyone")
        bridge_clients = [
            Client(
                type="bridge",
                transport_user_id=f"@{name}-bridge:test",
                display_name=name,
            )
            for name in ("slack", "discord")
        ]
        session.add_all(bridge_clients)
        await session.flush()
        slack = CollaborationBridge(
            type="slack",
            display_name="Acme Slack",
            status="active",
            is_default=True,
            client_id=bridge_clients[0].id,
        )
        discord = CollaborationBridge(
            type="discord",
            display_name="Acme Discord",
            status="active",
            client_id=bridge_clients[1].id,
        )
        session.add_all([slack, discord])
        await session.flush()
        session.add(
            MessagingInstall(
                platform="slack",
                external_workspace_id="T1",
                scopes="chat:write",
                status="active",
                installed_by_user_id=ada.id,
                bridge_id=slack.id,
            )
        )
        account = Client(
            type="external_user",
            transport_user_id="@slack-ada:test",
            display_name="ada",
        )
        session.add(account)
        await session.flush()
        identity = ExternalUser(
            bridge_id=slack.id,
            external_user_id="U1",
            external_username="ada",
            client_id=account.id,
        )
        session.add(identity)
        await session.flush()
        await ExternalUserStore().claim(session, identity, ada.id)
        await session.commit()
        return buddy.id, key, ada.id


async def test_it_says_who_it_works_for_and_where(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    buddy_id, key, _ = await _setup(harness)

    context = await _context(client, buddy_id, key)

    assert context["you"] == {"name": "switch-buddy-ada", "can_manage_agents": True}
    assert context["person"] == {
        "name": "ada",
        "email": "ada@example.invalid",
        "workspace_role": "member",
        "workspace_admin": False,
        "runs_server": False,
    }
    assert context["workspace"]["id"] == TENANT_ZERO_ID
    assert context["workspace"]["members"] == 1
    assert context["server"]["kind"] == "self_hosted"


async def test_it_says_how_messaging_apps_are_and_would_be_set_up(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    buddy_id, key, _ = await _setup(harness)

    apps = (await _context(client, buddy_id, key))["messaging_apps"]
    async with harness.session_factory() as session:
        bridge_ids = {
            bridge.type: bridge.id
            for bridge in await session.scalars(select(CollaborationBridge))
        }

    assert sorted(apps["connected"], key=lambda app: app["platform"]) == [
        {
            "id": bridge_ids["discord"],
            "platform": "discord",
            "name": "Acme Discord",
            "status": "active",
            "is_default": False,
            "installed_with": "own_app",
            "your_account_linked": False,
            "your_usernames": [],
        },
        {
            "id": bridge_ids["slack"],
            "platform": "slack",
            "name": "Acme Slack",
            "status": "active",
            "is_default": True,
            "installed_with": "official_app",
            "your_account_linked": True,
            "your_usernames": ["ada"],
        },
    ]
    assert [
        (entry["platform"], entry["path"], entry["who"]) for entry in apps["how_to_add"]
    ] == [
        ("discord", "own_app", "admins"),
        ("slack", "official_app", "admins"),
    ]


async def test_it_lists_only_the_persons_own_agents(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    buddy_id, key, _ = await _setup(harness)
    someone = await add_member(harness.session_factory, "bob")
    async with harness.session_factory() as session:
        await _agent(session, someone, "bobs-agent")
        await session.commit()

    agents = (await _context(client, buddy_id, key))["agents"]

    assert {agent["name"]: agent["who_can_talk"] for agent in agents} == {
        "switch-buddy-ada": "owner_only",
        "reviewer": "anyone",
    }


async def test_an_admin_is_told_so(harness: Harness, client: httpx.AsyncClient) -> None:
    buddy_id, key, ada_id = await _setup(harness)
    async with harness.session_factory() as session:
        membership = await session.get(TenantMember, (TENANT_ZERO_ID, ada_id))
        assert membership is not None
        membership.role = "owner"
        await session.commit()

    person = (await _context(client, buddy_id, key))["person"]

    assert person["workspace_role"] == "owner"
    assert person["workspace_admin"] is True


@pytest.mark.parametrize(
    ("config", "kind"),
    [
        (_config(cloud=True), "switch_cloud"),
        (_config(managed_by_console=True), "managed_by_console"),
    ],
)
async def test_it_tells_the_kind_of_server_apart(
    harness: Harness, client: httpx.AsyncClient, config: SimpleNamespace, kind: str
) -> None:
    buddy_id, key, _ = await _setup(harness)
    harness.protocol.config = config  # type: ignore[assignment]

    assert (await _context(client, buddy_id, key))["server"]["kind"] == kind


GITHUB_REACH = {"installation_id": INSTALLATION_ID, "repository_ids": [REPOSITORY_ID]}


async def _op(
    client: httpx.AsyncClient, agent_id: str, key: str, name: str, body: dict[str, Any]
) -> httpx.Response:
    return await client.post(
        f"/agents/{agent_id}/ops/{name}", json=body, headers=bearer(key)
    )


async def _grants(harness: Harness, agent_name: str) -> list[tuple[str, str]]:
    async with harness.session_factory() as session:
        agent = (
            await session.execute(select(Agent).where(Agent.name == agent_name))
        ).scalar_one()
        rows = await session.scalars(
            select(ServiceGrant).where(ServiceGrant.agent_id == agent.id)
        )
        return [(grant.service, grant.access) for grant in rows]


class TestGivingAgentsServices:
    async def test_gives_and_takes_away_an_agents_github(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        buddy_id, key, ada_id = await _setup(harness)
        async with harness.session_factory() as session:
            await connect_github(session, ada_id, TEST_KEYRING)
            await session.commit()

        given = await _op(
            client,
            buddy_id,
            key,
            "set_agent_service",
            {
                "agent_name": "reviewer",
                "service": "github",
                "access": "write",
                "resources": GITHUB_REACH,
            },
        )

        assert given.status_code == 200, given.text
        assert given.json()["result"]["summary"]
        assert await _grants(harness, "reviewer") == [("github", "write")]
        context = await _context(client, buddy_id, key)
        github = next(
            entry for entry in context["services"] if entry["slug"] == "github"
        )
        assert github["connection"] == "active"
        assert github["agents_using"] == ["reviewer"]
        assert (github["unavailable_reason"], github["unavailable_code"]) == (
            None,
            None,
        )
        datadog = next(
            entry for entry in context["services"] if entry["slug"] == "datadog"
        )
        assert datadog["unavailable_code"] == "key_never_expires"
        assert datadog["available"] is False

        taken = await _op(
            client,
            buddy_id,
            key,
            "remove_agent_service",
            {"agent_name": "reviewer", "service": "github"},
        )

        assert taken.status_code == 200, taken.text
        assert await _grants(harness, "reviewer") == []

    async def test_needs_the_capability(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        buddy_id, key, _ = await _setup(harness)
        async with harness.session_factory() as session:
            await session.execute(
                update(Agent)
                .where(Agent.id == buddy_id)
                .values(can_manage_agents=False)
            )
            await session.commit()

        refused = await _op(
            client,
            buddy_id,
            key,
            "set_agent_service",
            {"agent_name": "reviewer", "service": "github"},
        )

        assert refused.status_code == 403, refused.text
        assert "can manage agents" in refused.text

    async def test_reaches_only_the_owners_agents(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        buddy_id, key, _ = await _setup(harness)
        bob = await add_member(harness.session_factory, "bob")
        async with harness.session_factory() as session:
            await _agent(session, bob, "bobs-agent")
            await session.commit()

        refused = await _op(
            client,
            buddy_id,
            key,
            "set_agent_service",
            {"agent_name": "bobs-agent", "service": "github"},
        )

        assert refused.status_code >= 400
        assert "no agent named" in refused.text
        assert await _grants(harness, "bobs-agent") == []

    async def test_an_agent_cannot_give_itself_a_service(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        buddy_id, key, ada_id = await _setup(harness)
        async with harness.session_factory() as session:
            await connect_github(session, ada_id, TEST_KEYRING)
            await session.commit()

        refused = await _op(
            client,
            buddy_id,
            key,
            "set_agent_service",
            {"agent_name": "switch-buddy-ada", "service": "github"},
        )

        assert refused.status_code == 403, refused.text
        assert "can't change its own settings" in refused.text
        assert await _grants(harness, "switch-buddy-ada") == []

    async def test_says_what_is_missing_before_a_service_is_connected(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        buddy_id, key, _ = await _setup(harness)

        refused = await _op(
            client,
            buddy_id,
            key,
            "set_agent_service",
            {"agent_name": "reviewer", "service": "github", "resources": GITHUB_REACH},
        )

        assert refused.status_code >= 400
        assert "Connect GitHub" in refused.text
