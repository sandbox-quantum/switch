"""How a chat leaves the distributed Telegram app, and what guards its bot.

The Postgres half — one chat's room detached while the bridge stays, the last
chat taking the bridge with it, two leaving at once — is in
`test_install_claim.py`. This is the Telegram half: leaving a chat, reading a
supergroup's two migration notices, answering chats nobody claimed, asking
Telegram how delivery is going, and keeping the app's own bot out of every
self-registered bridge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from telegram.error import BadRequest, Forbidden, TimedOut

from switch_core.bridges.collaboration.install import (
    ClaimantMayNotConnect,
    ClaimProposal,
    InstallClaim,
    InstallGrant,
    MessagingInstallError,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.telegram import install as install_module
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.app_client import (
    TelegramAppClient,
    bot_resource,
)
from switch_core.bridges.collaboration.telegram.install import (
    ANSWERED,
    CLAIM_REFUSED,
    DIRECT_MESSAGE_REPLY,
    NOT_AN_ADMIN_ALERT,
    UNCLAIMED_NOTICE,
    TelegramAppInstaller,
)
from switch_core.db.models import CollaborationBridge
from switch_core.gateway.collaborations import update_bridge
from switch_core.gateway.schemas import BridgeUpdateRequest

_SECRET = "placeholder-secret"


@dataclass
class _Me:
    id: int = 123456
    username: str = "switch_app_bot"
    can_read_all_group_messages: bool = True
    can_join_groups: bool = True


@dataclass
class _WebhookInfo:
    pending_update_count: int = 0
    last_error_date: datetime | None = None
    last_error_message: str | None = None


@dataclass
class _Member:
    status: str


@dataclass
class _Bot:
    token: str = "123456:placeholder-token"
    left: list[int] = field(default_factory=list)
    sent: list[dict[str, Any]] = field(default_factory=list)
    leave_error: Exception | None = None
    webhook_info: _WebhookInfo = field(default_factory=_WebhookInfo)
    member_status: str = "administrator"
    member_error: Exception | None = None
    members_asked: list[tuple[int, int]] = field(default_factory=list)
    answered: list[dict[str, Any]] = field(default_factory=list)
    edited: list[dict[str, Any]] = field(default_factory=list)

    async def initialize(self) -> None:
        return None

    async def get_me(self) -> _Me:
        return _Me()

    async def set_webhook(self, **kwargs: Any) -> bool:
        return True

    async def set_my_commands(self, commands: Any) -> bool:
        return True

    async def leave_chat(self, *, chat_id: int) -> bool:
        if self.leave_error is not None:
            raise self.leave_error
        self.left.append(chat_id)
        return True

    async def send_message(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def answer_callback_query(self, **kwargs: Any) -> None:
        self.answered.append(kwargs)

    async def edit_message_text(self, **kwargs: Any) -> None:
        self.edited.append(kwargs)

    async def get_chat_member(self, *, chat_id: int, user_id: int) -> _Member:
        self.members_asked.append((chat_id, user_id))
        if self.member_error is not None:
            raise self.member_error
        return _Member(status=self.member_status)

    async def get_webhook_info(self) -> _WebhookInfo:
        return self.webhook_info


async def _nothing(client: TelegramAppClient) -> None:
    return None


async def _installer(bot: _Bot | None = None) -> tuple[TelegramAppInstaller, _Bot]:
    bot = bot or _Bot()
    client = TelegramAppClient(
        bot=bot,  # type: ignore[arg-type]
        webhook_url="https://switch.example/messaging/telegram/events",
        webhook_secret=_SECRET,
        on_connected=_nothing,
    )
    await client.start()
    return TelegramAppInstaller(client=client, webhook_secret=_SECRET), bot


class TestBeingUp:
    """A bridge starting once the bot is up is attached as it starts; one
    starting before is left for the walk `on_connected` makes, which must see
    the bot as up so a bridge starting during it is caught by one or the other."""

    async def test_not_before_start(self) -> None:
        client = TelegramAppClient(
            bot=_Bot(),  # type: ignore[arg-type]
            webhook_url="https://switch.example/messaging/telegram/events",
            webhook_secret=_SECRET,
            on_connected=_nothing,
        )

        assert not client.is_live

    async def test_up_by_the_time_the_running_bridges_are_walked(self) -> None:
        seen: list[bool] = []

        async def on_connected(client: TelegramAppClient) -> None:
            seen.append(client.is_live)

        client = TelegramAppClient(
            bot=_Bot(),  # type: ignore[arg-type]
            webhook_url="https://switch.example/messaging/telegram/events",
            webhook_secret=_SECRET,
            on_connected=on_connected,
        )
        await client.start_with_retry()

        assert seen == [True]


class TestLeaving:
    async def test_disconnecting_makes_the_bot_leave(self) -> None:
        installer, bot = await _installer()
        await installer.release(external_workspace_id="-1001")
        assert bot.left == [-1001]

    @pytest.mark.parametrize(
        "gone",
        [
            BadRequest("Bad Request: chat not found"),
            Forbidden("Forbidden: bot was kicked from the group chat"),
            Forbidden("Forbidden: bot is not a member of the supergroup chat"),
        ],
    )
    async def test_a_chat_it_is_already_out_of_is_a_success(
        self, gone: Exception
    ) -> None:
        installer, bot = await _installer(_Bot(leave_error=gone))
        await installer.release(external_workspace_id="-1001")

    @pytest.mark.parametrize(
        "refused",
        [
            BadRequest("Bad Request: CHANNEL_PRIVATE"),
            Forbidden("Forbidden: bot can't initiate conversation with a user"),
        ],
    )
    async def test_any_other_refusal_keeps_the_disconnect_from_finishing(
        self, refused: Exception
    ) -> None:
        installer, _ = await _installer(_Bot(leave_error=refused))
        with pytest.raises(MessagingInstallError, match="still in the chat"):
            await installer.release(external_workspace_id="-1001")

    async def test_any_other_failure_keeps_the_disconnect_from_finishing(
        self,
    ) -> None:
        installer, _ = await _installer(_Bot(leave_error=TimedOut()))
        with pytest.raises(MessagingInstallError, match="still in the chat"):
            await installer.release(external_workspace_id="-1001")


def _claim(claimant: str) -> InstallClaim:
    return InstallClaim(
        token="c1token",
        grant=InstallGrant(
            external_workspace_id="-1001",
            workspace_name="Telegram",
            bot_token=None,
            scopes="",
            platform_data={},
        ),
        claimant=claimant,
    )


class TestWhoMayConnectAChat:
    """Only a chat's creator or admins may connect it: the code says who in
    Switch asked, not who may decide for the chat."""

    @pytest.mark.parametrize("status", ["creator", "administrator"])
    async def test_its_admins_may(self, status: str) -> None:
        installer, bot = await _installer(_Bot(member_status=status))
        await installer.require_claimant_may_connect(_claim("42"))
        assert bot.members_asked == [(-1001, 42)]

    @pytest.mark.parametrize("status", ["member", "restricted"])
    async def test_anyone_else_may_not(self, status: str) -> None:
        installer, _ = await _installer(_Bot(member_status=status))
        with pytest.raises(ClaimantMayNotConnect, match="not one of its admins"):
            await installer.require_claimant_may_connect(_claim("42"))

    async def test_a_post_as_the_chat_itself_needs_no_lookup(self) -> None:
        """A channel's post, or an anonymous admin's message."""
        installer, bot = await _installer(_Bot(member_status="member"))
        await installer.require_claimant_may_connect(_claim("-1001"))
        assert bot.members_asked == []

    async def test_someone_telegram_will_not_answer_for_is_refused(self) -> None:
        installer, _ = await _installer(
            _Bot(member_error=BadRequest("Bad Request: PARTICIPANT_ID_INVALID"))
        )
        with pytest.raises(ClaimantMayNotConnect):
            await installer.require_claimant_may_connect(_claim("777000"))

    async def test_a_lookup_that_fails_is_retried_not_let_through(self) -> None:
        installer, _ = await _installer(_Bot(member_error=TimedOut()))
        with pytest.raises(MessagingInstallError, match="Could not ask Telegram"):
            await installer.require_claimant_may_connect(_claim("42"))


def _message(chat_id: int, **fields: Any) -> dict[str, Any]:
    return {
        "update_id": 1,
        "message": {"message_id": 1, "chat": {"id": chat_id, "type": "supergroup"}}
        | fields,
    }


class TestMigration:
    async def test_the_notice_in_the_old_chat(self) -> None:
        installer, _ = await _installer()
        payload = _message(-55, migrate_to_chat_id=-1009)
        assert installer.migration_of_event(payload) == ("-55", "-1009")

    async def test_the_notice_in_the_new_chat(self) -> None:
        installer, _ = await _installer()
        payload = _message(-1009, migrate_from_chat_id=-55)
        assert installer.migration_of_event(payload) == ("-55", "-1009")

    async def test_an_ordinary_message_is_not_one(self) -> None:
        installer, _ = await _installer()
        assert installer.migration_of_event(_message(-55, text="hi")) is None


def _added(chat_type: str = "supergroup", status: str = "member") -> dict[str, Any]:
    return {
        "update_id": 1,
        "my_chat_member": {
            "chat": {"id": -1001, "type": chat_type},
            "new_chat_member": {"status": status, "user": {"id": 123456}},
        },
    }


async def _answer(
    installer: TelegramAppInstaller, payload: dict[str, Any], *, owned: bool
) -> None:
    async def still_unowned() -> bool:
        return not owned

    workspace = str(
        payload.get("my_chat_member", payload.get("message", {}))["chat"]["id"]
    )  # type: ignore[index]
    await installer.on_unowned_event(
        workspace_id=workspace, payload=payload, still_unowned=still_unowned
    )


class TestUnclaimedChats:
    @pytest.fixture(autouse=True)
    def _no_grace(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(install_module, "UNCLAIMED_NOTICE_GRACE", 0.0)

    async def test_an_unclaimed_add_is_told_how_to_connect(self) -> None:
        installer, bot = await _installer()
        await _answer(installer, _added(), owned=False)
        assert bot.sent == [{"chat_id": -1001, "text": UNCLAIMED_NOTICE}]

    async def test_an_add_a_claim_followed_says_nothing(self) -> None:
        """The link sends the add and the claim a moment apart; the notice is
        only for an add no claim follows."""
        installer, bot = await _installer()
        await _answer(installer, _added(), owned=True)
        assert bot.sent == []

    async def test_a_channel_add_says_nothing(self) -> None:
        """A channel's code is posted after the bot is in, so every channel is
        added unclaimed, and a notice there reaches every subscriber."""
        installer, bot = await _installer()
        await _answer(
            installer, _added(chat_type="channel", status="administrator"), owned=False
        )
        assert bot.sent == []

    async def test_leaving_is_not_answered(self) -> None:
        installer, bot = await _installer()
        await _answer(installer, _added(status="left"), owned=False)
        assert bot.sent == []

    async def test_a_direct_message_is_told_it_reaches_no_one(self) -> None:
        installer, bot = await _installer()
        payload = {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": 42, "type": "private"},
                "text": "hi",
            },
        }
        await _answer(installer, payload, owned=False)
        assert bot.sent == [{"chat_id": 42, "text": DIRECT_MESSAGE_REPLY}]

    async def test_chatter_in_an_unclaimed_group_gets_no_answer(self) -> None:
        installer, bot = await _installer()
        await _answer(installer, _message(-1001, text="hello"), owned=False)
        assert bot.sent == []


class TestDeliveryHealth:
    async def test_a_new_delivery_error_is_reported(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bot = _Bot(
            webhook_info=_WebhookInfo(
                last_error_date=datetime(2026, 9, 28), last_error_message="timeout"
            )
        )
        installer, _ = await _installer(bot)
        client = installer.shared_connection()

        with caplog.at_level("WARNING"):
            seen = await client.check_delivery(None)
            await client.check_delivery(seen)

        assert [r.getMessage() for r in caplog.records].count(
            "Telegram reports failing to deliver to the webhook: timeout"
        ) == 1

    async def test_a_growing_backlog_is_reported(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bot = _Bot(webhook_info=_WebhookInfo(pending_update_count=80))
        installer, _ = await _installer(bot)
        with caplog.at_level("WARNING"):
            await installer.shared_connection().check_delivery(None)
        assert "holding 80 updates" in caplog.text

    async def test_a_small_backlog_is_not(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bot = _Bot(webhook_info=_WebhookInfo(pending_update_count=3))
        installer, _ = await _installer(bot)
        with caplog.at_level("WARNING"):
            await installer.shared_connection().check_delivery(None)
        assert caplog.text == ""


def _lifecycle() -> CollaborationBridgeLifecycleService:
    config = MagicMock()
    config.collaboration_callback_host = "127.0.0.1"
    config.collaboration_callback_port = 0
    config.jwt_secret_key = "server-secret-for-tests"
    lifecycle = CollaborationBridgeLifecycleService(
        bridge_store=None,  # type: ignore[arg-type]
        external_user_store=None,  # type: ignore[arg-type]
        bridge_message_map_store=None,  # type: ignore[arg-type]
        room_store=None,  # type: ignore[arg-type]
        agent_store=None,  # type: ignore[arg-type]
        client_store=None,  # type: ignore[arg-type]
        client_lifecycle=None,  # type: ignore[arg-type]
        room_service=None,  # type: ignore[arg-type]
        provisioning=None,  # type: ignore[arg-type]
        session_factory=None,  # type: ignore[arg-type]
        config=config,
        client_factory=None,  # type: ignore[arg-type]
        session_activity_listener=None,  # type: ignore[arg-type]
        session_activity_service=None,  # type: ignore[arg-type]
        connections=None,  # type: ignore[arg-type]
    )
    lifecycle.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)
    return lifecycle


class TestTheBotAsAResource:
    def test_a_self_registered_bridge_holds_its_bot(self) -> None:
        """Two pollers on one bot split its updates at random."""
        held = TelegramAdapter.exclusive_resource(
            {"bot_token": "987:placeholder", "bot_username": "acme_bot"}
        )
        assert held == bot_resource("987")

    def test_a_shared_bridge_holds_nothing(self) -> None:
        """Every tenant's shared bridge runs on the one app bot by design."""
        assert TelegramAdapter.exclusive_resource({"event_delivery": "shared"}) is None

    async def test_the_app_bot_cannot_be_connected_as_a_bridge(self) -> None:
        """Its updates go to the webhook, and a tenant polling it would take
        every other tenant's."""
        lifecycle = _lifecycle()
        lifecycle.reserve_resource(bot_resource("123456"), "Telegram app bot")

        with pytest.raises(ValueError, match="this deployment's own Telegram app bot"):
            await lifecycle.reject_claim_conflict(
                "telegram",
                {"bot_token": "123456:placeholder", "bot_username": "switch_app_bot"},
            )


