"""Putting a request card in a channel, and the row that makes it answerable.

Everything the earlier slices built reads a `session_request_posts` row: a
press finds one by token, a typed handle by name, a bare "yes" by the card it
replies to. Nothing wrote one. So the claim under this file is not that a card
appears — it is that the card that appears is the one the inbound half then
resolves, which is the only way to tell a posted card from a picture of one.

Against real Postgres, because the handle is only unique as far as the unique
index makes it, and that is the half a fake would not have.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from slack_sdk.errors import SlackApiError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import (
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session import demo
from switch_core.bridges.collaboration.session.contract import SnapshotRequest
from switch_core.bridges.collaboration.session.demo import TRIGGER, SessionDemo
from switch_core.bridges.collaboration.session.inbound import (
    InboundActor,
    SessionInteractions,
)
from switch_core.bridges.collaboration.session.outbound import (
    CardAlreadyPosted,
    CardNotPosted,
    SessionRequestCards,
    SessionTurnActivity,
)
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    Room,
    SessionRequestPost,
)
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .test_slack_agent_sessions import FakeResponse, FakeWebClient

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

CHANNEL = "C1"
FRESH_CHANNEL = "a-channel-nobody-has-spoken-in"

# The message that typed the trigger. The turn is threaded under it, so it is
# also where the activity goes.
TRIGGERED_BY = f"{CHANNEL}:1700000000.000100"


class _RefusingWebClient(FakeWebClient):
    """Slack taking the card and declining it."""

    async def chat_postMessage(self, **kwargs: Any) -> FakeResponse:
        raise SlackApiError("nope", FakeResponse({"error": "channel_not_found"}))


def _adapter(client: FakeWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache[CHANNEL] = "channel"
    return adapter


async def _fixture_request() -> SnapshotRequest:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, source.session_id)
    return projection.open_requests()[0]


async def _bridge_and_room(session: AsyncSession) -> tuple[str, str]:
    """A bridge and a room, because the row has a foreign key to each."""
    client = Client(
        matrix_user_id="@bridge-cards:test", display_name="bridge", type="bridge"
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Slack", client_id=client.id, status="active"
    )
    room = Room(matrix_room_id="!cards:test", name="cards", description="a room")
    session.add_all([bridge, room])
    await session.flush()
    await session.commit()
    return bridge.id, room.id


async def _cards(
    session_factory: async_sessionmaker[AsyncSession], client: FakeWebClient
) -> tuple[SessionRequestCards, str, str]:
    async with session_factory() as session:
        bridge_id, room_id = await _bridge_and_room(session)
    cards = SessionRequestCards(
        _adapter(client),
        bridge_id=bridge_id,
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
    )
    return cards, bridge_id, room_id


async def _demo(
    session_factory: async_sessionmaker[AsyncSession], client: FakeWebClient
) -> tuple[SessionDemo, str]:
    """The stand-in session, posting through one adapter for both messages."""
    async with session_factory() as session:
        bridge_id, room_id = await _bridge_and_room(session)
    adapter = _adapter(client)
    cards = SessionRequestCards(
        adapter,
        bridge_id=bridge_id,
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
    )
    return SessionDemo(cards, SessionTurnActivity(adapter)), room_id


async def _post_one(
    cards: SessionRequestCards, room_id: str, *, session_id: str = "session-demo"
) -> SessionRequestPost:
    return await cards.post(
        await _fixture_request(),
        channel_id=CHANNEL,
        thread_root_id=None,
        room_id=room_id,
        session_id=session_id,
        epoch="epoch-demo",
        agent_name="agent-demo",
    )


def _interactions(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> SessionInteractions:
    """The inbound half, reading the same rows the posting half writes."""

    async def identify(actor: InboundActor) -> str | None:
        return "@someone:test"

    async def is_first_reply(channel_id: str, root_ref: str, ref: str) -> bool:
        return True

    return SessionInteractions(
        bridge_id=bridge_id,
        surface="slack",
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
        identify=identify,
        is_first_reply=is_first_reply,
    )


# ── The card, and the row behind it ──────────────────────────────────────────


async def test_the_card_that_is_posted_is_one_a_press_resolves(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The whole point of the slice, in one test.

    Slices 2 to 5 built an inbound path that reads a row nothing had ever
    written, so every lookup it made could only miss. This is the first press
    in the codebase that finds its card.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)

    post = await _post_one(cards, room_id)

    command = await _interactions(session_factory, bridge_id).command_for(
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id="U1",
            sender_name="someone",
            action_id=f"{ANSWER_ACTION}:allow-once",
            value=post.token,
            message_ref=post.external_post_id,
        )
    )

    assert command is not None
    assert command.session_id == "session-demo"
    assert command.body.answer.option_id == "allow-once"  # type: ignore[union-attr]
    assert command.body.expected_revision == post.revision  # type: ignore[union-attr]


async def test_the_handle_the_card_shows_is_one_a_typed_answer_reaches(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The other half of the same claim, and the half the mint is for.

    A press carries the token back and never has to be read; a handle is copied
    off the card by a person, so it is only worth drawing if what they retype
    finds the row.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)

    post = await _post_one(cards, room_id)

    command = await _interactions(session_factory, bridge_id).command_for_text(
        InboundMessage(
            channel_id=CHANNEL,
            channel_type="channel_public",
            sender_id="U1",
            sender_name="someone",
            content=f"{post.handle.lower()} 2",
            message_ref="C1:222.0",
            root_id=None,
        )
    )

    assert command is not None
    assert command.body.answer.option_id == "deny"  # type: ignore[union-attr]


async def test_the_row_points_at_the_message_that_was_posted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Not at the placeholder it reserved the handle with.

    The reservation holds its own token in the post ref, so a row that never
    finished posting cannot be mistaken for one that did — and a row that did
    must not be left holding it.
    """
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    post = await _post_one(cards, room_id)

    assert len(client.posted) == 1
    assert post.external_post_id == f"{CHANNEL}:1.0"
    assert post.external_post_id != post.token


