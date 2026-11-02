"""`ALLOW_NON_EXPIRING_KEYS`: whether a connector offers a pasted credential
that never expires."""

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    id_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
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


def test_off_unless_the_operator_turns_it_on(monkeypatch) -> None:
    monkeypatch.delenv("ALLOW_NON_EXPIRING_KEYS", raising=False)
    assert _config().allow_non_expiring_keys is False


def test_read_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_NON_EXPIRING_KEYS", "true")
    assert _config().allow_non_expiring_keys is True
    monkeypatch.setenv("ALLOW_NON_EXPIRING_KEYS", "false")
    assert _config().allow_non_expiring_keys is False
