"""The box workers' own controller bearer, `box_controller_token`.

The box workers (scaler, cluster watch, restart and drain workers) call the
controller routes with their own bearer, separate from v1's controller
`token`. Every controller route takes both; the box-only ones (`/pool`,
`/cluster`) stop taking `token` once `box_routes_accept_controller_until` has
passed. With no `box_controller_token` configured, everything works as before.
No bearer is ever logged. These tests need no database: the dependencies are
called directly, as `test_hosted_operator_bearer` does.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.dependencies.models import Dependant

from switch_core.bridges.agent import refusals as refusals_module
from switch_core.bridges.agent.refusals import RefusalGuard
from switch_core.gateway import hosted_controller
from switch_core.gateway.admission import caller_key, controller_bearers
from switch_core.gateway.hosted_controller import (
    box_controller_session,
    box_overlap_log,
    controller_session,
    router,
)
from switch_core.gateway.hosted_operator_bearer import require_operator_bearer
from switch_core.keys import Keyring
from switch_core.providers.hosted import (
    HostedControllerSettings,
    load_hosted_settings,
    log_operator_overlaps,
)
from tests.switch_core.bridges.agent.test_controller_refusals import (
    _Clock,
    _Request,
    _Session,
)

CONTROLLER = "SYNTHETIC-CONTROLLER-BEARER-FOR-TESTS-0001"
BOX = "SYNTHETIC-BOX-CONTROLLER-BEARER-FOR-TEST-6"
PROVISIONER = "SYNTHETIC-PROVISIONER-BEARER-FOR-TESTS-02"
OPERATOR = "SYNTHETIC-OPERATOR-BEARER-FOR-TESTS-00003"
NOW = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)
MODULE_LOGGER = "switch_core.gateway.hosted_controller"


def _settings(**extra: object) -> HostedControllerSettings:
    return HostedControllerSettings(
        allowed_tenant_ids=None,
        token=CONTROLLER,
        provisioner_token=PROVISIONER,
        operator_token=OPERATOR,
        agent_api_endpoint="https://switch.example.com/api/agent",
        **extra,
    )


def _moving(until: datetime) -> HostedControllerSettings:
    """A box token with a move-over ending at `until`, built as if loaded
    before it was more than a day away."""
    return _settings(box_controller_token=BOX).model_copy(
        update={"box_routes_accept_controller_until": until}
    )


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(refusals_module, "_DEFAULT", RefusalGuard(clock=_Clock()))
    monkeypatch.setattr(hosted_controller, "_now", lambda: NOW)
    box_overlap_log.reset()


async def _status(
    session_dep, settings: HostedControllerSettings, bearer: str | None
) -> int:  # type: ignore[no-untyped-def]
    gen = session_dep(
        _Request(None if bearer is None else f"Bearer {bearer}"),  # type: ignore[arg-type]
        settings,
        lambda: _Session(),  # type: ignore[arg-type]
    )
    try:
        await gen.__anext__()
    except HTTPException as refused:
        return refused.status_code
    await gen.aclose()
    return 200


# Who each kind of controller route takes.


@pytest.mark.parametrize("dep", [controller_session, box_controller_session])
async def test_with_no_box_token_both_kinds_take_the_controller_token_as_before(
    dep: object,
) -> None:
    assert await _status(dep, _settings(), CONTROLLER) == 200
    assert await _status(dep, _settings(), BOX) == 401


@pytest.mark.parametrize("dep", [controller_session, box_controller_session])
async def test_the_box_token_is_taken_on_every_controller_route(dep: object) -> None:
    assert await _status(dep, _settings(box_controller_token=BOX), BOX) == 200


async def test_the_shared_routes_keep_taking_the_controller_token() -> None:
    """`/machines`, `/prepare` and `/observation` serve v1's controller too."""
    settings = _moving(NOW - timedelta(hours=1))
    assert await _status(controller_session, settings, CONTROLLER) == 200


async def test_the_box_only_routes_refuse_the_controller_token_with_no_move_over(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING)
    settings = _settings(box_controller_token=BOX)
    assert await _status(box_controller_session, settings, CONTROLLER) == 401
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "controller_token" in text
    assert "SYNTHETIC" not in text


