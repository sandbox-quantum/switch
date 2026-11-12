import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter


async def test_mattermost_join_does_not_treat_the_added_member_as_the_inviter():
    pending = []
    joined = AsyncMock()
    adapter = SimpleNamespace(
        _main_loop=asyncio.get_running_loop(),
        _admin_driver=SimpleNamespace(
            channels=SimpleNamespace(
                get_channel=lambda channel: {"type": "P", "display_name": "private"}
            )
        ),
        _to_channel_type=lambda kind: "channel_private",
        _bot_id_to_username={"bot": "worker"},
        _on_agent_joined=joined,
        _dispatch=lambda coro, loop: pending.append(coro),
    )
    await MattermostAdapter._handle_user_added(
        adapter,
        {
            "data": {"user_id": "bot"},
            "broadcast": {"channel_id": "channel"},
        },
    )
    for coro in pending:
        await coro
    assert joined.await_args.args[0].inviter_id is None


async def test_telegram_reports_the_actor_separately_from_the_added_members():
    app, user = AsyncMock(), AsyncMock()
    adapter = SimpleNamespace(
        _on_app_joined=app,
        _on_user_joined=user,
        _bot_user_id=99,
        _display_name=lambda member: "person",
    )
    await TelegramAdapter._handle_new_members(
        adapter,
        [SimpleNamespace(id=99), SimpleNamespace(id=7)],
        "chat",
        "channel_private",
        "private",
        inviter_id="42",
    )
    assert app.await_args.args[0].inviter_id == "42"
    assert user.await_args.args[0].inviter_id == "42"
    assert user.await_args.args[0].external_user_id == "7"


async def test_telegram_membership_update_keeps_its_actor():
    app = AsyncMock()
    adapter = SimpleNamespace(
        _on_app_joined=app,
        _channel_type_of=lambda chat: "channel_private",
        announce_visibility=AsyncMock(),
    )
    await TelegramAdapter._handle_my_chat_member(
        adapter,
        SimpleNamespace(
            new_chat_member=SimpleNamespace(status="member"),
            chat=SimpleNamespace(id=-123, title="private"),
            from_user=SimpleNamespace(id=42),
        ),
    )
    assert app.await_args.args[0].inviter_id == "42"


async def test_teams_prefers_the_actor_aad_identity_for_both_join_types():
    app, user = AsyncMock(), AsyncMock()
    adapter = SimpleNamespace(
        _report_rename=AsyncMock(),
        _inbound_channel_type=AsyncMock(return_value="group"),
        _resolve_channel_name=AsyncMock(return_value="private"),
        _team_of_channel={},
        _me=SimpleNamespace(shared=False),
        _on_app_joined=app,
        _on_user_joined=user,
        _sender_handle=AsyncMock(return_value="member"),
    )
    await TeamsAdapter._dispatch_conversation_update(
        adapter,
        {
            "from": {"id": "actor-botframework", "aadObjectId": "actor-aad"},
            "recipient": {"id": "bot"},
            "membersAdded": [
                {"id": "bot"},
                {"id": "member-botframework", "aadObjectId": "member-aad"},
            ],
        },
        "chat",
        "group",
    )
    assert app.await_args.args[0].inviter_id == "actor-aad"
    assert user.await_args.args[0].inviter_id == "actor-aad"
    assert user.await_args.args[0].external_user_id == "member-aad"
