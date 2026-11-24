"""A Hypothesis state machine over a collaboration bridge carrying messages
both ways, on two processes sharing Postgres (`bridge.roundtrip-exactly-once`).

One bridge, one channel bridged to one room, run by two switch-core processes
as `main` runs them: one holds the bridge and listens to the platform, the
other runs a quiet copy (`bridge_processes.py`). People post on the platform,
and the platform delivers a post again, to the holder or as a webhook reaching
the quiet copy. Someone in Switch writes in the room, for the bridge to post
out. The platform refuses a post now and then, or takes one and then fails. The
bridge is handed over, as a deploy replaces the process holding it.

What is checked, once everything sent has had time to arrive:

- Each post on the platform is in the room once, however often it was
  delivered and whichever copy it reached.
- Each message written in Switch is on the platform once. One the platform
  refused is tried again (`WorkspaceConsumer`), by the holder or, if the
  bridge is handed over first, by the next. One the platform took before
  failing is on it twice, since the bridge cannot tell it went out
  (`_claim_outbound` says so).
- Nothing the platform said is posted back to it.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, precondition, rule
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.clients import workspace_consumer
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, Message
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database
from tests.switch_core.bridges.collaboration.bridge_processes import (
    TIMEOUT,
    Bridge,
    Chat,
    Platform,
    Process,
    add_bridge,
    inbound_post,
    process_on,
    say_in_room,
)

# How long the platform is watched for a second copy of a post, once the
# first is there.
QUIET_SECONDS = 0.3
MAX_HANDOVERS = 2
# Long enough for a handover to come while a failed post waits to be tried
# again.
RETRY_AFTER_SECONDS = (0.5,)

REFUSE = "refuse"
TAKE_THEN_FAIL = "take then fail"

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "a post delivered again to the holder",
    "a post delivered again to the quiet copy",
    "handed the bridge over",
    "a post refused",
    "a post taken and then failed",
    "handed over with a failed post still to be tried",
)


class PlatformFailure(Exception):
    """The platform answering a post with an error."""


class MachinePlatform(Platform):
    """The platform, refusing or failing the next new post when told to. A
    post tried again goes through."""

    def __init__(self) -> None:
        super().__init__()
        self.next: list[str] = []
        # What happened to each post, in order: (content, outcome).
        self.outcomes: list[tuple[str, str]] = []

    async def receive(self, channel_id: str, sender_name: str, content: str) -> str:
        tried = any(seen == content for seen, _ in self.outcomes)
        outcome = self.next.pop(0) if self.next and not tried else "ok"
        self.outcomes.append((content, outcome))
        if outcome == REFUSE:
            raise PlatformFailure("the platform refused the post")
        ref = await super().receive(channel_id, sender_name, content)
        if outcome == TAKE_THEN_FAIL:
            raise PlatformFailure("the platform took the post and then failed")
        return ref


@dataclass
class Said:
    """A message written in Switch, and what may have become of it."""

    text: str
    refused: bool = False
    taken_then_failed: bool = False


@dataclass
class Posted:
    """A post on the platform."""

    ref: str
    text: str
    deliveries: int = 1


@dataclass
class World:
    said: list[Said] = field(default_factory=list)
    posted: list[Posted] = field(default_factory=list)


class BridgeRoundTrips(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        self.platform = MachinePlatform()
        self._platform_before = getattr(Chat, "platform", None)
        Chat.platform = self.platform
        self.processes: list[Process] = []
        self.world = World()
        self.handovers = 0
        self._retry_before = workspace_consumer.RETRY_RELAY_AFTER_SECONDS
        workspace_consumer.RETRY_RELAY_AFTER_SECONDS = RETRY_AFTER_SECONDS
        try:
            self.run(self._set_up())
        except BaseException:
            self._release()
            raise

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    async def _set_up(self) -> None:
        await empty_the_database(self.engine)
        self.session_factory = create_session_factory(self.engine)
        self.bridge: Bridge = await add_bridge(self.session_factory)
        for _ in range(2):
            process = await process_on(self.url, self.session_factory)
            self.processes.append(process)
            await process.boot()
        await self._balance()

    async def _balance(self) -> None:
        for process in self.processes:
            await process.ownership.balance()
        for process in self.processes:
            await process.settled()
        await self._until(
            lambda: len(self.platform.listening) == 1,
            "one copy of the bridge to listen",
        )

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self._stop())
        finally:
            workspace_consumer.RETRY_RELAY_AFTER_SECONDS = self._retry_before
            if self._platform_before is not None:
                Chat.platform = self._platform_before
            self.loop.close()
            self._scope.__exit__(None, None, None)

    async def _stop(self) -> None:
        for process in self.processes:
            with contextlib.suppress(Exception):
                await process.stop()
        await self.engine.dispose()

    # ── Reading ──────────────────────────────────────────────────────────────

    async def _until(self, done: Any, what: str) -> None:
        async def wait() -> None:
            while not done():
                await asyncio.sleep(0.01)

        try:
            await asyncio.wait_for(wait(), TIMEOUT)
        except TimeoutError:
            raise AssertionError(f"waited {TIMEOUT}s for {what}") from None

    def _holder(self) -> tuple[Process, Process]:
        holders = [p for p in self.processes if p.bridges.holds(self.bridge.bridge_id)]
        assert len(holders) == 1, f"{len(holders)} processes hold the bridge"
        (holder,) = holders
        (quiet,) = [p for p in self.processes if p is not holder]
        return holder, quiet

    async def _room_bodies(self) -> Counter[str]:
        """How many times each body is in the room, from anyone but the
        Switch speaker."""
        async with self.session_factory() as session:
            bodies = (
                await session.scalars(
                    select(Message.body).where(
                        Message.room_id == self.bridge.room_id,
                        Message.event_type == "m.room.message",
                        Message.sender_id != self.bridge.speaker,
                    )
                )
            ).all()
        return Counter(body for body in bodies if body is not None)

    # ── Steps ────────────────────────────────────────────────────────────────

    @rule()
    def person_posts(self) -> None:
        """Someone writes in the channel."""
        ref = f"m{len(self.world.posted) + 1}"
        text = f"from the platform {ref}"
        self.run(self.platform.say(user_id="U1", text=text, ref=ref))
        self.world.posted.append(Posted(ref, text))

    @precondition(lambda self: self.world.posted)
    @rule(data=st.data(), to_quiet=st.booleans())
    def deliver_again(self, data: st.DataObject, to_quiet: bool) -> None:
        """The platform delivers a post again: over the holder's connection,
        as Slack does with an event it saw no acknowledgement of, or as a
        webhook reaching the quiet copy."""
        posted = data.draw(st.sampled_from(self.world.posted), label="post")

        async def go() -> None:
            post = inbound_post(user_id="U1", text=posted.text, ref=posted.ref)
            if to_quiet:
                _, quiet = self._holder()
                copy = quiet.bridges.get(self.bridge.bridge_id)
                assert copy is not None
                await self._until(
                    lambda: quiet.bridges.is_connected(self.bridge.bridge_id),
                    "the quiet copy to come up",
                )
                await copy.adapter.hear(post)  # type: ignore[attr-defined]
            else:
                await self.platform.say(user_id="U1", text=posted.text, ref=posted.ref)

        self.run(go())
        posted.deliveries += 1
        COVERAGE[
            f"a post delivered again to the {'quiet copy' if to_quiet else 'holder'}"
        ] += 1

    @rule()
    def switch_says(self) -> None:
        """Someone in Switch writes in the room, for the bridge to post. Its
        first try is waited for, so a failure set up after this step is for
        a later message."""
        text = f"from switch {uuid.uuid4().hex[:8]}"
        said = Said(text)
        self.run(say_in_room(self.session_factory, self.bridge, text))
        self.world.said.append(said)

        def first_try() -> str | None:
            return next(
                (
                    outcome
                    for content, outcome in self.platform.outcomes
                    if content == text
                ),
                None,
            )

        self.run(
            self._until(
                lambda: first_try() is not None, f"the bridge to try posting {text!r}"
            )
        )
        outcome = first_try()
        said.refused = outcome == REFUSE
        said.taken_then_failed = outcome == TAKE_THEN_FAIL
        if said.refused:
            COVERAGE["a post refused"] += 1
        if said.taken_then_failed:
            COVERAGE["a post taken and then failed"] += 1

    @precondition(lambda self: not self.platform.next)
    @rule(outcome=st.sampled_from([TAKE_THEN_FAIL]))
    def fail_the_next_post(self, outcome: str) -> None:
        self.platform.next.append(outcome)

    @precondition(lambda self: self.handovers < MAX_HANDOVERS)
    @rule()
    def hand_over(self) -> None:
        """The process holding the bridge shuts down, as a deploy replaces
        it, and a new process starts beside the other."""

        posts = Counter(self.platform.posted())
        if any(
            posts[s.text] < (2 if s.taken_then_failed else 1)
            for s in self.world.said
            if s.refused or s.taken_then_failed
        ):
            COVERAGE["handed over with a failed post still to be tried"] += 1

        async def go() -> None:
            holder, _ = self._holder()
            await holder.stop()
            self.processes.remove(holder)
            process = await process_on(self.url, self.session_factory)
            self.processes.append(process)
            await process.boot()
            await self._balance()

        self.run(go())
        self.handovers += 1
        COVERAGE["handed the bridge over"] += 1

    @rule()
    def settle(self) -> None:
        """Everything sent has arrived: then each message is where it should
        be, as often as it should be."""
        self.run(self._check())

    async def _check(self) -> None:
        def on_platform() -> Counter[str]:
            return Counter(self.platform.posted())

        def expected(said: Said) -> int:
            return 2 if said.taken_then_failed else 1

        await self._until(
            lambda: all(on_platform()[s.text] >= expected(s) for s in self.world.said),
            "every message written in Switch to be on the platform",
        )
        await asyncio.sleep(QUIET_SECONDS)
        posts = on_platform()
        for said in self.world.said:
            copies = posts[said.text]
            assert copies == expected(said), (
                f"{said.text!r} is on the platform {copies} times"
                f"{' (taken, then failed)' if said.taken_then_failed else ''}"
                f"{' (refused)' if said.refused else ''}"
            )
        from_platform = {p.text for p in self.world.posted}
        echoed = [text for text in posts if text in from_platform]
        assert not echoed, f"posted back to the platform: {echoed}"

        def in_room_once() -> bool:
            return all(bodies.get(p.text, 0) >= 1 for p in self.world.posted)

        bodies: Counter[str] = Counter()

        async def read() -> None:
            nonlocal bodies
            while True:
                bodies = await self._room_bodies()
                if in_room_once():
                    return
                await asyncio.sleep(0.02)

        try:
            await asyncio.wait_for(read(), TIMEOUT)
        except TimeoutError:
            raise AssertionError(
                f"waited {TIMEOUT}s for every platform post to be in the room; "
                f"the room has {dict(bodies)}"
            ) from None
        for posted in self.world.posted:
            assert bodies[posted.text] == 1, (
                f"{posted.text!r}, delivered {posted.deliveries} times, is in the "
                f"room {bodies[posted.text]} times"
            )


def machine_on(url: str) -> type[BridgeRoundTrips]:
    return type("BridgeRoundTripsOnPostgres", (BridgeRoundTrips,), {"url": url})
