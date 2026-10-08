"""The adapter registry built from the catalog, and the settings it reads."""

from __future__ import annotations

import json
import shutil
from datetime import timedelta
from pathlib import Path

import pytest

from switch_core.connections.adapters.github import GitHubAdapter, load_github_app
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG, CATALOG_ROOT, load_catalog
from switch_core.connections.registry import (
    ServiceSetupError,
    build_adapters,
    load_client_settings,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _app_files, _config
from tests.switch_core.connections.test_loader import OAUTH_MCP_ENTRY, _write_example


def test_github_gets_its_adapter_where_the_app_is_set_up(tmp_path: Path) -> None:
    settings, key = _app_files(tmp_path)
    app = load_github_app(
        _config(github_app_config_path=settings, github_app_private_key_path=key)
    )
    adapters = build_adapters(CATALOG, github_app=app, environ={})
    assert set(adapters) == {"github"}
    assert isinstance(adapters["github"], GitHubAdapter)
    assert adapters["github"].can_issue is True


def test_github_without_the_app_is_left_not_set_up() -> None:
    assert build_adapters(CATALOG, github_app=None, environ={}) == {}


def test_an_entry_naming_an_adapter_this_server_lacks_stops_it(tmp_path: Path) -> None:
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(root)
    with pytest.raises(ServiceSetupError, match="example names the oauth-mcp adapter"):
        build_adapters(load_catalog(root), github_app=None, environ={})


def test_an_entry_not_set_up_here_shows_its_catalog_note(
    tmp_path: Path, session_factory
) -> None:
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(
        root,
        OAUTH_MCP_ENTRY.replace(
            "    registration: dynamic\n",
            "    registration: static\n"
            "    client_settings: EXAMPLE\n"
            "    setup_note: Its operator registers an Example app; see the docs.\n",
        ),
    )
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=load_catalog(root),
        adapters={},
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
    )
    assert broker.availability("example") == (
        "Not set up on this server. Its operator registers an Example app; see the docs."
    )
    assert broker.connectable("example") is False


class TestClientSettings:
    def test_unset_means_not_set_up(self) -> None:
        assert load_client_settings("EXAMPLE", {}) is None
        assert (
            load_client_settings("EXAMPLE", {"EXAMPLE_CLIENT_CONFIG_PATH": ""}) is None
        )

    def test_a_usable_file_names_the_client(self, tmp_path: Path) -> None:
        path = tmp_path / "client.json"
        path.write_text(
            json.dumps({"client_id": "example-client", "client_secret": "SYNTHETIC"})
        )
        settings = load_client_settings(
            "EXAMPLE", {"EXAMPLE_CLIENT_CONFIG_PATH": str(path)}
        )
        assert settings is not None
        assert settings.client_id == "example-client"
        assert "SYNTHETIC" not in repr(settings)

    @pytest.mark.parametrize(
        ("content", "message"),
        [
            (
                '{"client_id": "example-client"}',
                "non-empty client_id and client_secret",
            ),
            (
                '{"client_id": "", "client_secret": "SYNTHETIC"}',
                "non-empty client_id and client_secret",
            ),
            (
                '{"client_id": "c", "client_secret": "s", "origin": "x"}',
                "and nothing else",
            ),
            ("not json", "JSON file"),
        ],
    )
    def test_a_half_set_client_stops_the_server(
        self, tmp_path: Path, content: str, message: str
    ) -> None:
        path = tmp_path / "client.json"
        path.write_text(content)
        with pytest.raises(ServiceSetupError, match=message):
            load_client_settings("EXAMPLE", {"EXAMPLE_CLIENT_CONFIG_PATH": str(path)})

    def test_a_missing_file_stops_the_server(self, tmp_path: Path) -> None:
        with pytest.raises(ServiceSetupError, match="cannot be read"):
            load_client_settings(
                "EXAMPLE",
                {"EXAMPLE_CLIENT_CONFIG_PATH": str(tmp_path / "missing.json")},
            )

    def test_a_relative_path_stops_the_server(self) -> None:
        with pytest.raises(ServiceSetupError, match="absolute path"):
            load_client_settings(
                "EXAMPLE", {"EXAMPLE_CLIENT_CONFIG_PATH": "client.json"}
            )


class TestDisabledServices:
    def test_read_as_a_map_of_service_to_reason(self) -> None:
        config = _config(
            disabled_services={"google-workspace": "Coming soon here.", "jira": ""}
        )
        assert config.disabled_services == {
            "google-workspace": "Coming soon here.",
            "jira": "",
        }

    def test_empty_by_default(self) -> None:
        assert _config().disabled_services == {}

    def test_read_from_the_environment_as_json(self, monkeypatch) -> None:
        monkeypatch.setenv("DISABLED_SERVICES", '{"jira": "Not here."}')
        assert _config().disabled_services == {"jira": "Not here."}

    @pytest.mark.parametrize(
        "disabled",
        [{"Not A Slug": ""}, {"jira": "two\nlines"}, {"jira": "x" * 301}],
    )
    def test_refuses_a_bad_entry(self, disabled: dict[str, str]) -> None:
        with pytest.raises(ValueError, match="DISABLED_SERVICES"):
            _config(disabled_services=disabled)
