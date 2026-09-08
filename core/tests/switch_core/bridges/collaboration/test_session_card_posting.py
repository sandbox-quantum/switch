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
    InboundInteraction,
    InboundMessage,
)
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
    return projection.open_room_requests("room-demo")[0]


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


# ── The stand-in session ─────────────────────────────────────────────────────


async def test_the_trigger_posts_the_recorded_request_as_a_card(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    assert await SessionDemo(cards).handle(TRIGGER, CHANNEL, room_id) is True

    assert len(client.posted) == 1
    assert "Run project tests" in json.dumps(client.posted[0]["blocks"])


async def test_the_trigger_is_the_whole_message_or_it_is_not_the_trigger(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Otherwise talking about the demo in a channel posts one."""
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)
    demo = SessionDemo(cards)

    for said in [f"about {TRIGGER}", f"{TRIGGER} please", "hello", ""]:
        assert await demo.handle(said, CHANNEL, room_id) is False

    assert client.posted == []


async def test_the_trigger_is_case_insensitive_and_forgives_spacing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = FakeWebClient()
    cards, _, room_id = await _cards(session_factory, client)

    assert await SessionDemo(cards).handle(f"  {TRIGGER.upper()} ", CHANNEL, room_id)

    assert len(client.posted) == 1


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
    cards, _, room_id = await _cards(session_factory, client)
    demo = SessionDemo(cards)

    for channel in (CHANNEL, CHANNEL, "C2"):
        assert await demo.handle(TRIGGER, channel, room_id) is True

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


# ── Where the trigger runs on the inbound path ───────────────────────────────


async def test_the_trigger_works_in_a_channel_the_bridge_has_not_seen_before() -> None:
    """A channel is mapped to its room on the first message anyone sends in it.

    A demo channel is new by definition — somebody just made it to show this
    off — so the hook has to run after that mapping. Run before it, the first
    `!session-demo` in a fresh channel finds no room and returns: no card, no
    log line, nothing said in the channel, and only the second one works.
    """
    asked: list[str] = []

    async def _handle(_content: str, _channel_id: str, room_id: str) -> bool:
        asked.append(room_id)
        return True

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _create_room_for_channel(**_kwargs: object) -> tuple[str, str]:
        return ("room-made-just-now", "!made:test")

    async def _repair_placeholder_username(*_args: object) -> None:
        return None

    async def _ensure_user_in_matrix_room(**_kwargs: object) -> None:
        return None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._channel_to_room = {}
    bridge._channel_locks = {}
    bridge._session_interactions = None
    bridge._session_demo = cast(Any, SimpleNamespace(handle=_handle))
    bridge._is_registered_agent = _is_registered_agent  # type: ignore[assignment]
    bridge._create_room_for_channel = _create_room_for_channel  # type: ignore[assignment]
    bridge._repair_placeholder_username = _repair_placeholder_username  # type: ignore[assignment]
    bridge._ensure_user_in_matrix_room = _ensure_user_in_matrix_room  # type: ignore[assignment]

    await BridgeCore._handle_inbound_message(
        bridge,
        InboundMessage(
            channel_id="a-channel-nobody-has-spoken-in",
            channel_type="channel_public",
            sender_id="U1",
            sender_name="someone",
            content=TRIGGER,
            message_ref="slack-post-1",
        ),
    )

    assert asked == ["room-made-just-now"]


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
