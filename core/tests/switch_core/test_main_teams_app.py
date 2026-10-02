"""Turning the distributed Teams app on at startup, and off at shutdown."""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Callable
from typing import Any

import pytest

from switch_core import main as main_module
from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.install import MessagingInstallerRegistry
from switch_core.bridges.collaboration.teams.install import TeamsAppInstaller
from switch_core.bridges.collaboration.teams.shared_app import TeamsSharedApp
from switch_core.main import _distributed_teams_app, _shutdown
from tests.switch_core.test_config_teams_app import _APP, _config


class _Lifecycle:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self.starting_listeners: list[Callable[[CollaborationAdapter], None]] = []

    def add_bridge_starting_listener(
        self, listener: Callable[[CollaborationAdapter], None]
    ) -> None:
        self.starting_listeners.append(listener)

    async def stop_all(self) -> None:
        self.calls.append("bridges stopped")


def test_a_deployment_without_the_app_offers_no_teams_install() -> None:
    installers = MessagingInstallerRegistry()
    lifecycle = _Lifecycle([])

    app = _distributed_teams_app(_config(), installers, lifecycle)  # type: ignore[arg-type]

    assert app is None
    assert "teams" not in installers.platforms()
    assert lifecycle.starting_listeners == []


async def test_a_configured_deployment_offers_the_install_and_hands_bridges_the_app() -> (
    None
):
    installers = MessagingInstallerRegistry()
    lifecycle = _Lifecycle([])

    app = _distributed_teams_app(_config(**_APP), installers, lifecycle)  # type: ignore[arg-type]

    assert isinstance(app, TeamsSharedApp)
    installer = installers.get("teams")
    assert isinstance(installer, TeamsAppInstaller)
    assert installer.package.manifest_id == _APP["teams_app_client_id"]
    assert lifecycle.starting_listeners == [app.attach_if_teams]
    await app.aclose()


async def test_the_apps_client_is_closed_only_after_the_bridges_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every bridge on the app borrows its HTTP client until it stops."""
    calls: list[str] = []

    class _Stoppable:
        def __init__(self, name: str) -> None:
            self._name = name

        async def stop_all(self) -> None:
            calls.append(f"{self._name} stopped")

        async def close(self) -> None:
            calls.append(f"{self._name} closed")

    class _TeamsApp:
        async def aclose(self) -> None:
            calls.append("teams app closed")

    class _Exited(Exception):
        pass

    def fake_exit(code: int) -> None:
        raise _Exited

    async def no_grace(seconds: float) -> None:
        return None

    monkeypatch.setattr(main_module.os, "_exit", fake_exit)
    monkeypatch.setattr(main_module.asyncio, "sleep", no_grace)
    server: Any = type("Server", (), {"should_exit": False})()

    with pytest.raises(_Exited):
        await _shutdown(
            server=server,
            client_lifecycle=_Stoppable("clients"),  # type: ignore[arg-type]
            collab_lifecycle=_Lifecycle(calls),  # type: ignore[arg-type]
            connector_lifecycle=_Stoppable("connectors"),  # type: ignore[arg-type]
            matrix_admin=_Stoppable("matrix"),  # type: ignore[arg-type]
            discord_gateway=None,
            discord_gateway_task=None,
            teams_app=_TeamsApp(),  # type: ignore[arg-type]
        )

    assert calls.index("bridges stopped") < calls.index("teams app closed")
    assert server.should_exit is True


async def test_the_package_carries_the_environments_app_name() -> None:
    installers = MessagingInstallerRegistry()

    app = _distributed_teams_app(
        _config(**_APP, teams_app_name="Agent Switch (dev)"),
        installers,
        _Lifecycle([]),  # type: ignore[arg-type]
    )

    installer = installers.get("teams")
    assert isinstance(installer, TeamsAppInstaller)
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(installer.package.archive)).read("manifest.json")
    )
    assert manifest["name"]["short"] == "Agent Switch (dev)"
    assert app is not None
    await app.aclose()
