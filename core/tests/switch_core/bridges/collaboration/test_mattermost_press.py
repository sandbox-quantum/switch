"""A Mattermost button press arriving at Switch over HTTP.

Every other way Switch hears from Mattermost comes down the websocket the
bridge dials out on. A press does not: the Mattermost server posts it to a URL,
so the bridge has to be reachable, and anything else that can reach the port
can post the same shape. What separates the two is the signature the button
carried, checked before the press is a press at all.

What the button says is the card and the option. Who pressed it comes from the
body, which the server fills in. These cover that split, the private reply that
is the one thing a callback can say to the presser alone, and the fact that a
bridge with no address to be called back on says so rather than quietly never
working.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.ingress import (
    CallbackIngress,
    CallbackRefused,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.callback import action_context
from switch_core.bridges.collaboration.models import InboundInteraction

from .test_collaboration_ingress import _free_port
from .test_mattermost_sdk_only import _FakeDriver, _FakePosts, _FakeUsers, _posts

SECRET = "server-secret-for-tests"
BRIDGE = "bridge-1"
OTHER_BRIDGE = "bridge-2"
CALLBACK_BASE = "http://switch.example:8081"

TOKEN = "tok-1"
POSITION = 2
USER = "user-abc"
HANDLE = "alice"
POST = "post-abc"
CHANNEL = "chan-1"


def _adapter(
    *,
    callback_base_url: str | None = CALLBACK_BASE,
    ingress: CallbackIngress | None = None,
    **users: str,
) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm.example",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
            callback_base_url=callback_base_url,
        )
    )
    posts = _FakePosts()
    directory = _FakeUsers(**({USER: HANDLE} | users))
    adapter._agent_bots["worker"] = {"user_id": "bot-worker"}
    adapter._bot_drivers["worker"] = _FakeDriver(posts, directory, "worker")  # type: ignore[assignment]
    adapter._admin_driver = _FakeDriver(posts, directory, "admin")  # type: ignore[assignment]
    adapter._admin_bot_driver = _FakeDriver(posts, directory, "admin-bot")  # type: ignore[assignment]
    adapter._admin_bot_id = "bot-admin"
    adapter._main_loop = asyncio.get_event_loop()
    adapter.set_callback_endpoint(
        (ingress or _ingress()).endpoint_for("mattermost", BRIDGE)
    )
    return adapter


def _ingress() -> CallbackIngress:
    return CallbackIngress(host="127.0.0.1", port=_free_port(), secret=SECRET)


def _users(adapter: MattermostAdapter) -> _FakeUsers:
    driver: Any = adapter._admin_driver
    return driver.users


def _key(bridge_id: str = BRIDGE) -> str:
    return _ingress().endpoint_for("mattermost", bridge_id).key


def _body(context: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "user_id": USER,
        "post_id": POST,
        "channel_id": CHANNEL,
        "team_id": "team-abc",
        "context": context,
    }
    body.update(overrides)
    return body


def _signed(**overrides: Any) -> dict[str, Any]:
    return _body(action_context(_key(), TOKEN, POSITION), **overrides)


def _record(adapter: MattermostAdapter) -> list[InboundInteraction]:
    seen: list[InboundInteraction] = []

    async def handle(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(handle)
    return seen


# ── What a press turns into ──────────────────────────────────────────────────


async def test_a_signed_press_arrives_as_the_card_the_option_and_the_presser() -> None:
    adapter = _adapter()
    seen = _record(adapter)

    answer = await adapter._handle_callback(_signed())

    assert answer == {}
    assert len(seen) == 1
    assert seen[0].value == TOKEN
    assert seen[0].action_id.endswith(f":{POSITION}")
    assert seen[0].channel_id == CHANNEL
    assert seen[0].message_ref == POST


async def test_who_pressed_comes_from_the_server_not_from_the_button() -> None:
    """The context is confidential but it is still only what Switch put there.
    The presser is the one field on a callback that Mattermost asserts."""
    adapter = _adapter()
    seen = _record(adapter)

    await adapter._handle_callback(_signed())

    assert seen[0].sender_id == USER
    assert seen[0].sender_name == HANDLE


async def test_an_unsigned_press_never_reaches_the_answer_path() -> None:
    """The route is reachable by anything that can reach the port. A body of
    the right shape is not a press."""
    adapter = _adapter()
    seen = _record(adapter)

    with pytest.raises(CallbackRefused) as refused:
        await adapter._handle_callback(
            _body({"switch": {"token": TOKEN, "position": POSITION}})
        )

    assert refused.value.status == 401
    assert seen == []


async def test_a_press_signed_for_another_bridge_is_refused() -> None:
    """Two bridges can share a listener, and each is given a key of its own so
    a press minted for one is not a press for the other."""
    adapter = _adapter()
    seen = _record(adapter)

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(
            _body(action_context(_key(OTHER_BRIDGE), TOKEN, POSITION))
        )

    assert seen == []


async def test_a_bridge_that_handles_no_presses_refuses_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A signed press with nowhere to go means a card was drawn with buttons by
    a bridge that cannot answer them — worth a line, not a silent drop."""
    adapter = _adapter()

    with caplog.at_level(logging.WARNING):
        with pytest.raises(CallbackRefused):
            await adapter._handle_callback(_signed())

    assert CHANNEL in caplog.text


