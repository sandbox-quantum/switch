from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx


class GitHubError(Exception):
    pass


class GitHubUnavailableError(GitHubError):
    pass


class GitHubAuthorizationError(GitHubError):
    pass


class GitHubNotFoundError(GitHubError):
    pass


# How far a check of one installation pages before it gives up: 10,000
# repositories, against the 1,000 the picker lists across them all.
INSTALLATION_PAGES = 100


def _repository(repo: object) -> dict:
    if (
        not isinstance(repo, dict)
        or type(repo.get("id")) is not int
        or not isinstance(repo.get("full_name"), str)
    ):
        raise GitHubError("GitHub returned an invalid repository.")
    permissions = repo.get("permissions", {})
    return {
        "id": repo["id"],
        "name": repo["full_name"],
        "permissions": {
            key: isinstance(permissions, dict) and permissions.get(key) is True
            for key in ("push", "maintain", "admin")
        },
    }


def repository_writable(repository: dict) -> bool:
    permissions = repository.get("permissions")
    return isinstance(permissions, dict) and any(
        permissions.get(key) is True for key in ("push", "maintain", "admin")
    )


def rate_limited(response: httpx.Response) -> bool:
    return response.status_code == 429 or (
        response.status_code == 403
        and (
            response.headers.get("x-ratelimit-remaining") == "0"
            or "retry-after" in response.headers
            or "secondary rate limit" in response.text.lower()
        )
    )


def sso_hidden_organizations(header: str | None) -> list[int]:
    """The organization ids an `X-GitHub-SSO: partial-results` header names:
    those whose single sign-on this token is not authorized for, so a list
    GitHub answered leaves out what they hold."""
    if not header:
        return []
    kind, _, rest = header.partition(";")
    if kind.strip() != "partial-results":
        return []
    for part in rest.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "organizations":
            return [int(v) for v in value.split(",") if v.strip().isdigit()]
    return []


@dataclass(frozen=True)
class GitHubReach:
    """The App's installations a person reaches, and the organizations whose
    single sign-on hid installations from their sign-in (`sso_hidden`), which
    a new sign-in that authorizes them shows."""

    installations: list[dict]
    sso_hidden: list[int]


