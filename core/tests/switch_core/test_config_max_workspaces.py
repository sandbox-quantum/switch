import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[arg-type]
        **{
            **_BASE_KWARGS,
            "db_password": "placeholder",  # gitleaks:allow
            "gateway_admin_password": "placeholder",  # gitleaks:allow
            **overrides,
        }
    )


def test_a_deployment_that_configures_nothing_gets_a_bound() -> None:
    # The point of the default is that an unconfigured deployment is bounded
    # anyway: an operator has to opt *out* of the cap, not into it.
    assert _config().gateway_max_workspaces_per_user == 3


@pytest.mark.parametrize("limit", [0, 1, 50])
def test_zero_and_above_is_accepted(limit: int) -> None:
    # Zero is meaningful rather than degenerate — it closes `POST /tenants`.
    assert (
        _config(gateway_max_workspaces_per_user=limit).gateway_max_workspaces_per_user
        == limit
    )


def test_a_negative_limit_raises() -> None:
    # A negative cap would read as "no workspaces ever" while looking like a
    # typo for the value that says so, so it is refused at startup instead.
    with pytest.raises(ValueError, match="GATEWAY_MAX_WORKSPACES_PER_USER"):
        _config(gateway_max_workspaces_per_user=-1)
