"""GitHub, as the credential broker reaches it: a GitHub App.

A person connects their GitHub account through the App (the user-to-server
sign-in Core refreshes); a grant names one of the App's installations and some
of its repositories. A token is an installation token for exactly those
repositories, with the level's permissions from the catalog, and acts as the
App. Before every grant and every issue the person's own sign-in is asked
which of those repositories they still see, and for write, can push to, so a
grant never reaches further than its owner does.

An App whose permissions stop short of what the catalog's write level asks
for, as GitHub answered when it was saved or last checked
(`connections/app_checks.py`), lets agents read only: the broker refuses a
write grant on it, and a token for one made before.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from switch_core.config import SwitchConfig
from switch_core.connections.adapters import (
    AccessToken,
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import AccessLevel, ConnectionDefinition
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

logger = logging.getLogger(__name__)

# A GitHub App permission's levels as `GET /app` names them, least first.
PERMISSION_LEVELS = ("read", "write", "admin")


def level_permissions(
    definition: ConnectionDefinition, access: AccessLevel
) -> dict[str, AccessLevel]:
    """The App permissions the catalog's `access` level asks for; none for a
    level the entry does not have."""
    levels = definition.access
    if levels is None:
        raise ValueError(f"{definition.name} lists no access levels.")
    level = getattr(levels, access)
    return {} if level is None else dict(level.permissions or {})


def permission_rank(level: object) -> int:
    """Where `level` stands among GitHub's, -1 for none or one unknown."""
    return PERMISSION_LEVELS.index(level) if level in PERMISSION_LEVELS else -1


def permissions_short(
    wanted: Mapping[str, AccessLevel], held: Mapping[str, object]
) -> list[str]:
    """The permissions `wanted` asks for that `held`, an App's permissions as
    `GET /app` answers them, has at a lower level or not at all."""
    return [
        name
        for name, level in wanted.items()
        if permission_rank(held.get(name)) < permission_rank(level)
    ]


def permission_name(name: str) -> str:
    """A permission as the App's settings page names it: `Pull requests`."""
    return name.replace("_", " ").capitalize()


@dataclass(frozen=True)
class GitHubApp:
    """The App this deployment is set up with.

    `signer` is None only on the deprecated `HOSTED_GITHUB_CONFIG_PATH`, which
    names no signing key: GitHub can then be connected, but nothing granted.
    `lacks_write` names the permissions the catalog's write level asks for
    that GitHub said the App lacks, when it was saved or last checked: while
    it names any, agents can only read through the App. An App Switch has
    not asked about (one from configuration, or copied in from it and not
    checked since) is taken to lack none.
    """

    connections: GitHubConnections
    signer: GitHubInstallationCredentials | None
    lacks_write: tuple[str, ...]

    @property
    def read_only(self) -> bool:
        return bool(self.lacks_write)


def load_github_app(config: SwitchConfig) -> GitHubApp | None:
    """The App from `GITHUB_APP_*`, or from the deprecated hosted settings."""
    if config.github_app_config_path is not None:
        if config.github_app_private_key_path is None:
            raise ValueError("GITHUB_APP_PRIVATE_KEY_PATH is not set.")
        connections = GitHubConnections.from_file(config.github_app_config_path)
        return GitHubApp(
            connections,
            GitHubInstallationCredentials.from_file(
                connections.client_id, config.github_app_private_key_path
            ),
            lacks_write=(),
        )
    if config.hosted_github_config_path is None:
        return None
    logger.warning(
        "The GitHub App is configured through HOSTED_GITHUB_CONFIG_PATH, which "
        "is deprecated and will be removed, and no signing key is configured, so "
        "GitHub can be connected but not granted to agents. Set "
        "GITHUB_APP_CONFIG_PATH and GITHUB_APP_PRIVATE_KEY_PATH instead."
    )
    return GitHubApp(
        GitHubConnections.from_file(config.hosted_github_config_path),
        None,
        lacks_write=(),
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
        *,
        read_only: bool,
    ) -> None:
        self._connections = connections
        self._signer = signer
        self.can_issue = signer is not None
        self.read_only = read_only

    def current_client_id(self) -> str | None:
        return self._connections.client_id

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

    async def resolve_repositories(
        self, access_token: str, names: list[str]
    ) -> dict[str, Any]:
        """A grant's resources for repositories named `owner/name`: the one
        installation of the App that reaches them all, and their ids."""
        try:
            reach = await self._connections.repositories(access_token)
        except GitHubError as error:
            raise _vendor_error(error) from None
        wanted = {name.lower(): name for name in names}
        for installation in reach.installations:
            found = {
                repo["name"].lower(): repo["id"]
                for repo in installation["repositories"]
                if repo["name"].lower() in wanted
            }
            if len(found) == len(wanted):
                return {
                    "installation_id": installation["id"],
                    "repository_ids": sorted(found.values()),
                }
        reached = {
            repo["name"].lower()
            for installation in reach.installations
            for repo in installation["repositories"]
        }
        unseen = sorted(name for key, name in wanted.items() if key not in reached)
        if unseen:
            raise ServiceAdapterError(
                "Your GitHub account does not reach "
                f"{', '.join(unseen)} through the GitHub App. Install the App on "
                "it, or check the name is owner/name."
            )
        raise ServiceAdapterError(
            "One GitHub grant reaches repositories of one installation of the "
            f"GitHub App, and {', '.join(names)} span several."
        )

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

    async def issue(self, access: AccessToken, request: IssueRequest) -> IssuedToken:
        resources = await self.check_grant(access.token, request)
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
