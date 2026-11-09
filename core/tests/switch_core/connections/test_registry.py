"""The adapter registry built from the catalog, and the settings it reads."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.adapters.github import GitHubAdapter, load_github_app
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG, CATALOG_ROOT, load_catalog
from switch_core.connections.oauth_clients import (
    RegisteredClient,
    check_sign_in_redirects,
    sign_in_redirect_warnings,
)
from switch_core.connections.registry import (
    ClientRegistration,
    ServiceSetupError,
    build_adapters,
    load_client_settings,
)
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _app_files, _config
from tests.switch_core.connections.standing import availability, connectable, standing
from tests.switch_core.connections.test_loader import (
    API_KEY_ENTRY,
    CLI_ENTRY,
    OAUTH_ENTRY,
    _write_example,
)

HTTP = httpx.AsyncClient()
REG = ClientRegistration(
    session_factory=async_sessionmaker(),
    keyring=TEST_KEYRING,
    public_url=None,
    server_name="switch.local",
    redirects={},
)
STATIC = OAUTH_ENTRY.replace(
    "    registration: dynamic\n",
    "    registration: static\n    client_settings: EXAMPLE\n",
)


def _catalog(tmp_path: Path, text: str = OAUTH_ENTRY) -> dict:
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
        CATALOG, github_app=app, oauth_clients={}, http=HTTP, registration=REG
    )
    assert set(adapters) == {
        "github",
        "atlassian",
        "datadog",
        "linear",
        "notion",
        "sentry",
    }
    assert isinstance(adapters["github"], GitHubAdapter)
    assert adapters["github"].can_issue is True


def test_github_without_the_app_is_left_not_set_up() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    assert "github" not in adapters


def test_a_key_service_needs_nothing_set_up_on_the_server(tmp_path: Path) -> None:
    adapters = build_adapters(
        _catalog(tmp_path, API_KEY_ENTRY),
        github_app=None,
        oauth_clients={},
        http=HTTP,
        registration=REG,
    )
    assert isinstance(adapters["example"], ApiKeyAdapter)


def test_atlassian_needs_no_settings_and_registers_its_ports_and_scopes() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    adapter = adapters["atlassian"]
    assert isinstance(adapter, OAuthAdapter)
    client = adapter._client
    assert isinstance(client, RegisteredClient)
    assert client._request["redirect_uris"] == [
        f"http://127.0.0.1:{port}/switch-services/callback"
        for port in (39231, 39232, 39233, 39234, 39235)
    ]
    assert client._request["scope"] == (
        "read:me read:account email offline_access read:jira:agent-interface "
        "search:jira:agent-interface read:confluence:agent-interface "
        "search:confluence:agent-interface write:jira:agent-interface "
        "write:confluence:agent-interface"
    )


def test_atlassian_registers_cores_callback_only_where_the_server_names_it() -> None:
    public = "https://switch.example.com"
    loopback = [
        f"http://127.0.0.1:{port}/switch-services/callback"
        for port in (39231, 39232, 39233, 39234, 39235)
    ]
    definition = CATALOG["atlassian"].definition

    def registered(named: dict) -> list[str]:
        adapter = build_adapters(
            CATALOG,
            github_app=None,
            oauth_clients={},
            http=HTTP,
            registration=replace(REG, public_url=public, redirects=named),
        )["atlassian"]
        assert isinstance(adapter, OAuthAdapter)
        assert isinstance(adapter._client, RegisteredClient)
        return adapter._client._request["redirect_uris"]

    def mode(named: dict) -> str | None:
        flows = ServiceFlows(
            public, named, SignInFlows(async_sessionmaker(), TEST_KEYRING)
        )
        return flows.mode(definition)

    # A server that does not name Atlassian registers what it always has, and
    # signs in through Switch Console, so no connection has to reconnect.
    assert registered({}) == loopback
    assert mode({}) == "loopback"
    assert registered({"atlassian": "loopback"}) == loopback
    assert registered({"atlassian": "core"}) == [
        *loopback,
        f"{public}/gateway/service-connections/atlassian/flows/callback",
    ]
    assert mode({"atlassian": "core"}) == "core"


def test_notion_needs_no_settings_and_registers_a_loopback_on_any_port() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    adapter = adapters["notion"]
    assert isinstance(adapter, OAuthAdapter)
    client = adapter._client
    assert isinstance(client, RegisteredClient)
    assert client._request == {
        "redirect_uris": ["http://127.0.0.1/switch-services/callback"],
        "scope": "default",
    }


def test_sentry_needs_no_settings_and_registers_its_ports_and_scopes() -> None:
    adapters = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    adapter = adapters["sentry"]
    assert isinstance(adapter, OAuthAdapter)
    client = adapter._client
    assert isinstance(client, RegisteredClient)
    assert client._request["redirect_uris"] == [
        f"http://127.0.0.1:{port}/switch-services/callback"
        for port in (39231, 39232, 39233, 39234, 39235)
    ]
    assert client._request["scope"] == "org:read project:write team:write event:write"


def test_datadog_needs_no_settings_and_registers_its_ports_and_scope() -> None:
    adapter = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )["datadog"]
    assert isinstance(adapter, OAuthAdapter)
    client = adapter._client
    assert isinstance(client, RegisteredClient)
    assert client._request == {
        "redirect_uris": [
            f"http://127.0.0.1:{port}/switch-services/callback"
            for port in (39241, 39242, 39243, 39244, 39245)
        ],
        "scope": "mcp_all",
    }


def test_datadog_registers_cores_callback_only_where_the_server_names_it() -> None:
    public = "https://switch.example.com"
    adapter = build_adapters(
        CATALOG,
        github_app=None,
        oauth_clients={},
        http=HTTP,
        registration=replace(REG, public_url=public, redirects={"datadog": "core"}),
    )["datadog"]
    assert isinstance(adapter, OAuthAdapter)
    assert isinstance(adapter._client, RegisteredClient)
    assert adapter._client._request["redirect_uris"][-1] == (
        f"{public}/gateway/service-connections/datadog/flows/callback"
    )
    flows = ServiceFlows(
        public, {"datadog": "core"}, SignInFlows(async_sessionmaker(), TEST_KEYRING)
    )
    assert flows.mode(CATALOG["datadog"].definition) == "core"


def test_airtable_is_set_up_by_its_operators_own_client() -> None:
    assert "airtable" not in build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    adapters = build_adapters(
        CATALOG,
        github_app=None,
        oauth_clients={
            "airtable": OAuthClientCredentials("c", "SYNTHETIC", authentication=None)
        },
        http=HTTP,
        registration=REG,
    )
    adapter = adapters["airtable"]
    assert isinstance(adapter, OAuthAdapter)
    assert isinstance(adapter._client, StaticClient)
    assert adapter._client.client.client_id == "c"


def test_a_static_oauth_client_gets_the_generic_adapter(tmp_path: Path) -> None:
    adapters = build_adapters(
        _catalog(tmp_path, STATIC),
        github_app=None,
        oauth_clients={
            "example": OAuthClientCredentials("c", "SYNTHETIC", authentication=None)
        },
        http=HTTP,
        registration=REG,
    )
    assert isinstance(adapters["example"], OAuthAdapter)


def test_a_cli_entry_gets_the_generic_adapter_with_its_client(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path, CLI_ENTRY)
    adapters = build_adapters(
        catalog,
        github_app=None,
        oauth_clients={
            "example": OAuthClientCredentials("c", "SYNTHETIC", authentication=None)
        },
        http=HTTP,
        registration=REG,
    )
    assert isinstance(adapters["example"], OAuthAdapter)
    assert "example" not in build_adapters(
        catalog, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )


def test_a_static_oauth_client_without_settings_is_not_set_up(
    tmp_path: Path,
) -> None:
    adapters = build_adapters(
        _catalog(tmp_path, STATIC),
        github_app=None,
        oauth_clients={},
        http=HTTP,
        registration=REG,
    )
    assert "example" not in adapters


def test_a_dynamic_client_is_registered_by_core(tmp_path: Path) -> None:
    adapters = build_adapters(
        _catalog(tmp_path),
        github_app=None,
        oauth_clients={},
        http=HTTP,
        registration=REG,
    )
    adapter = adapters["example"]
    assert isinstance(adapter, OAuthAdapter)
    assert isinstance(adapter._client, RegisteredClient)


def test_a_core_callback_without_a_public_address_stops_the_server(
    tmp_path: Path,
) -> None:
    core_only = OAUTH_ENTRY.replace("redirect: [loopback, core]", "redirect: [core]")
    with pytest.raises(ServiceSetupError, match="needs GATEWAY_PUBLIC_URL"):
        build_adapters(
            _catalog(tmp_path, core_only),
            github_app=None,
            oauth_clients={},
            http=HTTP,
            registration=REG,
        )


def _broker(
    catalog: dict, session_factory, adapters: dict, public_url: str | None
) -> ServiceBroker:
    return ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=catalog,
        adapters=adapters,
        organization_apps=None,
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=public_url,
        allow_non_expiring_keys=False,
    )


async def test_an_app_not_set_up_here_says_who_sets_it_up(
    tmp_path: Path, session_factory
) -> None:
    broker = _broker(_catalog(tmp_path, STATIC), session_factory, {}, None)
    reason = (
        "{}'s connector app isn't set up on this server yet. "
        "Whoever runs Switch can set it up."
    )
    assert await availability(broker, "example") == reason.format("Example")
    assert await availability(broker, "github") == reason.format("GitHub")
    assert await connectable(broker, "example") is False
    for service in ("example", "github"):
        unavailable = (await standing(broker, service)).unavailable
        assert unavailable is not None and unavailable.code == "app_not_set_up"
        assert (await standing(broker, service)).server_setup_needed is True


async def test_a_service_signing_in_only_through_the_server_needs_its_public_url(
    tmp_path: Path, session_factory
) -> None:
    core_only = STATIC.replace("redirect: [loopback, core]", "redirect: [core]")
    broker = _broker(_catalog(tmp_path, core_only), session_factory, {}, None)
    example = (await standing(broker, "example")).unavailable
    assert example is not None
    assert example.code == "needs_public_url"
    assert example.reason == (
        "Example can't be connected here: it needs Switch's public address "
        "(GATEWAY_PUBLIC_URL)."
    )
    assert (await standing(broker, "example")).server_setup_needed is False
    # GitHub's App names its own callback, so it isn't held up the same way.
    github = (await standing(broker, "github")).unavailable
    assert github is not None and github.code == "app_not_set_up"
    with_url = _broker(
        _catalog(tmp_path / "again", core_only),
        session_factory,
        {},
        "https://switch.example.test",
    )
    example = (await standing(with_url, "example")).unavailable
    assert example is not None and example.code == "app_not_set_up"


async def test_github_cannot_work_on_a_server_at_another_computers_http_address(
    tmp_path: Path, session_factory
) -> None:
    catalog = _catalog(tmp_path, STATIC)
    broker = _broker(catalog, session_factory, {}, "http://switch.example.com")
    github = (await standing(broker, "github")).unavailable
    assert github is not None
    assert github.code == "needs_https"
    assert github.reason == (
        "GitHub can't be used here: it needs Switch to have an https address, "
        "or an http one on your own computer (localhost or 127.0.0.1)."
    )
    assert (await standing(broker, "github")).server_setup_needed is False
    # Google and the like take an http address back, so their app still can be.
    example = (await standing(broker, "example")).unavailable
    assert example is not None and example.code == "app_not_set_up"


@pytest.mark.parametrize(
    "public_url",
    [
        "https://switch.example.com",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://[::1]:8000",
    ],
)
async def test_github_can_be_set_up_on_https_or_on_this_computer(
    tmp_path: Path, session_factory, public_url: str
) -> None:
    broker = _broker(_catalog(tmp_path, STATIC), session_factory, {}, public_url)
    github = (await standing(broker, "github")).unavailable
    assert github is not None and github.code == "app_not_set_up"
    assert (await standing(broker, "github")).server_setup_needed is True


async def test_a_service_with_no_app_to_set_up_is_just_not_set_up(
    tmp_path: Path, session_factory
) -> None:
    broker = _broker(_catalog(tmp_path, STATIC), session_factory, {}, None)
    atlassian = (await standing(broker, "atlassian")).unavailable
    assert atlassian is not None
    assert (atlassian.code, atlassian.reason) == (
        "not_set_up",
        "Atlassian is not set up here.",
    )
    assert (await standing(broker, "atlassian")).server_setup_needed is False
    asana = (await standing(broker, "asana")).unavailable
    assert asana is not None and asana.code == "coming_soon"


async def test_a_key_that_never_expires_is_neither_connected_nor_granted(
    tmp_path: Path, session_factory
) -> None:
    catalog = _catalog(tmp_path, API_KEY_ENTRY)
    adapters = build_adapters(
        catalog, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    broker = _broker(catalog, session_factory, adapters, None)
    example = (await standing(broker, "example")).unavailable
    assert example is not None
    assert (example.code, example.reason) == (
        "key_never_expires",
        "Example keys are long-lived and only Example can revoke them, so Switch "
        "does not hand them to agents.",
    )
    assert await connectable(broker, "example") is False
    assert (await standing(broker, "example")).server_setup_needed is False


async def test_a_replaced_adapter_is_used_at_once(
    tmp_path: Path, session_factory
) -> None:
    catalog = _catalog(tmp_path, STATIC)
    broker = _broker(catalog, session_factory, {}, None)
    adapter = build_adapters(
        catalog,
        github_app=None,
        oauth_clients={
            "example": OAuthClientCredentials("c", "SYNTHETIC", authentication=None)
        },
        http=HTTP,
        registration=REG,
    )["example"]

    broker.replace_adapter("example", adapter)
    assert await availability(broker, "example") is None
    assert await connectable(broker, "example") is True

    broker.replace_adapter("example", None)
    assert await availability(broker, "example") is not None
    assert await connectable(broker, "example") is False

    with pytest.raises(ValueError, match="No service named"):
        broker.replace_adapter("nowhere", None)


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

    def test_names_datadog_as_atlassian(self) -> None:
        config = _config(
            service_sign_in_redirect={"datadog": "core", "atlassian": "loopback"},
            gateway_public_url="https://switch.example.com",
        )
        assert config.service_sign_in_redirect == {
            "datadog": "core",
            "atlassian": "loopback",
        }

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


class TestServiceSignInRedirect:
    def test_reading_the_config_does_not_load_the_catalog(self) -> None:
        # A subprocess, because this one has imported the loader already.
        # Alembic reads the config on every migration, and must not depend
        # on the catalog's files.
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys, switch_core.config; "
                "assert 'switch_core.connections.loader' not in sys.modules",
            ],
            check=True,
        )

    def test_read_as_a_map_of_service_to_the_way_back(self) -> None:
        config = _config(
            service_sign_in_redirect={"atlassian": "core"},
            gateway_public_url="https://switch.example.com",
        )
        assert config.service_sign_in_redirect == {"atlassian": "core"}
        assert (
            sign_in_redirect_warnings(
                CATALOG, config.service_sign_in_redirect, config.gateway_public_url
            )
            == []
        )

    def test_empty_by_default(self) -> None:
        assert _config().service_sign_in_redirect == {}

    def test_read_from_the_environment_as_json(self, monkeypatch) -> None:
        monkeypatch.setenv("SERVICE_SIGN_IN_REDIRECT", '{"atlassian": "loopback"}')
        assert _config().service_sign_in_redirect == {"atlassian": "loopback"}

    @pytest.mark.parametrize(
        ("named", "message"),
        [
            ({"nowhere": "core"}, "names 'nowhere', which is not in the catalog."),
            (
                {"airtable": "loopback"},
                "names 'loopback' for airtable, which allows only 'core'.",
            ),
            (
                {"github": "core"},
                "names 'core' for github, which allows none: it has no OAuth sign-in.",
            ),
        ],
    )
    def test_a_service_or_way_its_entry_does_not_list_stops_the_server(
        self, named: dict, message: str
    ) -> None:
        with pytest.raises(ValueError, match=re.escape(message)):
            check_sign_in_redirects(CATALOG, named)

    @pytest.mark.parametrize(
        ("named", "message"),
        [
            ({"atlassian": "web"}, "Input should be 'loopback' or 'core'"),
            ({"Not A Slug": "core"}, "names an invalid service: 'Not A Slug'"),
        ],
    )
    def test_a_malformed_entry_is_refused_as_the_config_is_read(
        self, named: dict, message: str
    ) -> None:
        with pytest.raises(ValueError, match=re.escape(message)):
            _config(service_sign_in_redirect=named)

    def test_core_without_a_public_url_warns_and_signs_in_through_loopback(
        self,
    ) -> None:
        config = _config(service_sign_in_redirect={"atlassian": "core"})
        assert sign_in_redirect_warnings(
            CATALOG, config.service_sign_in_redirect, config.gateway_public_url
        ) == [
            "SERVICE_SIGN_IN_REDIRECT names 'core' for atlassian, but "
            "GATEWAY_PUBLIC_URL is unset, so atlassian's sign-ins come back to "
            "Switch Console (loopback) instead."
        ]
        flows = ServiceFlows(
            config.gateway_public_url,
            config.service_sign_in_redirect,
            SignInFlows(async_sessionmaker(), TEST_KEYRING),
        )
        assert flows.mode(CATALOG["atlassian"].definition) == "loopback"
        adapter = build_adapters(
            CATALOG,
            github_app=None,
            oauth_clients={},
            http=HTTP,
            registration=replace(REG, redirects=config.service_sign_in_redirect),
        )["atlassian"]
        assert isinstance(adapter, OAuthAdapter)
        assert isinstance(adapter._client, RegisteredClient)
        assert all(
            uri.startswith("http://127.0.0.1:")
            for uri in adapter._client._request["redirect_uris"]
        )

    def test_a_service_that_signs_in_only_through_core_cannot_fall_back(
        self,
    ) -> None:
        assert sign_in_redirect_warnings(
            CATALOG, {"google-workspace": "core"}, None
        ) == [
            "SERVICE_SIGN_IN_REDIRECT names 'core' for google-workspace, but "
            "GATEWAY_PUBLIC_URL is unset, so google-workspace cannot be "
            "connected until it is set."
        ]
