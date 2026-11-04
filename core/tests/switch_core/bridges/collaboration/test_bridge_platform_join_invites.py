"""An agent added on the platform itself is judged as whoever added it (#805).

Someone can put an agent's bot in a channel straight from Slack, Telegram or
Mattermost, without going through Switch. When the platform says who did it,
that person is the inviter, exactly as if they had typed `!invite-agent`. When
it does not, the join stands but is disclosed: a notice in the channel that
names the owner, and a warning in the log. An unknown inviter is never treated
as trusted.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from types import MethodType, SimpleNamespace
from typing import Any

import pytest

from switch_core.addressing import owner_only_policy
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin, InboundUserJoin
from switch_core.db.models import Agent
from switch_core.invite_policy import Inviter, require_may_invite

OWNER = "user-owner"
BRIDGE = "bridge-1"
CHANNEL = "C1"


def _agent(*, restricted: bool) -> Agent:
    return Agent(
        id="agent-helper",
        name="helper",
        owner_id=OWNER,
        addressing_policy=owner_only_policy([]).model_dump() if restricted else None,
    )


def _account(id_: str, username: str) -> SimpleNamespace:
    return SimpleNamespace(id=id_, bridge_id=BRIDGE, external_username=username)


def _bridge(
    agent: Agent,
    *,
    room_exists: bool = True,
    agent_in_room: bool = False,
    accounts: dict[str, SimpleNamespace] | None = None,
    claims: dict[str, list[str]] | None = None,
    owner_accounts: list[SimpleNamespace] | None = None,
) -> Any:
    accounts = accounts or {}
    claims = claims or {}
    notices: list[str] = []
    invites: list[Inviter] = []
    configs: list[Any] = []

    @asynccontextmanager
    async def session_factory():  # noqa: ANN202
        yield object()

    class _AgentStore:
        async def get_by_name(self, session: object, name: str) -> Agent | None:
            return agent if name == agent.name else None

    class _ExternalUserStore:
        async def get_by_external_id(
            self, session: object, bridge_id: str, external_user_id: str
        ) -> SimpleNamespace | None:
            return accounts.get(external_user_id)

        async def claimant_ids(self, session: object, account_id: str) -> list[str]:
            return claims.get(account_id, [])

        async def get_by_user(
            self, session: object, user_id: str
        ) -> list[SimpleNamespace]:
            return (owner_accounts or []) if user_id == OWNER else []

    class _RoomService:
        async def add_agents_to_room(
            self, room_id: str, *, agent_ids: list[str], invited_by: Inviter, **_: Any
        ) -> list[str]:
            invites.append(invited_by)
            if agent_in_room:
                return []
            if invited_by.kind != "system":
                require_may_invite([agent], invited_by, room_id=room_id, group_id=None)
            return agent_ids

        async def create_room(self, config: Any) -> SimpleNamespace:
            configs.append(config)
            room = SimpleNamespace(
                id="room-1", tenant_id="t", transport_room_id="!r:switch.local"
            )
            return SimpleNamespace(room=room)

    class _Adapter:
        def slash_invite_hint(self) -> str | None:
            return None

        async def admin_message(
            self, channel_id: str, content: str, *_: Any, **__: Any
        ) -> str:
            notices.append(content)
            return "ref"

    async def resolve_agents(channel_id: str, channel_type: str) -> list[str]:
        return [agent.id]

    async def adopt(channel_id: str) -> None:
        return None

    bridge = SimpleNamespace(
        _session_factory=session_factory,
        _agent_store=_AgentStore(),
        _external_user_store=_ExternalUserStore(),
        _room_service=_RoomService(),
        _adapter=_Adapter(),
        _bridge_id=BRIDGE,
        _bridge_display_name="Switch",
        _channel_to_room={CHANNEL: ("room-1", "!r:switch.local")}
        if room_exists
        else {},
        _provisioning_channels=set(),
        _resolve_agents_for_channel=resolve_agents,
        _adopt_existing_room=adopt,
        add_room_mapping=lambda *_: None,
        notices=notices,
        invites=invites,
        configs=configs,
    )
    for name in (
        "_platform_inviter",
        "_refuse_platform_join",
        "_disclose_unverified_join",
        "_owner_mention",
        "_create_room_for_channel",
    ):
        setattr(bridge, name, MethodType(getattr(CollaborationCore, name), bridge))
    return bridge


def _join(added_by: str | None) -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id=CHANNEL,
        channel_type="channel_public",
        agent_name="helper",
        added_by_external_user_id=added_by,
    )


async def _joined(bridge: Any, added_by: str | None) -> None:
    await CollaborationCore._handle_agent_joined_channel_locked(bridge, _join(added_by))


class TestThePlatformNamesWhoAddedIt:
    async def test_the_owner_s_own_account_may_add_it(self) -> None:
        bridge = _bridge(
            _agent(restricted=True),
            accounts={"U-owner": _account("ext-owner", "olivia")},
            claims={"ext-owner": [OWNER]},
        )

        await _joined(bridge, "U-owner")

        assert bridge.invites == [Inviter.chat_account("ext-owner", [OWNER])]
        assert bridge.notices == []

    async def test_someone_the_policy_refuses_is_refused_and_told(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bridge = _bridge(
            _agent(restricted=True),
            accounts={"U-other": _account("ext-other", "sam")},
        )

        with caplog.at_level(logging.INFO):
            await _joined(bridge, "U-other")

        assert bridge.invites == [Inviter.chat_account("ext-other", [])]
        [notice] = bridge.notices
        assert "`helper`" in notice
        assert "won't take part" in notice
        assert "Ask its owner" in notice
        assert "Kept agent helper out of channel C1" in caplog.text

    async def test_an_account_switch_has_never_seen_is_not_trusted(self) -> None:
        bridge = _bridge(_agent(restricted=True))

        await _joined(bridge, "U-new")

        assert bridge.invites == [Inviter.chat_account("")]
        assert len(bridge.notices) == 1
        assert "won't take part" in bridge.notices[0]

    async def test_anyone_may_add_an_open_agent(self) -> None:
        bridge = _bridge(_agent(restricted=False))

        await _joined(bridge, "U-new")

        assert bridge.notices == []

    async def test_a_new_room_leaves_a_refused_agent_out(self) -> None:
        bridge = _bridge(_agent(restricted=True), room_exists=False)

        await _joined(bridge, "U-new")

        [config] = bridge.configs
        assert config.agent_ids == []
        assert any("won't take part" in notice for notice in bridge.notices)

    async def test_a_new_room_takes_an_agent_its_owner_added(self) -> None:
        bridge = _bridge(
            _agent(restricted=True),
            room_exists=False,
            accounts={"U-owner": _account("ext-owner", "olivia")},
            claims={"ext-owner": [OWNER]},
        )

        await _joined(bridge, "U-owner")

        [config] = bridge.configs
        assert config.agent_ids == ["agent-helper"]
        assert bridge.notices == []


class TestThePlatformDoesNotSay:
    async def test_the_join_stands_and_is_disclosed_to_the_owner(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bridge = _bridge(
            _agent(restricted=True),
            owner_accounts=[_account("ext-owner", "olivia")],
        )

        with caplog.at_level(logging.WARNING):
            await _joined(bridge, None)

        assert bridge.invites == [Inviter.system()]
        [notice] = bridge.notices
        assert "couldn't verify who added it" in notice
        assert "@olivia can remove it" in notice
        assert "by someone the platform did not name" in caplog.text

    async def test_an_owner_with_no_account_here_is_named_as_its_owner(self) -> None:
        bridge = _bridge(_agent(restricted=True))

        await _joined(bridge, None)

        assert "Its owner can remove it" in bridge.notices[0]

    async def test_an_agent_already_in_the_room_is_not_announced_again(self) -> None:
        # Mattermost replays the channels every bot is in on startup.
        bridge = _bridge(_agent(restricted=True), agent_in_room=True)

        await _joined(bridge, None)

        assert bridge.notices == []

    async def test_an_open_agent_needs_no_notice(self) -> None:
        bridge = _bridge(_agent(restricted=False))

        await _joined(bridge, None)

        assert bridge.notices == []

    async def test_a_new_room_discloses_it_too(self) -> None:
        bridge = _bridge(_agent(restricted=True), room_exists=False)

        await _joined(bridge, None)

        [config] = bridge.configs
        assert config.agent_ids == ["agent-helper"]
        assert any("couldn't verify" in notice for notice in bridge.notices)


async def test_a_user_join_that_is_an_agent_keeps_who_added_it() -> None:
    seen: list[InboundAgentJoin] = []

    async def handle(join: InboundAgentJoin) -> None:
        seen.append(join)

    async def is_registered_agent(name: str) -> bool:
        return True

    bridge = SimpleNamespace(
        _is_registered_agent=is_registered_agent,
        _handle_agent_joined_channel=handle,
    )
    await CollaborationCore._handle_user_joined_channel(
        bridge,
        InboundUserJoin(
            channel_id=CHANNEL,
            channel_type="channel_public",
            external_user_id="U-bot",
            external_username="helper",
            added_by_external_user_id="U-owner",
        ),
    )

    assert seen[0].added_by_external_user_id == "U-owner"
