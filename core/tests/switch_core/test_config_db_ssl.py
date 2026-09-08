import datetime
import ssl
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
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


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_default_ssl_mode_is_disable_and_yields_no_connect_args() -> None:
    config = _config()
    assert config.db_ssl_mode == "disable"
    assert config.db_connect_args == {}


@pytest.mark.parametrize(
    "mode", ["allow", "prefer", "require", "verify-ca", "verify-full"]
)
def test_non_disable_ssl_mode_forwards_ssl_connect_arg(mode: str) -> None:
    config = _config(db_ssl_mode=mode)
    assert config.db_connect_args == {"ssl": mode}


def test_invalid_ssl_mode_raises() -> None:
    with pytest.raises(ValueError, match="DB_SSL_MODE"):
        _config(db_ssl_mode="bogus")


def _ca_bundle(tmp_path: Path) -> str:
    """A throwaway CA, standing in for the one a managed database is signed by."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root CA")])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    path = tmp_path / "ca.pem"
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return str(path)


def test_verify_full_checks_the_hostname_against_the_given_bundle(
    tmp_path: Path,
) -> None:
    config = _config(db_ssl_mode="verify-full", db_ssl_root_cert=_ca_bundle(tmp_path))

    context = config.db_connect_args["ssl"]

    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_verify_ca_verifies_the_issuer_but_not_the_hostname(tmp_path: Path) -> None:
    """The difference that lets a deployment front the database with its own name."""
    config = _config(db_ssl_mode="verify-ca", db_ssl_root_cert=_ca_bundle(tmp_path))

    context = config.db_connect_args["ssl"]

    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is False


def test_a_bundle_under_a_mode_that_would_ignore_it_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="DB_SSL_ROOT_CERT"):
        _config(db_ssl_mode="require", db_ssl_root_cert=_ca_bundle(tmp_path))


def test_a_bundle_that_is_not_there_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="is not a file"):
        _config(
            db_ssl_mode="verify-full", db_ssl_root_cert=str(tmp_path / "absent.pem")
        )
