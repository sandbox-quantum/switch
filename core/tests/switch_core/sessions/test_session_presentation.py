import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.sessions.contract import TurnUpsert
from switch_core.sessions.presentation import (
    activity_error_summary,
    notification_recipient,
    request_card_recipient,
)


async def test_slack_thread_participant_needs_no_mention_or_identity_lookup():
    db = AsyncMock()
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="slack",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="123.456",
        )
        is None
    )
    db.scalar.assert_not_called()


async def test_other_origin_prefers_actor_and_scopes_mapping_to_bridge_and_membership():
    db = AsyncMock()
    db.scalar.return_value = "UACTOR"
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="console",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="123.456",
        )
        == "UACTOR"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query
    assert "clients.matrix_user_id = '@actor:switch'" in query
    assert db.scalar.call_count == 1


async def test_missing_actor_falls_back_to_claimed_owner_in_same_room():
    db = AsyncMock()
    db.scalar.side_effect = [None, None, "UOWNER"]
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="console",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id=None,
        )
        == "UOWNER"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "external_user_claims.user_id = 'owner'" in query
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query


async def test_the_asker_leads_even_where_a_mention_is_the_whole_notification():
    """The person waiting on the answer is named, not the agent's owner.

    A platform that only notifies by mention is the tempting place to name the
    owner instead — they are the one who can open Console — but the mention is
    also how the asker learns their own turn needs them, and naming somebody
    else leaves them watching a channel that never says their name."""
    db = AsyncMock()
    db.scalar.return_value = "UACTOR"

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="discord",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UACTOR"
    )
    query = str(
        db.scalar.call_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "clients.matrix_user_id = '@actor:switch'" in query
    assert db.scalar.call_count == 1


async def test_an_asker_with_no_account_here_still_reaches_the_owner():
    db = AsyncMock()
    db.scalar.side_effect = [None, None, "UOWNER"]

    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="discord",
            actor_id="@actor:switch",
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UOWNER"
    )


@pytest.mark.parametrize(
    "turn_status,online,expected",
    [
        ("error", True, "could not complete"),
        ("running", False, "host is offline"),
        ("queued", False, "host is offline"),
        ("completed", False, None),
        ("running", True, None),
    ],
)
def test_error_summary_uses_only_state(turn_status, online, expected):
    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn", command_id="command", status=turn_status
    )
    result = activity_error_summary(turn, online=online)
    if expected is None:
        assert result is None
    else:
        assert expected in result


async def test_an_unknown_asker_reaches_the_owner():
    db = AsyncMock()
    db.scalar.side_effect = ["UOWNER"]
    assert (
        await notification_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            surface="discord",
            actor_id=None,
            agent=SimpleNamespace(owner_id="owner"),
            thread_id="root-1",
        )
        == "UOWNER"
    )
    assert db.scalar.call_count == 1


# ── Who a request card in a thread names ─────────────────────────────────────

OWNER_ACCOUNT = SimpleNamespace(
    external_user_id="UOWNER", transport_user_id="@owner:switch"
)
ASKER_ACCOUNT = SimpleNamespace(
    external_user_id="UASKER", transport_user_id="@asker:switch"
)


def _found(*rows):
    """A db whose successive account lookups find these rows (None: no account,
    a list: several accounts)."""
    db = AsyncMock()
    results = []
    for row in rows:
        result = MagicMock()
        accounts = row if isinstance(row, list) else [] if row is None else [row]
        result.first.return_value = accounts[0] if accounts else None
        result.all.return_value = accounts
        results.append(result)
    db.execute.side_effect = results
    return db


def _sql(db, call: int) -> str:
    return str(
        db.execute.call_args_list[call]
        .args[0]
        .compile(compile_kwargs={"literal_binds": True})
    )


class MayAnswer:
    """The answer check, admitting only the room identities it is given."""

    def __init__(self, *admitted: str) -> None:
        self.admitted = set(admitted)
        self.asked: list[str] = []

    async def __call__(self, sender: str) -> bool:
        self.asked.append(sender)
        return sender in self.admitted


async def test_a_threaded_card_names_the_owner_when_the_asker_may_not_answer():
    """On the default policy only the owner may answer, so the asker is
    checked, refused, and the owner is named: naming the asker would ping a
    person who cannot press anything on the card."""
    db = _found(ASKER_ACCOUNT, OWNER_ACCOUNT)
    may_answer = MayAnswer("@owner:switch")

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@asker:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=may_answer,
        )
        == "UOWNER"
    )
    assert may_answer.asked == ["@asker:switch", "@owner:switch"]
    query = _sql(db, 1)
    assert "external_user_claims.user_id = 'owner'" in query
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query
    assert db.execute.call_count == 2


async def test_an_asker_who_may_answer_is_named_before_the_owner():
    """The asker is the one waiting on the card, so when the policy lets them
    answer they are named, and the owner is not looked up at all."""
    db = _found(ASKER_ACCOUNT, OWNER_ACCOUNT)
    may_answer = MayAnswer("@asker:switch", "@owner:switch")

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@asker:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=may_answer,
        )
        == "UASKER"
    )
    assert may_answer.asked == ["@asker:switch"]
    query = _sql(db, 0)
    assert "clients.matrix_user_id = '@asker:switch'" in query
    assert "external_users.bridge_id = 'bridge'" in query
    assert "client_rooms.room_id = 'room'" in query
    assert db.execute.call_count == 1


async def test_an_owner_is_named_by_the_one_linked_account_that_may_answer():
    """A person can link several accounts on one bridge, and a policy can
    admit just one of them, so every account is tried before giving up."""
    other = SimpleNamespace(
        external_user_id="UOWNER_OLD", transport_user_id="@owner-old:switch"
    )
    db = _found(None, [other, OWNER_ACCOUNT])
    may_answer = MayAnswer("@owner:switch")

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@asker:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=may_answer,
        )
        == "UOWNER"
    )
    assert may_answer.asked == ["@owner-old:switch", "@owner:switch"]
    assert db.execute.call_count == 2


async def test_an_asker_who_is_the_owner_is_not_asked_twice():
    db = _found(OWNER_ACCOUNT, [OWNER_ACCOUNT])
    may_answer = MayAnswer()

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@owner:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=may_answer,
        )
        is None
    )
    assert may_answer.asked == ["@owner:switch"]
    assert db.execute.call_count == 2


async def test_an_owner_with_no_account_here_is_not_named(caplog):
    db = _found(None, None)
    caplog.set_level(logging.INFO, logger="switch_core.sessions.presentation")

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@asker:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=MayAnswer("@owner:switch"),
        )
        is None
    )
    assert "no linked account" in caplog.text
    assert "names nobody" in caplog.text


async def test_an_asker_who_may_not_answer_is_not_named():
    db = _found(ASKER_ACCOUNT, None)
    may_answer = MayAnswer()

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id="@asker:switch",
            agent=SimpleNamespace(name="agent", owner_id="owner"),
            may_answer=may_answer,
        )
        is None
    )
    assert may_answer.asked == ["@asker:switch"]


async def test_an_ownerless_agent_with_no_known_asker_names_nobody(caplog):
    db = _found()
    caplog.set_level(logging.INFO, logger="switch_core.sessions.presentation")

    assert (
        await request_card_recipient(
            db,
            bridge_id="bridge",
            room_id="room",
            actor_id=None,
            agent=SimpleNamespace(name="agent", owner_id=None),
            may_answer=MayAnswer(),
        )
        is None
    )
    db.execute.assert_not_called()
    assert "names nobody" in caplog.text
