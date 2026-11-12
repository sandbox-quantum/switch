"""The Matrix bridge's sync: where it starts, what it remembers, which rooms it takes.

The position is kept in the bot's account data on the homeserver, so these
run the sync loop against the fake homeserver and look at what is stored there
and what reached Switch.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.matrix import adapter as matrix_adapter
from switch_core.bridges.collaboration.matrix.adapter import ENCRYPTED_ROOM_NOTICE
from tests.switch_core.bridges.collaboration.matrix_fakes import (
    ALICE,
    BOT,
    ROOM,
    TOKEN,
    FakeHomeserver,
    Recorder,
    batch,
    make_adapter,
    message_event,
    start,
)

POSITION = "com.switch.matrix.sync.bridge-1"


def _invite(
    room_id: str,
    inviter: str,
    *,
    encrypted: bool = False,
    is_direct: bool = False,
    upgraded_from: str | None = None,
) -> dict[str, object]:
    stripped: list[dict[str, object]] = [
        {
            "type": "m.room.member",
            "state_key": BOT,
            "sender": inviter,
            "content": {"membership": "invite", "is_direct": is_direct},
        },
        {
            "type": "m.room.name",
            "state_key": "",
            "sender": inviter,
            "content": {"name": "Ops"},
        },
    ]
    if encrypted:
        stripped.append(
            {
                "type": "m.room.encryption",
                "state_key": "",
                "sender": inviter,
                "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            }
        )
    if upgraded_from is not None:
        stripped.append(
            {
                "type": "m.room.create",
                "state_key": "",
                "sender": inviter,
                "content": {"predecessor": {"room_id": upgraded_from}},
            }
        )
    return {"invite": {room_id: {"invite_state": {"events": stripped}}}}


class TestPosition:
    async def test_the_first_start_takes_the_current_position_and_replays_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            initial_sync={
                "rooms": {
                    "join": {
                        ROOM: {
                            "timeline": {
                                "events": [
                                    message_event(
                                        "$old", "said before the bridge existed"
                                    )
                                ]
                            }
                        }
                    }
                }
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(1)
        await adapter.stop()

        first = homeserver.syncs[0]
        assert "since" not in first
        assert '"limit":0' in first["filter"]
        assert recorder.messages == []
        assert homeserver.account_data[POSITION] == {"next_batch": "s0"}
        assert homeserver.syncs[1]["since"] == "s0"

    async def test_a_restart_resumes_where_the_last_run_stopped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s41"}})
        adapter = make_adapter(monkeypatch, homeserver)
        await start(adapter, Recorder())
        await homeserver.until_syncs(1)
        await adapter.stop()

        assert all("since" in sync for sync in homeserver.syncs)
        assert homeserver.syncs[0]["since"] == "s41"

    async def test_the_position_is_stored_once_a_batch_has_reached_switch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(batch("s2", [message_event("$a", "hello")]))
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert [m.message_ref for m in recorder.messages] == ["$a"]
        assert homeserver.account_data[POSITION] == {"next_batch": "s2"}
        assert homeserver.syncs[1]["since"] == "s2"

    async def test_an_empty_batch_moves_on_without_writing_the_position(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue({"next_batch": "s2"})
        adapter = make_adapter(monkeypatch, homeserver)
        await start(adapter, Recorder())
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert homeserver.account_data[POSITION] == {"next_batch": "s1"}
        assert homeserver.syncs[1]["since"] == "s2"

    async def test_a_batch_delivered_again_after_a_crash_carries_the_same_refs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Switch drops a second delivery by `message_ref`; it has to be the
        event id both times, whichever process reads the batch."""
        refs: list[list[str]] = []
        for _ in range(2):
            homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
            homeserver.queue(batch("s2", [message_event("$same", "hello")]))
            adapter = make_adapter(monkeypatch, homeserver)
            recorder = Recorder()
            await start(adapter, recorder)
            await homeserver.until_syncs(2)
            await adapter.stop()
            refs.append([m.message_ref for m in recorder.messages])
        assert refs == [["$same"], ["$same"]]

    async def test_positions_are_kept_per_bridge(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        adapter = make_adapter(monkeypatch, homeserver, bridge_id="other")
        await start(adapter, Recorder())
        await homeserver.until_syncs(1)
        await adapter.stop()
        assert set(homeserver.account_data) == {"com.switch.matrix.sync.other"}

    async def test_a_gap_is_read_back_so_nothing_is_lost(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.messages_pages.append(
            {
                "chunk": [message_event("$gap2", "two"), message_event("$gap1", "one")],
                "end": "t0",
            }
        )
        homeserver.queue(
            batch("s2", [message_event("$new", "three")], limited=True, prev_batch="p1")
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert [m.content for m in recorder.messages] == ["one", "two", "three"]
        backfill = next(
            r for r in homeserver.requests if r.url.path.endswith("/messages")
        )
        assert backfill.url.params["from"] == "p1"
        assert backfill.url.params["to"] == "s1"
        assert backfill.url.params["dir"] == "b"

    async def test_a_room_joined_in_the_batch_is_not_read_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Nothing before the bot's join is relayed, so there is nothing to read."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        own_join = {
            "type": "m.room.member",
            "state_key": BOT,
            "event_id": "$botjoin",
            "sender": BOT,
            "content": {"membership": "join"},
        }
        homeserver.queue(
            batch(
                "s2",
                [own_join, message_event("$after", "hello bot")],
                limited=True,
                prev_batch="p1",
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [m.message_ref for m in recorder.messages] == ["$after"]
        assert not [r for r in homeserver.requests if r.url.path.endswith("/messages")]

    async def test_reading_back_stops_at_the_bots_own_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.messages_pages.extend(
            [
                {
                    "chunk": [
                        message_event("$gap", "after the join"),
                        {
                            "type": "m.room.member",
                            "state_key": BOT,
                            "event_id": "$botjoin",
                            "sender": BOT,
                            "content": {"membership": "join"},
                        },
                        message_event("$before", "before the join"),
                    ],
                    "end": "p2",
                },
                {"chunk": [message_event("$older", "long ago")], "end": "p3"},
            ]
        )
        homeserver.queue(
            batch(
                "s2", [message_event("$new", "newest")], limited=True, prev_batch="p1"
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [m.message_ref for m in recorder.messages] == ["$gap", "$new"]
        assert (
            len([r for r in homeserver.requests if r.url.path.endswith("/messages")])
            == 1
        )

    async def test_a_revoked_token_says_what_to_do_and_keeps_trying(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        adapter = make_adapter(monkeypatch, homeserver)
        await start(adapter, Recorder())
        homeserver.token = "syt_revoked_placeholder"
        attention = await _attention(adapter)
        assert "access token" in attention
        # Still trying: the token coming back is picked up without a restart.
        homeserver.queue({"next_batch": "s2"})
        homeserver.token = TOKEN
        await homeserver.until_syncs(2)
        assert await adapter.attention() is None
        await adapter.stop()


async def _until(predicate: Any, timeout: float = 5) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


async def _attention(adapter: Any) -> str:
    """What the connection says in Console, once it says something."""
    async with asyncio.timeout(5):
        while True:
            said = await adapter.attention()
            if said is not None:
                return str(said)
            await asyncio.sleep(0.005)


@pytest.fixture(autouse=True)
def _quick_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    """The loop's backoff, in milliseconds rather than seconds."""
    monkeypatch.setattr(matrix_adapter, "_RETRY_BASE_SECONDS", 0.001)
    monkeypatch.setattr(matrix_adapter, "_RETRY_MAX_SECONDS", 0.01)


class TestTheLoopNeverDies:
    @pytest.mark.parametrize(
        "answer",
        [
            lambda: httpx.Response(
                200,
                content=b"<html>login</html>",
                headers={"content-type": "text/html"},
            ),
            lambda: httpx.Response(
                302, headers={"location": "https://portal.example.org/"}
            ),
            lambda: httpx.Response(
                200, json={"next_batch": "s2", "rooms": {"join": ["oops"]}}
            ),
            lambda: httpx.Response(200, json={"rooms": {}}),
        ],
        ids=["html", "redirect", "malformed-batch", "no-next-batch"],
    )
    async def test_an_answer_it_cannot_use_is_reported_and_retried(
        self, monkeypatch: pytest.MonkeyPatch, answer: Callable[[], httpx.Response]
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.raw[("GET", "/sync$")] = answer
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)

        attention = await _attention(adapter)
        assert "has not been able to sync" in attention
        assert "It keeps trying" in attention

        # The homeserver answering properly again is picked up: nothing died.
        del homeserver.raw[("GET", "/sync$")]
        homeserver.queue(batch("s2", [message_event("$back", "hello again")]))
        async with asyncio.timeout(5):
            while not recorder.messages or await adapter.attention() is not None:
                await asyncio.sleep(0.005)
        await adapter.stop()
        assert [m.message_ref for m in recorder.messages] == ["$back"]

    async def test_a_rate_limit_beyond_what_is_waited_out_is_said_at_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An hour's wait is not sat through inside one request: the sync
        fails, backs off, and Console says why."""
        homeserver = FakeHomeserver(
            account_data={POSITION: {"next_batch": "s1"}},
            rate_limited={("GET", "/sync$"): 2},
            rate_limit_wait_ms=3_600_000,
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        attention = await _attention(adapter)
        assert "rate-limiting the bot" in attention
        assert homeserver.waits == []

        homeserver.queue(batch("s2", [message_event("$late", "got through")]))
        async with asyncio.timeout(5):
            while not recorder.messages or await adapter.attention() is not None:
                await asyncio.sleep(0.005)
        await adapter.stop()
        assert [m.message_ref for m in recorder.messages] == ["$late"]

    async def test_a_rate_limit_naming_no_wait_is_waited_a_second_not_forever(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            account_data={POSITION: {"next_batch": "s1"}},
            rate_limited={("GET", "/sync$"): 3},
            rate_limit_wait_ms=0,
        )
        homeserver.queue(batch("s2", [message_event("$m", "hello")]))
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await _until(lambda: bool(recorder.messages))
        await adapter.stop()
        assert homeserver.waits == [1.0, 1.0, 1.0]


class _Flaky(Recorder):
    """A Switch whose room writes fail the first `failures` times."""

    def __init__(self, failures: int) -> None:
        super().__init__()
        self.failures = failures
        self.attempts = 0

    async def on_message(self, message: Any) -> None:
        self.attempts += 1
        if self.attempts <= self.failures:
            raise RuntimeError("database unavailable")
        await super().on_message(message)


class TestAFailingHandler:
    async def test_the_position_does_not_move_past_an_event_switch_did_not_take(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch(
                "s2", [message_event("$ok", "first"), message_event("$bad", "second")]
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        refused = 0

        async def fails_twice_on_bad(message: Any) -> None:
            nonlocal refused
            if message.message_ref == "$bad" and refused < 2:
                refused += 1
                raise RuntimeError("database unavailable")
            recorder.messages.append(message)

        recorder.on_message = fails_twice_on_bad  # type: ignore[method-assign]
        await start(adapter, recorder)
        await homeserver.until_syncs(3)
        await _until(lambda: homeserver.account_data[POSITION]["next_batch"] == "s2")
        await adapter.stop()

        # Read again from s1 until it went through; "$ok" was handed over once.
        assert [s["since"] for s in homeserver.syncs[:3]] == ["s1", "s1", "s1"]
        assert [m.message_ref for m in recorder.messages] == ["$ok", "$bad"]

    async def test_one_event_that_keeps_failing_beside_others_is_skipped_alone(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Its neighbours reaching Switch shows the fault is the event's."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch(
                "s2",
                [message_event("$ok", "fine"), message_event("$poison", "never taken")],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        poisoned = 0

        async def refuses_poison(message: Any) -> None:
            nonlocal poisoned
            if message.message_ref == "$poison":
                poisoned += 1
                raise RuntimeError("cannot store this one")
            recorder.messages.append(message)

        recorder.on_message = refuses_poison  # type: ignore[method-assign]
        await start(adapter, recorder)
        await _until(lambda: homeserver.account_data[POSITION]["next_batch"] == "s2")
        await adapter.stop()

        assert poisoned == 3
        assert [m.message_ref for m in recorder.messages] == ["$ok"]
        [given_up] = [
            r for r in caplog.records if "Giving up on Matrix events" in r.getMessage()
        ]
        assert given_up.levelname == "ERROR"
        assert "$poison" in given_up.getMessage()
        assert "$ok" not in given_up.getMessage()

    async def test_a_batch_switch_takes_nothing_of_is_held_until_it_can(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Nothing reaching Switch is Switch's own outage, however long it lasts:
        the batch is held, nothing is skipped, and Console says so meanwhile."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch("s2", [message_event("$a", "one"), message_event("$b", "two")])
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = _Flaky(failures=40)
        await start(adapter, recorder)

        attention = await _attention(adapter)
        assert "held" in attention and "nothing is skipped" in attention
        assert "database unavailable" in attention
        await _until(lambda: homeserver.account_data[POSITION]["next_batch"] == "s2")
        await adapter.stop()

        # Far more attempts than the per-event bound, and nothing given up on.
        assert [m.message_ref for m in recorder.messages] == ["$a", "$b"]
        assert recorder.attempts > 3 * 2
        assert not any("Giving up" in r.getMessage() for r in caplog.records)
        assert await adapter.attention() is None

    async def test_one_rooms_unreadable_history_does_not_hold_up_another(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.refusals[("GET", "/messages$")] = (500, {"errcode": "M_UNKNOWN"})
        other = "!other:example.org"
        gappy = batch(
            "s2", [message_event("$gappy", "newest")], limited=True, prev_batch="p1"
        )
        gappy["rooms"]["join"][other] = {
            "timeline": {"events": [message_event("$fine", "elsewhere")]},
            "state": {"events": []},
        }
        homeserver.queue(gappy)
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert sorted(m.message_ref for m in recorder.messages) == ["$fine", "$gappy"]
        assert homeserver.account_data[POSITION] == {"next_batch": "s2"}


class TestQuiet:
    async def test_a_quiet_copy_calls_the_api_but_never_syncs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        adapter = make_adapter(monkeypatch, homeserver, listening=False)
        await start(adapter, Recorder())

        assert await adapter.send_message(ROOM, "coder", "hello") is not None
        await adapter.stop()

        assert homeserver.syncs == []
        assert POSITION not in homeserver.account_data


class TestInvites:
    async def test_an_invite_is_accepted_and_the_room_adopted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.state[("!new:example.org", "m.room.name", "")] = {"name": "Ops"}
        homeserver.queue(
            {"next_batch": "s2", "rooms": _invite("!new:example.org", ALICE)}
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert homeserver.joined == ["!new:example.org"]
        assert [
            (j.channel_id, j.channel_name, j.channel_type) for j in recorder.app_joins
        ] == [("!new:example.org", "Ops", "channel_private")]

    async def test_a_direct_chat_is_adopted_as_a_direct_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Read from the room, as every later message's type is, so the room
        is not adopted as one kind and then reported as another."""
        homeserver = FakeHomeserver(
            account_data={POSITION: {"next_batch": "s1"}},
            members={"!dm:example.org": [BOT, ALICE]},
        )
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!dm:example.org", ALICE, is_direct=True),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [j.channel_type for j in recorder.app_joins] == ["direct"]
        assert await adapter.get_channel_type("!dm:example.org") == "direct"

    async def test_a_named_room_marked_direct_is_not_taken_for_a_dm(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            account_data={POSITION: {"next_batch": "s1"}},
            members={"!named:example.org": [BOT, ALICE]},
        )
        homeserver.state[("!named:example.org", "m.room.name", "")] = {"name": "Ops"}
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!named:example.org", ALICE, is_direct=True),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [j.channel_type for j in recorder.app_joins] == ["channel_private"]

    async def test_the_room_that_replaces_an_upgraded_one_is_not_adopted_twice(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The old room's tombstone moves its Switch room over; adopting the
        new room on its invite would make a second room for one conversation."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.state[(ROOM, "m.room.tombstone", "")] = {
            "replacement_room": "!v2:example.org"
        }
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!v2:example.org", ALICE, upgraded_from=ROOM),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert homeserver.joined == ["!v2:example.org"]
        assert recorder.app_joins == []

    @pytest.mark.parametrize(
        "tombstone",
        [None, {"replacement_room": "!elsewhere:example.org"}],
        ids=["no-tombstone", "tombstone-names-another-room"],
    )
    async def test_a_predecessor_the_old_room_does_not_confirm_is_adopted(
        self, monkeypatch: pytest.MonkeyPatch, tombstone: dict[str, str] | None
    ) -> None:
        """Anyone can write a `predecessor` into a room they create: without the
        old room's tombstone pointing here, nothing else would bring it in."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        if tombstone is not None:
            homeserver.state[(ROOM, "m.room.tombstone", "")] = tombstone
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!v2:example.org", ALICE, upgraded_from=ROOM),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [j.channel_id for j in recorder.app_joins] == ["!v2:example.org"]

    async def test_an_upgrade_by_someone_who_may_not_invite_the_bot_is_adopted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`_follow_upgrade` ignores such a tombstone, so the invite adopts."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.state[(ROOM, "m.room.tombstone", "")] = {
            "replacement_room": "!v2:example.org"
        }
        homeserver.state_senders[(ROOM, "m.room.tombstone", "")] = "@eve:far.example"
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!v2:example.org", ALICE, upgraded_from=ROOM),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [j.channel_id for j in recorder.app_joins] == ["!v2:example.org"]

    async def test_invites_waiting_at_the_first_start_are_answered(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            initial_sync={"rooms": _invite("!waiting:example.org", ALICE)}
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(1)
        await adapter.stop()
        assert homeserver.joined == ["!waiting:example.org"]
        assert len(recorder.app_joins) == 1

    async def test_an_invite_that_fails_at_the_first_start_is_tried_again(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An incremental sync never lists a waiting invite again, so the first
        position is stored only once it has been answered."""
        homeserver = FakeHomeserver(
            initial_sync={"rooms": _invite("!waiting:example.org", ALICE)}
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        refused = 0

        async def fails_twice(join: Any) -> None:
            nonlocal refused
            if refused < 2:
                refused += 1
                raise RuntimeError("database unavailable")
            recorder.app_joins.append(join)

        recorder.on_app_joined = fails_twice  # type: ignore[method-assign]
        await start(adapter, recorder)
        await homeserver.until_syncs(1)
        await adapter.stop()

        assert len([s for s in homeserver.syncs if "since" not in s]) == 3
        assert [j.channel_id for j in recorder.app_joins] == ["!waiting:example.org"]
        assert homeserver.account_data[POSITION] == {"next_batch": "s0"}

    async def test_an_invite_the_homeserver_will_not_let_the_bot_join_is_given_up(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Withdrawn before it was accepted: asking again gets the same answer,
        so it is the invite that failed, not Switch, and the sync moves on."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.refusals[("POST", "/join/")] = (403, {"errcode": "M_FORBIDDEN"})
        homeserver.queue(
            {"next_batch": "s2", "rooms": _invite("!gone:example.org", ALICE)}
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await _until(lambda: homeserver.account_data[POSITION]["next_batch"] == "s2")
        await adapter.stop()

        assert [s["since"] for s in homeserver.syncs[:3]] == ["s1", "s1", "s1"]
        assert recorder.app_joins == []
        [given_up] = [
            r for r in caplog.records if "Giving up on Matrix events" in r.getMessage()
        ]
        assert "invite to !gone:example.org" in given_up.getMessage()
        assert await adapter.attention() is None

    async def test_a_poison_invite_at_the_first_start_does_not_hold_it_forever(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            initial_sync={"rooms": _invite("!gone:example.org", ALICE)}
        )
        homeserver.refusals[("POST", "/join/")] = (404, {"errcode": "M_NOT_FOUND"})
        adapter = make_adapter(monkeypatch, homeserver)
        await start(adapter, Recorder())
        await homeserver.until_syncs(1)
        await adapter.stop()
        assert len([s for s in homeserver.syncs if "since" not in s]) == 3
        assert homeserver.account_data[POSITION] == {"next_batch": "s0"}

    async def test_an_invite_from_another_homeserver_is_declined_by_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!far:other.example", "@eve:other.example"),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert homeserver.joined == []
        assert homeserver.left == ["!far:other.example"]
        assert recorder.app_joins == []

    async def test_other_homeservers_can_be_let_in(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!far:other.example", "@eve:other.example"),
            }
        )
        adapter = make_adapter(
            monkeypatch, homeserver, accept_invites_from_other_servers=True
        )
        await start(adapter, Recorder())
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert homeserver.joined == ["!far:other.example"]


class TestEncryptedRooms:
    async def test_an_invite_to_an_encrypted_room_is_refused_with_a_notice(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            {
                "next_batch": "s2",
                "rooms": _invite("!secret:example.org", ALICE, encrypted=True),
            }
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        notices = homeserver.messages_to("!secret:example.org")
        assert [n.content["msgtype"] for n in notices] == ["m.notice"]
        assert notices[0].content["body"] == ENCRYPTED_ROOM_NOTICE
        assert "format" not in notices[0].content
        assert homeserver.left == ["!secret:example.org"]
        assert recorder.app_joins == []

    async def test_encryption_found_only_after_joining_is_refused_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.state[("!quiet:example.org", "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        homeserver.queue(
            {"next_batch": "s2", "rooms": _invite("!quiet:example.org", ALICE)}
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert homeserver.left == ["!quiet:example.org"]
        assert recorder.app_joins == []

    async def test_encryption_turned_on_in_a_bridged_room_stops_bridging_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        encryption = {
            "type": "m.room.encryption",
            "state_key": "",
            "event_id": "$enc",
            "sender": ALICE,
            "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        }
        homeserver.queue(
            batch(
                "s2",
                [
                    message_event("$before", "still plain"),
                    encryption,
                    message_event("$after", "should not be relayed"),
                ],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()

        assert [m.message_ref for m in recorder.messages] == ["$before"]
        assert [n.content["body"] for n in homeserver.messages_to(ROOM)] == [
            ENCRYPTED_ROOM_NOTICE
        ]
        assert homeserver.left == [ROOM]

    async def test_encryption_turned_on_while_nobody_synced_is_found_in_state(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch(
                "s2",
                [message_event("$x", "encrypted by now")],
                state=[
                    {
                        "type": "m.room.encryption",
                        "state_key": "",
                        "sender": ALICE,
                        "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                    }
                ],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert recorder.messages == []
        assert homeserver.left == [ROOM]

    async def test_a_leave_that_failed_sends_nothing_and_is_tried_again(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.refusals[("POST", "/leave$")] = (500, {"errcode": "M_UNKNOWN"})
        encryption = {
            "type": "m.room.encryption",
            "state_key": "",
            "event_id": "$enc",
            "sender": ALICE,
            "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        }
        homeserver.queue(batch("s2", [encryption]))
        adapter = make_adapter(monkeypatch, homeserver)
        await start(adapter, Recorder())
        await homeserver.until_syncs(2)
        # The leave did not go through; the bot is still in the room.
        assert homeserver.left == []
        homeserver.state[(ROOM, "m.room.encryption", "")] = encryption["content"]

        # Nothing goes out to it in plain text meanwhile.
        sent_before = len(homeserver.sent)
        assert await adapter.send_message(ROOM, "coder", "secret plans") is None
        assert len(homeserver.sent) == sent_before

        # The room's next appearance in a sync tries the leave again.
        del homeserver.refusals[("POST", "/leave$")]
        homeserver.queue(batch("s3", [message_event("$later", "still here?")]))
        await homeserver.until_syncs(3)
        await adapter.stop()
        assert homeserver.left == [ROOM]

    async def test_a_room_left_is_forgotten(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        adapter = make_adapter(monkeypatch, homeserver, listening=False)
        await start(adapter, Recorder())
        await adapter.send_message(ROOM, "coder", "hello")
        assert ROOM in adapter._encryption
        await adapter.retire_channel(ROOM)
        await adapter.stop()
        assert ROOM not in adapter._encryption
        assert ROOM not in adapter._rooms

    async def test_a_quiet_copy_refuses_to_send_into_an_encrypted_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The process that is not syncing never sees the encryption event,
        so the room's own state is what it checks."""
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        adapter = make_adapter(monkeypatch, homeserver, listening=False)
        await start(adapter, Recorder())
        assert await adapter.send_message(ROOM, "coder", "secret plans") is None
        assert await adapter.admin_message(ROOM, "notice") is None
        ref = await adapter.send_attachment(
            ROOM, "coder", "plans.txt", "text/plain", b"secret"
        )
        await adapter.stop()
        assert ref is None
        assert homeserver.sent == []
        assert homeserver.uploads == []

    async def test_a_quiet_copy_reads_encryption_before_every_send(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It never sees encryption turned on, so nothing it read before is
        trusted: a room encrypted a moment ago gets nothing."""
        homeserver = FakeHomeserver()
        adapter = make_adapter(monkeypatch, homeserver, listening=False)
        await start(adapter, Recorder())
        assert await adapter.send_message(ROOM, "coder", "first") is not None
        homeserver.state[(ROOM, "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        assert await adapter.send_message(ROOM, "coder", "second") is None
        await adapter.stop()
        assert len(homeserver.messages_to(ROOM)) == 1
        reads = [
            r for r in homeserver.requests if r.url.path.endswith("/m.room.encryption/")
        ]
        assert len(reads) == 2


NEW_ROOM = "!v2:example.org"


class TestRoomUpgrades:
    def _tombstone(self, sender: str = ALICE) -> dict[str, Any]:
        return {
            "type": "m.room.tombstone",
            "state_key": "",
            "event_id": "$tomb",
            "sender": sender,
            "content": {"body": "upgraded", "replacement_room": NEW_ROOM},
        }

    def _homeserver(self, *, predecessor: str | None = ROOM) -> FakeHomeserver:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        if predecessor is not None:
            homeserver.state[(NEW_ROOM, "m.room.create", "")] = {
                "room_version": "11",
                "predecessor": {"room_id": predecessor},
            }
        return homeserver

    async def _run(
        self,
        monkeypatch: pytest.MonkeyPatch,
        homeserver: FakeHomeserver,
        *batches: dict[str, Any],
        recorder: Recorder | None = None,
        **overrides: Any,
    ) -> list[tuple[str, str]]:
        for queued in batches:
            homeserver.queue(queued)
        adapter = make_adapter(monkeypatch, homeserver, **overrides)
        migrated: list[tuple[str, str]] = []

        async def on_migrated(old: str, new: str) -> None:
            migrated.append((old, new))

        adapter.set_channel_migration_handler(on_migrated)
        await start(adapter, recorder or Recorder())
        await homeserver.until_syncs(len(batches) + 1)
        await adapter.stop()
        return migrated

    async def test_an_upgrade_moves_the_room_onto_its_replacement_and_leaves(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = self._homeserver()
        migrated = await self._run(
            monkeypatch, homeserver, batch("s2", [self._tombstone()])
        )
        assert homeserver.joined == [NEW_ROOM]
        join = next(r for r in homeserver.requests if "/join/" in r.url.path)
        assert join.url.params["server_name"] == "example.org"
        assert migrated == [(ROOM, NEW_ROOM)]
        # Out of the old room, so nothing said there makes a second room.
        assert homeserver.left == [ROOM]

    @pytest.mark.parametrize(
        "predecessor", [None, "!some-other-room:example.org"], ids=["none", "other"]
    )
    async def test_a_tombstone_naming_a_room_not_made_as_its_successor_is_ignored(
        self, monkeypatch: pytest.MonkeyPatch, predecessor: str | None
    ) -> None:
        """Anyone who may send state can write a tombstone naming any room; only
        an upgrade makes a room whose creation names this one."""
        homeserver = self._homeserver(predecessor=predecessor)
        recorder = Recorder()
        migrated = await self._run(
            monkeypatch,
            homeserver,
            batch("s2", [self._tombstone(), message_event("$after", "still here")]),
            recorder=recorder,
        )
        assert migrated == []
        assert homeserver.left == [NEW_ROOM]
        # The old room is still bridged.
        assert [m.message_ref for m in recorder.messages] == ["$after"]

    async def test_a_tombstone_from_another_homeserver_is_ignored(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = self._homeserver()
        migrated = await self._run(
            monkeypatch,
            homeserver,
            batch("s2", [self._tombstone(sender="@mallory:evil.example")]),
        )
        assert migrated == []
        assert homeserver.joined == []

    async def test_a_tombstone_from_another_homeserver_is_followed_when_allowed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = self._homeserver()
        migrated = await self._run(
            monkeypatch,
            homeserver,
            batch("s2", [self._tombstone(sender="@carol:partner.example")]),
            accept_invites_from_other_servers=True,
        )
        assert migrated == [(ROOM, NEW_ROOM)]

    async def test_a_later_message_in_the_old_room_makes_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Even while the leave keeps failing: what follows the tombstone, in
        its batch or a later one, is not relayed, and the leave is retried."""
        homeserver = self._homeserver()
        homeserver.refusals[("POST", f"/rooms/{ROOM}/leave$")] = (
            500,
            {"errcode": "M_UNKNOWN"},
        )
        recorder = Recorder()
        homeserver.queue(
            batch("s2", [self._tombstone(), message_event("$same", "same batch")])
        )
        homeserver.queue(batch("s3", [message_event("$later", "a later batch")]))
        adapter = make_adapter(monkeypatch, homeserver)
        migrated: list[tuple[str, str]] = []

        async def on_migrated(old: str, new: str) -> None:
            migrated.append((old, new))

        adapter.set_channel_migration_handler(on_migrated)
        await start(adapter, recorder)
        await homeserver.until_syncs(3)
        assert homeserver.left == []

        del homeserver.refusals[("POST", f"/rooms/{ROOM}/leave$")]
        homeserver.queue(batch("s4", [message_event("$last", "and another")]))
        await homeserver.until_syncs(4)
        await adapter.stop()

        assert migrated == [(ROOM, NEW_ROOM)]
        assert recorder.messages == []
        assert recorder.app_joins == []
        assert homeserver.left == [ROOM]

    async def test_an_encrypted_replacement_is_refused_and_said_in_the_old_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = self._homeserver()
        homeserver.state[(NEW_ROOM, "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        migrated = await self._run(
            monkeypatch, homeserver, batch("s2", [self._tombstone()])
        )
        assert migrated == []
        assert homeserver.left == [NEW_ROOM]
        [notice] = homeserver.messages_to(ROOM)
        assert "end-to-end encrypted" in notice.content["body"]
        assert "no longer bridged" in notice.content["body"]

    async def test_a_replacement_the_bot_cannot_join_is_said_in_the_old_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = self._homeserver()
        homeserver.refusals[("POST", "/join/")] = (403, {"errcode": "M_FORBIDDEN"})
        await self._run(monkeypatch, homeserver, batch("s2", [self._tombstone()]))
        [notice] = homeserver.messages_to(ROOM)
        assert "upgraded" in notice.content["body"]
        assert "Invite this account to the new room" in notice.content["body"]


class TestMembership:
    async def test_a_person_joining_is_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch(
                "s2",
                [
                    {
                        "type": "m.room.member",
                        "state_key": "@carol:example.org",
                        "event_id": "$join",
                        "sender": "@carol:example.org",
                        "content": {"membership": "join"},
                    },
                    {
                        "type": "m.room.member",
                        "state_key": "@carol:example.org",
                        "event_id": "$rename",
                        "sender": "@carol:example.org",
                        "content": {"membership": "join", "displayname": "Carol"},
                        "unsigned": {"prev_content": {"membership": "join"}},
                    },
                ],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert [
            (j.external_user_id, j.external_username) for j in recorder.user_joins
        ] == [("@carol:example.org", "carol")]

    async def test_a_profile_change_read_back_without_prev_content_is_no_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`/messages` may give only `replaces_state`; the event it names says
        the member was already in the room."""
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.put_event(
            ROOM,
            {
                "type": "m.room.member",
                "state_key": "@carol:example.org",
                "event_id": "$joined-long-ago",
                "sender": "@carol:example.org",
                "content": {"membership": "join"},
            },
        )
        homeserver.queue(
            batch(
                "s2",
                [
                    {
                        "type": "m.room.member",
                        "state_key": "@carol:example.org",
                        "event_id": "$rename",
                        "sender": "@carol:example.org",
                        "content": {"membership": "join", "displayname": "Carol"},
                        "unsigned": {"replaces_state": "$joined-long-ago"},
                    },
                ],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert recorder.user_joins == []

    async def test_the_bot_being_removed_ends_the_room_quietly(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(account_data={POSITION: {"next_batch": "s1"}})
        homeserver.queue(
            batch(
                "s2",
                [
                    {
                        "type": "m.room.member",
                        "state_key": BOT,
                        "event_id": "$kick",
                        "sender": ALICE,
                        "content": {"membership": "leave"},
                    },
                    message_event("$late", "after the kick"),
                ],
            )
        )
        adapter = make_adapter(monkeypatch, homeserver)
        recorder = Recorder()
        await start(adapter, recorder)
        await homeserver.until_syncs(2)
        await adapter.stop()
        assert recorder.messages == []
        assert homeserver.sent == []
