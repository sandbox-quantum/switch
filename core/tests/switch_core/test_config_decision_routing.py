"""Decision routing's settings: the `decision_routing` flag, the decision
service's endpoint, key and timeout."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from switch_core.decision.setup import build_decision_client
from switch_core.feature_flags import DECISION_ROUTING, FOLLOW_THE_CONVERSATION

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    id_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)

_BOTH = f"{FOLLOW_THE_CONVERSATION},{DECISION_ROUTING}"


@pytest.fixture(autouse=True)
def _no_ambient_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "FEATURE_FLAGS_ENABLED",
        "DECISION_ENDPOINT_URL",
        "DECISION_API_KEY",
        "DECISION_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_off_by_default_with_nothing_configured() -> None:
    config = _config()

    assert not config.decision_routing_enabled
    assert config.decision_endpoint_url is None
    assert config.decision_api_key is None
    assert config.decision_timeout_seconds == 5.0
    assert build_decision_client(config) is None


def test_the_flag_needs_follow_the_conversation() -> None:
    with pytest.raises(ValidationError, match=FOLLOW_THE_CONVERSATION):
        _config(feature_flags_enabled=DECISION_ROUTING)


def test_on_with_follow_the_conversation() -> None:
    config = _config(
        feature_flags_enabled=_BOTH,
        decision_endpoint_url="http://127.0.0.1:8100/decide",
        decision_api_key="placeholder",
        decision_timeout_seconds=2.5,
    )

    assert config.decision_routing_enabled
    assert config.decision_endpoint_url == "http://127.0.0.1:8100/decide"
    assert config.decision_api_key == "placeholder"
    built = build_decision_client(config)
    assert built is not None
    assert built[0].endpoint_url == "http://127.0.0.1:8100/decide"


@pytest.mark.parametrize("timeout", [0, -1])
def test_a_non_positive_timeout_is_refused(timeout: float) -> None:
    with pytest.raises(ValidationError, match="DECISION_TIMEOUT_SECONDS"):
        _config(decision_timeout_seconds=timeout)


def test_an_endpoint_that_is_not_http_is_refused() -> None:
    with pytest.raises(ValidationError, match="DECISION_ENDPOINT_URL"):
        _config(decision_endpoint_url="127.0.0.1:8100/decide")


def test_blank_settings_are_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_ENDPOINT_URL", "")
    monkeypatch.setenv("DECISION_API_KEY", " ")

    config = _config()

    assert config.decision_endpoint_url is None
    assert config.decision_api_key is None


def test_the_flag_without_an_endpoint_routes_nothing_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    config = _config(feature_flags_enabled=_BOTH)

    with caplog.at_level("WARNING"):
        assert build_decision_client(config) is None

    assert "DECISION_ENDPOINT_URL is not set" in caplog.text