async def test_the_card_carries_the_handle_that_was_reserved_for_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A handle drawn on a card nobody reserved is one a typed answer misses."""
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    post = await _post_one(cards, room_id)

    assert post.handle == "R1"
    assert post.handle in json.dumps(client.posted[0]["blocks"])


async def test_the_row_records_what_the_card_offered(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """In render order, because a typed number counts down that order."""
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    post = await _post_one(cards, room_id)

    assert post.form == {
        "kind": "approval",
        "options": [
            {"optionId": "allow-once", "decision": "accept"},
            {"optionId": "deny", "decision": "decline"},
        ],
    }


async def test_a_second_card_in_a_channel_gets_the_next_handle(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two sessions asking in one channel, and two names to tell them apart."""
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    first = await _post_one(cards, room_id)
    second = await _post_one(cards, room_id, session_id="session-other")

    assert (first.handle, second.handle) == ("R1", "R2")


async def test_asking_the_same_request_twice_is_a_repeat_and_not_a_second_card(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """One decision, one set of buttons.

    Two cards for one request means two places to answer it, and a reader with
    no way to tell that pressing the older one is pressing the same thing.
    """
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)
    first = await _post_one(cards, room_id)

    with pytest.raises(CardAlreadyPosted) as raised:
        await _post_one(cards, room_id)

    assert first.handle in str(raised.value)
    assert len(client.posted) == 1


async def test_a_handle_already_taken_is_counted_past_rather_than_reused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The count is a starting point, and the unique index is the arbiter.

    Two cards posted at once compute the same first guess, so the insert is what
    has to settle it. Reproduced without a race by leaving a gap: two cards
    numbered R1 and R3 make the count guess a number already on a card, which is
    exactly the state a lost race leaves behind.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)
    async with session_factory() as session:
        for handle in ("R1", "R3"):
            await SessionRequestPostStore().create(
                session,
                _row(bridge_id=bridge_id, room_id=room_id, handle=handle),
            )
        await session.commit()

    post = await _post_one(cards, room_id)

    assert post.handle == "R4"


# ── When it cannot be posted ─────────────────────────────────────────────────


