"""Two copies of one IRC bridge, as two switch-core processes run it: the
holder connected, a quiet copy that is not. Whatever reaches the quiet copy
and needs the connection is relayed to the holder and done there."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping

import pytest

from switch_core import signals
from switch_core.announcer import MAX_PAYLOAD_BYTES
from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.bridge_signals import BRIDGE_FOR_HOLDER_SIGNAL
from switch_core.bridges.collaboration.irc.adapter import IrcAdapter
from switch_core.bridges.collaboration.models import RetireOutcome
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.signals import PendingWork
from tests.switch_core.bridges.collaboration.irc_fakes import (
    CHANNEL,
    NICK,
    FakeIrcServer,
    quick,
    started,
)
from tests.switch_core.bridges.collaboration.session_fixtures import open_request

BRIDGE = "bridge-1"


@pytest.fixture
async def server() -> AsyncIterator[FakeIrcServer]:
    async with FakeIrcServer() as running:
        yield running


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    quick(monkeypatch)
    monkeypatch.setattr(signals, "RETRY_SECONDS", 0.05)


class Relay:
    """The signal bus between the two processes, as `BridgeSignals` uses it:
    each request is published whole, and the holder's process works them one
    at a time, in order, retrying one that fails."""

    def __init__(self, holder: IrcAdapter) -> None:
        self.holder = holder
        self.payloads: list[str] = []
        self.pending: PendingWork[tuple[str, tuple[tuple[str, str], ...]]] = (
            PendingWork("bridge-for-holder", self._work)
        )
        self._task = asyncio.create_task(self.pending.run())

    def __call__(self, request: dict[str, str]) -> None:
        self.payloads.append(
            json.dumps(
                {
                    "kind": BRIDGE_FOR_HOLDER_SIGNAL,
                    "from": "process-b",
                    "bridge_id": BRIDGE,
                    "request": request,
                },
                separators=(",", ":"),
            )
        )
        self.pending.add((BRIDGE, tuple(sorted(request.items()))))

    async def _work(self, relayed: tuple[str, tuple[tuple[str, str], ...]]) -> None:
        _, request = relayed
        await self.holder.receive_relayed(dict(request))

    async def stop(self) -> None:
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)


@pytest.fixture
async def pair(
    server: FakeIrcServer,
) -> AsyncIterator[tuple[IrcAdapter, IrcAdapter, Relay]]:
    holder = await started(server)
    quiet = await started(server, listening=False)
    relay = Relay(holder)
    quiet.set_holder_relay(relay)
    yield holder, quiet, relay
    await relay.stop()
    await quiet.stop()
    await holder.stop()


def _from_holder(server: FakeIrcServer, command: str) -> list[tuple[str, ...]]:
    """What the bot sent, all of it on the holder's one connection."""
    found = [r for r in server.received if r.line.command == command]
    assert {r.connection for r in found} <= {1}
    return [r.line.params for r in found]


