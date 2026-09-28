"""A Telegram bridge on the distributed app's shared bot.

Such a bridge polls nothing and holds no token: it is handed the deployment's
one bot, receives its updates from the webhook route, and waits out rate limits
against the one cooldown every tenant shares. The tests here are about what
differs from a self-registered bridge, and about the handful of places where
getting it wrong would reach another tenant: two bridges must share one
cooldown, and a bridge must never be handed anything but the Telegram bot.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError
from telegram.error import RetryAfter

from switch_core.bridges.collaboration.adapter import (
    RichContentThrottled,
    WebhookDeliveryUnsupported,
)
from switch_core.bridges.collaboration.models import InboundAppJoin, InboundMessage
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.app_client import TelegramAppClient
from switch_core.observability.catalogue import BRIDGE_THROTTLE_HELD
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.switch_core.bridges.collaboration.test_telegram_adapter import (
    _FakeBot,
)

_BOT_ID = 777
_USERNAME = "switch_app_bot"


class _Me:
    id = _BOT_ID
    username = _USERNAME
    can_read_all_group_messages = True
    can_join_groups = True


class _SharedBot(_FakeBot):
    """The adapter tests' fake bot, plus what the shared client asks of it."""

    token = f"{_BOT_ID}:placeholder-token"

    async def initialize(self) -> None:
        return None

    async def get_me(self) -> _Me:
        return _Me()

    async def set_webhook(self, **kwargs: Any) -> bool:
        return True

    async def shutdown(self) -> None:
        return None


async def _nothing(client: TelegramAppClient) -> None:
    return None


async def _client() -> TelegramAppClient:
    client = TelegramAppClient(
        bot=_SharedBot(),  # type: ignore[arg-type]
        webhook_url="https://switch.example/messaging/telegram/events",
        webhook_secret="placeholder-secret",
        on_connected=_nothing,
    )
    await client.start()
    return client


def _shared_adapter() -> TelegramAdapter:
    return TelegramAdapter(
        config=TelegramConnectionConfig(event_delivery="shared"),
    )


