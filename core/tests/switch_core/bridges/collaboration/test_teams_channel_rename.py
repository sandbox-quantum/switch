"""Teams reports renames as `conversationUpdate` activities: a channel's, a
team's, and a group chat's new topic. The bridge hands each to the room the
conversation is linked to, and keeps its own record of the name current."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

TEAM = "19:team-general@thread.tacv2"
CHANNEL = "19:payments@thread.tacv2"
GROUP_CHAT = "19:groupchat@thread.v2"


def _adapter() -> tuple[TeamsAdapter, list[tuple[str, str, str]]]:
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
    renamed: list[tuple[str, str, str]] = []

    async def named(channel_id: str, old: str, new: str) -> None:
        renamed.append((channel_id, old, new))

    adapter.set_channel_rename_handler(named)
    return adapter, renamed


def _team_activity(event_type: str | None, **channel_data: Any) -> dict[str, Any]:
    return {
        "type": "conversationUpdate",
        "id": f"act-{event_type}",
        "conversation": {"id": TEAM, "conversationType": "channel"},
        "channelData": {
            **({"eventType": event_type} if event_type else {}),
            **channel_data,
        },
    }


async def test_a_renamed_channel_reaches_the_room_and_its_name_is_kept() -> None:
    adapter, renamed = _adapter()
    adapter._team_of_channel[CHANNEL] = "team-1"
    adapter._channel_names[CHANNEL] = "Payments"
    await adapter._dispatch_activity(
        _team_activity(
            "channelRenamed",
            channel={"id": CHANNEL, "name": "Payments Squad"},
            team={"id": TEAM, "name": "Contoso"},
        )
    )
    assert renamed == [(CHANNEL, "Payments", "Payments Squad")]
    assert adapter._channel_names[CHANNEL] == "Payments Squad"


async def test_a_renamed_team_is_reported_as_its_general_channel() -> None:
    adapter, renamed = _adapter()
    # Any earlier activity from the team carries its name.
    await adapter._dispatch_activity(
        _team_activity(None, team={"id": TEAM, "name": "Contoso"})
    )
    await adapter._dispatch_activity(
        _team_activity("teamRenamed", team={"id": TEAM, "name": "Contoso Ltd"})
    )
    assert renamed == [(TEAM, "Contoso", "Contoso Ltd")]


async def test_a_team_renamed_before_its_old_name_was_seen_is_not_followed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, renamed = _adapter()
    await adapter._dispatch_activity(
        _team_activity("teamRenamed", team={"id": TEAM, "name": "Contoso Ltd"})
    )
    assert renamed == []
    assert "before Switch learned its old name" in caplog.text
    # The next rename is known to be one.
    await adapter._dispatch_activity(
        {
            **_team_activity("teamRenamed", team={"id": TEAM, "name": "Contoso Group"}),
            "id": "act-2",
        }
    )
    assert renamed == [(TEAM, "Contoso Ltd", "Contoso Group")]


async def test_a_group_chat_with_a_new_topic_reaches_the_room() -> None:
    adapter, renamed = _adapter()
    await adapter._dispatch_activity(
        {
            "type": "conversationUpdate",
            "id": "act-topic",
            "topicName": "Launch crew",
            "conversation": {"id": GROUP_CHAT, "conversationType": "groupChat"},
            "channelData": {"tenant": {"id": "tenant-1"}},
        }
    )
    assert renamed == [(GROUP_CHAT, "", "Launch crew")]


async def test_a_member_joining_is_not_a_rename() -> None:
    adapter, renamed = _adapter()
    await adapter._dispatch_activity(
        {
            "type": "conversationUpdate",
            "id": "act-join",
            "conversation": {"id": GROUP_CHAT, "conversationType": "personal"},
            "membersRemoved": [{"id": "29:someone"}],
            "channelData": {},
        }
    )
    assert renamed == []
