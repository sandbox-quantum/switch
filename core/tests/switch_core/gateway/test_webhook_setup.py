from __future__ import annotations

from switch_core.bridges.collaboration.webhook.adapter import WebhookAdapter
from switch_core.gateway.collaborations import create_bridge, list_bridges
from switch_core.gateway.schemas import BridgeCreateRequest
from tests.switch_core.gateway.test_collaborations_authz import (
    _BRIDGE_STORE,
    _ROOM_STORE,
    _admin,
    _make_bridge,
)
from tests.switch_core.gateway.test_collaborations_preconfigured import _Lifecycle


async def test_generated_secrets_are_returned_only_when_the_admin_creates_the_bridge(
    session_factory,
):
    config = await WebhookAdapter.prepare_config(
        {"outbound_url": "https://chat.example/receive"}
    )
    async with session_factory() as db, db.begin():
        bridge_id = await _make_bridge(db)
        bridge = await _BRIDGE_STORE.get(db, bridge_id)
        bridge.type = "webhook"
        bridge.connection_config = config
    lifecycle = _Lifecycle(registered=bridge)
    lifecycle.adapter_class = lambda _: WebhookAdapter
    async with session_factory() as db:
        created = await create_bridge(
            BridgeCreateRequest(
                bridge_type="webhook",
                display_name="Custom app",
                connection_config={"outbound_url": config["outbound_url"]},
                channel_creation_enabled=False,
            ),
            db,
            _BRIDGE_STORE,
            lifecycle,
            _admin(),
        )
    assert created.setup_values == WebhookAdapter.setup_values(config)
    async with session_factory() as db:
        listed = await list_bridges(db, _BRIDGE_STORE, _ROOM_STORE, lifecycle, _admin())
    assert all(item.setup_values is None for item in listed)
