"""switch_core.transport.invites: who hears an invitation when two transports
for one user overlap (CHOO-2623).

The overlap is real rather than theoretical: a client row can have a second
receive loop started for it — a boot sweep reaching a client registration
already started, a bridge restarting its own — and the first loop then unwinds
whenever it is finally cancelled or collected. If that teardown could clear the
slot by user id alone it would deafen the live client, and nothing would say
so: `invite` would report nobody listening, the caller would write the
membership row itself, and the client would sit in a room it was never told it
had joined.
"""

from __future__ import annotations

from switch_core.transport.invites import InviteBus


class _Listener:
    def __init__(self) -> None:
        self.rooms: list[str] = []

    async def on_invited(self, transport_room_id: str) -> None:
        self.rooms.append(transport_room_id)


async def test_the_newest_registration_is_the_one_that_hears() -> None:
    bus = InviteBus()
    old, new = _Listener(), _Listener()

    bus.register("@agent:test", old.on_invited)
    bus.register("@agent:test", new.on_invited)

    assert await bus.invite("@agent:test", "!room:test") is True
    assert (old.rooms, new.rooms) == ([], ["!room:test"])


async def test_a_superseded_listener_cannot_unregister_the_live_one() -> None:
    bus = InviteBus()
    old, new = _Listener(), _Listener()
    bus.register("@agent:test", old.on_invited)
    bus.register("@agent:test", new.on_invited)

    bus.unregister("@agent:test", old.on_invited)

    assert await bus.invite("@agent:test", "!room:test") is True, (
        "the superseded transport's teardown deafened the live client"
    )
    assert new.rooms == ["!room:test"]


async def test_the_live_listener_can_still_unregister_itself() -> None:
    bus = InviteBus()
    listener = _Listener()
    bus.register("@agent:test", listener.on_invited)

    bus.unregister("@agent:test", listener.on_invited)

    assert await bus.invite("@agent:test", "!room:test") is False
    assert listener.rooms == []


async def test_unregistering_a_user_nobody_registered_is_a_no_op() -> None:
    bus = InviteBus()
    bus.unregister("@agent:test", _Listener().on_invited)
    assert await bus.invite("@agent:test", "!room:test") is False