async def test_slack_refusing_the_card_releases_the_handle_and_says_so(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A handle held for a card nobody can see is a name that answers nothing.

    And the raise matters more than the release: the session is waiting on an
    answer, and this is the only moment anything can tell it nobody was asked.
    """
    cards, bridge_id, room_id = await _cards(session_factory, _RefusingWebClient())

    with pytest.raises(CardNotPosted):
        await _post_one(cards, room_id)

    async with session_factory() as session:
        assert (
            await SessionRequestPostStore().get_by_handle(
                session, bridge_id, CHANNEL, "R1"
            )
            is None
        )


async def test_a_freed_handle_is_the_one_the_next_card_takes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Proof the release is a release, and not just a row nobody looked at."""
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, _RefusingWebClient())
    with pytest.raises(CardNotPosted):
        await _post_one(cards, room_id)

    working = SessionRequestCards(
        _adapter(client),
        bridge_id=bridge_id,
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
    )
    post = await _post_one(working, room_id)

    assert post.handle == "R1"


class _RivalPoster(SessionRequestPostStore):
    """Another poster that commits its card while this one is still deciding.

    Slotted in after the read that catches a repeat and before the insert,
    which is the one ordering that read cannot cover. Both posters see no card,
    both insert, and the index refuses the second — the real race, without
    having to run two of anything.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        bridge_id: str,
        room_id: str,
        request_id: str,
    ) -> None:
        super().__init__()
        self._session_factory = session_factory
        self._bridge_id = bridge_id
        self._room_id = room_id
        self._request_id = request_id
        self._raced = False

    async def count_in_channel(
        self, session: AsyncSession, bridge_id: str, channel_id: str
    ) -> int:
        if not self._raced:
            self._raced = True
            rival = _row(bridge_id=self._bridge_id, room_id=self._room_id, handle="R1")
            rival.session_id = "session-demo"
            rival.request_id = self._request_id
            async with self._session_factory() as other:
                await SessionRequestPostStore().create(other, rival)
                await other.commit()
        return await super().count_in_channel(session, bridge_id, channel_id)


async def test_losing_the_race_is_reported_as_the_repeat_it_is(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A repeat and a handle clash are one error to Postgres and two to a reader.

    Caught without looking at which, the poster that gets there second is told
    it could not find a free name — after five tries at a name that was never
    the problem. It has to name the card that already asks the question,
    because that is the card the answer belongs on.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)
    racing = SessionRequestCards(
        _adapter(client),
        bridge_id=bridge_id,
        posts=_RivalPoster(
            session_factory,
            bridge_id=bridge_id,
            room_id=room_id,
            request_id=(await _fixture_request()).request_id,
        ),
        session_factory=session_factory,
    )

    with pytest.raises(CardAlreadyPosted) as raised:
        await _post_one(racing, room_id)

    assert "already has card R1" in str(raised.value)
    assert "free handle" not in str(raised.value)
    assert client.posted == []


async def test_a_row_that_cannot_be_written_at_all_is_not_retried(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Only the handle is a guess, so only the handle is worth another go.

    A row refused for any other reason is refused the same way five times over,
    and then reported as the wrong thing entirely. Here the room does not
    exist, which is a foreign key and not a name anyone can choose.
    """
    client = FakeWebClient()
    cards, _, _ = await _cards(session_factory, client)

    with pytest.raises(IntegrityError):
        await _post_one(cards, "00000000-0000-0000-0000-000000000000")

    assert client.posted == []


# ── The card, redrawn ────────────────────────────────────────────────────────


async def _revised_request() -> SnapshotRequest:
    """The same request, moved on: a new revision offering a new option.

    Both halves of the row are made to differ, because both are read back on
    the answer path — the revision an answer stands against, and the options a
    typed number counts down.
    """
    raw = (await _fixture_request()).model_dump(by_alias=True)
    raw["revision"] = 2
    raw["content"]["options"].append(
        {
            "optionId": "allow-always",
            "label": "Always allow",
            "decision": "acceptForSession",
        }
    )
    return SnapshotRequest.model_validate(raw)


