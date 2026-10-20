from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.sessions.contract import TurnUpsert
from switch_core.sessions.presentation import (
    activity_error_summary,
    notification_recipient,
)


async def test_slack_thread_participant_needs_no_mention_or_identity_lookup():
    db = AsyncMock()
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="slack",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="123.456",
        )
        is None
    )
    db.scalar.assert_not_called()


async def test_other_origin_prefers_actor_and_scopes_mapping_to_bridge_and_membership():
    db = AsyncMock()
    db.scalar.return_value = "UACTOR"
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="console",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="123.456",
        )
        == "UACTOR"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query
    assert "clients.matrix_user_id = '@actor:switch'" in query
    assert db.scalar.call_count == 1


async def test_missing_actor_falls_back_to_claimed_owner_in_same_room():
    db = AsyncMock()
    db.scalar.side_effect = [None, None, "UOWNER"]
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="console",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id=None,
        )
        == "UOWNER"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_user_claims.user_id = 'owner'" in query
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query


async def test_the_asker_leads_even_where_a_mention_is_the_whole_notification():
    """The person waiting on the answer is named, not the agent's owner.

    A platform that only notifies by mention is the tempting place to name the
    owner instead — they are the one who can open Console — but the mention is
    also how the asker learns their own turn needs them, and naming somebody
    else leaves them watching a channel that never says their name."""
    db = AsyncMock()
    db.scalar.return_value = "UACTOR"

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="mattermost",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UACTOR"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "clients.matrix_user_id = '@actor:switch'" in query
    assert db.scalar.call_count == 1


async def test_an_asker_with_no_account_here_still_reaches_the_owner():
    db = AsyncMock()
    db.scalar.side_effect = [None, None, "UOWNER"]

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="mattermost",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UOWNER"
    )


@pytest.mark.parametrize(
    "turn_status,online,expected",
    [
        ("error", True, "could not complete"),
        ("running", False, "host is offline"),
        ("queued", False, "host is offline"),
        ("completed", False, None),
        ("running", True, None),
    ],
)
def test_error_summary_uses_only_state(turn_status, online, expected):
    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn", command_id="command", status=turn_status
    )
    result = activity_error_summary(turn, online=online)
    if expected is None:
        assert result is None
    else:
        assert expected in result


async def test_an_unknown_asker_reaches_the_owner():
    db = AsyncMock()
    db.scalar.side_effect = ["UOWNER"]
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="mattermost",
            actor_id=None,
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UOWNER"
    )
    assert db.scalar.call_count == 1
