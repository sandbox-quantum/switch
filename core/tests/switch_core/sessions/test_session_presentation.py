from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import pytest

from switch_core.sessions.contract import Origin, TurnUpsert
from switch_core.sessions.presentation import (
    activity_error_summary,
    notification_recipient,
    session_console_url,
)


def test_console_link_uses_current_sdk_identity_and_configured_server():
    result = session_console_url(
        "https://switch.example/", "agent&1", "room 2", "sdk-session"
    )
    parts = urlsplit(result)
    assert (parts.scheme, parts.netloc) == ("switchdash", "session")
    assert parse_qs(parts.query) == {
        "server": ["https://switch.example"],
        "agent": ["agent&1"],
        "room": ["room 2"],
        "session": ["sdk-session"],
    }


@pytest.mark.parametrize("server", [None, "", "localhost", "file:///tmp/server"])
def test_console_link_does_not_invent_a_server(server):
    assert session_console_url(server, "agent", "room", "session") is None


def origin(surface="slack"):
    return Origin(
        surface=surface,
        actor_id="@actor:switch",
        room_id="room",
        thread_id=None,
        message_id="message",
    )


async def test_slack_thread_participant_needs_no_mention_or_identity_lookup():
    db = AsyncMock()
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            origin=origin(),
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
            origin=origin("console"),
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
            origin=origin("console"),
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
            origin=origin("mattermost"),
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
            origin=origin("mattermost"),
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UOWNER"
    )


@pytest.mark.parametrize(
    "turn_status,session_status,online,expected",
    [
        ("error", "ready", True, "could not complete"),
        ("running", "error", True, "session encountered an error"),
        ("running", "running", False, "host is offline"),
        ("queued", "ready", False, "host is offline"),
        ("completed", "error", False, None),
        ("running", "running", True, None),
    ],
)
def test_error_summary_uses_only_state(turn_status, session_status, online, expected):
    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn", command_id="command", status=turn_status
    )
    result = activity_error_summary(
        turn, SimpleNamespace(status=session_status), online=online, unconfirmed=False
    )
    if expected is None:
        assert result is None
    else:
        assert expected in result


def test_an_unacknowledged_command_is_not_reported_as_a_failed_one():
    """Nobody here knows whether the agent saw it, so nothing may claim it didn't.

    The turn is carried as an error because there is no other status to carry
    it as, which is exactly why the sentence cannot be read off the status.
    """
    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn", command_id="command", status="error"
    )

    summary = activity_error_summary(
        turn, SimpleNamespace(status="ready"), online=True, unconfirmed=True
    )

    assert summary is not None
    assert "could not complete" not in summary
    assert "could not confirm" in summary
    assert "not be resent" in summary
