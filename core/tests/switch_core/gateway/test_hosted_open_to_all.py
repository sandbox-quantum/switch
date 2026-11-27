"""Who an unset cloud-machine list admits, and the start-up warnings.

Hosted agents v1 is frozen. A person with a live v1 machine keeps v1's reading
of the lists for it: unset admits everyone, as before boxes, so no v1 owner is
shut out when a server gains a box cluster. A box takes the closed reading:
unset admits nobody, and only an explicit `"*"` opens a list to everyone.
With a box cluster, Core warns at start that unset lists admit nobody to a box,
and says so when both lists are `"*"`."""

from __future__ import annotations

import json
import logging
import os

import pytest

from switch_core import box_cluster
from switch_core.providers.hosted import (
    OPEN_TO_ALL_WARNING,
    HostedControllerSettings,
    machines_tenant_allowed,
    machines_user_allowed,
    open_to_all,
    warn_if_open_to_all,
)
from tests.switch_core.gateway.test_app_route_mounting import _app

NOBODY = "nobody can get a cloud box"


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
    ("settings", "capacity", "without_cluster", "with_cluster"),
    [
        # Can run machines, nobody narrowed: v1's default; boxes are closed.
        (_settings(None, None), 2, True, False),
        (_settings(None, None), 0, False, False),  # can't run machines at all
        (_settings(["t1"], None), 2, False, False),  # workspaces narrowed
        (_settings(None, ["u1"]), 2, False, False),  # accounts narrowed
        (_settings([], None), 2, False, False),  # an empty list allows nobody
        (_settings(["*"], ["*"]), 2, True, True),  # everyone, said explicitly
        (_settings(["*"], None), 2, True, False),  # accounts unset: boxes closed
        (_settings(None, ["*"]), 2, True, False),  # workspaces unset: boxes closed
        (_settings(["*"], ["u1"]), 2, False, False),
        (None, 2, False, False),  # no hosted config (Core refuses this at start)
    ],
)
def test_open_to_all_only_when_it_can_run_machines_and_neither_list_narrows(
    monkeypatch, settings, capacity, without_cluster, with_cluster
):
    monkeypatch.setattr(box_cluster, "_process_on", False)
    assert open_to_all(settings, capacity) is without_cluster
    monkeypatch.setattr(box_cluster, "_process_on", True)
    assert open_to_all(settings, capacity) is with_cluster


@pytest.mark.parametrize(
    ("tenants", "users", "v1", "box"),
    [
        (None, None, True, False),  # unset: everyone to v1, nobody to a box
        ([], [], False, False),  # empty: nobody
        ([], None, False, False),
        (["*"], ["*"], True, True),  # "*": everyone
        (["t1"], ["u1"], True, True),  # named: whom it names
        (["t2"], ["u1"], False, False),
        (["t1"], ["u2"], False, False),
        (["t1"], None, True, False),  # a named list and an unset one
        (None, ["u1"], True, False),
        (["*"], ["u1"], True, True),  # "*" and a named list
        (["*"], ["u2"], False, False),
    ],
)
def test_who_the_lists_admit_to_a_v1_machine_and_to_a_box(tenants, users, v1, box):
    settings = _settings(tenants, users)
    for for_v1, expected in ((True, v1), (False, box)):
        admitted = machines_tenant_allowed(
            settings, "t1", for_v1=for_v1
        ) and machines_user_allowed(settings, "u1", for_v1=for_v1)
        assert admitted is expected, (tenants, users, for_v1)


def test_the_warning_is_logged_once_and_only_when_open(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(["t1"], ["u1"]), 2) is False
        assert caplog.records == []
        assert warn_if_open_to_all(_settings(["*"], ["*"]), 2) is True
    assert [r.getMessage() for r in caplog.records] == [OPEN_TO_ALL_WARNING]
    assert caplog.records[0].levelno == logging.WARNING


