from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

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


# GitHub's limit on the repositories one installation token may name.
MAX_REPOSITORIES = 500


@dataclass(frozen=True)
class InstallationToken:
    token: str = field(repr=False)
    expires_at: datetime
    repository_ids: list[int]


@dataclass(frozen=True)
class RepositoryCredential:
    token: str = field(repr=False)
    expires_at: datetime
    repository_id: int
    repository_name: str


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
                raise GitHubError("Could not revoke the GitHub repository credential.")
        except httpx.HTTPError:
            raise GitHubError(
                "Could not reach GitHub to revoke the repository credential."
            ) from None

    async def issue(
        self,
        github: GitHubConnections,
        user_token: str,
        installation_id: int,
        repository_id: int,
    ) -> RepositoryCredential:
        if (
            type(installation_id) is not int
            or installation_id <= 0
            or type(repository_id) is not int
            or repository_id <= 0
        ):
            raise GitHubError("Choose a valid GitHub installation and repository.")
        installations = await github.repositories(user_token)
        repository = next(
            (
                repo
                for installation in installations
                if installation["id"] == installation_id
                for repo in installation["repositories"]
                if repo["id"] == repository_id
            ),
            None,
        )
        if repository is None:
            raise GitHubError(
                "Your GitHub account no longer has access to the selected repository."
            )
        if not repository_writable(repository):
            raise GitHubError(
                "Your GitHub account needs write access to this repository to run a cloud agent."
            )
        token = await self.mint(
            installation_id,
            [repository_id],
            {"contents": "write", "pull_requests": "write"},
        )
        return RepositoryCredential(
            token.token, token.expires_at, repository_id, repository["name"]
        )

    async def mint(
        self,
        installation_id: int,
        repository_ids: list[int],
        permissions: dict[str, str],
    ) -> InstallationToken:
        """An installation token for exactly these repositories and permissions.

        GitHub's answer is checked against the request: the same permissions
        (and `metadata: read`, which every token carries), the same
        repositories, and an expiry within the hour. Any difference revokes
        the token and refuses it.
        """
        if (
            type(installation_id) is not int
            or installation_id <= 0
            or not 1 <= len(repository_ids) <= MAX_REPOSITORIES
            or len(set(repository_ids)) != len(repository_ids)
            or any(type(i) is not int or i <= 0 for i in repository_ids)
        ):
            raise GitHubError(
                f"Choose a GitHub installation and 1 to {MAX_REPOSITORIES} repositories."
            )
        if (
            not permissions
            or "workflows" in permissions
            or any(level not in ("read", "write") for level in permissions.values())
        ):
            raise GitHubError("These GitHub permissions cannot be granted.")
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
                        "repository_ids": list(repository_ids),
                        "permissions": dict(permissions),
                    },
                )
            if rate_limited(response) or response.status_code >= 500:
                raise GitHubUnavailableError(
                    "GitHub is temporarily unavailable or rate limited. Please retry."
                )
            if response.status_code != 201:
                raise GitHubError(
                    "Could not authorize the worker for this repository. Check the GitHub App installation and signing key."
                )
            result = response.json()
            token = result["token"]
            expires_at = datetime.fromisoformat(
                result["expires_at"].replace("Z", "+00:00")
            )
            returned = result["permissions"]
            if (
                not isinstance(token, str)
                or not token
                or len(token) > 16384
                or any(not 33 <= ord(char) <= 126 for char in token)
                or expires_at.tzinfo is None
                or not time.time() + 60 < expires_at.timestamp() <= time.time() + 3660
                or not isinstance(returned, dict)
                or {k: v for k, v in returned.items() if k != "metadata"}
                != dict(permissions)
                or returned.get("metadata", "read") != "read"
                or sorted(repo["id"] for repo in result["repositories"])
                != sorted(repository_ids)
            ):
                raise GitHubError(
                    "GitHub returned an invalid repository credential or scope."
                )
            return InstallationToken(token, expires_at, sorted(repository_ids))
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
                "Could not obtain a scoped GitHub repository credential. Please retry."
            ) from None
