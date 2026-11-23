"""A client's address is taken from `X-Forwarded-For` only when the request
comes from `FORWARDED_ALLOW_IPS`."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import httpx
import pytest
from starlette.types import Receive, Scope, Send

from switch_core.config import SwitchConfig
from switch_core.main import uvicorn_config


async def _client_address(scope: Scope, receive: Receive, send: Send) -> None:
    client = scope.get("client")
    body = (client[0] if client else "-").encode()
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": body})


def _config(forwarded_allow_ips: str) -> SimpleNamespace:
    return SimpleNamespace(
        server_host="127.0.0.1",
        server_port=0,
        forwarded_allow_ips=forwarded_allow_ips,
    )


async def _seen_as(forwarded_allow_ips: str, peer: str) -> str:
    config = uvicorn_config(_client_address, _config(forwarded_allow_ips))  # type: ignore[arg-type]
    config.load()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=config.loaded_app, client=(peer, 5000)),
        base_url="http://test",
    ) as client:
        response = await client.get("/", headers={"X-Forwarded-For": "198.51.100.9"})
    return response.text


@pytest.mark.parametrize(
    ("allowed", "peer", "seen"),
    [
        ("127.0.0.1", "127.0.0.1", "198.51.100.9"),
        ("127.0.0.1", "203.0.113.5", "203.0.113.5"),
        ("10.0.0.0/8", "10.1.2.3", "198.51.100.9"),
        ("10.0.0.0/8, 192.0.2.1", "192.0.2.1", "198.51.100.9"),
        ("10.0.0.0/8", "203.0.113.5", "203.0.113.5"),
    ],
)
async def test_only_the_trusted_proxy_names_the_client(
    allowed: str, peer: str, seen: str
) -> None:
    assert await _seen_as(allowed, peer) == seen


def test_trusting_everyone_is_warned_about(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="switch_core.main")
    uvicorn_config(_client_address, _config("10.0.0.0/8, *"))  # type: ignore[arg-type]
    assert "can be forged" in caplog.text


def test_the_default_trusts_only_this_host() -> None:
    assert SwitchConfig.model_fields["forwarded_allow_ips"].default == "127.0.0.1"
