"""The hosted controller config holding the provisioner's bearer must be
Core's alone. A config without that bearer is read as before."""

import json
from pathlib import Path

import pytest

from switch_core.providers.hosted import load_hosted_settings

BASE = {
    "allowed_tenant_ids": None,
    "token": "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS",
    "agent_api_endpoint": "https://switch.example.com/api/agent",
}


def _write(tmp_path: Path, body: dict, mode: int) -> str:
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(body))
    path.chmod(mode)
    return str(path)


def test_a_shared_file_with_the_provisioner_bearer_is_refused(tmp_path: Path) -> None:
    body = {**BASE, "provisioner_token": "SYNTHETIC-PROVISIONER-CREDENTIAL"}
    with pytest.raises(ValueError, match="Core's user only"):
        load_hosted_settings(_write(tmp_path, body, 0o644))


@pytest.mark.parametrize("mode", [0o400, 0o600])
def test_an_owner_only_file_is_read(tmp_path: Path, mode: int) -> None:
    body = {**BASE, "provisioner_token": "SYNTHETIC-PROVISIONER-CREDENTIAL"}
    settings = load_hosted_settings(_write(tmp_path, body, mode))
    assert settings is not None and settings.provisioner_token is not None


def test_a_config_without_it_is_read_as_before(tmp_path: Path) -> None:
    settings = load_hosted_settings(_write(tmp_path, BASE, 0o644))
    assert settings is not None and settings.provisioner_token is None
