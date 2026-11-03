from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.addressing import owner_and_owner_agents_policy
from switch_core.agent_invites import AgentInviteDenied, AgentInvitePolicy, AgentInviter
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import SenderPrincipal


def target(**kw):
    return Agent(
        id="target",
        name="worker",
        owner_id="owner",
        addressing_policy=kw.get(
            "policy", owner_and_owner_agents_policy().model_dump()
        ),
    )


def checker(agents):
    policy = AgentInvitePolicy(AgentStore(), RoomStore())
    session = SimpleNamespace(
        scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: agents))
    )
    policy._addressing.claimed_accounts = AsyncMock(return_value=[])
    return policy, session


@pytest.mark.parametrize(
    "user,allowed", [("owner", True), ("stranger", False), ("admin", False)]
)
async def test_gateway_users_are_checked_as_themselves(user, allowed):
    policy, session = checker([target()])
    call = policy.require(
        session,
        agent_ids=["target"],
        room_id="room",
        group_id=None,
        inviter=AgentInviter(kind="user", subject=user),
    )
    if allowed:
        assert await call == []
    else:
        with pytest.raises(AgentInviteDenied, match="Ask its owner"):
            await call


@pytest.mark.parametrize(
    "owner,allowed", [("owner", True), ("other", False), (None, False)]
)
async def test_agent_invites_use_the_inviting_agent_not_its_owner_as_a_user(
    owner, allowed
):
    policy, session = checker([target()])
    policy._agents.get = AsyncMock(
        return_value=SimpleNamespace(id="manager", owner_id=owner)
    )
    call = policy.require(
        session,
        agent_ids=["target"],
        room_id="room",
        group_id=None,
        inviter=AgentInviter(kind="agent", subject="manager"),
    )
    if allowed:
        await call
    else:
        with pytest.raises(AgentInviteDenied):
            await call


async def test_unreported_platform_inviter_is_returned_for_warning_but_unresolvable_reported_inviter_is_denied():
    policy, session = checker([target()])
    args = dict(agent_ids=["target"], room_id="room", group_id=None)
    assert (
        len(
            await policy.require(
                session,
                **args,
                inviter=AgentInviter(kind="platform", subject=None, bridge_id="bridge"),
            )
        )
        == 1
    )
    policy._external.get_by_external_id = AsyncMock(return_value=None)
    with pytest.raises(AgentInviteDenied):
        await policy.require(
            session,
            **args,
            inviter=AgentInviter(
                kind="platform", subject="reported-user", bridge_id="bridge"
            ),
        )
    with pytest.raises(AgentInviteDenied):
        await policy.require(session, **args, inviter=None)


@pytest.mark.parametrize(
    "room,group,allowed",
    [("room", "group", True), ("wrong", "group", False), ("room", None, False)],
)
async def test_invites_preserve_room_and_group_constraints(room, group, allowed):
    rules = {
        "rules": [
            {
                "owner": True,
                "users": [],
                "agents": [],
                "rooms": ["room"],
                "room_groups": ["group"],
            }
        ]
    }
    policy, session = checker([target(policy=rules)])
    call = policy.require(
        session,
        agent_ids=["target"],
        room_id=room,
        group_id=group,
        inviter=AgentInviter(kind="user", subject="owner"),
    )
    if allowed:
        await call
    else:
        with pytest.raises(AgentInviteDenied):
            await call


async def test_chat_sender_and_platform_admin_are_distinct():
    policy, session = checker([target()])
    policy._addressing.resolve_sender = AsyncMock(
        return_value=SenderPrincipal("user", "external", ["owner"], None)
    )
    args = dict(
        agent_ids=["target"],
        room_id="room",
        group_id=None,
        inviter=AgentInviter(kind="sender", subject="@human:test"),
    )
    await policy.require(session, **args)
    policy._addressing.resolve_sender.return_value = SenderPrincipal(
        "platform", "admin-client", [], None
    )
    with pytest.raises(AgentInviteDenied):
        await policy.require(session, **args)


async def test_legacy_open_policy_and_missing_targets():
    policy, session = checker([target(policy=None)])
    assert (
        await policy.require(
            session, agent_ids=["target"], room_id="room", group_id=None, inviter=None
        )
        == []
    )
    with pytest.raises(ValueError, match="no longer exists"):
        await policy.require(
            session,
            agent_ids=["target", "missing"],
            room_id="room",
            group_id=None,
            inviter=None,
        )
