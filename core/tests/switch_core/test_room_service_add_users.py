"""CHOO-2067 — a person who cannot be added must not take the room with them.

Adding a room to a Teams bridge answered `500` when any one member could not
be added to the channel: the Teams adapter raised where Slack, Mattermost and
Discord log and continue, and it runs inside room creation, so the request died
with a half-provisioned room behind it. The opposite failure is just as bad —
dropping people quietly leaves a room that lacks the people it was asked for
and says nothing.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.models import ChannelType
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


class _FakeCollaborationCore:
    def __init__(self, *, known: dict[str, str], failing_ids: list[str]) -> None:
        self._known = known
        self.adapter = _FakeAdapter(failing_ids=failing_ids)

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        return {n: self._known[n] for n in user_names if n in self._known}


async def _add(
    *,
    known: dict[str, str],
    failing_ids: list[str],
    asked_for: list[str],
    already_added: tuple[str, ...] = (),
) -> tuple[list[dict[str, Any]], _FakeCollaborationCore]:
    bridge = _FakeCollaborationCore(known=known, failing_ids=failing_ids)
    failures = await RoomService._add_users_to_channel(
        bridge,  # type: ignore[arg-type]
        "chan-1",
        asked_for,
        already_added=already_added,
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
    bridge = _FakeCollaborationCore(known={"alice": "ext-a"}, failing_ids=[])

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


async def test_someone_already_in_the_channel_is_not_asked_for_again() -> None:
    # The creator of a private channel is put in it first; naming them in the
    # request as well must not add them twice.
    failures, bridge = await _add(
        known={"ada": "ext-a", "bob": "ext-b"},
        failing_ids=[],
        asked_for=["ada", "bob"],
        already_added=("ext-a",),
    )

    assert failures == []
    assert bridge.adapter.calls == [(["bob"], ["ext-b"])]


async def test_nobody_left_to_add_asks_the_platform_nothing() -> None:
    failures, bridge = await _add(
        known={"ada": "ext-a"},
        failing_ids=[],
        asked_for=["ada"],
        already_added=("ext-a",),
    )

    assert failures == []
    assert bridge.adapter.calls == []


class _CreatorCore(_FakeCollaborationCore):
    def __init__(self, *, failing_ids: list[str], needs_owner: bool) -> None:
        super().__init__(known={}, failing_ids=failing_ids)
        self.adapter.private_channel_needs_owner = needs_owner  # type: ignore[attr-defined]
        self.in_room: list[str] = []

    async def ensure_external_users_in_room(
        self, room_id: str, transport_room_id: str, external_user_ids: list[str]
    ) -> None:
        self.in_room.extend(external_user_ids)


async def _add_creator(
    core: _CreatorCore, channel_type: ChannelType = "channel_private"
) -> list[dict[str, Any]]:
    creator = SimpleNamespace(external_user_id="ext-a", external_username="ada")
    return await RoomService._add_creator_to_channel(
        core,  # type: ignore[arg-type]
        "room-1",
        "!room:test",
        "chan-1",
        creator,  # type: ignore[arg-type]
        channel_type,
    )


async def test_the_creator_is_put_in_the_channel_and_the_room() -> None:
    core = _CreatorCore(failing_ids=[], needs_owner=False)

    assert await _add_creator(core) == []
    assert core.adapter.calls == [(["ada"], ["ext-a"])]
    assert core.in_room == ["ext-a"]


async def test_a_platform_refusing_the_creator_is_reported() -> None:
    core = _CreatorCore(failing_ids=["ext-a"], needs_owner=False)

    assert await _add_creator(core) == [
        {
            "kind": "user",
            "id": "ada",
            "error": "the platform would not add you to the channel",
        }
    ]


async def test_a_creator_made_owner_is_not_added_to_the_channel_again() -> None:
    core = _CreatorCore(failing_ids=[], needs_owner=True)

    assert await _add_creator(core) == []
    assert core.adapter.calls == []
    assert core.in_room == ["ext-a"]


async def test_the_creator_of_a_public_channel_is_asked_for_wherever_owners_are_named() -> (
    None
):
    # Naming an owner (Teams) puts someone in a private channel only.
    core = _CreatorCore(failing_ids=[], needs_owner=True)

    assert await _add_creator(core, "channel_public") == []
    assert core.adapter.calls == [(["ada"], ["ext-a"])]
    assert core.in_room == ["ext-a"]


async def test_no_creator_means_nothing_to_do() -> None:
    core = _CreatorCore(failing_ids=[], needs_owner=False)

    assert (
        await RoomService._add_creator_to_channel(
            core,  # type: ignore[arg-type]
            "room-1",
            "!room:test",
            "chan-1",
            None,
            "channel_private",
        )
        == []
    )
    assert core.adapter.calls == []