async def test_only_the_holder_is_connected(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    assert (server.connections, server.open) == (1, 1)


async def test_a_message_sent_from_a_quiet_copy_is_said_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    first = await quiet.send_message(CHANNEL, "coder", "deploy is green")
    second = await quiet.send_message(CHANNEL, "coder", "deploy is green")
    notice = await quiet.admin_message(CHANNEL, "Room renamed.")
    assert None not in (first, second, notice) and first != second
    await server.wait_for(lambda: len(server.said()) == 3)
    assert _from_holder(server, "PRIVMSG") == [
        (CHANNEL, "<coder> deploy is green"),
        (CHANNEL, "<coder> deploy is green"),
        (CHANNEL, "Room renamed."),
    ]


async def test_a_long_message_is_relayed_in_parts_that_fit_a_signal(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, relay = pair
    text = "\n".join(f"line {n}: " + "é" * 150 for n in range(120))
    await quiet.send_message(CHANNEL, "coder", text)
    assert len(relay.payloads) > 1
    assert all(len(payload.encode()) <= MAX_PAYLOAD_BYTES for payload in relay.payloads)
    await server.wait_for(lambda: len(server.said()) == 120)
    said = [params[1] for params in _from_holder(server, "PRIVMSG")]
    assert said == [f"<coder> line {n}: " + "é" * 150 for n in range(120)]


async def test_a_room_created_from_a_quiet_copy_is_made_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    channel = (
        await quiet.create_channel("incident", "Paging", channel_type="channel_private")
    ).id
    await server.wait_for(lambda: bool(server.sent("TOPIC")))
    assert _from_holder(server, "JOIN")[-1] == (channel,)
    assert _from_holder(server, "MODE") == [(channel, "+si")]
    assert _from_holder(server, "TOPIC") == [(channel, "Paging")]


async def test_a_channel_bound_on_a_quiet_copy_is_joined_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    await quiet.ensure_channel_subscriptions([("#deploys", "channel_public")])
    await server.wait_for(lambda: len(server.sent("JOIN")) == 2)
    assert _from_holder(server, "JOIN") == [(CHANNEL,), ("#deploys",)]


async def test_a_private_room_bound_while_nobody_held_is_made_private_later(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    """A relayed create can reach no holder, in a handover. The next holder
    comes to the room's channel from its rooms, and still makes it private."""
    holder, _, _ = pair
    await holder.ensure_channel_subscriptions([("#lost-create", "channel_private")])
    await server.wait_for(lambda: bool(server.sent("MODE")))
    assert _from_holder(server, "MODE") == [("#lost-create", "+si")]


async def test_people_added_on_a_quiet_copy_are_invited_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    left_out = await quiet.add_users_to_channel(
        CHANNEL, ["ada", "bob"], ["account:ada", "nick:bob"]
    )
    assert left_out == []
    await server.wait_for(lambda: len(server.sent("INVITE")) == 2)
    assert _from_holder(server, "INVITE") == [("ada", CHANNEL), ("bob", CHANNEL)]


async def test_a_room_deleted_on_a_quiet_copy_is_left_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    assert await quiet.retire_channel(CHANNEL) == RetireOutcome(outcome="left")
    await server.wait_for(lambda: bool(server.sent("PART")))
    assert _from_holder(server, "PART")[0][0] == CHANNEL


async def test_a_card_posted_from_a_quiet_copy_is_said_by_the_holder(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    card = RequestCard(open_request(), RequestReference(token="tok", handle="A9"))
    assert await quiet.post_rich(CHANNEL, "coder", card)
    await server.wait_for(lambda: bool(server.said()))
    assert "A9" in " ".join(server.said())


async def test_a_message_relayed_while_the_holder_reconnects_is_said_once_back(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, relay = pair
    server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
    await server.drop()
    await server.wait_for(lambda: server.connections >= 2)
    await quiet.send_message(CHANNEL, "coder", "while you were out")
    await asyncio.sleep(0.2)
    # Taken by the holder to say once it can: nothing is left for the relay
    # to retry, and nothing holds up other bridges' relayed work.
    assert relay.pending.pending == 0
    server.taken = set()
    await server.wait_for(lambda: bool(server.said()))
    assert server.said() == ["<coder> while you were out"]


async def test_a_copy_that_does_not_hold_the_bridge_ignores_relays(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    request: Mapping[str, str] = {"action": "say", "target": CHANNEL, "lines": "x"}
    await quiet.receive_relayed(request)
    await asyncio.sleep(0.05)
    assert not server.said()


async def test_a_relayed_request_naming_no_channel_is_refused(
    server: FakeIrcServer,
    pair: tuple[IrcAdapter, IrcAdapter, Relay],
    caplog: pytest.LogCaptureFixture,
) -> None:
    holder, _, _ = pair
    await holder.receive_relayed(
        {"action": "join", "channel": "#a,#b", "topic": "", "secret": "no"}
    )
    await holder.receive_relayed({"action": "say", "target": "#a b", "lines": "x"})
    await asyncio.sleep(0.05)
    assert len(server.sent("JOIN")) == 1 and not server.said()
    assert "Ignoring a relayed IRC request" in caplog.text
    assert "it is no IRC channel or nick" in caplog.text


async def test_a_channel_bound_through_a_quiet_copy_is_joined_at_once(
    server: FakeIrcServer, pair: tuple[IrcAdapter, IrcAdapter, Relay]
) -> None:
    _, quiet, _ = pair
    await quiet.check_channel_usable("#deploys")
    await server.wait_for(lambda: len(server.sent("JOIN")) == 2)
    assert _from_holder(server, "JOIN") == [(CHANNEL,), ("#deploys",)]


async def test_every_copy_gives_a_channel_the_same_type(
    pair: tuple[IrcAdapter, IrcAdapter, Relay],
) -> None:
    """A room bound through any process records the same privacy: a quiet
    copy that has never seen a channel must not call it private."""
    holder, quiet, _ = pair
    for channel_id in (CHANNEL, "#never-seen", "ada"):
        assert await quiet.get_channel_type(channel_id) == (
            await holder.get_channel_type(channel_id)
        )
    assert await quiet.get_channel_type("#never-seen") == "channel_public"
