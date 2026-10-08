"""Half-configuring Switch Trust has to be a startup error, the same shape as
the distributed Slack/Discord app config: setting the key without the policy
(or the reverse) looks configured and checks nothing.
"""

import pytest

from switch_core.config import SwitchConfig

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

_TRUST = dict(
    switch_trust_api_key="key",
    switch_trust_policy_id="pol_123",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_off_by_default() -> None:
    config = _config()
    assert config.trust_enabled is False
    assert config.switch_trust_endpoint == "https://api.flintai.dev"


def test_setting_both_enables_it() -> None:
    assert _config(**_TRUST).trust_enabled is True


@pytest.mark.parametrize("missing", sorted(_TRUST))
def test_setting_only_one_raises(missing: str) -> None:
    partial = {key: value for key, value in _TRUST.items() if key != missing}
    with pytest.raises(ValueError, match="Partial Switch Trust config"):
        _config(**partial)


def test_a_path_on_the_endpoint_is_refused() -> None:
    """The check path is appended, so a value already carrying one would be
    posted to e.g. /guardrails/check/guardrails/check."""
    with pytest.raises(ValueError, match="must have no path"):
        _config(
            **_TRUST, switch_trust_endpoint="https://trust.example/guardrails/check"
        )


def test_an_http_endpoint_is_refused() -> None:
    with pytest.raises(ValueError, match="must be an http"):
        _config(**_TRUST, switch_trust_endpoint="not-a-url")


def test_a_non_positive_timeout_is_refused() -> None:
    with pytest.raises(ValueError, match="SWITCH_TRUST_TIMEOUT_SECONDS"):
        _config(**_TRUST, switch_trust_timeout_seconds=0)
