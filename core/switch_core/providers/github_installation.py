from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from switch_core.providers.github import (
    GitHubConnections,
    GitHubError,
    GitHubUnavailableError,
    rate_limited,
    repository_writable,
)

logger = logging.getLogger(__name__)


# The one permission set every agent installation token carries. GitHub adds
# `metadata: read` to it.
GITHUB_PERMISSIONS = {"contents": "write", "pull_requests": "write"}
MAX_TOKEN_REPOSITORIES = 500


@dataclass(frozen=True)
class InstallationCredential:
    token: str = field(repr=False)
    expires_at: datetime
    installation_id: int
    account: str
    # `"all"`, or the `owner/name` of each repository the token reaches.
    repositories: Literal["all"] | list[str]


def granted_repositories(
    installation: dict, repositories: Literal["all"] | list[int]
) -> list[dict]:
    """The repositories of `installation` (as `GitHubConnections.repositories`
    lists it) a grant gives an agent: for `"all"`, each one the owner can push
    to; for a list, each listed one, which the owner must still see and push
    to. Raises `GitHubError` when the grant no longer holds."""
    visible = installation["repositories"]
    if repositories == "all":
        writable = [repo for repo in visible if repository_writable(repo)]
        if not writable:
            raise GitHubError(
                f"Your GitHub account cannot push to any repository of {installation['account']} that the Switch GitHub App can reach."
            )
        if len(writable) > MAX_TOKEN_REPOSITORIES:
            raise GitHubError(
                f"Your GitHub account can push to more than {MAX_TOKEN_REPOSITORIES} repositories of {installation['account']}. Grant selected repositories instead."
            )
        return writable
    by_id = {repo["id"]: repo for repo in visible}
    selected = []
    for repository_id in repositories:
        repository = by_id.get(repository_id)
        if repository is None:
            raise GitHubError(
                f"Your GitHub account no longer has access to a selected repository of {installation['account']}."
            )
        if not repository_writable(repository):
            raise GitHubError(
                f"Your GitHub account needs write access to {repository['name']} to grant it to a cloud agent."
            )
        selected.append(repository)
    return selected


def visible_installation(installations: list[dict], installation_id: int) -> dict:
    """The installation with `installation_id` among those the owner sees;
    `GitHubError` when the owner no longer sees it."""
    installation = next(
        (item for item in installations if item["id"] == installation_id), None
    )
    if installation is None:
        raise GitHubError(
            f"Your GitHub account no longer has access to GitHub installation {installation_id}. Update the agent's GitHub access."
        )
    return installation


class GitHubInstallationCredentials:
    def __init__(self, client_id: str, private_key_path: str):
        if not client_id:
            raise ValueError("A GitHub App client ID is required.")
        try:
            key = load_pem_private_key(
                Path(private_key_path).read_bytes(), password=None
            )
        except (ValueError, TypeError, OSError):
            raise ValueError(
                "The GitHub App signing key could not be loaded."
            ) from None
        if not isinstance(key, RSAPrivateKey) or key.key_size < 2048:
            raise ValueError(
                "The GitHub App signing key must be an RSA key of at least 2048 bits."
            )
        self._key = key
        self._client_id = client_id

    @staticmethod
    async def revoke(token: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                response = await client.delete(
                    "https://api.github.com/installation/token",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/vnd.github+json",
                    },
                )
            if response.status_code not in (204, 401, 404, 422):
                raise GitHubError(
                    "Could not revoke the GitHub installation credential."
                )
        except httpx.HTTPError:
            raise GitHubError(
                "Could not reach GitHub to revoke the installation credential."
            ) from None

    async def issue(
        self,
        github: GitHubConnections,
        user_token: str,
        installation_id: int,
        repositories: Literal["all"] | list[int],
    ) -> InstallationCredential:
        """An installation token limited to the repositories the grant gives
        (see `granted_repositories`), with `GITHUB_PERMISSIONS`. The owner's
        access is checked live with `user_token` first."""
        if (
            type(installation_id) is not int
            or installation_id <= 0
            or not (
                repositories == "all"
                or (
                    isinstance(repositories, list)
                    and 0 < len(repositories) <= MAX_TOKEN_REPOSITORIES
                    and all(type(item) is int and item > 0 for item in repositories)
                    and len(set(repositories)) == len(repositories)
                )
            )
        ):
            raise GitHubError("Choose a valid GitHub installation and repositories.")
        installation = visible_installation(
            await github.repositories(user_token), installation_id
        )
        selected = granted_repositories(installation, repositories)
        repository_ids = sorted(repo["id"] for repo in selected)
        now = int(time.time())
        assertion = jwt.encode(
            {"iat": now - 60, "exp": now + 540, "iss": self._client_id},
            self._key,
            algorithm="RS256",
        )
        token = None
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                response = await client.post(
                    f"https://api.github.com/app/installations/{installation_id}/access_tokens",
                    headers={
                        "Authorization": f"Bearer {assertion}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                    json={
                        "repository_ids": repository_ids,
                        "permissions": GITHUB_PERMISSIONS,
                    },
                )
            if rate_limited(response) or response.status_code >= 500:
                raise GitHubUnavailableError(
                    "GitHub is temporarily unavailable or rate limited. Please retry."
                )
            if response.status_code != 201:
                raise GitHubError(
                    "Could not authorize the agent for this GitHub installation. Check the GitHub App installation and signing key."
                )
            result = response.json()
            token = result["token"]
            expires_at = datetime.fromisoformat(
                result["expires_at"].replace("Z", "+00:00")
            )
            permissions = result["permissions"]
            if (
                not isinstance(token, str)
                or not token
                or len(token) > 16384
                or any(not 33 <= ord(char) <= 126 for char in token)
                or expires_at.tzinfo is None
                or not time.time() + 60 < expires_at.timestamp() <= time.time() + 3660
                or not isinstance(permissions, dict)
                or {k: v for k, v in permissions.items() if k != "metadata"}
                != GITHUB_PERMISSIONS
                or permissions.get("metadata", "read") != "read"
                or result.get("repository_selection") != "selected"
                or sorted(repo["id"] for repo in result["repositories"])
                != repository_ids
            ):
                raise GitHubError(
                    "GitHub returned an invalid installation credential or scope."
                )
            return InstallationCredential(
                token,
                expires_at,
                installation_id,
                installation["account"],
                "all" if repositories == "all" else [repo["name"] for repo in selected],
            )
        except (
            GitHubError,
            httpx.HTTPError,
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
        ) as error:
            if isinstance(token, str) and token:
                try:
                    async with asyncio.timeout(8):
                        await self.revoke(token)
                except Exception as cleanup_error:
                    logger.error(
                        "Rejected GitHub token could not be revoked: error_type=%s",
                        type(cleanup_error).__name__,
                    )
            if isinstance(error, GitHubError):
                raise
            raise GitHubError(
                "Could not obtain a scoped GitHub installation credential. Please retry."
            ) from None
