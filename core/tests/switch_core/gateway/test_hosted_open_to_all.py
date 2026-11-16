"""An unset workspace list means every workspace may use cloud machines. Core keeps that default, but says
so with one WARN at start when the server can run machines and neither list narrows who may."""

from __future__ import annotations

import json
import logging

import pytest

from switch_core.providers.hosted import (
    OPEN_TO_ALL_WARNING,
    HostedControllerSettings,
    open_to_all,
    warn_if_open_to_all,
)
from tests.switch_core.gateway.test_app_route_mounting import _app


def _settings(
    tenants: list[str] | None, users: list[str] | None = None
) -> HostedControllerSettings:
    return HostedControllerSettings(
        allowed_tenant_ids=tenants,
        allowed_user_ids=users,
        token="x" * 32,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )


@pytest.mark.parametrize(
    ("settings", "capacity", "expected"),
    [
        (_settings(None, None), 2, True),  # can run machines, nobody narrowed: warn
        (_settings(None, None), 0, False),  # can't run machines at all
        (_settings(["t1"], None), 2, False),  # workspaces narrowed
        (_settings(None, ["u1"]), 2, False),  # accounts narrowed
        (_settings([], None), 2, False),  # an empty list allows nobody
        (None, 2, False),  # no hosted config (Core refuses this at start anyway)
    ],
)
def test_open_to_all_only_when_it_can_run_machines_and_neither_list_is_set(
    settings, capacity, expected
):
    assert open_to_all(settings, capacity) is expected


def test_the_warning_is_logged_once_and_only_when_open(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(["t1"]), 2) is False
        assert caplog.records == []
        assert warn_if_open_to_all(_settings(None), 2) is True
    assert [r.getMessage() for r in caplog.records] == [OPEN_TO_ALL_WARNING]
    assert caplog.records[0].levelno == logging.WARNING


def _start(tmp_path, caplog, settings: dict, capacity: int) -> list[str]:
    path = tmp_path / "controller.json"
    path.write_text(json.dumps(settings))
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        _app(
            feature_flags_enabled="agent_management,hosted_agents",
            controller_token_secret="s" * 40,
            hosted_controller_config_path=str(path),
            hosted_launch_capacity=capacity,
        )
    return [
        r.getMessage() for r in caplog.records if r.getMessage() == OPEN_TO_ALL_WARNING
    ]


BASE = {"token": "x" * 32, "agent_api_endpoint": "https://switch.example.com/api/agent"}


def test_core_warns_at_start_when_open_to_every_workspace_and_account(tmp_path, caplog):
    assert _start(
        tmp_path, caplog, {**BASE, "allowed_tenant_ids": None}, capacity=2
    ) == [OPEN_TO_ALL_WARNING]


def test_core_stays_quiet_at_start_when_either_list_is_set_or_it_runs_no_machines(
    tmp_path, caplog
):
    assert (
        _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": ["t1"]}, capacity=2)
        == []
    )
    assert (
        _start(
            tmp_path,
            caplog,
            {**BASE, "allowed_tenant_ids": None, "allowed_user_ids": ["u1"]},
            capacity=2,
        )
        == []
    )
    assert (
        _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": None}, capacity=0) == []
    )
