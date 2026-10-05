"""ID_SERVER_NAME replaced MATRIX_SERVER_NAME; the old name still works for now."""

from __future__ import annotations

import pytest

from switch_core.config import SwitchConfig, deprecated_env_names

_REQUIRED = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_USER": "switch_app",
    "DB_PASSWORD": "x",
    "DB_NAME": "switch",
    "DB_OWNER_USER": "switch_owner",
    "DB_OWNER_PASSWORD": "x",
    "AGENT_REGISTRATION_TOKEN": "x",
    "SECRET_KEYS": "test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GATEWAY_ADMIN_EMAIL": "admin@example.com",
    "GATEWAY_ADMIN_PASSWORD": "x",
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for key, value in _REQUIRED.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("ID_SERVER_NAME", raising=False)
    monkeypatch.delenv("MATRIX_SERVER_NAME", raising=False)
    return monkeypatch


def test_reads_the_new_name(env: pytest.MonkeyPatch) -> None:
    env.setenv("ID_SERVER_NAME", "switch.example")
    assert SwitchConfig(_env_file=None).id_server_name == "switch.example"  # type: ignore[call-arg]
    assert deprecated_env_names() == []


def test_still_reads_the_old_name_and_says_so(env: pytest.MonkeyPatch) -> None:
    env.setenv("MATRIX_SERVER_NAME", "legacy.example")
    assert SwitchConfig(_env_file=None).id_server_name == "legacy.example"  # type: ignore[call-arg]
    assert len(deprecated_env_names()) == 1


def test_the_new_name_wins_when_both_are_set(env: pytest.MonkeyPatch) -> None:
    env.setenv("ID_SERVER_NAME", "new.example")
    env.setenv("MATRIX_SERVER_NAME", "old.example")
    assert SwitchConfig(_env_file=None).id_server_name == "new.example"  # type: ignore[call-arg]
    assert deprecated_env_names() == []
