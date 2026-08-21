"""Claiming an identity on a platform with no searchable directory (CHOO-2137).

Telegram is the case that exposed this. A bot there can only see who has spoken
to it, so `search_directory_users` raises — and the endpoint used to turn that
into a 501, leaving the link dialog with a warning and nothing to pick. Switch
knew perfectly well who those people were; it just refused to say. Owner-only
addressing was therefore unreachable on the platform, which is the failure the
whole feature exists to prevent.

The search now falls back to the accounts Switch has already recorded, and says
so. It is a narrower answer, not an error — and the response has to admit the
difference, because presenting it as a whole-workspace search would tell the
user that someone who has never spoken does not exist.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from switch_core.bridges.collaboration.models import DirectoryUser
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.gateway.collaborations import (
    _known_as_directory_users,
    search_bridge_directory,
)

NO_DIRECTORY = NotImplementedError(
    "Telegram has no searchable user directory — on this platform someone must "
    "send a message before Switch knows them"
)


def _known(external_user_id: str, username: str) -> SimpleNamespace:
    """An `ExternalUser` row, with only the fields the fallback reads."""
    return SimpleNamespace(
        id=f"row-{external_user_id}",
        bridge_id="b1",
        external_user_id=external_user_id,
        external_username=username,
    )


class _StubLifecycle:
    def __init__(self, result: list[DirectoryUser] | Exception | None) -> None:
        self._result = result

    def get_adapter(self, _bridge_id: str) -> object | None:
        return None if self._result is None else self

    async def search_directory_users(self, _query: str) -> list[DirectoryUser]:
        if isinstance(self._result, Exception):
            raise self._result
        assert self._result is not None
        return self._result


class _StubExternalUserStore:
    def __init__(self, rows: list[SimpleNamespace]) -> None:
        self._rows = rows

    async def get_by_bridge(
        self, _session: object, _bridge_id: str
    ) -> list[SimpleNamespace]:
        return self._rows

    async def claimant_ids_for(
        self, _session: object, _row_ids: list[str]
    ) -> dict[str, list[str]]:
        return {}


class _StubBridgeStore:
    async def get(self, _session: object, _bridge_id: str) -> object:
        return SimpleNamespace(id="b1", display_name="Telegram louis")


class _StubUserStore:
    async def get_all(self, _session: object) -> list[object]:
        return []


async def _search(
    *,
    adapter_result: list[DirectoryUser] | Exception | None,
    known: list[SimpleNamespace],
    query: str = "lou",
) -> object:
    return await search_bridge_directory(
        "b1",
        query,
        None,  # type: ignore[arg-type]
        _StubBridgeStore(),  # type: ignore[arg-type]
        _StubExternalUserStore(known),  # type: ignore[arg-type]
        _StubUserStore(),  # type: ignore[arg-type]
        _StubLifecycle(adapter_result),  # type: ignore[arg-type]
        SimpleNamespace(id="u1", role="user", name="u1"),  # type: ignore[arg-type]
    )


class TestFallsBackToWhoSwitchHasSeen:
    async def test_a_platform_without_a_directory_still_answers(self) -> None:
        # The whole point: a 501 here is what made Telegram unusable.
        result = await _search(
            adapter_result=NO_DIRECTORY,
            known=[_known("11", "louis"), _known("22", "someone-else")],
        )

        assert [u.username for u in result.users] == ["louis"]

    async def test_it_says_the_answer_is_narrower(self) -> None:
        # Without this the caller cannot tell a whole-workspace search from the
        # handful of people who happen to have spoken.
        result = await _search(
            adapter_result=NO_DIRECTORY, known=[_known("11", "louis")]
        )

        assert result.source == "known"
        assert result.note is not None
        assert "send a message" in result.note

    async def test_the_row_id_is_carried_so_the_claim_reuses_it(self) -> None:
        # An account Switch already has must not be provisioned a second time.
        result = await _search(
            adapter_result=NO_DIRECTORY, known=[_known("11", "louis")]
        )

        assert result.users[0].known_external_user_id == "row-11"

    async def test_nobody_seen_yet_is_an_empty_list_not_an_error(self) -> None:
        result = await _search(adapter_result=NO_DIRECTORY, known=[])

        assert result.users == []
        assert result.source == "known"


class TestAPlatformWithADirectoryIsUnaffected:
    async def test_it_reports_the_directory_as_the_source(self) -> None:
        found = [
            DirectoryUser(
                external_user_id="U1",
                username="louis",
                display_name="Louisa A",
                email="l@example.com",
            )
        ]
        result = await _search(adapter_result=found, known=[])

        assert result.source == "directory"
        assert result.note is None
        assert [u.email for u in result.users] == ["l@example.com"]

    async def test_a_platform_that_failed_still_raises(self) -> None:
        # A refusal from Slack is not "nobody has spoken here" — turning it into
        # the fallback would report a broken workspace as an empty one.
        with pytest.raises(HTTPException) as excinfo:
            await _search(adapter_result=RuntimeError("slack said no"), known=[])
        assert excinfo.value.status_code == 502

    async def test_a_stopped_bridge_still_refuses(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            await _search(adapter_result=None, known=[])
        assert excinfo.value.status_code == 409


class TestMatchingKnownAccounts:
    def test_matches_anywhere_in_the_handle(self) -> None:
        # Prefix matching would hide someone whose handle starts with a team
        # prefix, and this list is the last resort — not finding yourself in it
        # is the end of the road.
        found = _known_as_directory_users([_known("11", "team-louis")], "louis")

        assert [u.username for u in found] == ["team-louis"]

    def test_ignores_case(self) -> None:
        found = _known_as_directory_users([_known("11", "Louis")], "lOuIs")

        assert len(found) == 1

    def test_a_blank_query_matches_nobody(self) -> None:
        # Returning the entire workspace for an empty box is not a search.
        found = _known_as_directory_users([_known("11", "louis")], "   ")

        assert found == []

    def test_results_are_ordered_by_name_regardless_of_case(self) -> None:
        rows = [_known("1", "zoe-a"), _known("2", "Adam-a"), _known("3", "mia-a")]

        found = _known_as_directory_users(rows, "-a")

        assert [u.username for u in found] == ["Adam-a", "mia-a", "zoe-a"]

    def test_carries_no_email_it_cannot_know(self) -> None:
        # The row is built from a message, which carries no address. Inventing
        # one would put a wrong address next to a face in the picker.
        found = _known_as_directory_users([_known("11", "louis")], "lou")

        assert found[0].email is None


async def test_the_platform_names_itself_in_the_refusal() -> None:
    """The refusal is shown verbatim in the link dialog, so it has to name the
    platform a person would recognise — it read "TelegramAdapter has no
    searchable user directory" on screen."""
    adapter = TelegramAdapter.__new__(TelegramAdapter)

    with pytest.raises(NotImplementedError) as excinfo:
        await adapter.search_directory_users("lou")

    assert str(excinfo.value).startswith("Telegram has no searchable user directory")
    assert "Adapter" not in str(excinfo.value)
