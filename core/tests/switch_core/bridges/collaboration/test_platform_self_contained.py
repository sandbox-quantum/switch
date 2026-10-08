"""Adding a messaging platform touches its adapter folder and one line, nothing else.

Dummy Chat (`dummy_platform/`) is registered here the way `platforms.py`
registers a real platform, and every part of Switch that used to keep its own
list of platforms is asked about it: the gateway's platform list, telemetry,
the session contract, the cards that say where an answer came from, and the
failure classifier. Then Dummy Hook, its webhook flavour, takes a signed event
on its own address all the way to the adapter.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import messaging_platforms
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
    _failure_reason,
)
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.session.renderers import surface_label
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.gateway.collaborations import list_bridge_types
from switch_core.sessions.contract import DecidedBy
from switch_core.telemetry.catalogue import validate
from switch_core.telemetry.snapshot import UsageCounts, normalise_platform

from .dummy_platform.adapter import (
    SIGNATURE_HEADER,
    DummyChatAdapter,
    DummyChatConnectionConfig,
    DummyChatError,
    DummyHookAdapter,
    DummyHookConnectionConfig,
    sign,
)
from .test_lifecycle_tenant_binding import _service


@pytest.fixture
def lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = _service(session_factory)
    service._config.messaging_public_url = "https://switch.example"
    # The one line a platform adds.
    service.register_adapter("dummychat", DummyChatAdapter, DummyChatConnectionConfig)
    service.register_adapter("dummyhook", DummyHookAdapter, DummyHookConnectionConfig)
    return service


class TestEverythingLearnsThePlatformFromItsAdapter:
    async def test_the_gateway_lists_it_with_its_name_icon_docs_and_capabilities(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        types = {t.key: t for t in await list_bridge_types(lifecycle, MagicMock())}

        dummy = types["dummychat"]
        assert dummy.display_name == "Dummy Chat"
        assert dummy.docs_slug == "dummy-chat"
        assert dummy.icon_svg is not None and dummy.icon_svg.startswith("<svg")
        assert dummy.channel_creation_supported is False
        assert dummy.directory_search_supported is False
        assert dummy.receives_webhooks is False
        assert dummy.config_schema["required"] == ["api_token"]
        assert types["dummyhook"].receives_webhooks is True

    async def test_telemetry_reports_it_by_name(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        assert normalise_platform("dummychat") == "dummychat"
        validate(
            "bridge_connected",
            {
                "bridge": "collaboration",
                "bridge_platform": "dummychat",
                "outcome": "success",
                "failure_reason": "none",
                "duration_ms": 12,
            },
        )

    async def test_the_daily_snapshot_counts_its_connections(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        counts = UsageCounts()
        counts.connector_counts["dummychat"] += 2
        properties = counts.as_event_properties(session_live_count=0)

        assert properties["connector_dummychat_count"] == 2
        assert properties["connector_slack_count"] == 0
        validate("usage_snapshot", properties)

    async def test_a_platform_nobody_registered_is_unknown_not_no_bridge(self) -> None:
        assert normalise_platform("neverregistered") == "unknown"
        assert normalise_platform(None) == "none"

    async def test_an_answer_given_on_it_is_valid_and_named_on_cards(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        decided = DecidedBy(actor_id="ada", surface="dummychat", command_id="c-1")
        assert surface_label(decided.surface) == "Dummy Chat"

    async def test_its_own_failures_are_classified_by_its_adapter(self) -> None:
        assert _failure_reason(DummyChatError("bad_token"), DummyChatAdapter) == (
            "auth_failed"
        )
        assert _failure_reason(DummyChatError("down"), DummyChatAdapter) == (
            "platform_error"
        )

    async def test_an_adapter_that_does_not_name_its_platform_is_refused(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        class _Nameless(DummyChatAdapter):
            display_name = ""

        with pytest.raises(ValueError, match="declares no display_name"):
            lifecycle.register_adapter("nameless", _Nameless, DummyChatConnectionConfig)

    async def test_a_key_that_could_carry_free_text_is_refused(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        with pytest.raises(messaging_platforms.PlatformKeyInvalid):
            lifecycle.register_adapter(
                "Dummy Chat!", DummyChatAdapter, DummyChatConnectionConfig
            )


class _RunningBridge:
    """What the lifecycle keeps for a running bridge, as far as webhooks look."""

    def __init__(self, adapter: Any) -> None:
        self.adapter = adapter


async def _hook_bridge(
    session_factory: async_sessionmaker[AsyncSession], *, bridge_type: str
) -> str:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant, slug=tenant, name=tenant))
        await session.flush()
        client = Client(
            tenant_id=tenant,
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=tenant,
            type=bridge_type,
            display_name="Dummy",
            client_id=client.id,
            status="active",
            connection_config={"signing_secret": "s3cret"},
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()
    return bridge_id


class TestAWebhookPlatformReceivesAVerifiedEventEndToEnd:
    @pytest.fixture
    async def hook(
        self,
        lifecycle: CollaborationBridgeLifecycleService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]]:
        bridge_id = await _hook_bridge(session_factory, bridge_type="dummyhook")
        adapter = DummyHookAdapter(
            config=DummyHookConnectionConfig(signing_secret="s3cret")
        )
        heard: list[InboundMessage] = []

        async def on_message(message: InboundMessage) -> None:
            heard.append(message)

        async def ignore(_: Any) -> None:
            return None

        await adapter.start(on_message, ignore, ignore, ignore, ignore)
        lifecycle._bridges[bridge_id] = _RunningBridge(adapter)  # type: ignore[assignment]

        app = FastAPI()
        app.include_router(
            create_bridge_webhook_router(
                BridgeWebhookService(
                    lifecycle=lifecycle,
                    session_factory=session_factory,
                    receipts=MessagingEventReceiptStore(),
                )
            )
        )
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
        )
        return client, bridge_id, adapter, heard

    @staticmethod
    def _event(event_id: str, text: str = "hello") -> bytes:
        return json.dumps(
            {"id": event_id, "channel": "c-1", "user": "ada", "text": text}
        ).encode()

    async def test_a_signed_event_reaches_the_room_side_of_the_bridge(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, bridge_id, adapter, heard = hook
        body = self._event("evt-1")

        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign("s3cret", body)},
        )

        assert response.status_code == 200
        assert [m.content for m in heard] == ["hello"]
        assert adapter.dispatched[0][0] == "message"

    async def test_an_event_signed_with_another_secret_is_refused(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, bridge_id, adapter, heard = hook
        body = self._event("evt-2")

        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign("someone-elses", body)},
        )

        assert response.status_code == 401
        assert heard == []

    async def test_a_retried_delivery_is_handled_once(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, bridge_id, adapter, heard = hook
        body = self._event("evt-3")
        headers = {SIGNATURE_HEADER: sign("s3cret", body)}

        first = await client.post(
            webhook_path(bridge_id), content=body, headers=headers
        )
        again = await client.post(
            webhook_path(bridge_id), content=body, headers=headers
        )

        assert (first.status_code, again.status_code) == (200, 200)
        assert len(heard) == 1

    async def test_the_platforms_address_check_is_answered_and_nothing_dispatched(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, bridge_id, adapter, heard = hook

        response = await client.get(
            webhook_path(bridge_id), params={"token": "s3cret", "challenge": "abc123"}
        )

        assert response.status_code == 200
        assert response.text == "abc123"
        assert adapter.dispatched == []

    async def test_an_unreadable_verified_body_is_a_400(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, bridge_id, _adapter, _heard = hook
        body = b"not json"

        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign("s3cret", body)},
        )

        assert response.status_code == 400

    async def test_an_address_nobody_owns_is_not_found(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
    ) -> None:
        client, _bridge_id, _adapter, _heard = hook
        response = await client.post(webhook_path("no-such-bridge"), content=b"{}")
        assert response.status_code == 404

    async def test_a_stopped_bridge_asks_the_platform_to_retry(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
        lifecycle: CollaborationBridgeLifecycleService,
    ) -> None:
        client, bridge_id, _adapter, _heard = hook
        lifecycle._bridges.pop(bridge_id)

        response = await client.post(webhook_path(bridge_id), content=b"{}")

        assert response.status_code == 503

    async def test_a_platform_without_webhooks_has_no_address(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
        lifecycle: CollaborationBridgeLifecycleService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        client, _bridge_id, _adapter, _heard = hook
        chat_bridge = await _hook_bridge(session_factory, bridge_type="dummychat")

        response = await client.post(webhook_path(chat_bridge), content=b"{}")

        assert response.status_code == 404
        assert lifecycle.webhook_url(chat_bridge, "dummychat") is None

    async def test_the_operator_is_given_the_address_to_paste_into_the_platform(
        self,
        hook: tuple[httpx.AsyncClient, str, DummyHookAdapter, list[InboundMessage]],
        lifecycle: CollaborationBridgeLifecycleService,
    ) -> None:
        _client, bridge_id, _adapter, _heard = hook
        assert lifecycle.webhook_url(bridge_id, "dummyhook") == (
            f"https://switch.example/messaging/bridges/{bridge_id}/events"
        )
