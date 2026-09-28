"""The distributed Telegram app's installer, and the shared bot behind it.

Everything here reads an update Telegram posted, before any tenant is known,
so it is pure and needs no database. What matters is that the reading is
exact: which chat an update belongs to decides whose rooms it reaches, and a
claim read from the wrong message would attach a chat to a tenant nobody chose.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.collaboration.install import (
    MessagingInstallerRegistry,
    WebhookAuthenticityError,
    WebhookPayloadError,
)
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.telegram.adapter import (
    _ALLOWED_UPDATES,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.app_client import (
    ALLOWED_UPDATES,
    TelegramAppClient,
    TelegramAppNotReady,
    bot_id_of,
)
from switch_core.bridges.collaboration.telegram.install import (
    SECRET_TOKEN_HEADER,
    TelegramAppInstaller,
)

_SECRET = "placeholder-secret"
_WEBHOOK_URL = "https://switch.example/messaging/telegram/events"


@dataclass
class _Me:
    id: int
    username: str | None
    can_read_all_group_messages: bool = True
    can_join_groups: bool = True


@dataclass
class _FakeBot:
    """Stands in for `telegram.Bot`, recording what the client asked of it."""

    token: str = "123456:placeholder-token"
    username: str | None = "switch_app_bot"
    webhooks: list[dict[str, Any]] = field(default_factory=list)
    menus: list[list[Any]] = field(default_factory=list)
    shut_down: bool = False

    async def initialize(self) -> None:
        return None

    async def get_me(self) -> _Me:
        return _Me(id=123456, username=self.username)

    async def set_webhook(self, **kwargs: Any) -> bool:
        self.webhooks.append(kwargs)
        return True

    async def set_my_commands(self, commands: Any) -> bool:
        self.menus.append(list(commands))
        return True

    async def shutdown(self) -> None:
        self.shut_down = True


async def _nothing(client: TelegramAppClient) -> None:
    return None


def _client(bot: _FakeBot | None = None) -> TelegramAppClient:
    return TelegramAppClient(
        bot=bot or _FakeBot(),  # type: ignore[arg-type]
        webhook_url=_WEBHOOK_URL,
        webhook_secret=_SECRET,
        on_connected=_nothing,
    )


async def _installer() -> TelegramAppInstaller:
    client = _client()
    await client.start()
    return TelegramAppInstaller(client=client, webhook_secret=_SECRET)


def _group_message(text: str, *, chat_id: int = -1001, chat_type: str = "supergroup"):
    return {
        "update_id": 7,
        "message": {
            "message_id": 1,
            "chat": {"id": chat_id, "type": chat_type, "title": "Acme"},
            "from": {"id": 42, "is_bot": False, "first_name": "Ada"},
            "text": text,
        },
    }


def _channel_post(text: str, *, chat_id: int = -1002):
    return {
        "update_id": 8,
        "channel_post": {
            "message_id": 1,
            "chat": {"id": chat_id, "type": "channel", "title": "News"},
            "text": text,
        },
    }


def _membership(status: str, *, chat_id: int = -1001):
    return {
        "update_id": 9,
        "my_chat_member": {
            "chat": {"id": chat_id, "type": "supergroup"},
            "from": {"id": 42, "is_bot": False, "first_name": "Ada"},
            "old_chat_member": {"status": "member", "user": {"id": 123456}},
            "new_chat_member": {"status": status, "user": {"id": 123456}},
        },
    }


class TestTheSharedBot:
    def test_the_bot_id_is_read_from_the_token(self) -> None:
        assert bot_id_of("123456:placeholder") == "123456"

    def test_a_token_without_an_id_is_refused(self) -> None:
        with pytest.raises(ValueError):
            bot_id_of("placeholder")

    async def test_it_has_no_username_until_it_has_asked(self) -> None:
        client = _client()
        with pytest.raises(TelegramAppNotReady):
            client.bot_username

        await client.start()

        assert client.bot_username == "switch_app_bot"

    async def test_start_points_telegram_at_the_webhook(self) -> None:
        """Every start, so the URL, secret and update types always match the
        running config — rotating the secret is a redeploy."""
        bot = _FakeBot()
        await _client(bot).start()

        assert bot.webhooks == [
            {
                "url": _WEBHOOK_URL,
                "secret_token": _SECRET,
                "allowed_updates": list(ALLOWED_UPDATES),
            }
        ]

    async def test_a_bot_with_no_username_does_not_start(self) -> None:
        """Every link is built from the username, so there is nothing to offer."""
        bot = _FakeBot(username=None)
        with pytest.raises(Exception, match="no username"):
            await _client(bot).start()
        assert bot.webhooks == []

    async def test_start_publishes_the_command_menu_once_for_every_tenant(
        self,
    ) -> None:
        bot = _FakeBot()
        await _client(bot).start()
        assert len(bot.menus) == 1 and bot.menus[0]

    async def test_bridges_already_running_are_handed_the_bot_once_it_is_up(
        self,
    ) -> None:
        connected: list[TelegramAppClient] = []

        async def on_connected(client: TelegramAppClient) -> None:
            connected.append(client)

        client = TelegramAppClient(
            bot=_FakeBot(),  # type: ignore[arg-type]
            webhook_url=_WEBHOOK_URL,
            webhook_secret=_SECRET,
            on_connected=on_connected,
        )
        await client.start_with_retry()

        assert connected == [client]

    def test_it_asks_for_what_the_self_registered_bot_polls_for(self) -> None:
        """One adapter reads both, so they must be offered the same updates."""
        assert list(ALLOWED_UPDATES) == list(_ALLOWED_UPDATES)


class TestAuthenticity:
    async def test_the_right_secret_is_accepted(self) -> None:
        installer = await _installer()
        installer.verify_webhook(headers={SECRET_TOKEN_HEADER: _SECRET}, body=b"{}")

    async def test_the_header_name_is_case_insensitive(self) -> None:
        """Starlette hands the route lower-cased header names."""
        installer = await _installer()
        installer.verify_webhook(
            headers={SECRET_TOKEN_HEADER.lower(): _SECRET}, body=b"{}"
        )

    async def test_a_wrong_secret_is_refused(self) -> None:
        installer = await _installer()
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(
                headers={SECRET_TOKEN_HEADER: "not-it"}, body=b"{}"
            )

    async def test_a_missing_secret_is_refused(self) -> None:
        installer = await _installer()
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(headers={}, body=b"{}")


class TestParsing:
    async def test_the_update_id_is_what_retries_are_caught_by(self) -> None:
        installer = await _installer()
        event = installer.parse_webhook(
            endpoint="events",
            headers={},
            body=json.dumps(_group_message("hello")).encode(),
        )
        assert event.external_event_id == "7"
        assert event.delivery_attempt == 0
        assert event.handshake is None

    async def test_an_update_without_an_id_is_refused(self) -> None:
        installer = await _installer()
        with pytest.raises(WebhookPayloadError):
            installer.parse_webhook(endpoint="events", headers={}, body=b"{}")

    async def test_a_body_that_is_not_json_is_refused(self) -> None:
        installer = await _installer()
        with pytest.raises(WebhookPayloadError):
            installer.parse_webhook(endpoint="events", headers={}, body=b"<html>")

    async def test_only_the_events_endpoint_is_telegrams(self) -> None:
        installer = await _installer()
        body = json.dumps(_group_message("hello")).encode()
        with pytest.raises(WebhookPayloadError):
            installer.parse_webhook(endpoint="interactive", headers={}, body=body)


class TestWhichChat:
    @pytest.mark.parametrize(
        ("payload", "chat"),
        [
            (_group_message("hi", chat_id=-1001), "-1001"),
            (_channel_post("hi", chat_id=-1002), "-1002"),
            (_membership("member", chat_id=-1003), "-1003"),
            (
                {
                    "update_id": 1,
                    "callback_query": {
                        "id": "cb",
                        "message": {"chat": {"id": -1004, "type": "group"}},
                    },
                },
                "-1004",
            ),
        ],
    )
    async def test_each_update_type_names_its_chat(
        self, payload: dict[str, Any], chat: str
    ) -> None:
        installer = await _installer()
        assert installer.workspace_of_event(payload) == chat

    async def test_a_migrated_chat_is_routed_by_the_id_it_had(self) -> None:
        """The new id is owned by nobody until the install row follows it."""
        installer = await _installer()
        payload = _group_message("", chat_id=-1009)
        payload["message"]["migrate_from_chat_id"] = -55

        assert installer.workspace_of_event(payload) == "-55"

    async def test_an_update_with_no_chat_is_refused(self) -> None:
        installer = await _installer()
        with pytest.raises(WebhookPayloadError):
            installer.workspace_of_event({"update_id": 1, "poll": {}})


class TestRevocation:
    @pytest.mark.parametrize("status", ["left", "kicked"])
    async def test_the_bot_leaving_ends_the_install(self, status: str) -> None:
        installer = await _installer()
        reason = installer.revocation_of_event(_membership(status))
        assert reason is not None and status in reason

    @pytest.mark.parametrize("status", ["member", "administrator", "restricted"])
    async def test_anything_else_does_not(self, status: str) -> None:
        installer = await _installer()
        assert installer.revocation_of_event(_membership(status)) is None

    async def test_an_ordinary_message_does_not(self) -> None:
        installer = await _installer()
        assert installer.revocation_of_event(_group_message("bye")) is None


class TestClaims:
    async def test_the_handshake_from_the_link_is_a_claim(self) -> None:
        installer = await _installer()
        claim = installer.claim_of_event(
            _group_message("/start@switch_app_bot c1token", chat_id=-1001)
        )

        assert claim is not None
        assert claim.token == "c1token"
        assert claim.grant.external_workspace_id == "-1001"
        assert claim.grant.bot_token is None

    async def test_connect_in_a_channel_is_a_claim(self) -> None:
        installer = await _installer()
        claim = installer.claim_of_event(
            _channel_post("/connect c1token", chat_id=-1002)
        )

        assert claim is not None
        assert claim.grant.external_workspace_id == "-1002"

    async def test_the_bot_name_is_matched_without_case(self) -> None:
        installer = await _installer()
        claim = installer.claim_of_event(
            _group_message("/start@Switch_App_Bot c1token")
        )
        assert claim is not None

    async def test_a_command_for_another_bot_is_not_ours(self) -> None:
        """With privacy off this bot sees other bots' commands too."""
        installer = await _installer()
        assert (
            installer.claim_of_event(_group_message("/start@other_bot c1token")) is None
        )

    async def test_a_private_chat_never_claims(self) -> None:
        installer = await _installer()
        message = _group_message("/start c1token", chat_id=42, chat_type="private")
        assert installer.claim_of_event(message) is None

    @pytest.mark.parametrize(
        "text", ["/start", "/connect", "/start a b", "/invite-agent c1token", "hello"]
    )
    async def test_other_text_is_not_a_claim(self, text: str) -> None:
        installer = await _installer()
        assert installer.claim_of_event(_group_message(text)) is None

    async def test_a_membership_change_is_not_a_claim(self) -> None:
        installer = await _installer()
        assert installer.claim_of_event(_membership("member")) is None


