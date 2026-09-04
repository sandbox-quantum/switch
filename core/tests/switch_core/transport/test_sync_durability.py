"""What counts as a batch worth persisting the cursor for.

The judgement has to live here rather than in the client: only the transport
sees what a sync response held, and the port hands the client a bool so a nio
response class never reaches it. The client's side of the bargain — the
throttle, the staleness flush, the per-client jitter — is covered in
`tests/switch_core/clients/test_sync_cursor_persistence.py`.

Timeline events, room state and invites are dispatched to handlers, so a
restart must not skip them. Presence, typing and receipts are not: resuming
from the older cursor replays the same nothing.
"""

from __future__ import annotations

import pytest
from nio import (
    DeviceList,
    DeviceOneTimeKeyCount,
    InviteInfo,
    RoomInfo,
    Rooms,
    SyncResponse,
    Timeline,
)

from switch_core.transport.matrix import _carries_durable_events

ROOM = "!room:switch.local"


def _sync(
    next_batch: str = "s1",
    *,
    timeline: list[object] | None = None,
    state: list[object] | None = None,
    ephemeral: list[object] | None = None,
    invite: bool = False,
    to_device: list[object] | None = None,
) -> SyncResponse:
    join = {
        ROOM: RoomInfo(
            timeline=Timeline(
                events=list(timeline or []), limited=False, prev_batch=None
            ),
            state=list(state or []),
            ephemeral=list(ephemeral or []),
            account_data=[],
        )
    }
    return SyncResponse(
        next_batch=next_batch,
        rooms=Rooms(
            invite={ROOM: InviteInfo(invite_state=[])} if invite else {},
            join=join,
            leave={},
        ),
        device_key_count=DeviceOneTimeKeyCount(curve25519=None, signed_curve25519=None),
        device_list=DeviceList(changed=[], left=[]),
        to_device_events=list(to_device or []),
        presence_events=[],
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeline": [object()]},
        {"state": [object()]},
        {"invite": True},
        {"to_device": [object()]},
    ],
    ids=["timeline", "state", "invite", "to_device"],
)
def test_anything_a_restart_would_replay_is_durable(kwargs: dict[str, object]) -> None:
    assert _carries_durable_events(_sync(**kwargs)) is True  # type: ignore[arg-type]


def test_an_empty_batch_is_not() -> None:
    assert _carries_durable_events(_sync()) is False


def test_ephemeral_only_is_not() -> None:
    """Typing notices and read receipts move the token and mean nothing."""
    assert _carries_durable_events(_sync(ephemeral=[object()])) is False