class GitHubConnections:
    def __init__(
        self, *, client_id: str, client_secret: str, slug: str, origin: str
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.slug = slug
        self.origin = origin.rstrip("/")
        url = urlsplit(self.origin)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.path
            or url.query
            or url.fragment
            or not re.fullmatch(r"[a-z0-9-]+", self.slug)
            or not self.client_id
            or not self.client_secret
        ):
            raise ValueError("GitHub connection configuration is invalid")
        self.callback = self.origin + "/gateway/provider-connections/github/callback"
        self.install_url = f"https://github.com/apps/{self.slug}/installations/new"

    @classmethod
    def from_file(cls, config_path: str) -> GitHubConnections:
        config = json.loads(Path(config_path).read_text())
        return cls(
            client_id=config["client_id"],
            client_secret=config["client_secret"],
            slug=config["slug"],
            origin=config["origin"],
        )

    async def revoke(self, token: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                response = await client.request(
                    "DELETE",
                    f"https://api.github.com/applications/{self.client_id}/token",
                    auth=httpx.BasicAuth(self.client_id, self.client_secret),
                    json={"access_token": token},
                    headers={"Accept": "application/vnd.github+json"},
                )
            if response.status_code not in (204, 404, 422):
                raise GitHubError("Could not revoke the GitHub sign-in.")
        except httpx.HTTPError:
            raise GitHubError("Could not reach GitHub to revoke the sign-in.") from None

    def authorize_url(self, state: str, verifier: str) -> str:
        """Where the browser signs in at GitHub for the flow under `state`."""
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        return "https://github.com/login/oauth/authorize?" + urlencode(
            {
                "client_id": self.client_id,
                "redirect_uri": self.callback,
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }
        )

    async def request(
        self, method: str, url: str, *, token: str, data: dict | None
    ) -> dict:
        result, _ = await self.request_with_headers(method, url, token=token, data=data)
        return result

    async def request_with_headers(
        self, method: str, url: str, *, token: str, data: dict | None
    ) -> tuple[dict, httpx.Headers]:
        headers = {"Accept": "application/json", "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.request(method, url, headers=headers, data=data)
            if response.status_code == 401:
                raise GitHubAuthorizationError(
                    "GitHub access expired or was revoked. Connect GitHub again."
                )
            if rate_limited(response) or response.status_code >= 500:
                raise GitHubUnavailableError(
                    "GitHub refused this request or reached its rate limit. Check access and retry later."
                )
            if response.status_code == 403:
                raise GitHubError(
                    "GitHub access was refused. Check repository permissions, organization sign-in, and the App installation."
                )
            if response.status_code == 404:
                raise GitHubNotFoundError(
                    "GitHub could not complete the request. Check access and try again."
                )
            if not response.is_success:
                raise GitHubError(
                    "GitHub could not complete the request. Check access and try again."
                )
            result = response.json()
            if isinstance(result, dict) and result.get("error") in {
                "invalid_grant",
                "bad_refresh_token",
                "expired_token",
            }:
                raise GitHubAuthorizationError(
                    "GitHub authorization expired or was revoked. Reconnect GitHub."
                )
            if not isinstance(result, dict) or result.get("error"):
                raise GitHubError(
                    "GitHub authorization was not completed. Connect again."
                )
            return result, response.headers
        except (httpx.HTTPError, ValueError):
            raise GitHubUnavailableError(
                "Could not reach GitHub or read its response. Please try again."
            ) from None

    async def exchange(self, data: dict) -> dict:
        result = await self.request(
            "POST",
            "https://github.com/login/oauth/access_token",
            token="",
            data={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                **data,
            },
        )
        if not all(
            isinstance(result.get(k), str) and result[k]
            for k in ("access_token", "refresh_token")
        ):
            raise GitHubError(
                "GitHub did not return expiring credentials. Check the app configuration."
            )
        if not isinstance(result.get("expires_in"), int) or not isinstance(
            result.get("refresh_token_expires_in"), int
        ):
            raise GitHubError("GitHub did not return credential expiration times.")
        return {
            "access_token": result["access_token"],
            "refresh_token": result["refresh_token"],
            "expires_at": time.time() + result["expires_in"],
            "refresh_expires_at": time.time() + result["refresh_token_expires_in"],
        }

    async def sign_in(self, code: str, verifier: str) -> dict:
        """Exchange the code the browser brought back, and read whose account
        it signed in to: the credentials a connection stores."""
        credentials = await self.exchange(
            {
                "code": code,
                "redirect_uri": self.callback,
                "code_verifier": verifier,
            }
        )
        user = await self.request(
            "GET",
            "https://api.github.com/user",
            token=credentials["access_token"],
            data=None,
        )
        if not isinstance(user.get("login"), str) or not isinstance(
            user.get("id"), int
        ):
            raise GitHubError("GitHub did not return a valid account.")
        return {**credentials, "login": user["login"], "user_id": user["id"]}

    async def pages(self, path: str, key: str, token: str) -> list[dict]:
        values = []
        for page in range(1, 11):
            result = await self.request(
                "GET",
                f"https://api.github.com{path}?per_page=100&page={page}",
                token=token,
                data=None,
            )
            batch = result.get(key)
            if not isinstance(batch, list):
                raise GitHubError("GitHub returned an invalid repository list.")
            values.extend(batch)
            if len(batch) < 100:
                return values
        raise GitHubError(
            "Too many GitHub results to display. Limit the app's repository access and try again."
        )

    async def _installations(self, token: str) -> tuple[list[dict], list[int]]:
        """The App's installations the person reaches, and the organizations
        whose single sign-on hid theirs from this token (GitHub's
        `X-GitHub-SSO: partial-results; organizations=…`)."""
        values: list[dict] = []
        hidden: set[int] = set()
        for page in range(1, 11):
            result, headers = await self.request_with_headers(
                "GET",
                f"https://api.github.com/user/installations?per_page=100&page={page}",
                token=token,
                data=None,
            )
            hidden.update(sso_hidden_organizations(headers.get("x-github-sso")))
            batch = result.get("installations")
            if not isinstance(batch, list):
                raise GitHubError("GitHub returned an invalid installation list.")
            values.extend(batch)
            if len(batch) < 100:
                return values, sorted(hidden)
        raise GitHubError(
            "Too many GitHub results to display. Limit the app's repository access and try again."
        )

    async def repositories(self, token: str) -> GitHubReach:
        installations, sso_hidden = await self._installations(token)
        result = []
        for installation in installations:
            if not isinstance(installation, dict):
                raise GitHubError("GitHub returned an invalid installation.")
            if installation.get("suspended_at"):
                continue
            account = installation.get("account")
            installation_id = installation.get("id")
            if (
                type(installation_id) is not int
                or installation_id <= 0
                or not isinstance(account, dict)
                or not isinstance(account.get("login"), str)
            ):
                raise GitHubError("GitHub returned an invalid installation.")
            repositories = await self.pages(
                f"/user/installations/{installation_id}/repositories",
                "repositories",
                token,
            )
            selected = [_repository(repo) for repo in repositories]
            result.append(
                {
                    "id": installation_id,
                    "account": account["login"],
                    "repositories": selected,
                }
            )
        return GitHubReach(installations=result, sso_hidden=sso_hidden)

    async def installation_repositories(
        self, token: str, installation_id: int, wanted: set[int]
    ) -> list[dict] | None:
        """Those of `wanted` the person reaches through one installation of
        the App, or None when they no longer reach the installation.

        Pages only that installation, and stops once every one of `wanted` is
        found, so a large installation elsewhere costs nothing. A suspended
        installation is refused with its own reason, as the full listing
        passes over one.
        """
        installation = next(
            (
                item
                for item in await self.pages(
                    "/user/installations", "installations", token
                )
                if isinstance(item, dict) and item.get("id") == installation_id
            ),
            None,
        )
        if installation is None:
            return None
        if installation.get("suspended_at"):
            account = installation.get("account")
            login = account.get("login") if isinstance(account, dict) else None
            raise GitHubError(
                f"The GitHub App's installation on {login or 'this account'} is "
                "suspended. Unsuspend it in GitHub's settings to use it."
            )
        missing = set(wanted)
        found: list[dict] = []
        for page in range(1, INSTALLATION_PAGES + 1):
            if not missing:
                return found
            try:
                result = await self.request(
                    "GET",
                    f"https://api.github.com/user/installations/{installation_id}"
                    f"/repositories?per_page=100&page={page}",
                    token=token,
                    data=None,
                )
            except GitHubNotFoundError:
                return None
            batch = result.get("repositories")
            if not isinstance(batch, list):
                raise GitHubError("GitHub returned an invalid repository list.")
            for repo in map(_repository, batch):
                if repo["id"] in missing:
                    missing.discard(repo["id"])
                    found.append(repo)
            if len(batch) < 100:
                return found
        raise GitHubError(
            "This GitHub App installation reaches more than "
            f"{INSTALLATION_PAGES * 100} repositories. Limit the app's repository "
            "access and try again."
        )
