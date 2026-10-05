"""Every variable the standalone compose file defaults to empty must boot empty.

`KEY: ${KEY:-}` hands the container an empty string whenever `.env` does not
set the key, which is most deployments for most keys. An empty string is not
unset to a settings class that validates: a boolean or a checked string refuses
it and the container never starts. So a key forwarded that way has to be one
the config accepts empty, and any other is forwarded as a bare key instead.
"""

import re
from pathlib import Path

import pytest

from switch_core.config import SwitchConfig

_COMPOSE = (
    Path(__file__).resolve().parents[3] / "deploy/local/standalone-docker-compose.yml"
)

_EMPTY_DEFAULT = re.compile(r"^\s+([A-Z][A-Z0-9_]*): \$\{\1:-\}\s*$", re.MULTILINE)

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


def _defaulted_to_empty() -> list[str]:
    return sorted(set(_EMPTY_DEFAULT.findall(_COMPOSE.read_text())))


def test_the_compose_file_has_such_keys() -> None:
    assert _defaulted_to_empty()


@pytest.mark.parametrize("key", _defaulted_to_empty())
def test_the_config_accepts_it_empty(key: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(key, "")

    SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]
