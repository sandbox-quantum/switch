"""CHOO-2067 — a person who cannot be added must not take the room with them.

Adding a room to a Teams bridge answered `500` when any one member could not
be added to the channel: the Teams adapter raised where Slack, Mattermost and
Discord log and continue, and it runs inside room creation, so the request died
with a half-provisioned room behind it. The opposite failure is just as bad —
dropping people quietly leaves a room that lacks the people it was asked for
and says nothing.
"""

from __future__ import annotations

from typing import Any

from switch_core.room_service import RoomService


class _FakeAdapter:
    def __init__(self, *, failing_ids: list[str]) -> None:
        self._failing_ids = failing_ids
        self.calls: list[tuple[list[str], list[str]]] = []

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        self.calls.append((list(user_names), list(user_external_ids)))
        return [i for i in user_external_ids if i in self._failing_ids]


class _FakeBridgeCore:
    def __init__(self, *, known: dict[str, str], failing_ids: list[str]) -> None:
        self._known = known
        self.adapter = _FakeAdapter(failing_ids=failing_ids)

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        return {n: self._known[n] for n in user_names if n in self._known}


async def _add(
    *, known: dict[str, str], failing_ids: list[str], asked_for: list[str]
) -> tuple[list[dict[str, Any]], _FakeBridgeCore]:
    bridge = _FakeBridgeCore(known=known, failing_ids=failing_ids)
    failures = await RoomService._add_users_to_channel(
        bridge,  # type: ignore[arg-type]
        "chan-1",
        asked_for,
    )
    return failures, bridge


async def test_everyone_added_reports_nothing() -> None:
    failures, bridge = await _add(
        known={"alice": "ext-a", "bob": "ext-b"},
        failing_ids=[],
        asked_for=["alice", "bob"],
    )

    assert failures == []
    assert bridge.adapter.calls == [(["alice", "bob"], ["ext-a", "ext-b"])]


async def test_a_name_the_bridge_does_not_know_is_reported_by_name() -> None:
    failures, bridge = await _add(
        known={"alice": "ext-a"},
        failing_ids=[],
        asked_for=["alice", "ghost"],
    )

    assert failures == [
        {
            "kind": "user",
            "id": "ghost",
            "error": "no account with this name is known on the bridge",
        }
    ]
    # Only the resolvable person is offered to the adapter — and the two lists
    # stay aligned, which is the bug that used to lurk here: the caller's full
    # name list went out beside a shorter list of ids, so an adapter that zipped
    # them attributed a failure to the wrong person.
    assert bridge.adapter.calls == [(["alice"], ["ext-a"])]


async def test_a_platform_refusal_is_reported_by_name_not_by_id() -> None:
    # The operator typed a name; an opaque platform id means nothing to them.
    failures, _ = await _add(
        known={"alice": "ext-a", "bob": "ext-b"},
        failing_ids=["ext-b"],
        asked_for=["alice", "bob"],
    )

    assert failures == [
        {
            "kind": "user",
            "id": "bob",
            "error": "the platform would not add them to the channel",
        }
    ]


async def test_both_kinds_of_miss_are_reported_together() -> None:
    failures, _ = await _add(
        known={"alice": "ext-a", "bob": "ext-b"},
        failing_ids=["ext-b"],
        asked_for=["alice", "bob", "ghost"],
    )

    assert [f["id"] for f in failures] == ["ghost", "bob"]


async def test_an_unmappable_failure_id_still_gets_reported() -> None:
    # An adapter returning something we did not hand it is a bug, but losing
    # the failure entirely would be worse than reporting it raw.
    bridge = _FakeBridgeCore(known={"alice": "ext-a"}, failing_ids=[])

    async def _add_users(
        channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        return ["ext-surprise"]

    bridge.adapter.add_users_to_channel = _add_users  # type: ignore[assignment]

    failures = await RoomService._add_users_to_channel(
        bridge,  # type: ignore[arg-type]
        "chan-1",
        ["alice"],
    )

    assert failures == [
        {
            "kind": "user",
            "id": "ext-surprise",
            "error": "the platform would not add them to the channel",
        }
    ]