async def test_a_redrawn_card_is_answered_at_the_revision_it_now_shows(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The card and the row have to move together, or the answer is thrown away.

    `expectedRevision` comes off the row. Redraw the card without it and the
    channel shows revision 2 while the row still says 1, so everyone answering
    the card they can see builds a command the session rejects as stale — and
    rejects on the far side of a transport this bridge cannot report from, so
    the person is left watching a card that never moves.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)
    post = await _post_one(cards, room_id)

    await cards.refresh(post, await _revised_request())

    command = await _interactions(session_factory, bridge_id).command_for_text(
        InboundMessage(
            channel_id=CHANNEL,
            channel_type="channel_public",
            sender_id="U1",
            sender_name="someone",
            content=f"{post.handle} 3",
            message_ref="C1:333.0",
            root_id=None,
        )
    )

    assert command is not None
    assert command.body.expected_revision == 2  # type: ignore[union-attr]
    assert command.body.answer.option_id == "allow-always"  # type: ignore[union-attr]


async def test_a_redraw_slack_refused_leaves_the_row_on_what_is_on_screen(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A failed edit means the old card is still the one anybody can read.

    Writing the new revision back anyway would point the row at a card nobody
    was shown: the third option is not on screen, and the two that are would
    answer at a revision the channel never displayed. Neither revision makes a
    late answer land — the request has moved on either way — so the row stays
    with what the reader can actually see.
    """
    client = FakeWebClient()
    cards, bridge_id, room_id = await _cards(session_factory, client)
    post = await _post_one(cards, room_id)
    client.update_error = "message_not_found"

    await cards.refresh(post, await _revised_request())

    async with session_factory() as session:
        row = await SessionRequestPostStore().get_by_token(
            session, bridge_id, post.token
        )
    assert row is not None
    assert row.revision == 1
    assert [option["optionId"] for option in row.form["options"]] == [
        "allow-once",
        "deny",
    ]


# ── The stand-in session ─────────────────────────────────────────────────────


async def test_the_trigger_posts_the_recorded_turn_and_then_its_card(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The work first, then the question, which is the order they happened in."""
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    assert await demo.handle(TRIGGER, CHANNEL, room_id, TRIGGERED_BY) is True

    assert len(client.posted) == 2
    turn, card = (json.dumps(post["blocks"]) for post in client.posted)
    assert "same fixture user" in turn
    assert "Ran tests/auth/test_login.py" in turn
    assert "Edit tests/auth/conftest.py?" in card


async def test_running_the_recording_to_the_end_edits_what_is_already_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two messages, four states between them, and nothing posted twice.

    The variant exists to make the anchor visible in a real channel: without
    it, a turn only ever gets one publish and nothing shows that the second
    one lands on the first message rather than beside it.
    """
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    assert await demo.handle(f"{TRIGGER} end", CHANNEL, room_id, TRIGGERED_BY) is True

    assert len(client.posted) == 2
    turn, card = (
        json.dumps(call["blocks"], ensure_ascii=False) for call in client.updated
    )
    assert "Turn interrupted. 1 step left unfinished." in turn
    assert "Permission request closed" in card
    assert "Interrupted before it was answered." in card


async def test_ending_carries_on_the_demo_already_in_the_channel(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Nothing new is posted for the ending, which is its whole point.

    Posting a fresh session for it left the first one hanging in the channel
    forever — it never ends, because nothing produces its events — and buried
    the one thing the variant shows under a duplicate of what it is showing it
    about.
    """
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    assert await demo.handle(TRIGGER, CHANNEL, room_id, TRIGGERED_BY) is True
    posted = len(client.posted)
    assert (
        await demo.handle(f"{TRIGGER} end", CHANNEL, room_id, "C1:1700000000.9") is True
    )

    assert len(client.posted) == posted
    turn, card = (
        json.dumps(call["blocks"], ensure_ascii=False) for call in client.updated
    )
    assert "Turn interrupted. 1 step left unfinished." in turn
    assert "Permission request closed" in card

    async with session_factory() as session:
        handles = list(
            (await session.execute(select(SessionRequestPost.handle))).scalars().all()
        )
    assert handles == ["R1"]


async def test_ending_a_channel_with_no_demo_in_it_runs_one_through(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Refusing would leave somebody typing a command that does nothing."""
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    assert await demo.handle(f"{TRIGGER} end", CHANNEL, room_id, TRIGGERED_BY) is True

    assert len(client.posted) == 2
    assert "Permission request closed" in json.dumps(
        client.updated[1]["blocks"], ensure_ascii=False
    )


async def test_a_demo_can_only_be_ended_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The second `end` has nothing on screen to carry on, so it replays.

    Which is the same rule as a channel that never had one: the demo that was
    ended is over, and the alternative is editing a turn that already says it
    was interrupted.
    """
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    await demo.handle(TRIGGER, CHANNEL, room_id, TRIGGERED_BY)
    await demo.handle(f"{TRIGGER} end", CHANNEL, room_id, TRIGGERED_BY)
    posted = len(client.posted)
    await demo.handle(f"{TRIGGER} end", CHANNEL, room_id, TRIGGERED_BY)

    assert len(client.posted) == posted + 2


async def test_each_channel_ends_its_own_demo(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two channels showing one each, and `end` in one leaves the other alone."""
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    await demo.handle(TRIGGER, CHANNEL, room_id, TRIGGERED_BY)
    await demo.handle(TRIGGER, "C2", room_id, "C2:1700000000.1")
    posted = len(client.posted)
    await demo.handle(f"{TRIGGER} end", "C2", room_id, "C2:1700000000.2")

    assert len(client.posted) == posted
    assert {call["channel"] for call in client.updated} == {"C2"}


async def test_the_trigger_is_the_whole_message_or_it_is_not_the_trigger(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Otherwise talking about the demo in a channel posts one."""
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    for said in [f"about {TRIGGER}", f"{TRIGGER} please", "hello", ""]:
        assert await demo.handle(said, CHANNEL, room_id, TRIGGERED_BY) is False

    assert client.posted == []


async def test_the_trigger_is_case_insensitive_and_forgives_spacing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    assert await demo.handle(f"  {TRIGGER.upper()} ", CHANNEL, room_id, TRIGGERED_BY)

    assert len(client.posted) == 2


async def test_the_demo_can_be_shown_more_than_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The recording holds one request under one session id.

    Posted as itself, that request is answered once and refused ever after — in
    this channel, in another channel, and tomorrow morning in front of someone
    new, with the only way back a DELETE against Postgres. A demo that works
    exactly once, and only for whoever ran it first, is not a demo.
    """
    client = FakeWebClient()
    demo, room_id = await _demo(session_factory, client)

    for channel in (CHANNEL, CHANNEL, "C2"):
        assert await demo.handle(TRIGGER, channel, room_id, TRIGGERED_BY) is True

    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(SessionRequestPost).order_by(SessionRequestPost.created_at)
                )
            )
            .scalars()
            .all()
        )

    assert [(row.external_channel_id, row.handle) for row in rows] == [
        (CHANNEL, "R1"),
        (CHANNEL, "R2"),
        ("C2", "R1"),
    ]
    assert len({row.session_id for row in rows}) == 3


# ── Finding the recording ────────────────────────────────────────────────────


def test_the_recording_is_found_in_a_checkout() -> None:
    """The console tree beside `core/`, which is where a developer runs."""
    assert demo._recording() == demo._RECORDING_PLACES[0]


def test_the_recording_is_found_in_an_image_that_has_no_console_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shape every deployment has, and the one this could not run in.

    A built image carries `switch_core/` and nothing else, so looking only
    where a checkout keeps it meant the demo raised on every trigger anywhere
    it was actually deployed. The image build drops the file beside the module.
    """
    beside_the_module = tmp_path / "examples.activity.json"
    beside_the_module.write_text("{}")
    monkeypatch.setattr(
        demo, "_RECORDING_PLACES", (tmp_path / "no-console-tree", beside_the_module)
    )

    assert demo._recording() == beside_the_module


def test_a_recording_in_neither_place_names_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two places to look is two places to be told about."""
    monkeypatch.setattr(demo, "_RECORDING_PLACES", (tmp_path / "a", tmp_path / "b"))

    with pytest.raises(FileNotFoundError) as raised:
        demo._recording()

    assert str(tmp_path / "a") in str(raised.value)
    assert str(tmp_path / "b") in str(raised.value)


# ── Where the trigger runs on the inbound path ───────────────────────────────


def _bridge_for_trigger(
    handle: Any, *, bridged: list[str], known_channel: bool = False
) -> BridgeCore:
    """A bridge stubbed down to the inbound command path and nothing else."""

    async def _create_room_for_channel(**_kwargs: object) -> tuple[str, str]:
        return ("room-made-just-now", "!made:test")

    async def _ensure_user_in_matrix_room(**kwargs: object) -> None:
        bridged.append(str(kwargs["room_id"]))
        return None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._channel_to_room = (
        {FRESH_CHANNEL: ("room-known-already", "!known:test")} if known_channel else {}
    )
    bridge._channel_locks = {}
    bridge._session_demo = cast(Any, SimpleNamespace(handle=handle))
    bridge._create_room_for_channel = _create_room_for_channel  # type: ignore[assignment]
    bridge._ensure_user_in_matrix_room = _ensure_user_in_matrix_room  # type: ignore[assignment]
    return bridge


def _typed(content: str) -> InboundCommand:
    """The trigger as an adapter hands it over: a command, not a message.

    Every adapter routes a leading `!` to the command hook, so this is the only
    shape `!session-demo` ever arrives in.
    """
    command, _, args = content.lstrip("!").partition(" ")
    return InboundCommand(
        channel_id=FRESH_CHANNEL,
        channel_type="channel_public",
        sender_id="U1",
        sender_name="someone",
        command=command,
        args=args,
        message_ref="slack-post-1",
    )


async def test_the_trigger_works_in_a_channel_the_bridge_has_not_seen_before() -> None:
    """A channel is mapped to its room on the first message anyone sends in it.

    A demo channel is new by definition — somebody just made it to show this
    off — so the hook has to run after that mapping. Run before it, the first
    `!session-demo` in a fresh channel finds no room and returns: no card, no
    log line, nothing said in the channel, and only the second one works.
    """
    asked: list[tuple[str, str]] = []

    async def _handle(
        content: str, _channel_id: str, room_id: str, _trigger_ref: str | None
    ) -> bool:
        asked.append((content, room_id))
        return True

    bridged: list[str] = []
    await BridgeCore._handle_inbound_command(
        _bridge_for_trigger(_handle, bridged=bridged), _typed(f"{TRIGGER} end")
    )

    assert asked == [(f"{TRIGGER} end", "room-made-just-now")]


async def test_the_trigger_is_answered_here_and_not_relayed_as_a_command() -> None:
    """The bug this fixes: the room answered `!session-demo` with "unknown command".

    The demo watched the message path, which a leading `!` never reaches, so
    the trigger was bridged into the room as a command nothing implements.
    """

    async def _handle(*_args: object) -> bool:
        return True

    bridged: list[str] = []
    await BridgeCore._handle_inbound_command(
        _bridge_for_trigger(_handle, bridged=bridged, known_channel=True),
        _typed(TRIGGER),
    )

    assert bridged == []


async def test_a_command_that_is_not_the_trigger_is_relayed_as_before() -> None:
    """Consuming everything would take `!help` with it."""

    async def _handle(*_args: object) -> bool:
        return False

    bridged: list[str] = []
    await BridgeCore._handle_inbound_command(
        _bridge_for_trigger(_handle, bridged=bridged, known_channel=True),
        _typed("!help"),
    )

    assert bridged == ["room-known-already"]


def _row(*, bridge_id: str, room_id: str, handle: str) -> SessionRequestPost:
    """Another session's card, already in the channel and holding its handle."""
    return SessionRequestPost(
        bridge_id=bridge_id,
        token=f"token-{handle}",
        handle=handle,
        external_channel_id=CHANNEL,
        external_post_id=f"{CHANNEL}:{handle}",
        room_id=room_id,
        thread_id=None,
        session_id=f"session-{handle}",
        epoch="epoch-demo",
        request_id="request-other",
        revision=1,
        form={"kind": "approval", "options": []},
    )