class _BridgeStore:
    def __init__(self, bridge: CollaborationBridge) -> None:
        self.bridge = bridge

    async def get(self, session: Any, bridge_id: str) -> CollaborationBridge:
        return self.bridge


class _Session:
    """The request's session; the route commits it before checking the edit."""

    async def commit(self) -> None:
        return None


class TestEditingAConnection:
    async def _patch(
        self, lifecycle: Any, stored: dict[str, object], change: dict[str, object]
    ) -> None:
        bridge = CollaborationBridge(
            id="b1", type="telegram", display_name="Telegram", connection_config=stored
        )
        await update_bridge(
            "b1",
            BridgeUpdateRequest(connection_config=change),
            _Session(),  # type: ignore[arg-type]
            _BridgeStore(bridge),  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            lifecycle,
            None,  # type: ignore[arg-type]
        )

    async def test_the_delivery_mode_cannot_be_changed(self) -> None:
        """It would turn an install into a bridge polling a bot of its own."""
        with pytest.raises(HTTPException) as refused:
            await self._patch(
                _lifecycle(),
                {"event_delivery": "shared"},
                {
                    "event_delivery": "own_connection",
                    "bot_token": "1:placeholder",
                    "bot_username": "b",
                },
            )
        assert refused.value.status_code == 422

    async def test_the_app_bot_cannot_be_edited_in(self) -> None:
        lifecycle = _lifecycle()
        lifecycle.reserve_resource(bot_resource("123456"), "Telegram app bot")
        with pytest.raises(HTTPException) as refused:
            await self._patch(
                lifecycle,
                {
                    "event_delivery": "own_connection",
                    "bot_token": "987:placeholder",
                    "bot_username": "acme_bot",
                },
                {"bot_token": "123456:placeholder"},
            )
        assert refused.value.status_code == 400


