"""Linking a Slack account: what the search offers, and what it finds.

An app made from Switch's manifest is not granted `users:read.email`, so
Slack hands over no addresses and a search by email never matches. The
search field says so by not offering it."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    _granted_scopes,
)


class _Directory:
    def __init__(self, members: list[dict[str, Any]]) -> None:
        self._members = members

    async def users_list(self, *, limit: int, cursor: str | None) -> dict[str, Any]:
        return {"members": self._members, "response_metadata": {}}


def _adapter(
    *, scopes: frozenset[str] | None, members: tuple[dict[str, Any], ...] = ()
) -> SlackAdapter:
    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._granted_scopes = scopes
    adapter._web_client = _Directory(list(members))  # type: ignore[assignment]
    return adapter


def _member(uid: str, handle: str, real_name: str, email: str | None = None) -> dict:
    profile: dict[str, Any] = {"real_name": real_name, "display_name": ""}
    if email is not None:
        profile["email"] = email
    return {"id": uid, "name": handle, "profile": profile}


class TestTheSearchFieldOffersOnlyWhatMatches:
    def test_without_email_access_it_does_not_mention_email(self) -> None:
        adapter = _adapter(scopes=frozenset({"users:read", "chat:write"}))

        assert adapter.account_search_hint() == "Your name or handle"

    def test_with_email_access_it_does(self) -> None:
        adapter = _adapter(scopes=frozenset({"users:read", "users:read.email"}))

        assert adapter.account_search_hint() == "Your name, handle or email"

    def test_when_slack_did_not_list_the_scopes_it_does_not_promise_email(
        self,
    ) -> None:
        assert _adapter(scopes=None).account_search_hint() == "Your name or handle"


class TestReadingTheGrantedScopes:
    def test_from_slacks_header(self) -> None:
        assert _granted_scopes(
            {"X-OAuth-Scopes": "users:read, chat:write,users:read.email"}
        ) == frozenset({"users:read", "chat:write", "users:read.email"})

    def test_none_when_slack_sent_none(self) -> None:
        assert _granted_scopes({"content-type": "application/json"}) is None
        assert _granted_scopes(None) is None


class TestFindingAPerson:
    @pytest.mark.parametrize("query", ["M M", "mm", "M  M", " mm "])
    async def test_spaces_are_ignored_on_both_sides(self, query: str) -> None:
        adapter = _adapter(
            scopes=frozenset({"users:read"}),
            members=(
                _member("U1", "mm", "M M"),
                _member("U2", "zoe", "Zoe Q"),
            ),
        )

        found = await adapter.search_directory_users(query)

        assert [u.external_user_id for u in found] == ["U1"]

    async def test_a_name_with_a_space_finds_a_handle_without_one(self) -> None:
        adapter = _adapter(
            scopes=frozenset({"users:read"}),
            members=(_member("U1", "mohammadk", ""),),
        )

        found = await adapter.search_directory_users("Mohammad K")

        assert [u.username for u in found] == ["mohammadk"]

    async def test_email_still_matches_when_slack_hands_it_over(self) -> None:
        adapter = _adapter(
            scopes=frozenset({"users:read", "users:read.email"}),
            members=(_member("U1", "mm", "M M", email="mm@example.com"),),
        )

        found = await adapter.search_directory_users("mm@example")

        assert [u.email for u in found] == ["mm@example.com"]
