"""CHOO-2067 — a Teams id is not a person's name.

Teams leaves the sender's name off some activities, 1:1 chats above all, and
the fallback was the raw id. `29:1AbCdEf…` then became a
person's name everywhere it was used: the auto-created room's title, their
Matrix account, and the text of every agent reply that addressed them. All
three were visible in one screenshot from switch-dev.

The second half is agreement. The directory used to hand back a whole user
principal name while inbound messages handed back a display name, so the same
human was filed under two names and whichever arrived first won.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
    _handle_for,
)

_AAD_ID = "29:1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Graph:
    def __init__(self, user: dict[str, Any] | None, *, fail: bool = False) -> None:
        self._user = user
        self._fail = fail
        self.lookups: list[str] = []

    async def get_user(self, *, user_id: str) -> dict[str, Any]:
        self.lookups.append(user_id)
        if self._fail:
            raise RuntimeError("Graph said no")
        return self._user or {}


def _adapter(graph: _Graph | None = None) -> TeamsAdapter:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    if graph is not None:
        adapter._graph = graph  # type: ignore[assignment]
    return adapter


# ── the handle both paths agree on ───────────────────────────────────────────


def test_the_handle_is_the_local_part_of_the_principal_name() -> None:
    # Not the whole UPN: `@ada.lovelace@contoso.com` does not survive being
    # written as a mention, and being addressable is the point of a handle.
    assert (
        _handle_for(
            {
                "id": "aad-1",
                "userPrincipalName": "ada.lovelace@contoso.com",
                "displayName": "Ada Lovelace",
            }
        )
        == "ada.lovelace"
    )


def test_the_display_name_is_used_when_there_is_no_principal_name() -> None:
    assert _handle_for({"id": "aad-1", "displayName": "Ada Lovelace"}) == (
        "Ada Lovelace"
    )


def test_the_id_is_the_last_resort_only() -> None:
    assert _handle_for({"id": "aad-1"}) == "aad-1"


# ── resolving an inbound sender ──────────────────────────────────────────────


def test_a_missing_name_is_looked_up_rather_than_replaced_by_the_id() -> None:
    graph = _Graph({"userPrincipalName": "ada.lovelace@contoso.com"})
    adapter = _adapter(graph)

    handle = _run(adapter._sender_handle(_AAD_ID, ""))

    assert handle == "ada.lovelace"
    assert graph.lookups == [_AAD_ID]


def test_a_one_word_name_teams_offered_is_taken_without_asking_graph() -> None:
    graph = _Graph({"userPrincipalName": "someone.else@contoso.com"})
    adapter = _adapter(graph)

    handle = _run(adapter._sender_handle(_AAD_ID, "ada"))

    assert handle == "ada"
    assert graph.lookups == []


def test_a_display_name_with_a_space_is_traded_for_the_principal_name() -> None:
    # The offered name is what Teams puts on an activity, and it is nearly
    # always two words. `@Ada Lovelace` cannot be read back out of a message —
    # a mention ends at the space — so filing someone under it makes them
    # permanently untaggable. The directory has a one-word answer; ask for it.
    graph = _Graph({"userPrincipalName": "ada.lovelace@contoso.com"})
    adapter = _adapter(graph)

    handle = _run(adapter._sender_handle(_AAD_ID, "Ada Lovelace"))

    assert handle == "ada.lovelace"
    assert graph.lookups == [_AAD_ID]


def test_a_display_name_stands_when_the_directory_cannot_improve_on_it() -> None:
    # Worse than a handle, better than an id: the room still shows a person's
    # name, and `_mark_mentions` can still tag them by matching the whole of it.
    graph = _Graph(None, fail=True)
    adapter = _adapter(graph)

    assert _run(adapter._sender_handle(_AAD_ID, "Ada Lovelace")) == "Ada Lovelace"


def test_a_name_that_is_really_the_id_is_not_believed() -> None:
    # The shape of the old bug: Teams "offers" a name that is the id.
    graph = _Graph({"userPrincipalName": "ada.lovelace@contoso.com"})
    adapter = _adapter(graph)

    assert _run(adapter._sender_handle(_AAD_ID, _AAD_ID)) == "ada.lovelace"


def test_the_lookup_happens_once_per_person() -> None:
    graph = _Graph({"userPrincipalName": "ada.lovelace@contoso.com"})
    adapter = _adapter(graph)

    _run(adapter._sender_handle(_AAD_ID, ""))
    _run(adapter._sender_handle(_AAD_ID, ""))

    assert graph.lookups == [_AAD_ID]


def test_a_failed_lookup_falls_back_to_the_id_rather_than_dropping_the_message() -> (
    None
):
    # Degraded, and visibly so in the log — but a message from someone whose
    # name we cannot resolve still has to reach the room.
    graph = _Graph(None, fail=True)
    adapter = _adapter(graph)

    assert _run(adapter._sender_handle(_AAD_ID, "")) == _AAD_ID


def test_no_graph_client_still_yields_something_usable() -> None:
    adapter = _adapter()

    assert _run(adapter._sender_handle(_AAD_ID, "")) == _AAD_ID
