"""Each platform's word that someone left a channel reaches the bridge core.

Slack, Mattermost, Teams and Telegram all say when a person leaves or is taken
out of a channel; until these were read, Switch dropped every one of them, and
someone who had left kept the rights being in the room gives (CHOO-4255).
Telegram's is covered with its adapter's other service messages.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundUserLeave
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)


def _collecting(adapter: Any) -> list[InboundUserLeave]:
    seen: list[InboundUserLeave] = []

    async def on_left(leave: InboundUserLeave) -> None:
        seen.append(leave)

    adapter.set_user_left_handler(on_left)
    return seen


# ── Slack ────────────────────────────────────────────────────────────────────


def _slack() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._bot_user_id = "UBOT"
    return adapter


async def _slack_event(adapter: SlackAdapter, event: dict[str, Any]) -> None:
    await adapter.dispatch_event(envelope_type="events_api", payload={"event": event})


def test_slack_channel_leave_post_is_a_departure() -> None:
    """Slack's "has left the channel" post comes over the message subscription
    every install already has, so no app needs new events to notice."""
    adapter = _slack()
    seen = _collecting(adapter)

    asyncio.run(
        _slack_event(
            adapter,
            {
                "type": "message",
                "subtype": "channel_leave",
                "user": "U1",
                "channel": "C1",
            },
        )
    )

    assert [(s.channel_id, s.external_user_id) for s in seen] == [("C1", "U1")]


def test_slack_member_left_channel_event_is_a_departure() -> None:
    adapter = _slack()
    seen = _collecting(adapter)

    asyncio.run(
        _slack_event(
            adapter, {"type": "member_left_channel", "user": "U1", "channel": "C1"}
        )
    )

    assert [s.external_user_id for s in seen] == ["U1"]


def test_slack_app_leaving_is_not_a_person_leaving() -> None:
    adapter = _slack()
    seen = _collecting(adapter)

    asyncio.run(
        _slack_event(
            adapter,
            {
                "type": "message",
                "subtype": "channel_leave",
                "user": "UBOT",
                "channel": "C1",
            },
        )
    )

    assert seen == []


def test_slack_leave_post_is_not_bridged_as_a_message() -> None:
    adapter = _slack()
    _collecting(adapter)
    messages: list[Any] = []

    async def on_message(message: Any) -> None:
        messages.append(message)

    adapter._on_message = on_message

    asyncio.run(
        _slack_event(
            adapter,
            {
                "type": "message",
                "subtype": "channel_leave",
                "user": "U1",
                "channel": "C1",
            },
        )
    )

    assert messages == []


# ── Mattermost ───────────────────────────────────────────────────────────────


class _Users:
    def get_user(self, user_id: str) -> dict[str, str]:
        return {"id": user_id, "username": {"u-rita": "rita"}.get(user_id, user_id)}


class _Driver:
    users = _Users()


def _mattermost() -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    adapter._admin_driver = _Driver()  # type: ignore[assignment]
    adapter._admin_user_id = "u-admin"
    adapter._bot_id_to_username["u-bot"] = "worker"
    return adapter


def _removed(user_id: str | None, remover_id: str) -> dict[str, Any]:
    data: dict[str, Any] = {"remover_id": remover_id}
    if user_id is not None:
        data["user_id"] = user_id
    return {
        "event": "user_removed",
        "data": data,
        "broadcast": {"channel_id": "ch-1"},
    }


def _mattermost_seen(event: dict[str, Any]) -> list[InboundUserLeave]:
    import json

    adapter = _mattermost()
    seen = _collecting(adapter)

    async def go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter._ws_handler(json.dumps(event), "worker")
        # The departure is handed to the main loop, as from the socket thread.
        for _ in range(5):
            await asyncio.sleep(0)

    asyncio.run(go())
    return seen


def test_mattermost_someone_leaving_is_a_departure() -> None:
    seen = _mattermost_seen(_removed("u-bob", "u-bob"))

    assert [(s.channel_id, s.external_user_id) for s in seen] == [("ch-1", "u-bob")]
    assert seen[0].removed_by_name is None


def test_mattermost_a_removal_names_who_removed_them() -> None:
    seen = _mattermost_seen(_removed("u-bob", "u-rita"))

    assert [s.removed_by_name for s in seen] == ["rita"]


def test_mattermost_the_copy_sent_to_the_removed_account_is_ignored() -> None:
    """The second `user_removed`, addressed to whoever was removed, names no
    member: it is how a bot hears it was removed, not a person leaving."""
    assert _mattermost_seen(_removed(None, "u-rita")) == []


def test_mattermost_an_agent_bot_leaving_is_not_a_person_leaving() -> None:
    assert _mattermost_seen(_removed("u-bot", "u-rita")) == []


# ── Teams ────────────────────────────────────────────────────────────────────


def _teams() -> TeamsAdapter:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-1",
            team_id="team-1",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    adapter.set_third_party_avatars(True)
    return adapter


def _members_removed(
    removed: list[dict[str, str]],
    *,
    actor: dict[str, str] | None = None,
    event_type: str | None = None,
) -> dict[str, Any]:
    channel_data: dict[str, Any] = {
        "channel": {"id": "19:abc@thread.tacv2"},
        "team": {"aadGroupId": "team-1"},
    }
    if event_type is not None:
        channel_data["eventType"] = event_type
    activity: dict[str, Any] = {
        "type": "conversationUpdate",
        "serviceUrl": "https://smba.example/amer/",
        "recipient": {"id": "28:app-123"},
        "membersRemoved": removed,
        "conversation": {"id": "19:abc@thread.tacv2", "conversationType": "channel"},
        "channelData": channel_data,
    }
    if actor is not None:
        activity["from"] = actor
    return activity


def test_teams_members_removed_is_a_departure() -> None:
    adapter = _teams()
    seen = _collecting(adapter)

    asyncio.run(
        adapter._dispatch_activity(
            _members_removed(
                [{"id": "29:bob", "aadObjectId": "aad-bob"}],
                actor={"id": "29:bob", "aadObjectId": "aad-bob"},
            )
        )
    )

    assert [(s.channel_id, s.external_user_id) for s in seen] == [
        ("19:abc@thread.tacv2", "aad-bob")
    ]
    assert seen[0].removed_by_name is None


def test_teams_a_removal_names_who_removed_them() -> None:
    adapter = _teams()
    seen = _collecting(adapter)

    asyncio.run(
        adapter._dispatch_activity(
            _members_removed(
                [{"id": "29:bob", "aadObjectId": "aad-bob"}],
                actor={"id": "29:rita", "aadObjectId": "aad-rita", "name": "Rita"},
            )
        )
    )

    assert [s.removed_by_name for s in seen] == ["Rita"]


def test_teams_leaving_a_team_leaves_each_of_its_channels() -> None:
    adapter = _teams()
    adapter._team_of_channel["19:other@thread.tacv2"] = "team-1"
    adapter._team_of_channel["19:elsewhere@thread.tacv2"] = "team-2"
    seen = _collecting(adapter)

    asyncio.run(
        adapter._dispatch_activity(
            _members_removed(
                [{"id": "29:bob", "aadObjectId": "aad-bob"}],
                event_type="teamMemberRemoved",
            )
        )
    )

    assert sorted(s.channel_id for s in seen) == [
        "19:abc@thread.tacv2",
        "19:other@thread.tacv2",
    ]


def test_teams_the_bot_being_removed_is_not_a_person_leaving() -> None:
    adapter = _teams()
    seen = _collecting(adapter)

    asyncio.run(adapter._dispatch_activity(_members_removed([{"id": "28:app-123"}])))

    assert seen == []


# ── The bridge core ──────────────────────────────────────────────────────────


class _RoomService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str], str | None]] = []
        self.kinds: list[str] = []

    async def remove_people_from_room(
        self,
        room_id: str,
        external_user_ids: list[str],
        *,
        removed_by: str | None,
        removed_by_kind: str = "platform",
    ) -> list[str]:
        self.calls.append((room_id, external_user_ids, removed_by))
        self.kinds.append(removed_by_kind)
        return []


def _core(known: dict[str, str]) -> Any:
    from types import SimpleNamespace

    core = SimpleNamespace(
        _channel_to_room={"C1": ("room-1", "!room-1:test")},
        _human_actors=known,
        _room_service=_RoomService(),
        _expected_removals={},
        EXPECTED_REMOVAL_SECONDS=CollaborationCore.EXPECTED_REMOVAL_SECONDS,
    )
    core._expected_remover = lambda channel, person: (
        CollaborationCore._expected_remover(core, channel, person)  # type: ignore[arg-type]
    )
    core.expect_removals = lambda channel, people, by: (
        CollaborationCore.expect_removals(core, channel, people, by)  # type: ignore[arg-type]
    )
    return core


async def test_the_core_takes_a_person_who_left_out_of_the_channels_room() -> None:
    from switch_core.bridges.collaboration.collaboration_core import (
        CollaborationCore,
    )

    core = _core({"U1": "client-1"})

    await CollaborationCore._handle_user_left_channel(
        core,
        InboundUserLeave(
            channel_id="C1", external_user_id="U1", removed_by_name="Rita"
        ),
    )

    assert core._room_service.calls == [("room-1", ["U1"], "Rita")]


async def test_a_removal_switch_asked_for_names_who_asked() -> None:
    """The platform's leave for a removal Switch requested can arrive before
    Switch's own call; it names the person who asked, not the platform's
    account, and counts as a removal by a person."""
    core = _core({"U1": "client-1"})
    core.expect_removals("C1", ["U1"], "carol")

    await CollaborationCore._handle_user_left_channel(
        core,
        InboundUserLeave(
            channel_id="C1", external_user_id="U1", removed_by_name="admin"
        ),
    )

    assert core._room_service.calls == [("room-1", ["U1"], "carol")]
    assert core._room_service.kinds == ["user"]


async def test_the_core_ignores_a_channel_with_no_room_or_a_stranger() -> None:
    from switch_core.bridges.collaboration.collaboration_core import (
        CollaborationCore,
    )

    core = _core({"U1": "client-1"})

    await CollaborationCore._handle_user_left_channel(
        core, InboundUserLeave(channel_id="C-unmapped", external_user_id="U1")
    )
    await CollaborationCore._handle_user_left_channel(
        core, InboundUserLeave(channel_id="C1", external_user_id="U-never-seen")
    )

    assert core._room_service.calls == []


def test_mattermost_the_notice_bot_being_added_is_not_a_person_joining() -> None:
    """Switch adds the bot it posts notices as to a channel the first time it
    answers there; filed as a person, it counted as in the room."""
    adapter = _mattermost()
    adapter._admin_bot_id = "u-notice"
    adapter._admin_driver = SimpleNamespace(  # type: ignore[assignment]
        channels=SimpleNamespace(get_channel=lambda _id: {"type": "O"}),
        users=_Users(),
    )
    joined: list[Any] = []

    async def on_user_joined(join: Any) -> None:
        joined.append(join)

    adapter._on_user_joined = on_user_joined

    async def go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter._handle_user_added(
            {"data": {"user_id": "u-notice"}, "broadcast": {"channel_id": "ch-1"}}
        )
        for _ in range(5):
            await asyncio.sleep(0)

    asyncio.run(go())

    assert joined == []
