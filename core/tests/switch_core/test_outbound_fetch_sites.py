"""Each place Switch fetches a URL a tenant or agent chose goes through the
outbound policy: bridge configs when stored and started, the
Mattermost driver's redirects, the Mattermost icon fetch, and Slack file
downloads."""

from __future__ import annotations

import json
import threading
from collections.abc import AsyncIterator, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from aiohttp import web
from mattermostdriver import Driver
from mattermostdriver.exceptions import ResourceNotFound

from switch_core.bridges.collaboration import mattermost
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.http_client import (
    MattermostRedirectRefused,
    NoRedirectClient,
)
from switch_core.bridges.collaboration.models import BridgeStartRefused
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.outbound import OutboundPolicy, OutboundURLRefused


def _mattermost_config(url: str) -> dict[str, object]:
    return {
        "url": url,
        "admin_user": "bot",
        "admin_password": "placeholder",  # gitleaks:allow
        "team_name": "eng",
    }


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
    )
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )
    return service


class TestBridgeConfigs:
    async def test_registering_a_private_server_url_is_refused(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse(""))
        with pytest.raises(OutboundURLRefused):
            await service.register(
                bridge_type="mattermost",
                display_name="Internal",
                connection_config=_mattermost_config("http://10.1.2.3:8065"),
                channel_creation_enabled=False,
                preconfigured=False,
            )

    async def test_an_edit_or_start_naming_one_is_refused(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse(""))
        with pytest.raises(BridgeStartRefused, match="10.1.2.3"):
            await service.check_start_guards(
                bridge_id="bridge-1",
                tenant_id="tenant-1",
                bridge_type="mattermost",
                connection_config=_mattermost_config("http://10.1.2.3:8065"),
            )

    async def test_an_allowed_private_host_passes(self) -> None:
        service = _bridge_lifecycle(OutboundPolicy.parse("localhost"))
        await service.check_start_guards(
            bridge_id="bridge-1",
            tenant_id="tenant-1",
            bridge_type="mattermost",
            connection_config=_mattermost_config("http://localhost:8065"),
        )

    async def test_a_url_with_no_scheme_is_checked_as_the_driver_reads_it(
        self,
    ) -> None:
        """The driver takes a scheme-less URL as http, and bridges configured
        that way keep starting; the host is still what is checked."""
        allowed = _bridge_lifecycle(OutboundPolicy.parse("localhost"))
        await allowed.check_start_guards(
            bridge_id="bridge-1",
            tenant_id="tenant-1",
            bridge_type="mattermost",
            connection_config=_mattermost_config("localhost:8065"),
        )
        refused = _bridge_lifecycle(OutboundPolicy.parse(""))
        with pytest.raises(BridgeStartRefused, match="10.1.2.3"):
            await refused.check_start_guards(
                bridge_id="bridge-1",
                tenant_id="tenant-1",
                bridge_type="mattermost",
                connection_config=_mattermost_config("10.1.2.3:8065"),
            )


class _Handler(BaseHTTPRequestHandler):
    def _reply(self, status: int, body: dict[str, Any], **headers: str) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/api/v4/redirect":
            self._reply(302, {}, Location="http://169.254.169.254/latest/meta-data/")
        elif self.path == "/api/v4/missing":
            self._reply(404, {"message": "not here"})
        else:
            self._reply(200, {"ok": True})

    def log_message(self, *_: Any) -> None:
        pass


@pytest.fixture
def mattermost_server() -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()


def _client(port: int) -> NoRedirectClient:
    driver = Driver(
        {"url": "127.0.0.1", "scheme": "http", "port": port, "verify": True},
        client_cls=NoRedirectClient,
    )
    return driver.client  # type: ignore[no-any-return]


class TestTheMattermostDriver:
    def test_a_redirect_is_refused_not_followed(self, mattermost_server: int) -> None:
        with pytest.raises(MattermostRedirectRefused, match="169.254.169.254"):
            _client(mattermost_server).make_request("get", "/redirect")

    def test_errors_keep_the_drivers_types(self, mattermost_server: int) -> None:
        with pytest.raises(ResourceNotFound):
            _client(mattermost_server).make_request("get", "/missing")

    def test_an_ordinary_request(self, mattermost_server: int) -> None:
        response = _client(mattermost_server).make_request("get", "/users/me")
        assert response.json() == {"ok": True}


@pytest_asyncio.fixture
async def icon_server() -> AsyncIterator[int]:
    async def icon(request: web.Request) -> web.Response:
        return web.Response(body=b"x" * int(request.query["size"]))

    app = web.Application()
    app.router.add_get("/icon.png", icon)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    finally:
        await runner.cleanup()


def _mattermost_adapter(policy: OutboundPolicy) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig.model_validate(
            _mattermost_config("http://localhost:8065")
        )
    )
    adapter.set_outbound_policy(policy)
    return adapter


class TestTheMattermostIconFetch:
    async def test_an_icon_at_a_refused_address_is_not_fetched(
        self, icon_server: int
    ) -> None:
        adapter = _mattermost_adapter(OutboundPolicy.parse(""))
        with pytest.raises(OutboundURLRefused):
            await adapter._fetch_icon(
                f"http://127.0.0.1:{icon_server}/icon.png?size=10"
            )

    async def test_an_icon_within_the_ceiling(self, icon_server: int) -> None:
        adapter = _mattermost_adapter(OutboundPolicy.parse("127.0.0.1/32"))
        data = await adapter._fetch_icon(
            f"http://127.0.0.1:{icon_server}/icon.png?size=10"
        )
        assert data == b"x" * 10

    async def test_an_icon_over_the_ceiling_is_dropped(
        self, icon_server: int, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(mattermost.adapter, "_MAX_BOT_ICON_BYTES", 1024)
        adapter = _mattermost_adapter(OutboundPolicy.parse("127.0.0.1/32"))
        data = await adapter._fetch_icon(
            f"http://127.0.0.1:{icon_server}/icon.png?size=100000"
        )
        assert data is None

    async def test_an_adapter_without_a_policy_fails_loudly(self) -> None:
        adapter = MattermostAdapter(
            config=MattermostConnectionConfig.model_validate(
                _mattermost_config("http://localhost:8065")
            )
        )
        with pytest.raises(RuntimeError, match="outbound policy"):
            await adapter._fetch_icon("https://example.com/icon.png")


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