async def test_the_box_only_routes_take_the_controller_token_until_the_move_over_ends(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=MODULE_LOGGER)
    open_ = _moving(NOW + timedelta(hours=1))
    assert await _status(box_controller_session, open_, CONTROLLER) == 200
    assert await _status(box_controller_session, open_, CONTROLLER) == 200
    used = [
        r
        for r in caplog.records
        if "box_routes_accept_controller_until" in r.getMessage()
    ]
    assert len(used) == 1  # at most once a minute
    lapsed = _moving(NOW - timedelta(seconds=1))
    assert await _status(box_controller_session, lapsed, CONTROLLER) == 401
    assert await _status(box_controller_session, lapsed, CONTROLLER) == 401
    warned = [
        r
        for r in caplog.records
        if r.levelno == logging.WARNING and "lapsed" in r.getMessage()
    ]
    assert len(warned) == 1
    assert all("SYNTHETIC" not in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("dep", [controller_session, box_controller_session])
@pytest.mark.parametrize(
    "bearer", [None, "", PROVISIONER, OPERATOR, BOX + "x", "Basic x"]
)
async def test_every_other_credential_is_refused(
    dep: object, bearer: str | None
) -> None:
    assert await _status(dep, _settings(box_controller_token=BOX), bearer) == 401


def test_the_box_token_is_refused_on_the_operator_routes() -> None:
    with pytest.raises(HTTPException) as refused:
        require_operator_bearer(
            _Request(f"Bearer {BOX}"),  # type: ignore[arg-type]
            _settings(box_controller_token=BOX),
        )
    assert refused.value.status_code == 401


def _session_dep(path: str, method: str) -> object:
    for route in router.routes:
        if (
            getattr(route, "path", None) == "/hosted-controller" + path
            and method in route.methods
        ):  # type: ignore[attr-defined]
            dependant: Dependant = route.dependant  # type: ignore[attr-defined]
            calls = {d.call for d in dependant.dependencies}
            return calls & {controller_session, box_controller_session}
    raise AssertionError(path)


@pytest.mark.parametrize(
    ("method", "path", "dep"),
    [
        ("GET", "/machines", controller_session),
        ("POST", "/machines/{machine_id}/prepare", controller_session),
        ("POST", "/machines/{machine_id}/observation", controller_session),
        ("GET", "/pool", box_controller_session),
        ("POST", "/cluster", box_controller_session),
    ],
)
def test_each_controller_route_takes_its_kind_of_session(
    method: str, path: str, dep: object
) -> None:
    assert _session_dep(path, method) == {dep}


# The settings.


@pytest.mark.parametrize("other", ["token", "provisioner_token", "operator_token"])
def test_the_box_token_must_differ_from_every_other_bearer(other: str) -> None:
    same = {
        "token": CONTROLLER,
        "provisioner_token": PROVISIONER,
        "operator_token": OPERATOR,
    }[other]
    with pytest.raises(ValueError, match="separate identity|separate identities"):
        _settings(box_controller_token=same)


def test_a_short_box_token_is_refused() -> None:
    with pytest.raises(ValueError):
        _settings(box_controller_token="x" * 31)


def test_a_move_over_needs_the_box_token() -> None:
    with pytest.raises(ValueError, match="needs box_controller_token"):
        _settings(
            box_routes_accept_controller_until=datetime.now(UTC) + timedelta(hours=1)
        )


def test_a_move_over_more_than_a_day_ahead_or_without_an_offset_is_refused() -> None:
    with pytest.raises(ValueError, match="at most 24 hours"):
        _settings(
            box_controller_token=BOX,
            box_routes_accept_controller_until=datetime.now(UTC) + timedelta(hours=25),
        )
    with pytest.raises(ValueError, match="UTC offset"):
        _settings(
            box_controller_token=BOX,
            box_routes_accept_controller_until=datetime.now() + timedelta(hours=1),  # noqa: DTZ005
        )


def test_the_move_over_is_logged_at_start(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    open_ = _moving(NOW + timedelta(hours=2))
    assert "box_routes_accept_controller_until" in log_operator_overlaps(open_, NOW)
    assert "SYNTHETIC" not in caplog.text


def test_a_shared_file_with_the_box_token_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "hosted.json"
    path.write_text(
        json.dumps(
            {
                "allowed_tenant_ids": None,
                "token": CONTROLLER,
                "box_controller_token": BOX,
                "agent_api_endpoint": "https://switch.example.com/api/agent",
            }
        )
    )
    path.chmod(0o640)
    with pytest.raises(ValueError, match="Core's user only"):
        load_hosted_settings(str(path))


# The admission middleware: each controller counts as its own caller.


def _scope(bearer: str) -> dict:
    return {
        "type": "http",
        "headers": [(b"authorization", f"Bearer {bearer}".encode())],
        "client": ("192.0.2.10", 1234),
    }


def test_v1_and_the_box_workers_are_separate_callers() -> None:
    keyring = Keyring.from_secret("k" * 32) if hasattr(Keyring, "from_secret") else None
    auth = {
        caller: f"Bearer {value}".encode()
        for caller, value in controller_bearers(
            _settings(box_controller_token=BOX)
        ).items()
    }
    assert caller_key(_scope(CONTROLLER), keyring, auth) == "cloud-controller"  # type: ignore[arg-type]
    assert caller_key(_scope(BOX), keyring, auth) == "box-controller"  # type: ignore[arg-type]
    assert caller_key(_scope("made-up"), keyring, auth) == "address:192.0.2.10"  # type: ignore[arg-type]


def test_with_no_box_token_only_v1_is_a_named_caller() -> None:
    assert set(controller_bearers(_settings())) == {"cloud-controller"}
    assert controller_bearers(None) == {}
