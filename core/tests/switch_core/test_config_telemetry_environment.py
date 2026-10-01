"""TELEMETRY_ENVIRONMENT picks the Amplitude project a deployment's usage lands in.

The relay files an event under the project its `flint_env` names, and drops one
naming an environment it has no project for — answering 200 either way. So the
setting is held to the four the relay knows, and an unknown value stops the
server at startup rather than quietly losing its usage.
"""

import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def test_a_deployment_that_says_nothing_is_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every customer's deployment is production, and none of them sets it."""
    monkeypatch.delenv("TELEMETRY_ENVIRONMENT", raising=False)

    assert SwitchConfig(**_BASE_KWARGS).telemetry_environment == "prod"  # type: ignore[arg-type]


@pytest.mark.parametrize("environment", ["prod", "staging", "dev", "local"])
def test_each_environment_the_relay_knows_is_accepted(
    environment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEMETRY_ENVIRONMENT", environment)

    assert SwitchConfig(**_BASE_KWARGS).telemetry_environment == environment  # type: ignore[arg-type]


@pytest.mark.parametrize("environment", ["qa", "production", "development", "Dev"])
def test_an_environment_the_relay_does_not_know_is_refused(
    environment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEMETRY_ENVIRONMENT", environment)

    with pytest.raises(ValidationError, match="telemetry_environment"):
        SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]
