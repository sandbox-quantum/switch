"""switch_core.transport.invites: who hears a membership change when two
transports for one client overlap (CHOO-2623).

The overlap is real rather than theoretical: a client row can have a second
receive loop started for it — a boot sweep reaching a client registration
already started, a bridge restarting its own — and the first loop then unwinds
whenever it is finally cancelled or collected. If that teardown could clear the
slot by id alone it would deafen the live client, and nothing would say so:
`invite` would report nobody listening, the caller would write the membership
row itself, and the client would sit in a room it was never told it had joined.

A removal is the same slot and the worse failure. There is no membership row
for the caller to write instead, so a removal that reaches nobody is a live
transport left delivering a room it has been taken out of — which is why both
arms are registered and given up together, and why the bus says so out loud if
it is ever asked to remove for a client listening only for invitations.
"""

from __future__ import annotations

import logging

import pytest

from switch_core.transport.invites import InviteBus


class _Listener:
    def __init__(self) -> None:
        self.rooms: list[str] = []
        self.removed: list[str] = []

    async def on_invited(self, transport_room_id: str) -> None:
        self.rooms.append(transport_room_id)

    async def on_removed(self, transport_room_id: str) -> None:
        self.removed.append(transport_room_id)


async def test_the_newest_registration_is_the_one_that_hears() -> None:
    bus = InviteBus()
    old, new = _Listener(), _Listener()

    bus.register("client-1", old.on_invited, old.on_removed)
    bus.register("client-1", new.on_invited, new.on_removed)

    assert await bus.invite("client-1", "!room:test") is True
    assert (old.rooms, new.rooms) == ([], ["!room:test"])


async def test_a_superseded_listener_cannot_unregister_the_live_one() -> None:
    bus = InviteBus()
    old, new = _Listener(), _Listener()
    bus.register("client-1", old.on_invited, old.on_removed)
    bus.register("client-1", new.on_invited, new.on_removed)

    bus.unregister("client-1", old.on_invited, old.on_removed)

    assert await bus.invite("client-1", "!room:test") is True, (
        "the superseded transport's teardown deafened the live client"
    )
    assert new.rooms == ["!room:test"]


async def test_a_superseded_listener_cannot_unregister_the_live_removal() -> None:
    """The half with no fallback, so the one the same mistake costs most.

    A restarting client registers before the old loop's `finally` runs. If that
    teardown cleared the removal slot by id, every later kick would reach
    nobody and the live transport would keep delivering rooms it was no longer
    in — with no membership row for the caller to write instead, and nothing
    logged.
    """
    bus = InviteBus()
    old, new = _Listener(), _Listener()
    bus.register("client-1", old.on_invited, old.on_removed)
    bus.register("client-1", new.on_invited, new.on_removed)

    bus.unregister("client-1", old.on_invited, old.on_removed)

    await bus.remove("client-1", "!room:test")
    assert (old.removed, new.removed) == ([], ["!room:test"])


async def test_the_live_listener_can_still_unregister_itself() -> None:
    bus = InviteBus()
    listener = _Listener()
    bus.register("client-1", listener.on_invited, listener.on_removed)

    bus.unregister("client-1", listener.on_invited, listener.on_removed)

    assert await bus.invite("client-1", "!room:test") is False
    await bus.remove("client-1", "!room:test")
    assert (listener.rooms, listener.removed) == ([], [])


async def test_unregistering_a_client_nobody_registered_is_a_no_op() -> None:
    bus = InviteBus()
    listener = _Listener()
    bus.unregister("client-1", listener.on_invited, listener.on_removed)
    assert await bus.invite("client-1", "!room:test") is False


async def test_removing_for_a_client_that_is_not_running_is_quiet() -> None:
    """The expected answer, not a decision point.

    A client that is not running holds no subscription to drop, and one that
    starts later reads its rooms from the table the removal already updated.
    """
    bus = InviteBus()
    await bus.remove("client-1", "!room:test")


async def test_a_client_listening_only_for_invitations_is_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The state `register` makes unrepresentable, said out loud if it happens.

    On its own the symptom is a room going quietly on being delivered to
    someone no longer in it, which is not a thing anyone goes looking for.
    """
    bus = InviteBus()
    listener = _Listener()
    bus._handlers["client-1"] = listener.on_invited

    with caplog.at_level(logging.ERROR):
        await bus.remove("client-1", "!room:test")

    assert "not for removals" in caplog.text
