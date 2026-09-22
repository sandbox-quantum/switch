from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from switch_core.providers.github import GitHubConnections, GitHubError


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
        now = int(time.time())
        assertion = jwt.encode(
            {"iat": now - 60, "exp": now + 540, "iss": self._client_id},
            self._key,
            algorithm="RS256",
        )
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
                        "repository_ids": [repository_id],
                        "permissions": {"contents": "write", "pull_requests": "write"},
                    },
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
            permissions = result["permissions"]
            if (
                not isinstance(token, str)
                or not token
                or len(token) > 16384
                or any(not 33 <= ord(char) <= 126 for char in token)
                or expires_at.tzinfo is None
                or not time.time() + 60 < expires_at.timestamp() <= time.time() + 3660
                or not isinstance(permissions, dict)
                or permissions.get("contents") != "write"
                or permissions.get("pull_requests") != "write"
                or set(permissions) - {"contents", "pull_requests", "metadata"}
                or permissions.get("metadata", "read") != "read"
                or [repo["id"] for repo in result["repositories"]] != [repository_id]
            ):
                raise GitHubError(
                    "GitHub returned an invalid repository credential or scope."
                )
            return RepositoryCredential(
                token, expires_at, repository_id, repository["name"]
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            raise GitHubError(
                "Could not obtain a scoped GitHub repository credential. Please retry."
            ) from None
