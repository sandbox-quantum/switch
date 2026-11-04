"""The operator API's own bearer (operator bearer design note v1.3, security).

The two operator routes take `operator_token` and nothing else. The controller's
and the provisioner's bearers are refused there, and the operator bearer is
refused on theirs. Both overlaps (rotation, move-over) end on a clock Core
enforces, and no bearer is ever logged. These tests need no database: the
dependency is called directly, as `test_controller_refusals` does for the
controller's.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent import refusals as refusals_module
from switch_core.bridges.agent.refusals import RefusalGuard
from switch_core.gateway import (
    hosted_controller,
    hosted_operator_bearer,
    hosted_provisioner,
)
from switch_core.gateway.hosted_operator_bearer import (
    overlap_log,
    require_operator_bearer,
)
from switch_core.providers.hosted import (
    HostedControllerSettings,
    load_hosted_settings,
    log_operator_overlaps,
)
from tests.switch_core.bridges.agent.test_controller_refusals import (
    CLIENT,
    _Clock,
    _Request,
    _Session,
    _warnings,
)

CONTROLLER = "SYNTHETIC-CONTROLLER-BEARER-FOR-TESTS-0001"
PROVISIONER = "SYNTHETIC-PROVISIONER-BEARER-FOR-TESTS-02"
OPERATOR = "SYNTHETIC-OPERATOR-BEARER-FOR-TESTS-00003"
OLD_OPERATOR = "SYNTHETIC-OLD-OPERATOR-BEARER-FOR-TESTS-4"
NOW = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)
MODULE_LOGGER = "switch_core.gateway.hosted_operator_bearer"
SECRETS = ("SYNTHETIC",)


def _settings(**extra: object) -> HostedControllerSettings:
    return HostedControllerSettings(
        allowed_tenant_ids=None,
        token=CONTROLLER,
        provisioner_token=PROVISIONER,
        agent_api_endpoint="https://switch.example.com/api/agent",
        **extra,
    )


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(refusals_module, "_DEFAULT", RefusalGuard(clock=_Clock()))
    monkeypatch.setattr(hosted_operator_bearer, "_now", lambda: NOW)
    overlap_log.reset()


def _call(
    settings: HostedControllerSettings,
    authorization: str | None,
    client: tuple[str, int] = CLIENT,
) -> None:
    require_operator_bearer(_Request(authorization, client), settings)  # type: ignore[arg-type]


def _refused(settings: HostedControllerSettings, authorization: str | None) -> int:
    with pytest.raises(HTTPException) as refused:
        _call(settings, authorization)
    return refused.value.status_code


def _all_text(caplog: pytest.LogCaptureFixture) -> str:
    return "\n".join(r.getMessage() for r in caplog.records)


# 1, 2, 3: who the two routes accept.


def test_the_operator_bearer_is_accepted() -> None:
    _call(_settings(operator_token=OPERATOR), f"Bearer {OPERATOR}")


@pytest.mark.usefixtures("hosted_v2_on")
def test_the_controller_bearer_is_refused_and_named_in_the_log_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    with pytest.raises(HTTPException) as refused:
        _call(_settings(operator_token=OPERATOR), f"Bearer {CONTROLLER}")
    assert refused.value.status_code == 401
    assert "controller_token" not in str(refused.value.detail)
    assert _warnings(caplog) == [
        "Refused a controller credential: reason=controller_token "
        "route=hosted_operator method=GET client=203.0.113.9"
    ]
    assert not any(s in _all_text(caplog) for s in SECRETS)


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    ("authorization", "reason"),
    [
        (f"Bearer {PROVISIONER}", "wrong"),
        ("Bearer eyJhbGciOiJFZERTQSJ9.e30.c2ln", "wrong"),
        ("Bearer swcc_synthetic-controller-credential", "wrong"),
        (f"Bearer {OPERATOR}-but-not", "wrong"),
        (OPERATOR, "wrong"),
        (None, "missing"),
    ],
)
def test_every_other_credential_is_refused(
    caplog: pytest.LogCaptureFixture, authorization: str | None, reason: str
) -> None:
    caplog.set_level(logging.WARNING)
    assert _refused(_settings(operator_token=OPERATOR), authorization) == 401
    assert _warnings(caplog) == [
        f"Refused a controller credential: reason={reason} "
        "route=hosted_operator method=GET client=203.0.113.9"
    ]


# 4: the operator bearer goes nowhere else.


async def test_the_operator_bearer_is_refused_on_the_controller_routes() -> None:
    gen = hosted_controller.controller_session(
        _Request(f"Bearer {OPERATOR}"),  # type: ignore[arg-type]
        _settings(operator_token=OPERATOR),
        lambda: _Session(),  # type: ignore[arg-type]
    )
    with pytest.raises(HTTPException) as refused:
        await gen.__anext__()
    assert refused.value.status_code == 401


async def test_the_operator_bearer_is_refused_on_the_provisioner_routes() -> None:
    gen = hosted_provisioner.provisioner_session(
        _Request(f"Bearer {OPERATOR}"),  # type: ignore[arg-type]
        _settings(operator_token=OPERATOR),
        lambda: _Session(),  # type: ignore[arg-type]
    )
    with pytest.raises(HTTPException) as refused:
        await gen.__anext__()
    assert refused.value.status_code == 401


# 5: unset means closed, with no fallback.


def test_with_no_operator_bearer_every_call_is_refused() -> None:
    settings = _settings()
    for authorization in (f"Bearer {CONTROLLER}", f"Bearer {OPERATOR}", None):
        assert _refused(settings, authorization) in (401, 429)


def test_a_move_over_time_needs_the_operator_bearer() -> None:
    with pytest.raises(ValueError, match="needs operator_token"):
        _settings(operator_routes_accept_controller_until=NOW + timedelta(hours=1))


# 6: rotation.


def _built(**overlaps: object) -> HostedControllerSettings:
    """Settings with overlaps set against the frozen clock, skipping the
    load-time 24-hour check, which uses the real clock (tested below)."""
    fields = _settings(operator_token=OPERATOR).model_dump()
    fields.update(overlaps)
    return HostedControllerSettings.model_construct(**fields)


def _rotating(until: datetime) -> HostedControllerSettings:
    return _built(
        operator_token_previous=_settings(operator_token=OLD_OPERATOR).operator_token,
        operator_token_previous_until=until,
    )


def test_the_previous_bearer_is_accepted_until_its_time_then_refused(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.INFO)
    settings = _rotating(NOW + timedelta(minutes=30))
    _call(settings, f"Bearer {OLD_OPERATOR}")
    _call(settings, f"Bearer {OPERATOR}")
    used = [r for r in caplog.records if r.name == MODULE_LOGGER]
    assert [r.getMessage() for r in used] == [
        "Operator API call accepted on an overlap bearer: kind=operator_previous"
    ]

    monkeypatch.setattr(
        hosted_operator_bearer, "_now", lambda: NOW + timedelta(minutes=30)
    )
    assert _refused(settings, f"Bearer {OLD_OPERATOR}") == 401
    _call(settings, f"Bearer {OPERATOR}")
    assert not any(s in _all_text(caplog) for s in SECRETS)


def test_overlap_use_is_logged_at_most_once_a_minute(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.INFO, logger=MODULE_LOGGER)
    settings = _rotating(NOW + timedelta(hours=1))
    for seconds in (0, 10, 59, 60):
        monkeypatch.setattr(
            hosted_operator_bearer, "_now", lambda s=seconds: NOW + timedelta(seconds=s)
        )
        _call(settings, f"Bearer {OLD_OPERATOR}")
    assert len([r for r in caplog.records if r.levelno == logging.INFO]) == 2


# 7: the move-over.


def _moving(until: datetime) -> HostedControllerSettings:
    return _built(operator_routes_accept_controller_until=until)


def test_the_controller_bearer_passes_here_only_until_the_move_over_ends(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.INFO, logger=MODULE_LOGGER)
    settings = _moving(NOW + timedelta(hours=1))
    _call(settings, f"Bearer {CONTROLLER}")
    assert [r.getMessage() for r in caplog.records] == [
        "Operator API call accepted on an overlap bearer: kind=controller_transition"
    ]
    # The provisioner's bearer never gets in on the move-over.
    assert _refused(settings, f"Bearer {PROVISIONER}") == 401

    monkeypatch.setattr(
        hosted_operator_bearer, "_now", lambda: NOW + timedelta(hours=1)
    )
    assert _refused(settings, f"Bearer {CONTROLLER}") == 401


# 8: start-up refusals.


@pytest.mark.parametrize(
    "extra",
    [
        {"operator_token": CONTROLLER},
        {"operator_token": PROVISIONER},
        {
            "operator_token": OPERATOR,
            "operator_token_previous": OPERATOR,
            "operator_token_previous_until": datetime.now(UTC) + timedelta(hours=1),
        },
        {
            "operator_token": OPERATOR,
            "operator_token_previous": CONTROLLER,
            "operator_token_previous_until": datetime.now(UTC) + timedelta(hours=1),
        },
    ],
)
def test_any_two_equal_bearers_are_refused(extra: dict) -> None:
    with pytest.raises(ValueError, match="must differ"):
        _settings(**extra)


def test_an_overlap_more_than_a_day_ahead_is_refused() -> None:
    later = datetime.now(UTC) + timedelta(hours=24, minutes=5)
    with pytest.raises(ValueError, match="at most 24 hours ahead"):
        _settings(
            operator_token=OPERATOR,
            operator_token_previous=OLD_OPERATOR,
            operator_token_previous_until=later,
        )
    with pytest.raises(ValueError, match="at most 24 hours ahead"):
        _settings(
            operator_token=OPERATOR, operator_routes_accept_controller_until=later
        )


def test_a_day_ahead_or_less_is_accepted_and_a_past_one_is_read() -> None:
    soon = datetime.now(UTC) + timedelta(hours=23)
    _settings(operator_token=OPERATOR, operator_routes_accept_controller_until=soon)
    past = datetime.now(UTC) - timedelta(days=3)
    _settings(
        operator_token=OPERATOR,
        operator_token_previous=OLD_OPERATOR,
        operator_token_previous_until=past,
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"operator_token": OPERATOR, "operator_token_previous": OLD_OPERATOR},
        {
            "operator_token": OPERATOR,
            "operator_token_previous_until": datetime.now(UTC) + timedelta(hours=1),
        },
        {
            "operator_token_previous": OLD_OPERATOR,
            "operator_token_previous_until": datetime.now(UTC) + timedelta(hours=1),
        },
    ],
)
def test_half_a_rotation_is_refused(extra: dict) -> None:
    with pytest.raises(ValueError):
        _settings(**extra)


def test_an_overlap_time_needs_a_utc_offset() -> None:
    with pytest.raises(ValueError, match="UTC offset"):
        _settings(
            operator_token=OPERATOR,
            operator_routes_accept_controller_until=datetime(2026, 10, 30, 12, 0),
        )


BASE_FILE = {
    "allowed_tenant_ids": None,
    "token": CONTROLLER,
    "agent_api_endpoint": "https://switch.example.com/api/agent",
}


def _write(tmp_path: Path, body: dict, mode: int) -> str:
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(body))
    path.chmod(mode)
    return str(path)


def test_a_shared_file_with_the_operator_bearer_is_refused(tmp_path: Path) -> None:
    body = {**BASE_FILE, "operator_token": OPERATOR}
    with pytest.raises(ValueError, match="Core's user only"):
        load_hosted_settings(_write(tmp_path, body, 0o640))


@pytest.mark.parametrize("mode", [0o400, 0o600])
def test_an_owner_only_file_with_the_operator_bearer_is_read(
    tmp_path: Path, mode: int
) -> None:
    body = {**BASE_FILE, "operator_token": OPERATOR}
    settings = load_hosted_settings(_write(tmp_path, body, mode))
    assert settings is not None and settings.operator_token is not None


# 9: no bearer in any log line; 11: the lapse WARN.


def test_start_up_names_open_overlaps_and_warns_on_lapsed_ones(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="switch_core.providers.hosted")
    settings = _built(
        operator_token_previous=_settings(operator_token=OLD_OPERATOR).operator_token,
        operator_token_previous_until=NOW - timedelta(minutes=1),
        operator_routes_accept_controller_until=NOW + timedelta(hours=1),
    )
    assert log_operator_overlaps(settings, NOW) == [
        "operator_token_previous_until",
        "operator_routes_accept_controller_until",
    ]
    levels = [(r.levelno, r.getMessage()) for r in caplog.records]
    assert levels[0][0] == logging.WARNING
    assert "lapsed" in levels[0][1] and "operator_token_previous_until" in levels[0][1]
    assert levels[1][0] == logging.INFO
    assert "open until" in levels[1][1]
    assert not any(s in _all_text(caplog) for s in SECRETS)
    assert log_operator_overlaps(None, NOW) == []


def test_a_running_core_warns_once_when_an_overlap_lapses(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.WARNING, logger=MODULE_LOGGER)
    settings = _moving(NOW + timedelta(minutes=5))
    _call(settings, f"Bearer {OPERATOR}")
    assert not caplog.records
    monkeypatch.setattr(
        hosted_operator_bearer, "_now", lambda: NOW + timedelta(minutes=6)
    )
    for _ in range(3):
        _call(settings, f"Bearer {OPERATOR}")
    warned = [r.getMessage() for r in caplog.records]
    assert len(warned) == 1
    assert "operator_routes_accept_controller_until" in warned[0]
    assert not any(s in warned[0] for s in SECRETS)


# 10: lock-out, and the right bearer still served from a locked address.


@pytest.mark.usefixtures("hosted_v2_on")
def test_repeated_refusals_lock_out_but_the_operator_bearer_is_served(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        refusals_module, "_DEFAULT", RefusalGuard(lockout_after=2, clock=_Clock())
    )
    settings = _settings(operator_token=OPERATOR)
    for _ in range(2):
        assert _refused(settings, "Bearer nope") == 401
    assert _refused(settings, "Bearer nope") == 429
    _call(settings, f"Bearer {OPERATOR}")
