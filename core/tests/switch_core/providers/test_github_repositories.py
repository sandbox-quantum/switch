"""Checking a grant against one installation of the GitHub App.

A token request checks the granted repositories against what the person
reaches now. It pages only the granted installation and stops once every
granted repository is found, so a large installation elsewhere, or the rest of
a large one, never stands between an agent and its token.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core.providers.github import (
    INSTALLATION_PAGES,
    GitHubConnections,
    GitHubError,
)


@pytest.fixture
def github(tmp_path) -> GitHubConnections:
    config = tmp_path / "github.json"
    config.write_text(
        json.dumps(
            {
                "client_id": "example-client",
                "client_secret": "SYNTHETIC-PLACEHOLDER",
                "slug": "example-app",
                "origin": "https://switch.example.com",
            }
        )
    )
    return GitHubConnections(str(config))


def _repo(repo_id: int) -> dict:
    return {
        "id": repo_id,
        "full_name": f"example-org/repo-{repo_id}",
        "permissions": {"push": True},
    }


def _serve(monkeypatch, installations: dict[int, int]) -> list[str]:
    """Answer `/user/installations/{id}/repositories` for installations of the
    given sizes, numbering each one's repositories from id*100_000; anything
    else is a 404. Returns the URLs asked for."""
    asked: list[str] = []

    async def request(_client, method, url, **kwargs):
        asked.append(url)
        parts = urlsplit(url)
        segments = parts.path.strip("/").split("/")
        if segments[:2] != ["user", "installations"] or len(segments) != 4:
            return httpx.Response(404)
        installation_id = int(segments[2])
        if installation_id not in installations:
            return httpx.Response(404)
        page = int(parse_qs(parts.query)["page"][0])
        first = installation_id * 100_000 + (page - 1) * 100
        last = min(
            first + 100, installation_id * 100_000 + installations[installation_id]
        )
        return httpx.Response(
            200, json={"repositories": [_repo(i) for i in range(first, last)]}
        )

    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    return asked


async def test_only_the_granted_installation_is_paged_and_paging_stops_early(
    github, monkeypatch
) -> None:
    asked = _serve(monkeypatch, {1: 5_000, 2: 3})
    wanted = 1 * 100_000 + 150

    reached = await github.installation_repositories("gho_user", 1, {wanted})

    assert [repo["id"] for repo in reached or []] == [wanted]
    assert len(asked) == 2
    assert all("/user/installations/1/" in url for url in asked)


async def test_an_installation_past_the_pickers_limit_still_answers(
    github, monkeypatch
) -> None:
    _serve(monkeypatch, {1: 2_500})
    wanted = 1 * 100_000 + 2_400

    reached = await github.installation_repositories("gho_user", 1, {wanted})

    assert [repo["id"] for repo in reached or []] == [wanted]


async def test_a_repository_not_in_the_installation_is_left_out(
    github, monkeypatch
) -> None:
    _serve(monkeypatch, {1: 3})

    reached = await github.installation_repositories("gho_user", 1, {100_000, 7})

    assert [repo["id"] for repo in reached or []] == [100_000]


async def test_an_installation_the_person_no_longer_reaches_is_none(
    github, monkeypatch
) -> None:
    _serve(monkeypatch, {1: 3})

    assert await github.installation_repositories("gho_user", 9, {900_000}) is None


async def test_an_installation_beyond_the_cap_fails_loudly(github, monkeypatch) -> None:
    _serve(monkeypatch, {1: INSTALLATION_PAGES * 100 + 1})

    with pytest.raises(GitHubError, match="more than"):
        await github.installation_repositories("gho_user", 1, {7})
