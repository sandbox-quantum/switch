import json
import time
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.providers.github import GitHubError
from switch_core.providers.github_installation import GitHubInstallationCredentials


@pytest.fixture
def signing(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    path = tmp_path / "app.pem"
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    path.chmod(0o600)
    return GitHubInstallationCredentials("example-client", str(path)), key


def response_body():
    return {
        "token": "SYNTHETIC-INSTALLATION-TOKEN",
        "expires_at": datetime.fromtimestamp(time.time() + 3600, UTC).isoformat(),
        "permissions": {
            "contents": "write",
            "pull_requests": "write",
            "metadata": "read",
        },
        "repositories": [{"id": 789}],
    }


def user_access():
    return AsyncMock(
        repositories=AsyncMock(
            return_value=[
                {"id": 456, "repositories": [{"id": 789, "name": "example/project"}]}
            ]
        )
    )


async def test_signs_request_and_limits_worker_to_users_selected_repository(
    signing, monkeypatch
):
    issuer, key = signing

    async def post(_client, url, **kwargs):
        assert url == "https://api.github.com/app/installations/456/access_tokens"
        assertion = kwargs["headers"]["Authorization"].removeprefix("Bearer ")
        claims = jwt.decode(
            assertion, key.public_key(), algorithms=["RS256"], issuer="example-client"
        )
        assert claims["exp"] - claims["iat"] == 600
        assert kwargs["json"] == {
            "repository_ids": [789],
            "permissions": {"contents": "write", "pull_requests": "write"},
        }
        return httpx.Response(201, json=response_body())

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    github = user_access()
    credential = await issuer.issue(github, "SYNTHETIC-USER-TOKEN", 456, 789)
    github.repositories.assert_awaited_once_with("SYNTHETIC-USER-TOKEN")
    assert credential.repository_name == "example/project"
    assert credential.token not in repr(credential)


@pytest.mark.parametrize(
    "installation,repository", [(456, 999), (999, 789), (0, 789), (True, 789)]
)
async def test_refuses_unowned_or_invalid_selection_before_minting(
    signing, monkeypatch, installation, repository
):
    post = AsyncMock()
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(GitHubError):
        await signing[0].issue(
            user_access(), "SYNTHETIC-USER-TOKEN", installation, repository
        )
    post.assert_not_called()


@pytest.mark.parametrize(
    "change",
    [
        {"repositories": [{"id": 789}, {"id": 999}]},
        {
            "permissions": {
                "contents": "write",
                "pull_requests": "write",
                "issues": "write",
            }
        },
        {"expires_at": "2000-01-01T00:00:00Z"},
        {"token": "bad\ntoken"},
        {"expires_at": "not-a-date"},
    ],
)
async def test_rejects_overbroad_or_invalid_credential(signing, monkeypatch, change):
    body = response_body() | change
    monkeypatch.setattr(
        httpx.AsyncClient,
        "post",
        AsyncMock(return_value=httpx.Response(201, json=body)),
    )
    with pytest.raises(GitHubError) as raised:
        await signing[0].issue(user_access(), "SYNTHETIC-USER-TOKEN", 456, 789)
    assert "SYNTHETIC" not in str(raised.value)


async def test_remote_errors_do_not_expose_tokens_or_response_bodies(
    signing, monkeypatch
):
    monkeypatch.setattr(
        httpx.AsyncClient,
        "post",
        AsyncMock(
            return_value=httpx.Response(
                403, text=json.dumps({"secret": "SYNTHETIC-SECRET"})
            )
        ),
    )
    with pytest.raises(GitHubError) as raised:
        await signing[0].issue(user_access(), "SYNTHETIC-USER-TOKEN", 456, 789)
    assert "SYNTHETIC" not in str(raised.value)


def test_invalid_key_fails_without_key_material(tmp_path):
    path = tmp_path / "invalid.pem"
    path.write_text("SYNTHETIC-INVALID-KEY")
    with pytest.raises(ValueError, match="could not be loaded"):
        GitHubInstallationCredentials("example-client", str(path))
