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


@dataclass
class GitHubFlow:
    tenant_id: str
    user_id: str
    expires_at: float
    verifier: str
    browser_nonce: str
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

    def start(self, tenant_id: str, user_id: str) -> str:
        self.flows = {k: v for k, v in self.flows.items() if v.expires_at > time.time()}
        for key in list(self.flows):
            flow = self.flows[key]
            if (flow.tenant_id, flow.user_id) == (tenant_id, user_id):
                del self.flows[key]
        if len(self.flows) >= 256:
            raise GitHubError("GitHub connection is busy. Please try again shortly.")
        flow_id = secrets.token_urlsafe(32)
        self.flows[flow_id] = GitHubFlow(
            tenant_id,
            user_id,
            time.time() + 600,
            secrets.token_urlsafe(48),
            secrets.token_urlsafe(32),
        )
        return flow_id

    def flow(self, flow_id: str) -> GitHubFlow:
        flow = self.flows.get(flow_id)
        if flow is None or flow.expires_at <= time.time():
            self.flows.pop(flow_id, None)
            raise GitHubError(
                "GitHub authorization expired or the server restarted. Connect again."
            )
        return flow

    def authorize_url(self, flow_id: str) -> str:
        flow = self.flow(flow_id)
        if flow.status != "pending":
            raise GitHubError(
                "This authorization has already been used. Connect again."
            )
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
                raise GitHubError(
                    "GitHub access expired or was revoked. Connect GitHub again."
                )
            if not response.is_success:
                raise GitHubError(
                    "GitHub could not complete the request. Check access and try again."
                )
            result = response.json()
            if not isinstance(result, dict) or result.get("error"):
                raise GitHubError(
                    "GitHub authorization was not completed. Connect again."
                )
            return result
        except (httpx.HTTPError, ValueError):
            raise GitHubError(
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

    async def complete(self, flow_id: str, browser_nonce: str, code: str) -> None:
        flow = self.flow(flow_id)
        if (
            not secrets.compare_digest(flow.browser_nonce, browser_nonce)
            or flow.status != "pending"
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
            if installation.get("suspended_at"):
                continue
            installation_id = installation["id"]
            repositories = await self.pages(
                f"/user/installations/{installation_id}/repositories",
                "repositories",
                token,
            )
            result.append(
                {
                    "id": installation_id,
                    "account": installation["account"]["login"],
                    "repositories": [
                        {"id": repo["id"], "name": repo["full_name"]}
                        for repo in repositories
                    ],
                }
            )
        return result
