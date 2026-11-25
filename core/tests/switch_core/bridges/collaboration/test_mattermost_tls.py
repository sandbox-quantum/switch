"""The Mattermost driver verifies TLS by default (security fix).

_create_driver used to hardcode ``verify=False`` for every driver, so the admin
password and bot tokens were sent over an unverified https connection. TLS
verification now defaults on, with an explicit opt-out for a trusted self-signed
CA.
"""

from __future__ import annotations

import asyncio
import ssl
from unittest.mock import patch

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter(**overrides: object) -> MattermostAdapter:
    cfg = MattermostConnectionConfig(
        url="https://mm.example",
        admin_user="a",
        admin_password="p",
        team_name="t",
        **overrides,  # type: ignore[arg-type]
    )
    return MattermostAdapter(config=cfg)


def test_tls_verification_on_by_default() -> None:
    assert _adapter()._create_driver().options["verify"] is True


def test_tls_verification_can_be_opted_out() -> None:
    assert _adapter(verify_tls=False)._create_driver().options["verify"] is False


@pytest.mark.parametrize("verify", [True, False])
def test_websocket_uses_a_client_tls_context(verify: bool) -> None:
    driver = _adapter(verify_tls=verify)._create_driver()
    # Observe the SSL context passed by the real Switch driver before opening a socket.
    seen: list[ssl.SSLContext] = []

    class ExitSocket(BaseException):
        pass

    def capture(uri: str, *, ssl: ssl.SSLContext, **_kwargs: object) -> None:
        assert uri == "wss://mm.example:443/api/v4/websocket"
        seen.append(ssl)
        raise ExitSocket

    async def handle_event(_message: str) -> None:
        pytest.fail("no event should arrive")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        with patch("websockets.connect", capture), pytest.raises(ExitSocket):
            driver.init_websocket(handle_event)
    finally:
        loop.close()
        asyncio.set_event_loop(None)
    assert seen[0].protocol == ssl.PROTOCOL_TLS_CLIENT
    assert seen[0].check_hostname is verify
    assert seen[0].verify_mode == (ssl.CERT_REQUIRED if verify else ssl.CERT_NONE)
