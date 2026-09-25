from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx


class GitHubError(Exception):
    pass


class GitHubUnavailableError(GitHubError):
    pass


class GitHubAuthorizationError(GitHubError):
    pass


def rate_limited(response: httpx.Response) -> bool:
    return response.status_code == 429 or (
        response.status_code == 403
        and (
            response.headers.get("x-ratelimit-remaining") == "0"
            or "retry-after" in response.headers
            or "secondary rate limit" in response.text.lower()
        )
    )


def repository_writable(repository: dict) -> bool:
    permissions = repository.get("permissions")
    return isinstance(permissions, dict) and any(
        permissions.get(key) is True for key in ("push", "maintain", "admin")
    )


@dataclass
class GitHubFlow:
    tenant_id: str
    user_id: str
    expires_at: float
    verifier: str
    browser_nonce: str
    port: int
    completion_secret: str
    owner_label: str
    status: str = "pending"
    login: str = ""
    credentials: dict = field(default_factory=dict)


class GitHubConnections:
    def __init__(self, config_path: str):
        config = json.loads(Path(config_path).read_text())
        self.client_id = config["client_id"]
        self.client_secret = config["client_secret"]
        self.slug = config["slug"]
        self.origin = config["origin"].rstrip("/")
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
        self.flows: dict[str, GitHubFlow] = {}

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

    def start(
        self,
        tenant_id: str,
        user_id: str,
        port: int,
        completion_secret: str,
        flow_id: str,
        owner_label: str,
    ) -> str:
        self.flows = {k: v for k, v in self.flows.items() if v.expires_at > time.time()}
        if flow_id in self.flows:
            raise GitHubError(
                "This authorization has already been used. Connect again."
            )
        for key in list(self.flows):
            flow = self.flows[key]
            if (flow.tenant_id, flow.user_id) == (tenant_id, user_id):
                del self.flows[key]
        if len(self.flows) >= 256:
            raise GitHubError("GitHub connection is busy. Please try again shortly.")
        self.flows[flow_id] = GitHubFlow(
            tenant_id,
            user_id,
            time.time() + 600,
            secrets.token_urlsafe(48),
            secrets.token_urlsafe(32),
            port,
            completion_secret,
            owner_label,
        )
        return flow_id

    def flow(self, flow_id: str) -> GitHubFlow:
        flow = self.flows.get(flow_id)
        if flow is None or flow.expires_at <= time.time():
            self.flows.pop(flow_id, None)
            raise GitHubError(
                "Sign-in was interrupted. Start it again from Switch Console."
            )
        return flow

    def authorize_url(self, flow_id: str) -> str:
        flow = self.flow(flow_id)
        if flow.status != "pending":
            raise GitHubError(
                "This authorization has already been used. Connect again."
            )
        flow.status = "authorizing"
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(flow.verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        return "https://github.com/login/oauth/authorize?" + urlencode(
            {
                "client_id": self.client_id,
                "redirect_uri": self.callback,
                "state": flow_id,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }
        )

    async def request(
        self, method: str, url: str, *, token: str, data: dict | None
    ) -> dict:
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
            return result
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

    async def complete(self, flow_id: str, completion_secret: str, code: str) -> None:
        flow = self.flow(flow_id)
        if (
            not secrets.compare_digest(flow.completion_secret, completion_secret)
            or flow.status != "delivered"
        ):
            raise GitHubError(
                "GitHub authorization could not be verified. Connect again."
            )
        flow.status = "checking"
        try:
            credentials = await self.exchange(
                {
                    "code": code,
                    "redirect_uri": self.callback,
                    "code_verifier": flow.verifier,
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
            flow.login = user["login"]
            flow.credentials = {
                **credentials,
                "login": user["login"],
                "user_id": user["id"],
            }
            flow.status = "ready"
        except (GitHubError, asyncio.CancelledError):
            flow.status = "failed"
            raise

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

    async def repositories(self, token: str) -> list[dict]:
        installations = await self.pages("/user/installations", "installations", token)
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
            selected = []
            for repo in repositories:
                if (
                    not isinstance(repo, dict)
                    or type(repo.get("id")) is not int
                    or not isinstance(repo.get("full_name"), str)
                ):
                    raise GitHubError("GitHub returned an invalid repository.")
                permissions = repo.get("permissions", {})
                selected.append(
                    {
                        "id": repo["id"],
                        "name": repo["full_name"],
                        "permissions": {
                            key: isinstance(permissions, dict)
                            and permissions.get(key) is True
                            for key in ("push", "maintain", "admin")
                        },
                    }
                )
            result.append(
                {
                    "id": installation_id,
                    "account": account["login"],
                    "repositories": selected,
                }
            )
        return result
