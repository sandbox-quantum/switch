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


@pytest.mark.parametrize("prefer_owner", [False, True])
async def test_slack_thread_participant_needs_no_mention_or_identity_lookup(
    prefer_owner,
):
    db = AsyncMock()
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            origin=origin(),
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="123.456",
            prefer_owner=prefer_owner,
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
            prefer_owner=False,
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
            prefer_owner=False,
        )
        == "UOWNER"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_user_claims.user_id = 'owner'" in query
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query


async def test_mention_only_platform_names_the_owner_ahead_of_the_asker():
    """On a platform where the mention is the whole notification, the person
    who can act on a stalled session is named, not whoever typed the command."""
    db = AsyncMock()
    db.scalar.return_value = "UOWNER"

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            origin=origin("mattermost"),
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
            prefer_owner=True,
        )
        == "UOWNER"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_user_claims.user_id = 'owner'" in query
    assert db.scalar.call_count == 1


async def test_an_unclaimed_owner_still_falls_back_to_whoever_asked():
    db = AsyncMock()
    db.scalar.side_effect = [None, "UACTOR"]

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            origin=origin("mattermost"),
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
            prefer_owner=True,
        )
        == "UACTOR"
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
        turn, SimpleNamespace(status=session_status), online=online
    )
    if expected is None:
        assert result is None
    else:
        assert expected in result


@pytest.mark.parametrize(
    "surface,actor,thread,recipient",
    [
        ("slack", "@owner:example.test", "123.1", None),
        ("slack", "@outsider:example.test", "123.1", None),
        ("console", "@outsider:example.test", "123.1", "platform-outsider"),
        ("console", "unmapped-actor", None, "platform-owner"),
    ],
)
async def test_request_publication_metadata_and_refresh(
    session_factory, surface, actor, thread, recipient
):
    from switch_core.db.models import SdkSessionCommand
    from switch_core.sessions.publication import refresh_cards

    from .test_authority import opened, setup
    from .test_publication_retries import cards_for

    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db, db.begin():
        from sqlalchemy import select

        stored = await db.scalar(select(SdkSessionCommand))
        command = dict(stored.command)
        command["origin"] = {
            **command["origin"],
            "surface": surface,
            "actorId": actor,
            "threadId": thread,
        }
        stored.command = command

    class Capture:
        def __init__(self):
            self.contents = []

        async def post_rich(self, channel, agent, content, thread):
            self.contents.append(content)
            return "channel-demo:111.0"

        async def update_rich(self, channel, post, content):
            self.contents.append(content)

    platform = Capture()
    cards = cards_for(session_factory, platform)
    for _ in range(2):
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards,
        )
    assert len(platform.contents) == 2
    assert platform.contents[0].notify_external_id == recipient
    assert platform.contents[1].notify_external_id is None


async def test_live_session_fault_redraws_activity_with_safe_summary(session_factory):
    from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
    from switch_core.db.models import SdkSession, require_tenant_id
    from switch_core.sessions.publication import SessionPublisher

    from .test_authority import opened, setup
    from .test_publication import Platform
    from .test_publication_retries import cards_for
    from .test_turn_activity_publication import ActivityPlatform

    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivityPlatform()
    activity = SessionTurnActivity(platform)
    activity.publish = AsyncMock(wraps=activity.publish)
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity,
        gateway_public_url="https://switch.example",
    )
    await publisher.publish_pending()
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.snapshot = {
            **row.snapshot,
            "throughSequence": row.snapshot["throughSequence"] + 1,
            "session": {**row.snapshot["session"], "status": "error"},
        }
    await publisher.publish_pending()
    content = SimpleNamespace(**activity.publish.call_args.kwargs)
    assert (
        content.error_summary
        == "The agent session encountered an error. Open Switch Console for details."
    )
    assert content.notify_external_id == "platform-owner"
    assert content.session_url.endswith("session=session-demo")
