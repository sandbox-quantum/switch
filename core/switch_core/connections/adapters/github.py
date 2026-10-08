"""GitHub, as the credential broker reaches it: a GitHub App.

A person connects their GitHub account through the App (the user-to-server
sign-in Core refreshes); a grant names one of the App's installations and some
of its repositories. A token is an installation token for exactly those
repositories, with the level's permissions from the catalog, and acts as the
App. Before every grant and every issue the person's own sign-in is asked
which of those repositories they still see, and for write, can push to, so a
grant never reaches further than its owner does.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from switch_core.config import SwitchConfig
from switch_core.connections.adapters import (
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import AccessLevel
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubConnections,
    GitHubError,
    GitHubUnavailableError,
    repository_writable,
)
from switch_core.providers.github_installation import (
    MAX_REPOSITORIES,
    GitHubInstallationCredentials,
)
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GitHubApp:
    """The App this deployment is set up with.

    `signer` is None only on the deprecated hosted settings without a hosted
    controller file: GitHub can then be connected, but nothing can be granted.
    """

    connections: GitHubConnections
    signer: GitHubInstallationCredentials | None


def load_github_app(config: SwitchConfig) -> GitHubApp | None:
    """The App from `GITHUB_APP_*`, or for one release from the hosted settings."""
    if config.github_app_config_path is not None:
        if config.github_app_private_key_path is None:
            raise ValueError("GITHUB_APP_PRIVATE_KEY_PATH is not set.")
        connections = GitHubConnections(config.github_app_config_path)
        return GitHubApp(
            connections,
            GitHubInstallationCredentials(
                connections.client_id, config.github_app_private_key_path
            ),
        )
    if config.hosted_github_config_path is None:
        return None
    key_path: Path | None = None
    if config.hosted_controller_config_path is not None:
        key_path = HostedControllerSettings.model_validate_json(
            Path(config.hosted_controller_config_path).read_text()  # nosemgrep
        ).github_private_key_path
    logger.warning(
        "The GitHub App is configured through HOSTED_GITHUB_CONFIG_PATH and the "
        "hosted controller file's github_private_key_path, which stop working in "
        "the next release. Set GITHUB_APP_CONFIG_PATH and "
        "GITHUB_APP_PRIVATE_KEY_PATH instead."
    )
    connections = GitHubConnections(config.hosted_github_config_path)
    if key_path is None:
        logger.warning(
            "No GitHub App signing key is configured, so GitHub can be connected "
            "but not granted to agents."
        )
        return GitHubApp(connections, None)
    return GitHubApp(
        connections,
        GitHubInstallationCredentials(connections.client_id, str(key_path)),
    )


def _reach(resources: dict[str, Any]) -> tuple[int, list[int]]:
    installation_id = resources.get("installation_id")
    repository_ids = resources.get("repository_ids")
    if (
        type(installation_id) is not int
        or installation_id <= 0
        or not isinstance(repository_ids, list)
        or not 1 <= len(repository_ids) <= MAX_REPOSITORIES
        or any(type(i) is not int or i <= 0 for i in repository_ids)
        or len(set(repository_ids)) != len(repository_ids)
    ):
        raise ServiceAdapterError(
            "Choose one GitHub installation and 1 to "
            f"{MAX_REPOSITORIES} of its repositories."
        )
    return installation_id, sorted(repository_ids)


def _vendor_error(error: GitHubError) -> ServiceAdapterError:
    if isinstance(error, GitHubAuthorizationError):
        return ReauthorizationRequiredError(str(error))
    if isinstance(error, GitHubUnavailableError):
        return ServiceUnavailableError(str(error))
    return ServiceAdapterError(str(error))


class GitHubAdapter:
    def __init__(
        self,
        connections: GitHubConnections,
        signer: GitHubInstallationCredentials | None,
    ) -> None:
        self._connections = connections
        self._signer = signer
        self.can_issue = signer is not None

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        refresh_token = secret.values.get("refresh_token")
        refresh_expires_at = secret.values.get("refresh_expires_at")
        if (
            not isinstance(refresh_token, str)
            or not refresh_token
            or not isinstance(refresh_expires_at, int | float)
            or refresh_expires_at <= time.time()
        ):
            raise ReauthorizationRequiredError("The GitHub sign-in has expired.")
        try:
            refreshed = await self._connections.exchange(
                {"grant_type": "refresh_token", "refresh_token": refresh_token}
            )
        except GitHubError as error:
            raise _vendor_error(error) from None
        return ConnectionSecret({**secret.values, **refreshed})

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        installation_id, repository_ids = _reach(request.resources)
        try:
            reached = await self._connections.installation_repositories(
                access_token, installation_id, set(repository_ids)
            )
        except GitHubError as error:
            raise _vendor_error(error) from None
        if reached is None:
            raise ServiceAdapterError(
                "Your GitHub account no longer reaches the chosen installation of "
                "the GitHub App."
            )
        visible = {repo["id"]: repo for repo in reached}
        unseen = [i for i in repository_ids if i not in visible]
        if unseen:
            raise ServiceAdapterError(
                "Your GitHub account no longer has access to "
                f"{len(unseen)} of the chosen repositories."
            )
        if request.access == "write":
            read_only = sorted(
                visible[i]["name"]
                for i in repository_ids
                if not repository_writable(visible[i])
            )
            if read_only:
                raise ServiceAdapterError(
                    "Your GitHub account cannot push to "
                    f"{', '.join(read_only)}, so it cannot be granted for writing."
                )
        return {"installation_id": installation_id, "repository_ids": repository_ids}

    async def issue(self, access_token: str, request: IssueRequest) -> IssuedToken:
        resources = await self.check_grant(access_token, request)
        permissions = request.reach.get("permissions")
        if not isinstance(permissions, dict):
            raise ServiceAdapterError("GitHub grants name App permissions.")
        if self._signer is None:
            raise ServiceAdapterError(
                "GitHub cannot be granted on this server: no signing key is configured."
            )
        try:
            token = await self._signer.mint(
                resources["installation_id"], resources["repository_ids"], permissions
            )
        except GitHubError as error:
            raise _vendor_error(error) from None
        return IssuedToken(
            token=token.token,
            expires_at=token.expires_at,
            resources=resources,
            revocable=True,
        )

    async def revoke_issued(self, token: str) -> None:
        try:
            await GitHubInstallationCredentials.revoke(token)
        except GitHubError as error:
            raise _vendor_error(error) from None

    async def revoke_connection(self, secret: ConnectionSecret) -> None:
        token = secret.access_token
        if token is None:
            return
        try:
            await self._connections.revoke(token)
        except GitHubError as error:
            raise _vendor_error(error) from None

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        count = len(resources.get("repository_ids", []))
        noun = "repository" if count == 1 else "repositories"
        verb = "read and push to" if access == "write" else "read"
        return f"{agent_name} can {verb} {count} {noun}, acting as the GitHub App."