async def test_a_presser_the_server_cannot_name_is_refused_loudly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The id is what authority is judged against, but the handle is what a
    participant would be created under. A lookup failure must not become
    somebody's permanent name."""
    adapter = _adapter()
    seen = _record(adapter)
    _users(adapter).error = RuntimeError("the directory is down")

    with caplog.at_level(logging.ERROR):
        with pytest.raises(CallbackRefused):
            await adapter._handle_callback(_signed())

    assert seen == []
    assert "cannot resolve" in caplog.text


# ── The private reply ────────────────────────────────────────────────────────


async def test_a_refusal_comes_back_to_the_presser_and_not_to_the_channel() -> None:
    """`ephemeral_text` is shown to whoever pressed and to nobody else, which
    is the only private reply a callback gets."""
    adapter = _adapter()

    async def handle(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            CHANNEL, USER, HANDLE, "root-1", "That request is already answered."
        )

    adapter.set_interaction_handler(handle)

    answer = await adapter._handle_callback(_signed())

    assert answer == {"ephemeral_text": "That request is already answered."}
    assert _posts(adapter).created == []


async def test_a_press_that_lands_says_nothing_at_all() -> None:
    """The card's own redraw is what says the answer was taken. A second notice
    saying so is a second thing to read."""
    adapter = _adapter()
    _record(adapter)

    assert await adapter._handle_callback(_signed()) == {}
    assert _posts(adapter).created == []


async def test_a_typed_answer_is_still_refused_in_the_thread() -> None:
    """There is no press to reply to, so the notice goes where the base puts
    it: the card's own thread, where everyone reading it sees a notice
    addressed to somebody else. That is the platform's limit rather than a
    choice, and it must not be swallowed by the press path."""
    adapter = _adapter()
    said: list[tuple[str, str, str | None]] = []

    async def admin_message(
        channel_id: str, text: str, thread_root_id: str | None = None
    ) -> None:
        said.append((channel_id, text, thread_root_id))

    adapter.admin_message = admin_message  # type: ignore[method-assign]

    await adapter.tell_actor(CHANNEL, USER, HANDLE, "root-1", "Not your request.")

    assert len(said) == 1
    assert said[0][0] == CHANNEL
    assert "Not your request." in said[0][1]
    assert said[0][2] == "root-1"


# ── Being reachable at all ───────────────────────────────────────────────────


async def test_a_bridge_with_no_callback_address_takes_no_presses_and_says_why(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing fails: cards keep arriving and are answerable by typing. What
    must not happen is that they quietly never carry a button."""
    adapter = _adapter(callback_base_url=None)

    with caplog.at_level(logging.WARNING):
        await adapter._start_callbacks()

    assert adapter.callback_url is None
    assert "callback_base_url" in caplog.text


async def test_the_callback_url_is_the_operators_base_and_this_bridges_path() -> None:
    adapter = _adapter()

    assert adapter.callback_url == (
        f"{CALLBACK_BASE}/collaboration/mattermost/{BRIDGE}/callback"
    )


async def test_a_trailing_slash_on_the_base_does_not_double_up() -> None:
    adapter = _adapter(callback_base_url=f"{CALLBACK_BASE}/")

    assert adapter.callback_url == (
        f"{CALLBACK_BASE}/collaboration/mattermost/{BRIDGE}/callback"
    )


async def test_starting_says_where_presses_will_be_taken(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The one thing an operator has to get right is that the Mattermost server
    can reach this address, so the address is in the log rather than only in a
    configuration field."""
    ingress = _ingress()
    adapter = _adapter(ingress=ingress)
    _record(adapter)

    try:
        with caplog.at_level(logging.INFO):
            await adapter._start_callbacks()
    finally:
        await ingress.stop()

    url = adapter.callback_url
    assert url is not None
    assert url in caplog.text
