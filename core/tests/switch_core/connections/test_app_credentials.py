"""Where each connector's app comes from, and a change taking effect at once."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.datastructures import State

from switch_core.connections.adapters.github import GitHubAdapter
from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.app_credentials import (
    SECRET_NAMES,
    ConnectorApps,
    install_github_app,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.connections.registry import ClientRegistration, ServiceSetupError
from switch_core.db.models import User
from switch_core.db.stores.service_app_credential_store import (
    ServiceAppCredentialStore,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.keys import Keyring
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _app_files, _config

PUBLIC_URL = "https://switch.example.test"
GOOGLE_VARIABLE = "GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH"


def _pem(key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _rsa_pem() -> str:
    return _pem(rsa.generate_private_key(public_exponent=65537, key_size=2048))


def _google_file(tmp_path: Path, client_id: str = "configured-client-id") -> str:
    path = tmp_path / "google.json"
    path.write_text(
        json.dumps({"client_id": client_id, "client_secret": "example-secret-0000"})
    )
    return str(path)


def _apps(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    environ: dict[str, str] | None = None,
    **config: object,
) -> ConnectorApps:
    settings = _config(**{"gateway_public_url": PUBLIC_URL, **config})
    return ConnectorApps(
        catalog=CATALOG,
        config=settings,
        environ=environ or {},
        session_factory=session_factory,
        store=ServiceAppCredentialStore(TEST_KEYRING),
        http=httpx.AsyncClient(),
        registration=ClientRegistration(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            public_url=settings.gateway_public_url,
            server_name="switch.local",
        ),
    )


async def _operator(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="operator",
            email=f"operator-{uuid.uuid4().hex[:6]}@example.invalid",
            role="admin",
        )
        session.add(user)
        await session.commit()
        return user.id


async def _save(
    session_factory: async_sessionmaker[AsyncSession],
    service: str,
    *,
    client_id: str,
    secrets: dict[str, str],
    settings: dict[str, str] | None = None,
    keyring: Keyring = TEST_KEYRING,
) -> None:
    operator = await _operator(session_factory)
    kind = "github_app" if service == "github" else "oauth_client"
    async with session_factory() as session:
        await ServiceAppCredentialStore(keyring).save(
            session,
            service=service,
            client_id=client_id,
            settings=settings or {},
            secrets=secrets,
            secret_names=SECRET_NAMES[kind],
            updated_by=operator,
        )
        await session.commit()


def _broker(session_factory: async_sessionmaker[AsyncSession]) -> ServiceBroker:
    return ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={},
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )


class TestSpecs:
    def test_the_catalogs_apps_are_github_and_googles_client(self, session_factory):
        specs = _apps(session_factory).specs
        assert {slug: spec.kind for slug, spec in specs.items()} == {
            "github": "github_app",
            "google-workspace": "oauth_client",
        }
        assert specs["google-workspace"].variables == (GOOGLE_VARIABLE,)
        assert specs["github"].secret_names == {"client_secret", "private_key"}


class TestPrecedence:
    async def test_nothing_set_is_not_set_up(self, session_factory) -> None:
        apps = _apps(session_factory)
        await apps.load()
        assert apps.effective("google-workspace").source == "none"
        assert apps.github_app() is None
        assert apps.oauth_clients() == {}

    async def test_configuration_is_used_as_it_always_was(
        self, session_factory, tmp_path: Path
    ) -> None:
        apps = _apps(session_factory, environ={GOOGLE_VARIABLE: _google_file(tmp_path)})
        await apps.load()
        effective = apps.effective("google-workspace")
        assert effective.source == "configuration"
        assert effective.configuration_variables == (GOOGLE_VARIABLE,)
        assert effective.saved_ignored is False
        assert apps.oauth_clients()["google-workspace"].client_id == (
            "configured-client-id"
        )

    async def test_configuration_set_but_unusable_stops_the_server(
        self, session_factory, tmp_path: Path
    ) -> None:
        path = tmp_path / "google.json"
        path.write_text("not json")
        apps = _apps(session_factory, environ={GOOGLE_VARIABLE: str(path)})
        with pytest.raises(ServiceSetupError):
            await apps.load()

    async def test_a_saved_client_is_used_when_configuration_is_unset(
        self, session_factory
    ) -> None:
        await _save(
            session_factory,
            "google-workspace",
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        apps = _apps(session_factory)
        await apps.load()
        effective = apps.effective("google-workspace")
        assert effective.source == "saved"
        client = apps.oauth_clients()["google-workspace"]
        assert (client.client_id, client.client_secret) == (
            "saved-client-id",
            "example-secret-1111",
        )

    async def test_configuration_wins_over_a_saved_client_and_says_so(
        self, session_factory, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        await _save(
            session_factory,
            "google-workspace",
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        apps = _apps(session_factory, environ={GOOGLE_VARIABLE: _google_file(tmp_path)})
        with caplog.at_level(logging.WARNING):
            await apps.load()
        effective = apps.effective("google-workspace")
        assert effective.source == "configuration"
        assert effective.saved_ignored is True
        assert apps.oauth_clients()["google-workspace"].client_id == (
            "configured-client-id"
        )
        assert any(
            GOOGLE_VARIABLE in record.getMessage() and record.levelno == logging.WARNING
            for record in caplog.records
        )

    async def test_the_deprecated_hosted_file_counts_as_configuration(
        self, session_factory, tmp_path: Path
    ) -> None:
        settings, _ = _app_files(tmp_path)
        apps = _apps(session_factory, hosted_github_config_path=settings)
        await apps.load()
        effective = apps.effective("github")
        assert effective.source == "configuration"
        assert effective.deprecated is True
        assert effective.configuration_variables == ("HOSTED_GITHUB_CONFIG_PATH",)
        app = apps.github_app()
        assert app is not None and app.signer is None

    async def test_a_configured_github_app_keeps_its_files_origin(
        self, session_factory, tmp_path: Path
    ) -> None:
        settings, key = _app_files(tmp_path)
        apps = _apps(
            session_factory,
            github_app_config_path=settings,
            github_app_private_key_path=key,
        )
        await apps.load()
        effective = apps.effective("github")
        assert effective.source == "configuration"
        assert effective.configuration_variables == (
            "GITHUB_APP_CONFIG_PATH",
            "GITHUB_APP_PRIVATE_KEY_PATH",
        )
        assert effective.values is not None
        assert effective.values.secrets["private_key"].startswith("-----BEGIN")
        app = apps.github_app()
        assert app is not None
        assert app.connections.origin == "https://switch.example.com"


class TestSavedGitHubApp:
    async def test_it_is_called_back_at_the_public_url(self, session_factory) -> None:
        await _save(
            session_factory,
            "github",
            client_id="example-client-id",
            settings={"slug": "example-app"},
            secrets={"client_secret": "example-secret-0000", "private_key": _rsa_pem()},
        )
        apps = _apps(session_factory)
        await apps.load()
        app = apps.github_app()
        assert app is not None and app.signer is not None
        assert app.connections.callback == (
            f"{PUBLIC_URL}/gateway/provider-connections/github/callback"
        )

    async def test_it_is_not_set_up_without_an_https_public_url(
        self, session_factory
    ) -> None:
        await _save(
            session_factory,
            "github",
            client_id="example-client-id",
            settings={"slug": "example-app"},
            secrets={"client_secret": "example-secret-0000", "private_key": _rsa_pem()},
        )
        apps = _apps(session_factory, gateway_public_url="http://switch.example.test")
        await apps.load()
        effective = apps.effective("github")
        assert effective.source == "none"
        assert effective.load_error is not None
        assert "https" in effective.load_error

    async def test_a_key_that_is_not_rsa_leaves_it_not_set_up(
        self, session_factory, caplog: pytest.LogCaptureFixture
    ) -> None:
        await _save(
            session_factory,
            "github",
            client_id="example-client-id",
            settings={"slug": "example-app"},
            secrets={
                "client_secret": "example-secret-0000",
                "private_key": _pem(ec.generate_private_key(ec.SECP256R1())),
            },
        )
        apps = _apps(session_factory)
        with caplog.at_level(logging.ERROR):
            await apps.load()
        effective = apps.effective("github")
        assert effective.source == "none"
        assert effective.load_error is not None and "RSA" in effective.load_error
        assert effective.unreadable is False
        assert any(record.levelno == logging.ERROR for record in caplog.records)

    async def test_a_row_no_key_opens_is_unreadable(self, session_factory) -> None:
        retired = Keyring.parse("retired:" + "r" * 40, legacy_secret=None)
        await _save(
            session_factory,
            "google-workspace",
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
            keyring=retired,
        )
        apps = _apps(session_factory)
        await apps.load()
        effective = apps.effective("google-workspace")
        assert effective.source == "none"
        assert effective.unreadable is True


class TestApply:
    async def test_a_saved_client_is_in_use_at_once(self, session_factory) -> None:
        apps = _apps(session_factory)
        await apps.load()
        broker = _broker(session_factory)
        assert broker.connectable("google-workspace") is False

        await _save(
            session_factory,
            "google-workspace",
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        await apps.apply("google-workspace", broker=broker, state=State())

        assert broker.connectable("google-workspace") is True
        _, adapter = broker.sign_in("google-workspace")
        assert isinstance(adapter, OAuthAdapter)

        async with session_factory() as session:
            await apps.store.remove(session, "google-workspace")
            await session.commit()
        await apps.apply("google-workspace", broker=broker, state=State())
        assert broker.connectable("google-workspace") is False

    async def test_the_saved_github_app_is_swapped_in_place(
        self, session_factory
    ) -> None:
        await _save(
            session_factory,
            "github",
            client_id="example-client-id",
            settings={"slug": "example-app"},
            secrets={"client_secret": "example-secret-0000", "private_key": _rsa_pem()},
        )
        apps = _apps(session_factory)
        await apps.load()
        state = State()
        install_github_app(state, apps.github_app())
        before = state.github_connections

        await _save(
            session_factory,
            "github",
            client_id="example-client-id",
            settings={"slug": "example-app"},
            secrets={"client_secret": "example-secret-1111"},
        )
        broker = _broker(session_factory)
        await apps.apply("github", broker=broker, state=state)

        after = state.github_connections
        assert after is not before
        assert after.client_secret == "example-secret-1111"
        assert state.github_app.connections is after
        assert isinstance(broker._adapters["github"], GitHubAdapter)
