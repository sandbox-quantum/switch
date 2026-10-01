"""Half-configuring the distributed Teams app has to be a startup error.

The app's id, its home directory, one credential and the notification keypair
are useless apart: without the directory no Bot Connector token can be issued,
without a credential nothing can be, and without the keypair Graph has nothing
to encrypt captured messages to. A deployment that sets some of them looks
configured and breaks, so it does not start.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID

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

_TENANT = "11111111-2222-3333-4444-555555555555"


def _keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    return (
        certificate.public_bytes(serialization.Encoding.PEM).decode(),
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
    )


_NOTIFICATION_CERT, _NOTIFICATION_KEY = _keypair()
_CREDENTIAL_CERT, _CREDENTIAL_KEY = _keypair()

_APP = dict(
    teams_app_client_id="aaaaaaaa-0000-0000-0000-000000000001",
    teams_app_tenant_id=_TENANT,
    teams_app_client_secret="secret",
    teams_app_notification_certificate=_NOTIFICATION_CERT,
    teams_app_notification_private_key=_NOTIFICATION_KEY,
    messaging_public_url="https://switch.example",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def _without(*names: str, **overrides: object) -> dict[str, object]:
    return {**{k: v for k, v in _APP.items() if k not in names}, **overrides}


def test_setting_none_of_them_is_the_ordinary_case() -> None:
    assert _config().teams_app_client_id is None


def test_a_complete_secret_configuration_is_accepted() -> None:
    assert _config(**_APP).teams_app_client_secret == "secret"


def test_a_certificate_credential_is_accepted() -> None:
    config = _config(
        **_without(
            "teams_app_client_secret",
            teams_app_certificate=_CREDENTIAL_CERT,
            teams_app_certificate_private_key=_CREDENTIAL_KEY,
        )
    )
    assert config.teams_app_certificate == _CREDENTIAL_CERT


def test_a_federated_token_file_is_accepted(tmp_path: Path) -> None:
    token = tmp_path / "token"
    token.write_text("eyJ...")
    config = _config(
        **_without("teams_app_client_secret", teams_app_federated_token_file=str(token))
    )
    assert config.teams_app_federated_token_file == str(token)


@pytest.mark.parametrize(
    "missing",
    [
        "teams_app_client_id",
        "teams_app_tenant_id",
        "teams_app_notification_certificate",
        "teams_app_notification_private_key",
    ],
)
def test_a_missing_required_setting_raises(missing: str) -> None:
    with pytest.raises(ValueError, match="Partial distributed Teams app config"):
        _config(**_without(missing))


def test_no_credential_raises() -> None:
    with pytest.raises(ValueError, match="exactly one credential.*Got none"):
        _config(**_without("teams_app_client_secret"))


def test_two_credentials_raise() -> None:
    """Which one would be used is a guess, and the unused one is a secret
    deployed for nothing."""
    with pytest.raises(ValueError, match="exactly one credential"):
        _config(
            **_APP,
            teams_app_certificate=_CREDENTIAL_CERT,
            teams_app_certificate_private_key=_CREDENTIAL_KEY,
        )


def test_a_certificate_without_its_key_raises() -> None:
    with pytest.raises(ValueError, match="must be set together"):
        _config(
            **_without(
                "teams_app_client_secret", teams_app_certificate=_CREDENTIAL_CERT
            )
        )


@pytest.mark.parametrize("tenant", ["common", "organizations", "contoso.com"])
def test_a_tenant_that_is_not_a_directory_id_raises(tenant: str) -> None:
    """A SingleTenant bot's tokens come from its own directory and nowhere else."""
    with pytest.raises(ValueError, match="TEAMS_APP_TENANT_ID"):
        _config(**_without(teams_app_tenant_id=tenant))


def test_a_notification_key_that_is_not_the_certificates_raises() -> None:
    """Graph would encrypt every captured message to a key Switch does not hold."""
    _, other_key = _keypair()
    with pytest.raises(ValueError, match="are not a pair"):
        _config(**_without(teams_app_notification_private_key=other_key))


def test_a_credential_key_that_is_not_the_certificates_raises() -> None:
    _, other_key = _keypair()
    with pytest.raises(ValueError, match="are not a pair"):
        _config(
            **_without(
                "teams_app_client_secret",
                teams_app_certificate=_CREDENTIAL_CERT,
                teams_app_certificate_private_key=other_key,
            )
        )


def test_a_non_rsa_notification_key_raises() -> None:
    """Graph wraps each notification's key with RSA-OAEP and nothing else."""
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    with pytest.raises(ValueError, match="must be an RSA key"):
        _config(**_without(teams_app_notification_previous_private_key=pem))


def test_a_garbled_key_names_its_setting() -> None:
    with pytest.raises(ValueError, match="TEAMS_APP_NOTIFICATION_PRIVATE_KEY"):
        _config(**_without(teams_app_notification_private_key="not a key"))


def test_a_missing_federated_token_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="is not a file"):
        _config(
            **_without(
                "teams_app_client_secret",
                teams_app_federated_token_file=str(tmp_path / "absent"),
            )
        )


def test_an_app_with_no_public_origin_raises() -> None:
    with pytest.raises(ValueError, match="MESSAGING_PUBLIC_URL"):
        _config(**_without("messaging_public_url"))