def _joins(adapter: TelegramAdapter) -> list[InboundAppJoin]:
    joined: list[InboundAppJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        joined.append(join)

    adapter._on_app_joined = on_app_joined
    return joined


class TestConfig:
    def test_a_shared_bridge_carries_no_credential(self) -> None:
        config = TelegramConnectionConfig(event_delivery="shared")
        assert config.bot_token is None and config.bot_username is None

    def test_a_shared_bridge_with_a_token_is_refused(self) -> None:
        """A credential for a bot it does not own, which polling would steal
        every tenant's updates with."""
        with pytest.raises(ValidationError, match="shared-delivery"):
            TelegramConnectionConfig(
                event_delivery="shared", bot_token="1:placeholder", bot_username="x"
            )

    def test_a_self_registered_bridge_without_a_token_is_refused(self) -> None:
        with pytest.raises(ValidationError, match="bot_token and bot_username"):
            TelegramConnectionConfig(bot_username="acme_bot")

    def test_a_self_registered_bridge_is_unchanged(self) -> None:
        config = TelegramConnectionConfig(bot_token="1:placeholder", bot_username="b")
        assert config.event_delivery == "own_connection"

    def test_the_delivery_mode_is_not_on_the_registration_form(self) -> None:
        assert (
            "event_delivery"
            not in TelegramConnectionConfig.model_json_schema()["properties"]
        )


class TestAttaching:
    async def test_start_polls_nothing(self) -> None:
        adapter = _shared_adapter()
        await adapter.start(
            on_message=None,  # type: ignore[arg-type]
            on_command=None,  # type: ignore[arg-type]
            on_agent_joined=None,  # type: ignore[arg-type]
            on_user_joined=None,  # type: ignore[arg-type]
            on_app_joined=None,  # type: ignore[arg-type]
        )
        assert adapter._app is None
        assert adapter._bot is None

    async def test_attaching_hands_it_the_shared_bot(self) -> None:
        client = await _client()
        adapter = _shared_adapter()

        adapter.attach_shared_connection(client)

        assert adapter._bot is client.bot
        assert adapter._bot_user_id == _BOT_ID
        assert adapter._bot_username == _USERNAME
        assert adapter._privacy_mode_disabled is True

    async def test_attaching_runs_the_deferred_start_work_once(self) -> None:
        client = await _client()
        adapter = _shared_adapter()
        fired: list[None] = []
        adapter.set_on_attached(lambda: fired.append(None))

        adapter.attach_shared_connection(client)
        adapter.attach_shared_connection(client)

        assert fired == [None]

    async def test_a_self_registered_bridge_is_never_attached(self) -> None:
        client = await _client()
        adapter = TelegramAdapter(
            config=TelegramConnectionConfig(bot_token="1:placeholder", bot_username="b")
        )

        adapter.attach_shared_connection(client)

        assert adapter._bot is None

    def test_anything_but_the_telegram_client_is_refused(self) -> None:
        """Discord's shared connection is attached through the same method."""
        adapter = _shared_adapter()
        with pytest.raises(TypeError, match="Telegram app client"):
            adapter.attach_shared_connection(object())

    async def test_a_shared_bridge_offers_no_unsigned_add_link(self) -> None:
        """It would add the bot to a chat that belongs to nobody."""
        adapter = _shared_adapter()
        adapter.attach_shared_connection(await _client())
        assert await adapter.install_links() == []


class TestTheSharedCooldown:
    async def test_a_limit_earned_by_one_tenant_holds_back_another(self) -> None:
        """Telegram meters the bot, and every tenant's bridge is that bot."""
        client = await _client()
        first, second = _shared_adapter(), _shared_adapter()
        first.attach_shared_connection(client)
        second.attach_shared_connection(client)

        first._rich_failure(RetryAfter(30), "update", "text")

        with pytest.raises(RichContentThrottled):
            second._refuse_while_throttled("text")

    async def test_each_hold_back_is_measured(self) -> None:
        registry = MetricsRegistry()
        install(registry)
        try:
            adapter = _shared_adapter()
            adapter.attach_shared_connection(await _client())
            adapter._rich_failure(RetryAfter(30), "update", "text")
            with pytest.raises(RichContentThrottled):
                adapter._refuse_while_throttled("text")

            (payload,) = [
                p for p in registry.collect() if p.name == BRIDGE_THROTTLE_HELD.name
            ]
        finally:
            uninstall()
        (point,) = payload.histograms
        assert point.attributes == {"platform": "telegram", "delivery": "shared"}
        assert point.count == 1


def _update(**body: Any) -> dict[str, Any]:
    return {"update_id": 1, **body}


class TestDelivery:
    async def test_a_claim_in_a_group_is_its_join(self) -> None:
        """The bot's own add was dropped while the chat belonged to nobody, so
        the claim is what provisions the room."""
        adapter = _shared_adapter()
        adapter.attach_shared_connection(await _client())
        joined = _joins(adapter)

        await adapter.dispatch_event(
            envelope_type="events",
            payload=_update(
                message={
                    "message_id": 5,
                    "date": 0,
                    "chat": {"id": -1001, "type": "supergroup", "title": "Acme"},
                    "from": {"id": 42, "is_bot": False, "first_name": "Ada"},
                    "text": f"/start@{_USERNAME} c1token",
                }
            ),
        )

        assert [(j.channel_id, j.channel_name) for j in joined] == [("-1001", "Acme")]

    async def test_connect_in_a_channel_is_its_join(self) -> None:
        """A channel post has no sender and is otherwise dropped unread."""
        adapter = _shared_adapter()
        adapter.attach_shared_connection(await _client())
        joined = _joins(adapter)

        await adapter.dispatch_event(
            envelope_type="events",
            payload=_update(
                channel_post={
                    "message_id": 6,
                    "date": 0,
                    "chat": {"id": -1002, "type": "channel", "title": "News"},
                    "text": "/connect c1token",
                }
            ),
        )

        assert [(j.channel_id, j.channel_name) for j in joined] == [("-1002", "News")]

    async def test_an_ordinary_channel_post_is_still_dropped(self) -> None:
        adapter = _shared_adapter()
        adapter.attach_shared_connection(await _client())
        joined = _joins(adapter)

        await adapter.dispatch_event(
            envelope_type="events",
            payload=_update(
                channel_post={
                    "message_id": 7,
                    "date": 0,
                    "chat": {"id": -1002, "type": "channel", "title": "News"},
                    "text": "morning all",
                }
            ),
        )

        assert joined == []

    async def test_a_post_signed_with_its_authors_profile_is_bridged(self) -> None:
        """With Show Authors' Profiles on, a post carries its author as its
        sender, which is all a message needs to reach the room."""
        adapter = _shared_adapter()
        adapter.attach_shared_connection(await _client())
        seen: list[InboundMessage] = []

        async def on_message(message: InboundMessage) -> None:
            seen.append(message)

        adapter._on_message = on_message

        await adapter.dispatch_event(
            envelope_type="events",
            payload=_update(
                channel_post={
                    "message_id": 8,
                    "date": 0,
                    "chat": {"id": -1002, "type": "channel", "title": "News"},
                    "from": {"id": 42, "is_bot": False, "first_name": "Ada"},
                    "author_signature": "Ada",
                    "text": "morning all",
                }
            ),
        )

        assert [(m.channel_id, m.sender_id, m.content) for m in seen] == [
            ("-1002", "42", "morning all")
        ]

    async def test_a_self_registered_bridge_still_refuses_webhooks(self) -> None:
        adapter = TelegramAdapter(
            config=TelegramConnectionConfig(bot_token="1:placeholder", bot_username="b")
        )
        with pytest.raises(WebhookDeliveryUnsupported):
            await adapter.dispatch_event(envelope_type="events", payload=_update())

    async def test_an_unattached_shared_bridge_fails_loud(self) -> None:
        adapter = _shared_adapter()
        with pytest.raises(RuntimeError, match="not connected"):
            await adapter.dispatch_event(envelope_type="events", payload=_update())


async def test_a_claim_on_a_bridge_that_never_started_fails_loud() -> None:
    """Absorbing it quietly would lose the chat's room: a claim arrives once."""
    adapter = _shared_adapter()
    adapter.attach_shared_connection(await _client())

    with pytest.raises(RuntimeError, match="has not started"):
        await adapter.dispatch_event(
            envelope_type="events",
            payload=_update(
                message={
                    "message_id": 9,
                    "date": 0,
                    "chat": {"id": -1001, "type": "supergroup", "title": "Acme"},
                    "from": {"id": 42, "is_bot": False, "first_name": "Ada"},
                    "text": f"/start@{_USERNAME} c1token",
                }
            ),
        )
