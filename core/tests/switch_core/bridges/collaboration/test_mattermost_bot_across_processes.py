"""An agent's Mattermost bot when switch-core runs as more than one process.

Every process runs a copy of the bridge: one holds it (posts as the bots,
listens on their sockets), the others run it quietly. An agent registered on
one process has its bot created there, and the others hear of the agent a
moment later. A room created on any of them in that moment must still put the
agent in its channel, and two processes creating the same bot must end with
one bot and no error.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest
import requests

from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.http_client import (
    refusals_expected,
)
from tests.switch_core.bridges.collaboration.test_bridge_agent_display_names import (
    _agent,
    _bridge,
    _mattermost_identity_adapter,
    _MattermostAdmin,
    _run,
)
from tests.switch_core.bridges.collaboration.test_mattermost_directory_search import (
    _client_answering,
)


class _Admin(_MattermostAdmin):
    """The identity fake, recording what is added to the team and to channels
    in order, and able to refuse a bot as another process's creation does."""

    def __init__(self, bots: list[dict[str, Any]]) -> None:
        super().__init__(bots, "full_name")
        self.added: list[tuple[str, str]] = []
        self.teams = SimpleNamespace(
            add_user_to_team=lambda team_id, body: self.added.append(
                ("team", body["user_id"])
            )
        )
        # The channels each bot is already in, by bot id.
        self.memberships: dict[str, list[dict[str, Any]]] = {}
        self.channels = SimpleNamespace(
            add_user=lambda channel_id, body: self.added.append(
                (channel_id, body["user_id"])
            ),
            get_channels_for_user=lambda user_id, team_id: self.memberships.get(
                user_id, []
            ),
        )
        # Set to have creating a bot refused as already existing, with the
        # bot listed only after this many more lookups.
        self.created_elsewhere: dict[str, Any] | None = None
        self.listed_after_lookups = 0

    def _respond(
        self, method: str, endpoint: str, options: dict[str, Any] | None
    ) -> Any:
        if method == "post" and endpoint == "/bots" and self.created_elsewhere:
            raise requests.HTTPError("An account with that username already exists.")
        if method == "get" and endpoint.startswith("/bots?") and self.created_elsewhere:
            if self.listed_after_lookups > 0:
                self.listed_after_lookups -= 1
                return []
            return [self.created_elsewhere]
        return super()._respond(method, endpoint, options)


def _adapter(
    bots: list[dict[str, Any]], *, listening: bool
) -> tuple[MattermostAdapter, _Admin]:
    adapter, _ = _mattermost_identity_adapter(
        _bridge(_agent("helper", None)), [], "full_name"
    )
    admin = _Admin(bots)
    adapter._admin_driver = admin  # type: ignore[assignment]
    adapter.set_listening(listening)
    return adapter, admin


def _identity() -> AgentIdentity:
    return AgentIdentity(
        agent_id="agent-1", name="helper", description="helps", display_name=None
    )


_CREATED_ELSEWHERE = {"user_id": "bot-elsewhere", "username": "helper"}


@pytest.mark.parametrize("listening", [True, False])
def test_an_agent_registered_elsewhere_is_put_in_a_new_channel(
    listening: bool,
) -> None:
    """The room is created here before this process heard the agent was
    registered on another: its bot is adopted, put on the team (the process
    that created it may not hold the bridge, which leaves it off) and then in
    the channel."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=listening)

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.add_agents_to_channel("channel-1", ["helper"])

    _run(_go())

    assert admin.added[-2:] == [
        ("team", "bot-elsewhere"),
        ("channel-1", "bot-elsewhere"),
    ]
    assert adapter._agent_bots["helper"]["user_id"] == "bot-elsewhere"
    tokens = admin.bodies("post", "/users/bot-elsewhere/tokens")
    assert len(tokens) == (1 if listening else 0)


def test_an_agent_with_no_bot_anywhere_is_left_out_and_said() -> None:
    adapter, admin = _adapter([], listening=True)

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.add_agents_to_channel("channel-1", ["helper"])

    _run(_go())

    assert admin.added == []
    assert admin.bodies("post", "/bots") == [], "a channel add never creates a bot"


def test_registration_and_a_channel_add_at_once_set_the_bot_up_once() -> None:
    """Both reach for the bot while the other is still setting it up: one
    token, one socket, and the channel add waits for the bot to be ready."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=True)

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await asyncio.gather(
            adapter.create_agent_identity(_identity()),
            adapter.add_agents_to_channel("channel-1", ["helper"]),
        )

    _run(_go())

    assert len(admin.bodies("post", "/users/bot-elsewhere/tokens")) == 1
    assert ("channel-1", "bot-elsewhere") in admin.added


def test_a_channel_the_bot_is_already_in_is_bridged_without_waiting_on_itself() -> None:
    """Setting the bot up bridges the channels it is already in, and bridging
    one adds the room's agents to it, this one among them: that must find the
    bot ready rather than wait for its own setup to finish."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=True)
    admin.memberships["bot-elsewhere"] = [{"id": "channel-1", "type": "O"}]

    async def joined(join: Any) -> None:
        await adapter.add_agents_to_channel(join.channel_id, [join.agent_name])

    adapter._on_agent_joined = joined

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await asyncio.wait_for(adapter.create_agent_identity(_identity()), timeout=5)

    _run(_go())

    assert ("channel-1", "bot-elsewhere") in admin.added


def test_a_bot_another_process_created_a_moment_ago_is_adopted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Mattermost refuses the username before the other process's bot is in
    its list; the bot is looked for again until it is."""
    adapter, admin = _adapter([], listening=True)
    admin.created_elsewhere = dict(_CREATED_ELSEWHERE)
    # The look before creating, then two more that miss it.
    admin.listed_after_lookups = 3

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    with caplog.at_level(logging.ERROR):
        _run(_go())

    assert adapter._agent_bots["helper"]["user_id"] == "bot-elsewhere"
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []


def test_a_bot_that_never_appears_after_a_refusal_is_an_error(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.mattermost.adapter._CREATED_BOT_LOOKUP_PAUSE_SECONDS",
        0,
    )
    adapter, admin = _adapter([], listening=True)
    admin.created_elsewhere = dict(_CREATED_ELSEWHERE)
    admin.listed_after_lookups = 1000

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    with caplog.at_level(logging.ERROR):
        _run(_go())

    assert "helper" not in adapter._agent_bots
    assert any("Failed to create Mattermost bot" in r.message for r in caplog.records)


def test_a_failed_bot_lookup_is_raised_not_read_as_no_bot() -> None:
    adapter, admin = _adapter([], listening=True)

    def refuse(method: str, endpoint: str, options: Any) -> Any:
        raise requests.HTTPError("Mattermost is down")

    admin._respond = refuse  # type: ignore[method-assign]

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    with pytest.raises(requests.HTTPError):
        _run(_go())
    assert admin.bodies("post", "/bots") == [], "a failed lookup created a bot"


def test_a_refusal_the_caller_expects_is_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client = _client_answering(400, monkeypatch)
    with caplog.at_level(logging.WARNING):
        with refusals_expected(400), pytest.raises(requests.HTTPError):
            client.make_request("post", "/bots", options={"username": "helper"})
        with pytest.raises(requests.HTTPError):
            client.make_request("post", "/bots", options={"username": "helper"})
    assert [record.levelno for record in caplog.records] == [
        logging.WARNING,
        logging.ERROR,
    ]
