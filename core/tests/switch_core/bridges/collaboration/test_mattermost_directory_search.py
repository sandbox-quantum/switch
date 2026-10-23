"""Searching a Mattermost bridge's directory while it is still connecting.

The lifecycle starts the adapter in the background, and a bridge is searched
as soon as it is registered (the gateway's directory dialog, setup scripts).
A search that arrived before the admin driver had logged in went out with no
session, and Mattermost refused it as "Invalid or expired session", logged as
an error and answered as a 502. It now waits for the adapter to connect.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

import pytest
import requests

from switch_core.bridges.collaboration.mattermost import adapter as adapter_module
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.http_client import NoRedirectClient


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm.example",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
            callback_base_url=None,
        )
    )


class _Users:
    def __init__(self, logged_in: threading.Event) -> None:
        self._logged_in = logged_in
        self.searches: list[dict[str, Any]] = []

    def get_user(self, user_id: str) -> dict[str, Any]:
        return {"id": "admin-id"}

    def search_users(self, options: dict[str, Any]) -> list[dict[str, Any]]:
        assert self._logged_in.is_set(), "searched before logging in"
        self.searches.append(options)
        return [{"id": "u1", "username": "ada", "first_name": "Ada", "last_name": "L"}]


class _Teams:
    def get_team_by_name(self, name: str) -> dict[str, Any]:
        return {"id": "team-id"}


class _Driver:
    """Logs in only once `release` is set, as a slow Mattermost would."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.logged_in = threading.Event()
        self.users = _Users(self.logged_in)
        self.teams = _Teams()

    def login(self) -> None:
        assert self.release.wait(5)
        self.logged_in.set()


async def _connecting(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[MattermostAdapter, _Driver, asyncio.Task[None]]:
    adapter = _adapter()
    driver = _Driver()
    monkeypatch.setattr(adapter, "_create_driver", lambda **_: driver)

    async def nothing() -> None:
        return None

    monkeypatch.setattr(adapter, "_ensure_admin_bot", nothing)
    monkeypatch.setattr(adapter, "_start_callbacks", nothing)

    async def ignore(*_: object) -> None:
        return None

    starting = asyncio.create_task(
        adapter.start(ignore, ignore, ignore, ignore, ignore)
    )
    await asyncio.sleep(0.05)
    return adapter, driver, starting


async def test_a_search_made_while_connecting_waits_and_then_runs_logged_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, driver, starting = await _connecting(monkeypatch)
    assert adapter._admin_driver is None

    searching = asyncio.create_task(adapter.search_directory_users("ada"))
    await asyncio.sleep(0.05)
    assert not searching.done()
    assert driver.users.searches == []

    driver.release.set()
    found = await asyncio.wait_for(searching, 5)
    await starting

    assert [user.username for user in found] == ["ada"]
    assert driver.users.searches == [
        {"term": "ada", "team_id": "team-id", "allow_inactive": False}
    ]


async def test_a_search_says_so_when_the_adapter_never_connects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter_module, "_CONNECT_WAIT_SECONDS", 0.1)
    adapter, driver, starting = await _connecting(monkeypatch)
    try:
        with pytest.raises(RuntimeError, match="not connected yet"):
            await adapter.search_directory_users("ada")
        assert driver.users.searches == []
    finally:
        driver.release.set()
        await starting


async def test_a_stopped_adapter_is_not_searched_as_connected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter_module, "_CONNECT_WAIT_SECONDS", 0.1)
    adapter, driver, starting = await _connecting(monkeypatch)
    driver.release.set()
    await starting
    await adapter.stop()
    with pytest.raises(RuntimeError, match="not connected yet"):
        await adapter.search_directory_users("ada")


def _client_answering(status: int, monkeypatch: pytest.MonkeyPatch) -> NoRedirectClient:
    response = requests.Response()
    response.status_code = status
    response._content = (
        b'{"message": "Invalid or expired session, please login again."}'
    )
    response.url = "http://mm.example/api/v4/users/search"
    monkeypatch.setattr(requests, "request", lambda *_args, **_kwargs: response)
    return NoRedirectClient(
        {
            "url": "mm.example",
            "scheme": "http",
            "port": 80,
            "basepath": "/api/v4",
            "verify": True,
            "timeout": 5,
            "request_timeout": 5,
            "token": None,
            "login_id": "admin",
            "password": "pw",
            "mfa_token": None,
            "auth": None,
            "debug": False,
        }
    )


@pytest.mark.parametrize(
    ("status", "level"), [(401, logging.WARNING), (403, logging.ERROR)]
)
def test_an_expired_session_is_a_warning_and_other_refusals_errors(
    status: int,
    level: int,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _client_answering(status, monkeypatch)
    with caplog.at_level(logging.WARNING), pytest.raises(requests.HTTPError):
        client.make_request("post", "/users/search", options={"term": "ada"})
    assert [record.levelno for record in caplog.records] == [level]
