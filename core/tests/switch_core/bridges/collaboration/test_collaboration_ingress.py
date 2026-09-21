"""The one HTTP door collaboration bridges are called back on.

Almost every platform Switch bridges to is dialled out to, and nothing has to
reach Switch for it to work. A Mattermost button press is the exception: the
Mattermost server delivers it to a URL. These cover the door itself — that it
stays shut until a bridge asks for it, that a bridge is only reachable while it
is running, and that one bridge's trouble is not the port's.

What a press has to prove is the bridge's own business, decided by the handler
behind the door. The only credential here is the per-bridge key handed out with
the endpoint, so that no adapter ever holds the server secret it came from.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from typing import Any

import aiohttp
import pytest

from switch_core.bridges.collaboration.ingress import (
    CallbackIngress,
    CallbackRefused,
)

SECRET = "server-secret-for-tests"
BRIDGE = "bridge-1"
OTHER = "bridge-2"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


def _ingress(port: int) -> CallbackIngress:
    return CallbackIngress(host="127.0.0.1", port=port, secret=SECRET)


async def _post(
    port: int, bridge_id: str, body: Any, bridge_type: str = "mattermost"
) -> tuple[int, dict[str, Any]]:
    url = f"http://127.0.0.1:{port}/collaboration/{bridge_type}/{bridge_id}/callback"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=body) as response:
            return response.status, await response.json()


async def _post_raw(port: int, bridge_id: str, data: str) -> int:
    url = f"http://127.0.0.1:{port}/collaboration/mattermost/{bridge_id}/callback"
    async with aiohttp.ClientSession() as session:
        async with session.post(
            url, data=data, headers={"Content-Type": "application/json"}
        ) as response:
            return response.status


# ── Binding ──────────────────────────────────────────────────────────────────


async def test_nothing_is_listening_until_a_bridge_asks_to_be_served() -> None:
    """A deployment where no bridge is called back opens no port at all.

    The listener is constructed for every process because the lifecycle service
    owns one; what it must not do is bind on the strength of that.
    """
    port = _free_port()
    ingress = _ingress(port)

    with pytest.raises(aiohttp.ClientConnectorError):
        await _post(port, BRIDGE, {})

    await ingress.stop()


async def test_a_served_bridge_is_reached_and_its_answer_is_the_reply() -> None:
    port = _free_port()
    ingress = _ingress(port)
    seen: list[dict[str, Any]] = []

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        seen.append(body)
        return {"ephemeral_text": "Noted."}

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        status, answer = await _post(port, BRIDGE, {"user_id": "u-1"})
    finally:
        await ingress.stop()

    assert status == 200
    assert answer == {"ephemeral_text": "Noted."}
    assert seen == [{"user_id": "u-1"}]


async def test_two_bridges_share_the_one_port() -> None:
    """Two Mattermost servers — two tenants, or a test one beside a real one —
    are ordinary, and a listener each would be a port and an ingress rule
    each."""
    port = _free_port()
    ingress = _ingress(port)

    async def first(body: dict[str, Any]) -> dict[str, Any]:
        return {"who": "first"}

    async def second(body: dict[str, Any]) -> dict[str, Any]:
        return {"who": "second"}

    await ingress.serve("mattermost", BRIDGE, first)
    await ingress.serve("mattermost", OTHER, second)
    try:
        assert (await _post(port, BRIDGE, {}))[1] == {"who": "first"}
        assert (await _post(port, OTHER, {}))[1] == {"who": "second"}
    finally:
        await ingress.stop()


async def test_two_bridges_starting_together_bind_the_port_once() -> None:
    """Each bridge runs in a task of its own, so two configured for callbacks
    reach the bind together on boot. Both must come up: a bridge that failed
    because its neighbour won the race would be down for no reason it could
    report."""
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        return {"who": "either"}

    await asyncio.gather(
        ingress.serve("mattermost", BRIDGE, handle),
        ingress.serve("mattermost", OTHER, handle),
    )
    try:
        assert (await _post(port, BRIDGE, {}))[0] == 200
        assert (await _post(port, OTHER, {}))[0] == 200
    finally:
        await ingress.stop()


async def test_a_bridge_that_cannot_bind_does_not_leave_itself_registered() -> None:
    """Something else on the port is a startup failure, and it has to be a
    clean one: a handler left behind would have the door claiming to serve a
    bridge that never came up."""
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        ingress = _ingress(taken.getsockname()[1])

        async def handle(body: dict[str, Any]) -> dict[str, Any]:
            return {}

        with pytest.raises(OSError):
            await ingress.serve("mattermost", BRIDGE, handle)

        assert ingress._handlers == {}


async def test_the_port_closes_when_the_listener_stops() -> None:
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        return {}

    await ingress.serve("mattermost", BRIDGE, handle)
    await ingress.stop()

    with pytest.raises(aiohttp.ClientConnectorError):
        await _post(port, BRIDGE, {})


# ── Routing ──────────────────────────────────────────────────────────────────


async def test_a_bridge_that_is_not_running_is_answered_rather_than_refused(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A bridge is stopped while the process keeps running, and a press posted
    a minute earlier still arrives. Mattermost can report a 404; a connection
    refused is something it retries into."""
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        return {}

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        with caplog.at_level(logging.WARNING):
            status, _ = await _post(port, OTHER, {})
    finally:
        await ingress.stop()

    assert status == 404
    assert OTHER in caplog.text