class TestTheLink:
    async def test_it_adds_the_bot_to_a_group_with_the_state(self) -> None:
        installer = await _installer()
        url = installer.authorize_url(state="c1token", redirect_uri="unused")
        assert url == "https://t.me/switch_app_bot?startgroup=c1token"

    def test_there_is_no_link_before_the_bot_has_connected(self) -> None:
        installer = TelegramAppInstaller(client=_client(), webhook_secret=_SECRET)
        with pytest.raises(TelegramAppNotReady):
            installer.authorize_url(state="c1token", redirect_uri="unused")

    async def test_the_bridge_config_carries_no_credential(self) -> None:
        installer = await _installer()
        claim = installer.claim_of_event(_group_message("/start c1token"))
        assert claim is not None
        assert installer.connection_config(claim.grant) == {"event_delivery": "shared"}

    async def test_the_bridge_config_is_one_the_telegram_bridge_accepts(self) -> None:
        """Registration validates it against the adapter's config, and a claim
        whose config were refused there would roll back every time."""
        installer = await _installer()
        claim = installer.claim_of_event(_group_message("/start c1token"))
        assert claim is not None

        config = TelegramConnectionConfig.model_validate(
            installer.connection_config(claim.grant)
        )

        assert config.event_delivery == "shared"


class TestTheRoute:
    """Only the paths that end before a tenant is resolved, so the service
    needs nothing behind it."""

    def _client_for(self, installer: TelegramAppInstaller) -> httpx.AsyncClient:
        installers = MessagingInstallerRegistry()
        installers.register(installer)
        service = MessagingInstallService(
            session_factory=None,  # type: ignore[arg-type]
            store=None,  # type: ignore[arg-type]
            receipts=None,  # type: ignore[arg-type]
            installers=installers,
            lifecycle=None,  # type: ignore[arg-type]
            users=None,  # type: ignore[arg-type]
            rooms=None,  # type: ignore[arg-type]
            public_origin="https://switch.example",
            secret="unused",
        )
        app = FastAPI()
        app.include_router(create_messaging_install_router(service))
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
        )

    async def test_a_post_without_the_secret_is_refused(self) -> None:
        async with self._client_for(await _installer()) as client:
            response = await client.post(
                "/messaging/telegram/events",
                content=json.dumps(_group_message("hello")).encode(),
                headers={SECRET_TOKEN_HEADER: "not-it"},
            )
        assert response.status_code == 401

    async def test_a_claim_before_the_bot_has_connected_is_retried(self) -> None:
        """A 503, so Telegram holds the claim and sends it again, rather than a
        claim dropped because the bot did not yet know its own name."""
        installer = TelegramAppInstaller(client=_client(), webhook_secret=_SECRET)
        async with self._client_for(installer) as client:
            response = await client.post(
                "/messaging/telegram/events",
                content=json.dumps(
                    _group_message("/start@switch_app_bot c1token")
                ).encode(),
                headers={SECRET_TOKEN_HEADER: _SECRET},
            )
        assert response.status_code == 503