class TestRefusedClaims:
    @pytest.mark.parametrize("reason", sorted(CLAIM_REFUSED))
    async def test_the_chat_is_told_why(self, reason: str) -> None:
        installer, bot = await _installer()
        claim = InstallClaim(
            token="c1token",
            grant=InstallGrant(
                external_workspace_id="-1001",
                workspace_name="Telegram",
                bot_token=None,
                scopes="",
                platform_data={},
            ),
            claimant="42",
        )

        await installer.on_claim_refused(claim=claim, reason=reason)  # type: ignore[arg-type]

        assert bot.sent == [{"chat_id": -1001, "text": CLAIM_REFUSED[reason]}]  # type: ignore[index]


#: As long as a real compact state: `c1` and 44 bytes, base64 without padding.
_TOKEN = "c1" + "A" * 59


def _proposal_claim() -> InstallClaim:
    return InstallClaim(
        token=_TOKEN,
        grant=InstallGrant(
            external_workspace_id="-1001",
            workspace_name="Telegram",
            bot_token=None,
            scopes="",
            platform_data={},
        ),
        claimant="42",
    )


def _press(data: str, *, chat_type: str = "supergroup") -> dict[str, Any]:
    return {
        "update_id": 2,
        "callback_query": {
            "id": "press-1",
            "from": {"id": 7, "is_bot": False, "first_name": "Ada"},
            "data": data,
            "message": {
                "message_id": 55,
                "chat": {"id": -1001, "type": chat_type},
            },
        },
    }


