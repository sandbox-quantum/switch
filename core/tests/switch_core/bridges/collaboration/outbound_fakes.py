"""The outbound path's database calls, faked for tests that assemble a
`CollaborationCore` without a database.

Relaying a room message out to the platform reads whether its sender is a
person on the bridge (`_is_human_sender`) and which channel the room is
bridged to (`_channel_for_room`), each from the database when it is not known
in memory, and claims the message before posting it, so a hand-over between
processes never posts it twice (`_claim_outbound`, then settled with the
post's id or released). These stand in for those calls: a sender is a person
and a room has a channel only if the test says so, every claim succeeds, and
each post is recorded as the message map would hold it.
"""

from __future__ import annotations

from typing import Any


def posting_without_a_database(core: Any) -> list[dict[str, str]]:
    """Fake the outbound database calls on `core`, which may be a bare
    `CollaborationCore` or a namespace standing in for one. Returns the list
    every settled post is appended to."""
    recorded: list[dict[str, str]] = []
    claimed: dict[str, str] = {}

    async def is_human_sender(sender: str) -> bool:
        return sender in core._human_user_ids

    async def channel_for_room(transport_room_id: str) -> str | None:
        channel_id: str | None = core._find_channel(transport_room_id=transport_room_id)
        return channel_id

    async def claim(channel_id: str, transport_event_id: str) -> bool:
        claimed[transport_event_id] = channel_id
        return True

    async def settle(transport_event_id: str, external_post_id: str | None) -> None:
        channel_id = claimed.pop(transport_event_id)
        if external_post_id is not None:
            recorded.append(
                {
                    "external_channel_id": channel_id,
                    "transport_event_id": transport_event_id,
                    "external_post_id": external_post_id,
                }
            )

    async def release(transport_event_id: str) -> None:
        claimed.pop(transport_event_id, None)

    core._is_human_sender = is_human_sender
    core._channel_for_room = channel_for_room
    core._claim_outbound = claim
    core._settle_outbound = settle
    core._release_outbound = release
    return recorded
