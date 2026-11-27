"""Who an unset cloud-machine list admits, and the start-up warnings.

With hosted agents v2 off, an unset list means every workspace (or account),
as before v2, and Core says so with one WARN at start when the server can run
machines and neither list narrows who may. With v2 on, an unset list admits
nobody (Core warns that nobody can claim), and only an explicit `"*"` opens a
list to everyone, with the same open-to-all WARN."""

from __future__ import annotations

import json
import logging

import pytest

from switch_core.providers.hosted import (
    OPEN_TO_ALL_WARNING,
    HostedControllerSettings,
    machines_tenant_allowed,
    machines_user_allowed,
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
    ("settings", "capacity", "v1", "v2"),
    [
        # Can run machines, nobody narrowed: v1's default. v2 is closed.
        (_settings(None, None), 2, True, False),
        (_settings(None, None), 0, False, False),  # can't run machines at all
        (_settings(["t1"], None), 2, False, False),  # workspaces narrowed
        (_settings(None, ["u1"]), 2, False, False),  # accounts narrowed
        (_settings([], None), 2, False, False),  # an empty list allows nobody
        # Everyone, said explicitly with v2 on; with it off "*" is just a name.
        (_settings(["*"], ["*"]), 2, False, True),
        (_settings(["*"], None), 2, False, False),  # accounts unset: v2 closed
        (_settings(None, ["*"]), 2, False, False),  # workspaces unset: v2 closed
        (_settings(["*"], ["u1"]), 2, False, False),
        (None, 2, False, False),  # no hosted config (Core refuses this at start)
    ],
)
def test_open_to_all_only_when_it_can_run_machines_and_neither_list_narrows(
    settings, capacity, v1, v2
):
    assert open_to_all(settings, capacity, v2=False) is v1
    assert open_to_all(settings, capacity, v2=True) is v2


@pytest.mark.parametrize(
    ("tenants", "users", "v1", "v2"),
    [
        (None, None, True, False),  # unset: everyone in v1, nobody in v2
        ([], [], False, False),  # empty: nobody
        ([], None, False, False),
        (["*"], ["*"], False, True),  # "*": everyone with v2 on, a name off
        (["t1"], ["u1"], True, True),  # named: whom it names
        (["t2"], ["u1"], False, False),
        (["t1"], ["u2"], False, False),
        (["t1"], None, True, False),  # a named list and an unset one
        (None, ["u1"], True, False),
        (["*"], ["u1"], False, True),  # "*" and a named list
        (["*"], ["u2"], False, False),
    ],
)
def test_who_the_lists_admit_in_each_mode(tenants, users, v1, v2):
    settings = _settings(tenants, users)
    for on, expected in ((False, v1), (True, v2)):
        admitted = machines_tenant_allowed(
            settings, "t1", v2=on
        ) and machines_user_allowed(settings, "u1", v2=on)
        assert admitted is expected, (tenants, users, on)


def test_the_warning_is_logged_once_and_only_when_open(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(["t1"]), 2, v2=False) is False
        assert caplog.records == []
        assert warn_if_open_to_all(_settings(None), 2, v2=False) is True
    assert [r.getMessage() for r in caplog.records] == [OPEN_TO_ALL_WARNING]
    assert caplog.records[0].levelno == logging.WARNING


def test_with_v2_on_unset_lists_warn_that_nobody_can_claim(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(None, None), 2, v2=True) is False
        assert warn_if_open_to_all(_settings(["t1"], None), 2, v2=True) is False
        assert warn_if_open_to_all(_settings(["t1"], ["u1"]), 2, v2=True) is False
        assert warn_if_open_to_all(_settings(None, None), 0, v2=True) is False
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 2
    assert "allowed_tenant_ids and allowed_user_ids are unset" in messages[0]
    assert "allowed_user_ids is unset" in messages[1]
    assert all("nobody can use cloud machines" in m for m in messages)
    assert all('"*"' in m for m in messages)


def test_with_v2_on_a_star_on_both_warns_open_to_all(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(["*"], ["*"]), 2, v2=True) is True
    assert [r.getMessage() for r in caplog.records] == [OPEN_TO_ALL_WARNING]