def test_unset_lists_warn_that_nobody_can_get_a_box(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_open_to_all(_settings(None, None), 2) is False
        assert warn_if_open_to_all(_settings(["t1"], None), 2) is False
        assert warn_if_open_to_all(_settings(["t1"], ["u1"]), 2) is False
        assert warn_if_open_to_all(_settings(None, None), 0) is False
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 2
    assert "allowed_tenant_ids and allowed_user_ids are unset" in messages[0]
    assert "allowed_user_ids is unset" in messages[1]
    assert all(NOBODY in m for m in messages)
    assert all("existing v1 machines keep serving their owners" in m for m in messages)
    assert all('"*"' in m for m in messages)


BASE = {"token": "x" * 32, "agent_api_endpoint": "https://switch.example.com/api/agent"}


def _start(
    tmp_path, caplog, settings: dict, capacity: int, *, cluster: bool = True
) -> list[str]:
    """Start the gateway on this config; with `cluster`, as a server with a
    box cluster (the box operator's bearer and a keyed-id key)."""
    path = tmp_path / "controller.json"
    if cluster:
        settings = {**settings, "provisioner_token": "p" * 32}
    path.write_text(json.dumps(settings))
    os.chmod(path, 0o600)
    key = tmp_path / "keyed-id.key"
    if not key.exists():
        key.write_bytes(b"a-made-up-test-key-of-thirty-two-bytes-or-more")
        os.chmod(key, 0o400)
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        _app(
            feature_flags_enabled="agent_management,hosted_agents",
            controller_token_secret="s" * 40,
            hosted_controller_config_path=str(path),
            hosted_launch_capacity=capacity,
            visibility_keyed_id_key_path=str(key),
            visibility_keyed_id_key_version="k1",
        )
    return [
        r.getMessage()
        for r in caplog.records
        if r.getMessage() == OPEN_TO_ALL_WARNING or NOBODY in r.getMessage()
    ]


def test_with_a_box_cluster_core_warns_at_start_that_unset_lists_admit_nobody(
    tmp_path, caplog
):
    found = _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": None}, capacity=2)
    assert len(found) == 1 and NOBODY in found[0]


def test_with_a_box_cluster_core_warns_at_start_when_both_lists_are_a_star(
    tmp_path, caplog
):
    assert _start(
        tmp_path,
        caplog,
        {**BASE, "allowed_tenant_ids": "*", "allowed_user_ids": ["*"]},
        capacity=2,
    ) == [OPEN_TO_ALL_WARNING]


def test_core_stays_quiet_at_start_when_both_lists_are_named_or_it_runs_no_machines(
    tmp_path, caplog
):
    named = {**BASE, "allowed_tenant_ids": ["t1"], "allowed_user_ids": ["u1"]}
    assert _start(tmp_path, caplog, named, capacity=2) == []
    assert _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": None}, 0) == []


def test_without_a_box_cluster_core_says_nothing_about_the_lists(tmp_path, caplog):
    """No box can be made, and v1 machines read unset as everyone."""
    assert (
        _start(
            tmp_path,
            caplog,
            {**BASE, "allowed_tenant_ids": None},
            capacity=2,
            cluster=False,
        )
        == []
    )


@pytest.mark.parametrize("field", ["allowed_tenant_ids", "allowed_user_ids"])
def test_how_a_star_loads(field: str) -> None:
    """`"*"` or `["*"]` loads as everyone, and `"*"` beside other entries is
    refused."""
    base = {**BASE, "allowed_tenant_ids": ["t1"]}

    def load(value: object) -> HostedControllerSettings:
        return HostedControllerSettings.model_validate_json(
            json.dumps({**base, field: value})
        )

    for everyone in ("*", ["*"]):
        assert getattr(load(everyone), field) == ["*"]
    for mixed in (["*", "t2"], ["t2", "*"], ["*", "*"]):
        with pytest.raises(ValueError, match="stand alone"):
            load(mixed)


def test_a_star_beside_names_stops_the_server_at_start(tmp_path, caplog):
    with pytest.raises(ValueError, match="stand alone"):
        _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": ["*", "t1"]}, 2)


def test_a_bare_star_loads_as_everyone_at_start(tmp_path, caplog):
    _start(tmp_path, caplog, {**BASE, "allowed_tenant_ids": "*"}, capacity=2)
    # The same config, read as the gateway read it.
    settings = HostedControllerSettings.model_validate_json(
        json.dumps({**BASE, "allowed_tenant_ids": "*"})
    )
    assert settings.allowed_tenant_ids == ["*"]
    assert machines_tenant_allowed(settings, "any-workspace", for_v1=False)
