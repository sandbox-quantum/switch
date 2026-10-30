"""Each place Switch fetches a URL a tenant or agent chose goes through the
outbound policy: bridge configs when stored and started, and Slack file
downloads."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeStartRefused,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
from tests.ownership import SoleOwner


class _ServerConfig(BridgeConnectionConfig):
    url: str


class _ServerAdapter(SlackAdapter):
    """A platform reached at a URL its config names."""

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["url"])]

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        return None


def _server_config(url: str) -> dict[str, object]:
    return {"url": url}


def _bridge_lifecycle(policy: OutboundPolicy) -> CollaborationBridgeLifecycleService:
    config = MagicMock()
    config.outbound_policy = policy
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=MagicMock(),
        config=config,
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
        ownership=SoleOwner(),
        cursor_writer=SoleOwner.cursor_writer(MagicMock()),
    )
    service.register_adapter("server", _ServerAdapter, _ServerConfig)
    return service


class TestBridgeConfigs:
    async def test_registering_a_private_server_url_is_refused(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse(""))
        with pytest.raises(OutboundURLRefused):
            await service.register(
                bridge_type="server",
                display_name="Internal",
                connection_config=_server_config("http://10.1.2.3:8065"),
                channel_creation_enabled=False,
                preconfigured=False,
            )

    async def test_an_edit_or_start_naming_one_is_refused(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse(""))
        with pytest.raises(BridgeStartRefused, match="10.1.2.3"):
            await service.check_start_guards(
                bridge_id="bridge-1",
                tenant_id="tenant-1",
                bridge_type="server",
                connection_config=_server_config("http://10.1.2.3:8065"),
            )

    async def test_an_allowed_private_host_passes(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse("localhost"))
        await service.check_start_guards(
            bridge_id="bridge-1",
            tenant_id="tenant-1",
            bridge_type="server",
            connection_config=_server_config("http://localhost:8065"),
        )


class TestSlackFileDownloads:
    @pytest.mark.parametrize(
        "url",
        [
            "https://evil.example/files-pri/T1/x",
            "https://files.slack.com.evil.example/x",
            "http://files.slack.com/files-pri/T1/x",
            "https://notslack.com/x",
        ],
    )
    async def test_only_slack_is_sent_the_bot_token(self, url: str) -> None:
        adapter = SlackAdapter(
            config=SlackConnectionConfig(
                bot_token="xoxb-test", app_token="xapp-test", workspace_id="T1"
            )
        )
        with pytest.raises(ValueError, match="not a Slack file URL"):
            await adapter._download_file(url)
