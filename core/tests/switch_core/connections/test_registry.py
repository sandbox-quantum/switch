"""The adapter registry built from the catalog, and the settings it reads."""

from __future__ import annotations

import json
import shutil
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.connections.adapters.github import GitHubAdapter, load_github_app
from switch_core.connections.adapters.oauth_mcp import OAuthMcpAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG, CATALOG_ROOT, load_catalog
from switch_core.connections.oauth_clients import RegisteredClient
from switch_core.connections.registry import (
    ClientRegistration,
    ServiceSetupError,
    build_adapters,
    load_client_settings,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _app_files, _config
from tests.switch_core.connections.test_loader import OAUTH_MCP_ENTRY, _write_example

HTTP = httpx.AsyncClient()
REG = ClientRegistration(
    session_factory=async_sessionmaker(),
    keyring=TEST_KEYRING,
    public_url=None,
    server_name="switch.local",
)
STATIC = OAUTH_MCP_ENTRY.replace(
    "    registration: dynamic\n",
    "    registration: static\n    client_settings: EXAMPLE\n",
)


def _catalog(tmp_path: Path, text: str = OAUTH_MCP_ENTRY) -> dict:
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(root, text)
    return load_catalog(root)


def test_github_gets_its_adapter_where_the_app_is_set_up(tmp_path: Path) -> None:
    settings, key = _app_files(tmp_path)
    app = load_github_app(
        _config(github_app_config_path=settings, github_app_private_key_path=key)
    )
    adapters = build_adapters(
        CATALOG, github_app=app, environ={}, http=HTTP, registration=REG
    )
    assert set(adapters) == {"github", "atlassian"}
    assert isinstance(adapters["github"], GitHubAdapter)
    assert adapters["github"].can_issue is True


def test_github_without_the_app_is_left_not_set_up() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, environ={}, http=HTTP, registration=REG
    )
    assert "github" not in adapters


def test_atlassian_needs_no_settings_and_registers_its_ports_and_scopes() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, environ={}, http=HTTP, registration=REG
    )
    adapter = adapters["atlassian"]
    assert isinstance(adapter, OAuthMcpAdapter)
    client = adapter._client
    assert isinstance(client, RegisteredClient)
    assert client._request["redirect_uris"] == [
        f"http://127.0.0.1:{port}/switch-services/callback"
        for port in (39231, 39232, 39233, 39234, 39235)
    ]
    assert client._request["scope"] == (
        "read:me read:account email offline_access read:jira:agent-interface "
        "search:jira:agent-interface write:jira:agent-interface"
    )


def test_a_static_oauth_mcp_client_gets_the_generic_adapter(tmp_path: Path) -> None:
    path = tmp_path / "client.json"
    path.write_text(json.dumps({"client_id": "c", "client_secret": "SYNTHETIC"}))
    adapters = build_adapters(
        _catalog(tmp_path, STATIC),
        github_app=None,
        environ={"EXAMPLE_CLIENT_CONFIG_PATH": str(path)},
        http=HTTP,
        registration=REG,
    )
    assert isinstance(adapters["example"], OAuthMcpAdapter)


def test_a_static_oauth_mcp_client_without_settings_is_not_set_up(
    tmp_path: Path,
) -> None:
    adapters = build_adapters(
        _catalog(tmp_path, STATIC),
        github_app=None,
        environ={},
        http=HTTP,
        registration=REG,
    )
    assert "example" not in adapters


def test_a_dynamic_client_is_registered_by_core(tmp_path: Path) -> None:
    adapters = build_adapters(
        _catalog(tmp_path), github_app=None, environ={}, http=HTTP, registration=REG
    )
    adapter = adapters["example"]
    assert isinstance(adapter, OAuthMcpAdapter)
    assert isinstance(adapter._client, RegisteredClient)


def test_a_core_callback_without_a_public_address_stops_the_server(
    tmp_path: Path,
) -> None:
    core_only = OAUTH_MCP_ENTRY.replace(
        "redirect: [loopback, core]", "redirect: [core]"
    )
    with pytest.raises(ServiceSetupError, match="needs GATEWAY_PUBLIC_URL"):
        build_adapters(
            _catalog(tmp_path, core_only),
            github_app=None,
            environ={},
            http=HTTP,
            registration=REG,
        )


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