class TestAskingTheChat:
    """A claim is put to the chat it was posted in, naming the organisation and
    who asked, and connects nothing until one of the chat's admins answers."""

    async def test_it_names_the_organisation_and_who_asked(self) -> None:
        installer, bot = await _installer()

        await installer.on_claim_proposed(
            claim=_proposal_claim(),
            proposal=ClaimProposal(organisation="Acme", requested_by="Ada Lovelace"),
        )

        (sent,) = bot.sent
        assert sent["chat_id"] == -1001
        assert "Organisation: Acme" in sent["text"]
        assert "Requested by: Ada Lovelace" in sent["text"]
        (row,) = sent["reply_markup"].inline_keyboard
        assert [(b.text, b.callback_data) for b in row] == [
            ("Connect", f"c:{_TOKEN}"),
            ("Cancel", f"x:{_TOKEN}"),
        ]

    async def test_its_buttons_fit_telegrams_callback_data(self) -> None:
        installer, bot = await _installer()

        await installer.on_claim_proposed(
            claim=_proposal_claim(),
            proposal=ClaimProposal(organisation="Acme", requested_by="Ada"),
        )

        (row,) = bot.sent[0]["reply_markup"].inline_keyboard
        assert all(len(b.callback_data.encode()) <= 64 for b in row)

    async def test_an_add_waiting_on_an_answer_is_not_told_to_connect(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(install_module, "UNCLAIMED_NOTICE_GRACE", 0.0)
        installer, bot = await _installer()
        await installer.on_claim_proposed(
            claim=_proposal_claim(),
            proposal=ClaimProposal(organisation="Acme", requested_by="Ada"),
        )

        await _answer(installer, _added(), owned=False)

        assert len(bot.sent) == 1


class TestAnswers:
    async def test_connect_and_cancel_are_read_with_who_pressed(self) -> None:
        installer, _ = await _installer()

        connect = installer.answer_of_event(_press(f"c:{_TOKEN}"))
        cancel = installer.answer_of_event(_press(f"x:{_TOKEN}"))

        assert connect is not None and cancel is not None
        assert (connect.decision, cancel.decision) == ("connect", "cancel")
        assert connect.claim.token == _TOKEN
        assert connect.claim.claimant == "7"
        assert connect.claim.grant.external_workspace_id == "-1001"

    @pytest.mark.parametrize("data", ["sw:token:1", "sx:turn", "c:", "connect"])
    def test_any_other_press_is_not_one(self, data: str) -> None:
        installer = TelegramAppInstaller(client=MagicMock(), webhook_secret=_SECRET)
        assert installer.answer_of_event(_press(data)) is None

    async def test_connected_closes_the_press_and_the_proposal(self) -> None:
        installer, bot = await _installer()
        answer = installer.answer_of_event(_press(f"c:{_TOKEN}"))
        assert answer is not None

        await installer.on_claim_answered(answer=answer, outcome="connected")

        assert bot.answered == [{"callback_query_id": "press-1"}]
        assert bot.edited == [
            {"chat_id": -1001, "message_id": 55, "text": ANSWERED["connected"]}
        ]
        assert bot.left == []

    async def test_cancelled_takes_the_bot_out(self) -> None:
        installer, bot = await _installer()
        answer = installer.answer_of_event(_press(f"x:{_TOKEN}"))
        assert answer is not None

        await installer.on_claim_answered(answer=answer, outcome="cancelled")

        assert bot.edited[0]["text"] == ANSWERED["cancelled"]
        assert bot.left == [-1001]

    async def test_a_press_from_someone_not_an_admin_leaves_the_proposal(
        self,
    ) -> None:
        """Only the presser hears why, and an admin can still answer."""
        installer, bot = await _installer()
        answer = installer.answer_of_event(_press(f"c:{_TOKEN}"))
        assert answer is not None

        await installer.on_claim_answered(answer=answer, outcome="not_chat_admin")

        assert bot.answered == [
            {
                "callback_query_id": "press-1",
                "text": NOT_AN_ADMIN_ALERT,
                "show_alert": True,
            }
        ]
        assert bot.edited == []

    async def test_a_link_that_ran_out_says_so_in_place_of_the_proposal(
        self,
    ) -> None:
        installer, bot = await _installer()
        answer = installer.answer_of_event(_press(f"c:{_TOKEN}"))
        assert answer is not None

        await installer.on_claim_answered(answer=answer, outcome="expired")

        assert bot.edited[0]["text"] == CLAIM_REFUSED["expired"]
        assert bot.left == []
