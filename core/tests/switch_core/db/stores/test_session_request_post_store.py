from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    CollaborationBridge,
    Room,
    SessionRequestPost,
)
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore


async def _make_bridge(session: AsyncSession) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack",
        display_name="Slack",
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _make_room(session: AsyncSession) -> str:
    suffix = uuid.uuid4().hex[:8]
    room = Room(
        matrix_room_id=f"!room-{suffix}:test",
        name=f"room-{suffix}",
        description="a room",
    )
    session.add(room)
    await session.flush()
    return room.id


APPROVAL = {
    "kind": "approval",
    "options": [
        {"optionId": "allow-once", "decision": "accept"},
        {"optionId": "deny", "decision": "decline"},
    ],
}

QUESTIONS = {
    "kind": "questions",
    "questions": [
        {
            "questionId": "q-scope",
            "optionIds": ["all", "one-package"],
            "multiSelect": False,
            "allowCustomAnswer": False,
        },
        {
            "questionId": "q-branch",
            "optionIds": [],
            "multiSelect": False,
            "allowCustomAnswer": True,
        },
    ],
}


def _post(bridge_id: str, room_id: str, **overrides: object) -> SessionRequestPost:
    fields: dict[str, object] = {
        "bridge_id": bridge_id,
        "room_id": room_id,
        "token": "opaque-token",
        "handle": "R42",
        "external_channel_id": "C1",
        "external_post_id": "C1:111.0",
        "thread_id": "thread-demo",
        "session_id": "session-demo",
        "epoch": "epoch-demo",
        "request_id": "request-demo",
        "revision": 1,
        "form": APPROVAL,
    }
    fields.update(overrides)
    return SessionRequestPost(**fields)


class TestSessionRequestPostStore:
    async def test_a_token_resolves_to_what_was_posted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_token(session, bridge_id, "opaque-token")

        assert found is not None
        assert found.session_id == "session-demo"
        assert found.epoch == "epoch-demo"
        assert found.request_id == "request-demo"
        assert found.revision == 1

    async def test_a_token_does_not_resolve_on_another_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The workspace fence. A token names a request in one connection only."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            other_bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_token(session, other_bridge_id, "opaque-token")

        assert found is None

    async def test_an_unknown_token_resolves_to_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await session.commit()

        async with session_factory() as session:
            assert await store.get_by_token(session, bridge_id, "made-up") is None

    async def test_one_request_is_posted_once_per_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two rows for one request would give a request two live cards."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(
                        bridge_id,
                        room_id,
                        token="another-token",
                        handle="R43",
                        external_post_id="C1:222.0",
                    ),
                )

    async def test_a_handle_is_unambiguous_within_a_channel(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`R42` is what someone types instead of pressing. It must mean one thing."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(
                        bridge_id,
                        room_id,
                        token="another-token",
                        external_post_id="C1:222.0",
                        request_id="request-other",
                    ),
                )

    async def test_two_handles_that_differ_only_in_case_are_one_handle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The lookup ignores case, so uniqueness has to as well.

        `R42` beside `r42` in one channel makes the read find two rows and
        raise, and it raises into the relay — where the cost is not a refused
        answer but a message the room never sees.
        """
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(
                        bridge_id,
                        room_id,
                        handle="r42",
                        token="another-token",
                        external_post_id="C1:222.0",
                        request_id="request-other",
                    ),
                )

    async def test_one_posted_card_stands_for_one_request(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The bare form reads a request back off the card it replies to."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(
                        bridge_id,
                        room_id,
                        handle="R43",
                        token="another-token",
                        request_id="request-other",
                    ),
                )

    async def test_a_typed_handle_resolves_however_it_was_capitalised(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A handle is retyped by a person, not handed back by a platform."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_handle(session, bridge_id, "C1", "r42")

        assert found is not None
        assert found.request_id == "request-demo"

    async def test_a_handle_names_nothing_in_another_channel(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Handles only have to be unique as far as a reader can see."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            assert await store.get_by_handle(session, bridge_id, "C2", "R42") is None

    async def test_a_handle_names_nothing_on_another_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            other_bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_handle(session, other_bridge_id, "C1", "R42")

        assert found is None

    async def test_a_reply_to_a_card_finds_the_request_it_replies_to(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What makes a bare "yes" answerable: the thread root is the card."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_post(session, bridge_id, "C1:111.0")
            elsewhere = await store.get_by_post(session, bridge_id, "C1:999.0")

        assert found is not None
        assert found.request_id == "request-demo"
        assert elsewhere is None

    @pytest.mark.parametrize("form", [APPROVAL, QUESTIONS], ids=["approval", "form"])
    async def test_the_form_the_card_offered_survives_the_round_trip(
        self, session_factory: async_sessionmaker[AsyncSession], form: dict[str, object]
    ) -> None:
        """A typed number resolves against this, so its order is the record.

        Both kinds, because `kind` is what the press path reads to know which
        result to build: a record that came back without it would be answered
        as whichever kind the reader guessed.
        """
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id, form=form))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_handle(session, bridge_id, "C1", "R42")

        assert found is not None
        assert found.form == form

    async def test_a_card_cannot_be_recorded_without_saying_what_it_offered(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """There is no default form, deliberately.

        A row that defaulted to an empty approval would be a card every typed
        answer refuses and every press resolves to nothing, with the column
        looking populated. The caller knows what it rendered; it has to say.
        """
        store = SessionRequestPostStore()
        async with session_factory() as session:
            formless = SessionRequestPost(
                bridge_id=await _make_bridge(session),
                room_id=await _make_room(session),
                token="opaque-token",
                handle="R42",
                external_channel_id="C1",
                external_post_id="C1:111.0",
                thread_id="thread-demo",
                session_id="session-demo",
                epoch="epoch-demo",
                request_id="request-demo",
                revision=1,
            )
            with pytest.raises(IntegrityError):
                await store.create(session, formless)
