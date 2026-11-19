"""How many gateway requests a process and one caller run at once, and how
long one statement of a gateway read may take (`gateway/admission.py`)."""

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


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_gateway_requests_leave_ten_connections_to_the_process_by_default() -> None:
    config = _config()
    assert config.gateway_requests_at_once == 30
    assert config.gateway_requests_per_caller == 8
    assert config.gateway_read_statement_timeout == "10s"


def test_the_share_follows_the_pool_and_never_leaves_requests_none() -> None:
    assert _config(db_pool_size=20, db_max_overflow=8).gateway_requests_at_once == 21
    assert _config(db_pool_size=5, db_max_overflow=0).gateway_requests_at_once == 3
    assert _config(db_pool_size=1, db_max_overflow=0).gateway_requests_at_once == 1
    assert _config(gateway_pool_share=1).gateway_requests_at_once == 40


@pytest.mark.parametrize("share", [0, 1.5])
def test_a_share_outside_the_pool_is_refused(share: float) -> None:
    with pytest.raises(ValueError):
        _config(gateway_pool_share=share)


def test_a_caller_may_run_at_least_one_request() -> None:
    with pytest.raises(ValueError):
        _config(gateway_requests_per_caller=0)


@pytest.mark.parametrize("value", ["10s", "500ms", "2000", "1min"])
def test_the_read_timeout_takes_a_postgres_interval(value: str) -> None:
    assert _config(gateway_read_statement_timeout=value)


def test_a_read_timeout_that_is_not_an_interval_is_refused() -> None:
    with pytest.raises(ValueError, match="GATEWAY_READ_STATEMENT_TIMEOUT"):
        _config(gateway_read_statement_timeout="ten seconds")
