"""The GitHub adapter, with GitHub's side faked.

The person's sign-in (`GitHubConnections`) and the App's token endpoint
(`GitHubInstallationCredentials.mint`) are replaced; what is under test is
what the adapter asks of them and how it answers the broker.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.config import SwitchConfig
from switch_core.connections.adapters import (
    ConnectionSecret,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.github import GitHubAdapter, load_github_app
from switch_core.connections.loader import CATALOG
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubError,
    GitHubUnavailableError,
)
from switch_core.providers.github_installation import InstallationToken

READ = CATALOG["github"].definition.access.read.model_dump(exclude_none=True)  # type: ignore[union-attr]
WRITE = CATALOG["github"].definition.access.write.model_dump(exclude_none=True)  # type: ignore[union-attr]
INSTALLATIONS = [
    {
        "id": 456,
        "account": "example-org",
        "repositories": [
            {"id": 789, "name": "example-org/app", "permissions": {"push": True}},
            {"id": 790, "name": "example-org/docs", "permissions": {"push": False}},
        ],
    }
]


def _request(access: str, resources: dict) -> IssueRequest:
    return IssueRequest(
        service="github",
        access=access,  # type: ignore[arg-type]
        reach=WRITE if access == "write" else READ,
        resources=resources,
    )


@pytest.fixture
def github() -> AsyncMock:
    connections = AsyncMock()
    connections.repositories = AsyncMock(return_value=INSTALLATIONS)
    return connections


@pytest.fixture
def signer() -> AsyncMock:
    signer = AsyncMock()
    signer.mint = AsyncMock(
        return_value=InstallationToken(
            "ghs_synthetic", datetime.now(UTC) + timedelta(hours=1), [789]
        )
    )
    return signer


@pytest.fixture
def adapter(github: AsyncMock, signer: AsyncMock) -> GitHubAdapter:
    return GitHubAdapter(github, signer)


class TestRefresh:
    async def test_a_lapsed_sign_in_needs_reauthorization(
        self, adapter: GitHubAdapter, github: AsyncMock
    ) -> None:
        secret = ConnectionSecret(
            {"refresh_token": "ghr_x", "refresh_expires_at": time.time() - 1}
        )
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.refresh(secret)
        github.exchange.assert_not_called()

    @pytest.mark.parametrize(
        ("raised", "expected"),
        [
            (GitHubAuthorizationError("revoked"), ReauthorizationRequiredError),
            (GitHubUnavailableError("down"), ServiceUnavailableError),
            (GitHubError("odd"), ServiceAdapterError),
        ],
    )
    async def test_github_refusals_map_to_the_brokers_errors(
        self, adapter: GitHubAdapter, github: AsyncMock, raised, expected
    ) -> None:
        github.exchange = AsyncMock(side_effect=raised)
        secret = ConnectionSecret(
            {"refresh_token": "ghr_x", "refresh_expires_at": time.time() + 60}
        )
        with pytest.raises(expected):
            await adapter.refresh(secret)

    async def test_a_refresh_keeps_what_it_does_not_replace(
        self, adapter: GitHubAdapter, github: AsyncMock
    ) -> None:
        github.exchange = AsyncMock(
            return_value={"access_token": "gho_new", "refresh_token": "ghr_new"}
        )
        secret = ConnectionSecret(
            {
                "access_token": "gho_old",
                "refresh_token": "ghr_old",
                "refresh_expires_at": time.time() + 60,
                "login": "ada",
                "user_id": 1001,
            }
        )
        renewed = await adapter.refresh(secret)
        github.exchange.assert_awaited_once_with(
            {"grant_type": "refresh_token", "refresh_token": "ghr_old"}
        )
        assert renewed.values["access_token"] == "gho_new"
        assert (renewed.values["login"], renewed.values["user_id"]) == ("ada", 1001)


class TestGrantChecks:
    async def test_the_resources_come_back_in_order(
        self, adapter: GitHubAdapter
    ) -> None:
        checked = await adapter.check_grant(
            "gho_user",
            _request("read", {"installation_id": 456, "repository_ids": [790, 789]}),
        )
        assert checked == {"installation_id": 456, "repository_ids": [789, 790]}

    @pytest.mark.parametrize(
        "resources",
        [
            {},
            {"installation_id": 456, "repository_ids": []},
            {"installation_id": 456, "repository_ids": [789, 789]},
            {"installation_id": 456, "repository_ids": list(range(1, 502))},
            {"installation_id": True, "repository_ids": [789]},
        ],
    )
    async def test_a_malformed_reach_is_refused_before_asking_github(
        self, adapter: GitHubAdapter, github: AsyncMock, resources
    ) -> None:
        with pytest.raises(ServiceAdapterError, match="1 to 500"):
            await adapter.check_grant("gho_user", _request("read", resources))
        github.repositories.assert_not_called()

    async def test_an_installation_the_person_no_longer_reaches(
        self, adapter: GitHubAdapter
    ) -> None:
        with pytest.raises(ServiceAdapterError, match="installation"):
            await adapter.check_grant(
                "gho_user",
                _request("read", {"installation_id": 999, "repository_ids": [789]}),
            )

    async def test_a_repository_the_person_no_longer_sees(
        self, adapter: GitHubAdapter
    ) -> None:
        with pytest.raises(ServiceAdapterError, match="1 of the chosen"):
            await adapter.check_grant(
                "gho_user",
                _request("read", {"installation_id": 456, "repository_ids": [789, 1]}),
            )

    async def test_write_needs_push_on_every_repository(
        self, adapter: GitHubAdapter
    ) -> None:
        resources = {"installation_id": 456, "repository_ids": [789, 790]}
        assert await adapter.check_grant("gho_user", _request("read", resources))
        with pytest.raises(ServiceAdapterError, match="example-org/docs"):
            await adapter.check_grant("gho_user", _request("write", resources))

    async def test_a_revoked_sign_in_needs_reauthorization(
        self, adapter: GitHubAdapter, github: AsyncMock
    ) -> None:
        github.repositories = AsyncMock(side_effect=GitHubAuthorizationError("401"))
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.check_grant(
                "gho_user",
                _request("read", {"installation_id": 456, "repository_ids": [789]}),
            )


class TestIssue:
    async def test_mints_for_exactly_the_grant_with_the_levels_permissions(
        self, adapter: GitHubAdapter, signer: AsyncMock, github: AsyncMock
    ) -> None:
        issued = await adapter.issue(
            "gho_user",
            _request("read", {"installation_id": 456, "repository_ids": [789]}),
        )
        github.repositories.assert_awaited_once_with("gho_user")
        signer.mint.assert_awaited_once_with(
            456, [789], {"contents": "read", "pull_requests": "read"}
        )
        assert issued.revocable
        assert issued.resources == {"installation_id": 456, "repository_ids": [789]}
        assert issued.token not in repr(issued)

    async def test_nothing_is_minted_when_the_person_lost_access(
        self, adapter: GitHubAdapter, signer: AsyncMock
    ) -> None:
        with pytest.raises(ServiceAdapterError):
            await adapter.issue(
                "gho_user",
                _request("write", {"installation_id": 456, "repository_ids": [790]}),
            )
        signer.mint.assert_not_called()

    def test_the_summary_counts_what_it_reaches(self, adapter: GitHubAdapter) -> None:
        assert (
            adapter.summary("Build bot", "write", {"repository_ids": [1, 2]})
            == "Build bot can read and push to 2 repositories, acting as the GitHub App."
        )
        assert adapter.summary("Reader", "read", {"repository_ids": [1]}) == (
            "Reader can read 1 repository, acting as the GitHub App."
        )


_BASE = dict(
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


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE, **overrides})  # type: ignore[arg-type]


def _app_files(tmp_path: Path) -> tuple[str, str]:
    settings = tmp_path / "github.json"
    settings.write_text(
        json.dumps(
            {
                "client_id": "example-client",
                "client_secret": "SYNTHETIC-PLACEHOLDER",
                "slug": "example-app",
                "origin": "https://switch.example.com",
            }
        )
    )
    key = tmp_path / "app.pem"
    key.write_bytes(
        rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return str(settings), str(key)


class TestSettings:
    def test_both_or_neither(self, tmp_path: Path) -> None:
        settings, key = _app_files(tmp_path)
        with pytest.raises(ValueError, match="together or not at all"):
            _config(github_app_config_path=settings)
        with pytest.raises(ValueError, match="together or not at all"):
            _config(github_app_private_key_path=key)
        with pytest.raises(ValueError, match="absolute path"):
            _config(
                github_app_config_path=settings, github_app_private_key_path="a.pem"
            )

    def test_the_new_settings_name_the_app(self, tmp_path: Path, caplog) -> None:
        settings, key = _app_files(tmp_path)
        app = load_github_app(
            _config(github_app_config_path=settings, github_app_private_key_path=key)
        )
        assert app is not None
        assert app.connections.client_id == "example-client"
        assert "deprecated" not in caplog.text and "stop working" not in caplog.text

    def test_nothing_set_means_no_app(self) -> None:
        assert load_github_app(_config()) is None

    def test_the_hosted_settings_still_work_with_a_warning(
        self, tmp_path: Path, caplog
    ) -> None:
        caplog.set_level(logging.WARNING)
        settings, key = _app_files(tmp_path)
        controller = tmp_path / "controller.json"
        controller.write_text(
            json.dumps(
                {
                    "tenant_id": "t",
                    "token": "x" * 32,
                    "machine_slots": ["slot-1"],
                    "github_private_key_path": key,
                    "agent_api_endpoint": "https://switch.example.com",
                }
            )
        )
        app = load_github_app(
            _config(
                hosted_github_config_path=settings,
                hosted_controller_config_path=str(controller),
            )
        )
        assert app is not None
        assert "GITHUB_APP_CONFIG_PATH" in caplog.text

    def test_the_hosted_settings_without_a_key_connect_but_cannot_grant(
        self, tmp_path: Path, caplog
    ) -> None:
        caplog.set_level(logging.WARNING)
        settings, _ = _app_files(tmp_path)
        app = load_github_app(_config(hosted_github_config_path=settings))
        assert app is not None and app.signer is None
        assert "not granted to agents" in caplog.text
        adapter = GitHubAdapter(app.connections, app.signer)
        assert not adapter.can_issue