async def test_a_withdrawn_bridge_stops_being_reachable_and_its_neighbour_does_not() -> (
    None
):
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        return {"who": "still here"}

    await ingress.serve("mattermost", BRIDGE, handle)
    await ingress.serve("mattermost", OTHER, handle)
    await ingress.withdraw("mattermost", BRIDGE)
    try:
        assert (await _post(port, BRIDGE, {}))[0] == 404
        assert (await _post(port, OTHER, {}))[0] == 200
    finally:
        await ingress.stop()


async def test_a_bridge_of_another_type_at_the_same_id_is_not_the_same_bridge() -> None:
    """The type is in the path, so a second platform needing callbacks is a
    sibling rather than something that has to pick unique ids."""
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        return {}

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        status, _ = await _post(port, BRIDGE, {}, bridge_type="somethingelse")
    finally:
        await ingress.stop()

    assert status == 404


# ── What comes back ──────────────────────────────────────────────────────────


async def test_a_handler_that_refuses_says_so_with_its_own_status() -> None:
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        raise CallbackRefused("Not a press this bridge will act on.", status=401)

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        status, answer = await _post(port, BRIDGE, {})
    finally:
        await ingress.stop()

    assert status == 401
    assert answer["error"]["message"] == "Not a press this bridge will act on."


async def test_a_refusal_is_not_logged_as_a_fault(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Refusing an unauthenticated caller is what an authenticated route does
    all day. A stack trace per attempt buries the one that matters."""
    port = _free_port()
    ingress = _ingress(port)

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        raise CallbackRefused("No.", status=401)

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        with caplog.at_level(logging.ERROR):
            await _post(port, BRIDGE, {})
    finally:
        await ingress.stop()

    assert caplog.text == ""


async def test_a_handler_that_breaks_is_logged_and_does_not_take_the_port_with_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The listener is shared, so one bridge's bug must not be every bridge's
    outage — and must not pass silently either."""
    port = _free_port()
    ingress = _ingress(port)
    attempts: list[int] = []

    async def broken(body: dict[str, Any]) -> dict[str, Any]:
        attempts.append(1)
        raise RuntimeError("the store is down")

    async def working(body: dict[str, Any]) -> dict[str, Any]:
        return {"who": "fine"}

    await ingress.serve("mattermost", BRIDGE, broken)
    await ingress.serve("mattermost", OTHER, working)
    try:
        with caplog.at_level(logging.ERROR):
            status, _ = await _post(port, BRIDGE, {})
        assert (await _post(port, OTHER, {}))[1] == {"who": "fine"}
        assert (await _post(port, BRIDGE, {}))[0] == 500
    finally:
        await ingress.stop()

    assert status == 500
    assert "the store is down" in caplog.text
    assert len(attempts) == 2


async def test_a_body_that_is_not_a_json_object_is_turned_away() -> None:
    port = _free_port()
    ingress = _ingress(port)
    reached: list[Any] = []

    async def handle(body: dict[str, Any]) -> dict[str, Any]:
        reached.append(body)
        return {}

    await ingress.serve("mattermost", BRIDGE, handle)
    try:
        assert await _post_raw(port, BRIDGE, "not json at all") == 400
        assert (await _post(port, BRIDGE, ["a", "list"]))[0] == 400
    finally:
        await ingress.stop()

    assert reached == []


# ── The key that comes with the endpoint ─────────────────────────────────────


def test_each_bridge_is_given_a_key_of_its_own() -> None:
    ingress = _ingress(_free_port())

    assert (
        ingress.endpoint_for("mattermost", BRIDGE).key
        != ingress.endpoint_for("mattermost", OTHER).key
    )


def test_a_bridges_key_is_its_own_platforms() -> None:
    """Two bridges could share an id across types; their keys must not."""
    ingress = _ingress(_free_port())

    assert (
        ingress.endpoint_for("mattermost", BRIDGE).key
        != ingress.endpoint_for("somethingelse", BRIDGE).key
    )


def test_a_key_is_not_the_server_secret() -> None:
    """An adapter holds its key for the life of the bridge. What it must never
    hold is the value every other derived secret comes from."""
    key = _ingress(_free_port()).endpoint_for("mattermost", BRIDGE).key

    assert key != SECRET
    assert SECRET not in key


def test_a_rotated_server_secret_gives_a_different_key() -> None:
    port = _free_port()
    before = _ingress(port).endpoint_for("mattermost", BRIDGE).key
    after = (
        CallbackIngress(host="127.0.0.1", port=port, secret="the-next-one")
        .endpoint_for("mattermost", BRIDGE)
        .key
    )

    assert before != after


def test_the_same_secret_gives_the_same_key_across_restarts() -> None:
    """The key is derived, not minted, which is the whole reason a bridge
    registered before callbacks existed can take one without being edited."""
    port = _free_port()

    assert (
        _ingress(port).endpoint_for("mattermost", BRIDGE).key
        == _ingress(port).endpoint_for("mattermost", BRIDGE).key
    )


def test_an_endpoint_knows_the_path_its_bridge_is_reached_on() -> None:
    endpoint = _ingress(_free_port()).endpoint_for("mattermost", BRIDGE)

    assert endpoint.path == f"/collaboration/mattermost/{BRIDGE}/callback"