def _start(
    tmp_path, caplog, settings: dict, capacity: int, *, v2: bool = False
) -> list[str]:
    path = tmp_path / "controller.json"
    path.write_text(json.dumps(settings))
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        _app(
            feature_flags_enabled="agent_management,hosted_agents",
            controller_token_secret="s" * 40,
            hosted_controller_config_path=str(path),
            hosted_launch_capacity=capacity,
            hosted_box_provisioning=v2,
        )
    return [
        r.getMessage()
        for r in caplog.records
        if r.getMessage() == OPEN_TO_ALL_WARNING
        or "nobody can use cloud machines" in r.getMessage()
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


def test_with_v2_on_core_warns_at_start_that_unset_lists_admit_nobody(tmp_path, caplog):
    found = _start(
        tmp_path, caplog, {**BASE, "allowed_tenant_ids": None}, capacity=2, v2=True
    )
    assert len(found) == 1 and "nobody can use cloud machines" in found[0]


def test_with_v2_on_core_warns_at_start_when_both_lists_are_a_star(tmp_path, caplog):
    assert _start(
        tmp_path,
        caplog,
        {**BASE, "allowed_tenant_ids": "*", "allowed_user_ids": ["*"]},
        capacity=2,
        v2=True,
    ) == [OPEN_TO_ALL_WARNING]


def test_with_v2_off_a_star_is_just_a_name() -> None:
    """With hosted agents v2 off, exactly as released: `"*"` admits only a
    workspace or account actually named "*"."""
    settings = _settings(["*"], ["*"])
    assert not machines_tenant_allowed(settings, "t1", v2=False)
    assert machines_tenant_allowed(settings, "*", v2=False)
    assert not machines_user_allowed(settings, "u1", v2=False)
    assert machines_user_allowed(settings, "*", v2=False)


@pytest.mark.parametrize("field", ["allowed_tenant_ids", "allowed_user_ids"])
def test_how_a_star_loads_in_each_mode(field: str) -> None:
    """With v2 on, `"*"` or `["*"]` loads as everyone, and `"*"` beside other
    entries is refused. With v2 off the lists load exactly as released: a
    bare `"*"` string is refused (a list is expected) and `["*", "t1"]` loads
    as it is. With no mode given, as off."""
    base = {**BASE, "allowed_tenant_ids": ["t1"]}

    def load(value: object, v2: bool | None) -> HostedControllerSettings:
        text = json.dumps({**base, field: value})
        if v2 is None:
            return HostedControllerSettings.model_validate_json(text)
        return HostedControllerSettings.model_validate_json(text, context={"v2": v2})

    for everyone in ("*", ["*"]):
        assert getattr(load(everyone, True), field) == ["*"]
    for mixed in (["*", "t2"], ["t2", "*"], ["*", "*"]):
        with pytest.raises(ValueError, match="stand alone"):
            load(mixed, True)
    for v2 in (False, None):
        with pytest.raises(ValueError):
            load("*", v2)
        assert getattr(load(["*", "t2"], v2), field) == ["*", "t2"]
        assert getattr(load(["*"], v2), field) == ["*"]


def test_with_v2_on_a_star_beside_names_stops_the_server_at_start(tmp_path, caplog):
    with pytest.raises(ValueError, match="stand alone"):
        _start(
            tmp_path,
            caplog,
            {**BASE, "allowed_tenant_ids": ["*", "t1"]},
            capacity=2,
            v2=True,
        )


def test_with_v2_on_a_bare_star_loads_as_everyone_at_start(tmp_path, caplog):
    path = tmp_path / "controller.json"
    path.write_text(json.dumps({**BASE, "allowed_tenant_ids": "*"}))
    app = _app(
        feature_flags_enabled="agent_management,hosted_agents",
        controller_token_secret="s" * 40,
        hosted_controller_config_path=str(path),
        hosted_launch_capacity=2,
        hosted_box_provisioning=True,
    )
    settings = app.state.hosted_controller_settings  # type: ignore[attr-defined]
    assert settings.allowed_tenant_ids == ["*"]
    assert machines_tenant_allowed(settings, "any-workspace", v2=True)


def test_with_v2_off_the_same_configs_start_as_released(tmp_path, caplog):
    # `["*", "t1"]` loads as it is; a bare "*" is refused, as released.
    assert (
        _start(
            tmp_path, caplog, {**BASE, "allowed_tenant_ids": ["*", "t1"]}, capacity=2
        )
        == []
    )
    with pytest.raises(ValueError):
        _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": "*"}, capacity=2)
