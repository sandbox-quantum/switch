"""The credential on a Mattermost button, and what a press has to prove.

Mattermost keeps an action's context confidential and hands it back to the
integration untouched, which is where the proof that a callback came from the
server has to live. These cover what goes in, what is accepted back, and — more
to the point — what is not: a context nobody signed, one signed with another
bridge's key, and one whose numbers were changed after signing.

Nothing here decides whether the presser may answer. That is the shared
authority path's job, against the actor Mattermost names in the body.
"""

from __future__ import annotations

import logging
from typing import Any

from switch_core.bridges.collaboration.mattermost.callback import (
    CONTEXT_KEY,
    action_context,
    callback_key,
    read_press,
)

SERVER_SECRET = "server-secret-for-tests"
BRIDGE_ID = "bridge-1"
OTHER_BRIDGE_ID = "bridge-2"
TOKEN = "tok-1"
POSITION = 2

USER_ID = "user-abc"
POST_ID = "post-abc"
CHANNEL_ID = "channel-abc"


def _key() -> str:
    return callback_key(SERVER_SECRET, BRIDGE_ID)


def _body(context: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "user_id": USER_ID,
        "post_id": POST_ID,
        "channel_id": CHANNEL_ID,
        "team_id": "team-abc",
        "context": context,
    }
    body.update(overrides)
    return body


def test_a_signed_press_reads_back_as_what_it_was_built_from() -> None:
    press = read_press(_key(), _body(action_context(_key(), TOKEN, POSITION)))

    assert press is not None
    assert press.token == TOKEN
    assert press.position == POSITION
    assert press.user_id == USER_ID
    assert press.post_id == POST_ID
    assert press.channel_id == CHANNEL_ID


def test_the_context_carries_a_signature_and_not_the_key() -> None:
    key = _key()
    context = action_context(key, TOKEN, POSITION)

    carried = context[CONTEXT_KEY]
    assert set(carried) == {"token", "position", "signature"}
    assert key not in repr(context)
    assert SERVER_SECRET not in repr(context)


def test_the_signature_is_the_same_every_time_it_is_built() -> None:
    first = action_context(_key(), TOKEN, POSITION)
    second = action_context(_key(), TOKEN, POSITION)

    assert first == second


def test_a_body_with_no_context_is_not_ours() -> None:
    assert read_press(_key(), {"user_id": USER_ID, "post_id": POST_ID}) is None


def test_a_context_from_another_integration_is_passed_over() -> None:
    assert read_press(_key(), _body({"action": "something-else"})) is None


def test_a_context_that_is_not_an_object_is_not_ours() -> None:
    assert read_press(_key(), _body({CONTEXT_KEY: "answer"})) is None


def test_an_unsigned_context_is_refused() -> None:
    context = {CONTEXT_KEY: {"token": TOKEN, "position": POSITION}}

    assert read_press(_key(), _body(context)) is None


def test_a_position_changed_after_signing_is_refused_and_logged(
    caplog: Any,
) -> None:
    context = action_context(_key(), TOKEN, POSITION)
    context[CONTEXT_KEY]["position"] = POSITION + 1

    with caplog.at_level(logging.WARNING):
        assert read_press(_key(), _body(context)) is None

    assert "signature does not verify" in caplog.text


def test_a_token_changed_after_signing_is_refused() -> None:
    context = action_context(_key(), TOKEN, POSITION)
    context[CONTEXT_KEY]["token"] = "tok-2"

    assert read_press(_key(), _body(context)) is None


def test_another_bridges_signature_is_refused() -> None:
    other = callback_key(SERVER_SECRET, OTHER_BRIDGE_ID)
    context = action_context(other, TOKEN, POSITION)

    assert read_press(_key(), _body(context)) is None


def test_a_signature_from_a_rotated_secret_says_so(caplog: Any) -> None:
    stale = callback_key("the-previous-server-secret", BRIDGE_ID)
    context = action_context(stale, TOKEN, POSITION)

    with caplog.at_level(logging.WARNING):
        assert read_press(_key(), _body(context)) is None

    assert "rotated" in caplog.text
    assert TOKEN in caplog.text


def test_each_bridge_signs_with_a_key_of_its_own() -> None:
    assert callback_key(SERVER_SECRET, BRIDGE_ID) != callback_key(
        SERVER_SECRET, OTHER_BRIDGE_ID
    )


def test_the_key_is_not_the_server_secret() -> None:
    key = _key()

    assert SERVER_SECRET not in key
    assert key != SERVER_SECRET


def test_a_press_naming_nobody_is_refused() -> None:
    context = action_context(_key(), TOKEN, POSITION)

    assert read_press(_key(), _body(context, user_id="")) is None
    assert read_press(_key(), _body(context, post_id="")) is None
    assert read_press(_key(), _body(context, channel_id="")) is None


def test_an_actor_smuggled_into_the_context_is_refused() -> None:
    """The context says which card and which option. It never says who.

    The actor is read from the body, which Mattermost fills in, so a `user_id`
    here would be ignored on its own merits. It is refused outright instead,
    because the signature does not cover it: a field beside the signed ones is
    a field something added later could read and trust by mistake.
    """
    context = action_context(_key(), TOKEN, POSITION)
    context[CONTEXT_KEY]["user_id"] = "somebody-else"

    assert read_press(_key(), _body(context)) is None


def test_a_position_that_is_not_a_counting_number_is_refused() -> None:
    for position in (0, -1, True, "2", 2.0, None):
        context = {
            CONTEXT_KEY: {
                "token": TOKEN,
                "position": position,
                "signature": "whatever",
            }
        }
        assert read_press(_key(), _body(context)) is None


def test_a_token_that_is_not_a_string_is_refused() -> None:
    for token in (None, 7, ["tok-1"]):
        context = {
            CONTEXT_KEY: {
                "token": token,
                "position": POSITION,
                "signature": "whatever",
            }
        }
        assert read_press(_key(), _body(context)) is None
