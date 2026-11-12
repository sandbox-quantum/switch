"""The shared `FakeTransport` keeps up with the `MessageTransport` port.

A fake that falls behind the port fails its callers with `TypeError`s far from
the cause (27 Oct: 16 tests broke when `send_message` gained `client_txn_id`).
This fails at the source instead: every method of the port is on the fake, and
takes the same parameters, in the same kinds, with the same defaults."""

from __future__ import annotations

import inspect

import pytest

from switch_core.transport.port import MessageTransport
from tests.switch_core.transport.fake import FakeTransport

PORT_METHODS = sorted(
    name
    for name, member in vars(MessageTransport).items()
    if not name.startswith("_") and inspect.isfunction(member)
)


def _shape(fn: object) -> list[tuple[str, object, object]]:
    return [
        (p.name, p.kind, p.default)
        for p in inspect.signature(fn).parameters.values()  # type: ignore[arg-type]
        if p.name != "self"
    ]


def test_the_port_has_methods_to_check() -> None:
    assert "send_message" in PORT_METHODS
    assert "sent_under" in PORT_METHODS


@pytest.mark.parametrize("name", PORT_METHODS)
def test_the_fake_takes_what_the_port_takes(name: str) -> None:
    fake = getattr(FakeTransport, name, None)
    assert fake is not None, f"FakeTransport has no {name}"
    assert _shape(fake) == _shape(getattr(MessageTransport, name))


async def test_a_second_keyed_send_is_the_first() -> None:
    fake = FakeTransport()
    first = await fake.send_message(
        "!r", "hi", sender_name="a", metered=True, client_txn_id="reply:k"
    )
    again = await fake.send_message(
        "!r", "hi", sender_name="a", metered=True, client_txn_id="reply:k"
    )
    assert again.event_id == first.event_id
    assert len(fake.sent_messages) == 1
    assert await fake.sent_under("!r", "reply:k") == first.event_id
    assert await fake.sent_under("!r", "reply:other") is None
