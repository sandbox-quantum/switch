"""Lining a room up with its channel's member list (CHOO-4255).

A room only knew someone was in it once they spoke, and never noticed them
go. On the app being added to a channel, and at every start, the bridge now
asks the platform who is in the channel and adds or removes people to match;
Telegram, which cannot list members, keeps to its leave events.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration import collaboration_core as core_module
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import ChannelMembers
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

BRIDGE = "bridge-1"


class _Adapter:
    def __init__(self, listing: ChannelMembers | None) -> None:
        self.listing = listing

    async def list_channel_members(self, channel_id: str) -> ChannelMembers | None:
        return self.listing


class _RoomService:
    def __init__(self) -> None:
        self.removed: list[tuple[str, list[str]]] = []

    async def remove_people_from_room(
        self, room_id: str, external_user_ids: list[str]
    ) -> list[str]:
        self.removed.append((room_id, external_user_ids))
        return []


def _core(
    monkeypatch: pytest.MonkeyPatch,
    listing: ChannelMembers | None,
    *,
    present: list[str],
    agents: set[str] = frozenset(),  # type: ignore[assignment]
) -> SimpleNamespace:
    @asynccontextmanager
    async def _tenant_session(_factory: Any, _tenant: str):  # type: ignore[no-untyped-def]
        yield None

    monkeypatch.setattr(core_module, "tenant_session", _tenant_session)

    added: list[str] = []

    async def get_by_room(_session: Any, _room_id: str) -> list[Any]:
        return [
            SimpleNamespace(external_user_id=i, bridge_id=BRIDGE) for i in present
        ] + [SimpleNamespace(external_user_id="U-OTHER-BRIDGE", bridge_id="other")]

    async def ensure(**kw: Any) -> object:
        added.append(kw["external_user_id"])
        return object()

    async def is_agent(name: str) -> bool:
        return name in agents

    async def room_tenant(_room_id: str) -> str:
        return "tenant-1"

    core = SimpleNamespace(
        MEMBER_SYNC_MAX_ADDS=CollaborationCore.MEMBER_SYNC_MAX_ADDS,
        _bridge_id=BRIDGE,
        _bridge_type="slack",
        _session_factory=None,
        _channel_to_room={"C1": ("room-1", "!room-1:test")},
        _adapter=_Adapter(listing),
        _external_user_store=SimpleNamespace(get_by_room=get_by_room),
        _ensure_human_in_room=ensure,
        _is_registered_agent=is_agent,
        _room_tenant=room_tenant,
        _room_service=_RoomService(),
        added=added,
    )
    return core


async def _sync(core: SimpleNamespace) -> None:
    await CollaborationCore.sync_channel_members(core, "C1")  # type: ignore[arg-type]


async def test_people_in_the_channel_are_added_and_people_gone_removed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    core = _core(
        monkeypatch,
        ChannelMembers(members={"U1": "alice", "U2": "bob"}, complete=True),
        present=["U2", "U3"],
    )

    await _sync(core)

    assert core.added == ["U1"]
    assert core._room_service.removed == [("room-1", ["U3"])]


async def test_an_incomplete_listing_adds_but_removes_nobody(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    core = _core(
        monkeypatch,
        ChannelMembers(members={"U1": "alice"}, complete=False),
        present=["U3"],
    )

    await _sync(core)

    assert core.added == ["U1"]
    assert core._room_service.removed == []


async def test_an_empty_listing_removes_nobody(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bot that lost sight of the channel answers with nobody; taking that
    at its word would empty the room."""
    core = _core(monkeypatch, ChannelMembers(members={}, complete=True), present=["U3"])

    await _sync(core)

    assert core._room_service.removed == []


async def test_a_platform_that_cannot_list_members_is_left_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    core = _core(monkeypatch, None, present=["U3"])

    await _sync(core)

    assert core.added == []
    assert core._room_service.removed == []


async def test_an_agents_account_is_not_added_as_a_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    core = _core(
        monkeypatch,
        ChannelMembers(members={"U-BOT": "worker", "U1": "alice"}, complete=True),
        present=[],
        agents={"worker"},
    )

    await _sync(core)

    assert core.added == ["U1"]


async def test_a_huge_channel_is_added_in_part(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    members = {f"U{i}": f"person-{i}" for i in range(5)}
    core = _core(
        monkeypatch, ChannelMembers(members=members, complete=True), present=[]
    )
    core.MEMBER_SYNC_MAX_ADDS = 3

    await _sync(core)

    assert len(core.added) == 3


# ── Adapters ─────────────────────────────────────────────────────────────────


class _SlackClient:
    def __init__(self, pages: list[dict[str, Any]], users: dict[str, Any]) -> None:
        self._pages = pages
        self._users = users

    async def conversations_members(self, **kw: Any) -> dict[str, Any]:
        return self._pages.pop(0)

    async def users_info(self, *, user: str) -> dict[str, Any]:
        return {"user": self._users[user]}


def test_slack_lists_people_across_pages_without_bots() -> None:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter._bot_user_id = "UBOT"
    adapter._web_client = _SlackClient(  # type: ignore[assignment]
        pages=[
            {"members": ["U1", "UBOT"], "response_metadata": {"next_cursor": "n"}},
            {"members": ["U2", "UAPP", "UGONE"]},
        ],
        users={
            "U1": {"name": "alice"},
            "U2": {"name": "bob"},
            "UAPP": {"name": "datadog", "is_bot": True},
            "UGONE": {"name": "old", "deleted": True},
        },
    )

    listing = asyncio.run(adapter.list_channel_members("C1"))

    assert listing == ChannelMembers(
        members={"U1": "alice", "U2": "bob"}, complete=True
    )


class _MMChannels:
    def __init__(self, pages: list[list[dict[str, str]]]) -> None:
        self._pages = pages

    def get_channel_members(self, channel_id: str, params: Any = None) -> Any:
        return self._pages[params["page"]]


class _MMUsers:
    def get_users_by_ids(self, ids: list[str]) -> list[dict[str, Any]]:
        known = {
            "u1": {"id": "u1", "username": "alice"},
            "u-ext-bot": {"id": "u-ext-bot", "username": "ci", "is_bot": True},
            "u-gone": {"id": "u-gone", "username": "old", "delete_at": 123},
        }
        return [known[i] for i in ids if i in known]


def test_mattermost_lists_people_without_bots_or_the_admin() -> None:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    adapter._admin_user_id = "u-admin"
    adapter._bot_id_to_username["u-agent"] = "worker"
    adapter._admin_driver = SimpleNamespace(  # type: ignore[assignment]
        channels=_MMChannels(
            [
                [
                    {"user_id": "u1"},
                    {"user_id": "u-admin"},
                    {"user_id": "u-agent"},
                    {"user_id": "u-ext-bot"},
                    {"user_id": "u-gone"},
                ]
            ]
        ),
        users=_MMUsers(),
    )

    async def go() -> ChannelMembers | None:
        adapter._main_loop = asyncio.get_running_loop()
        return await adapter.list_channel_members("ch-1")

    assert asyncio.run(go()) == ChannelMembers(members={"u1": "alice"}, complete=True)
