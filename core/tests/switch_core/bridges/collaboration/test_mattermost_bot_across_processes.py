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
import time
from types import SimpleNamespace
from typing import Any

import pytest
import requests
from mattermostdriver.exceptions import (
    InvalidOrMissingParameters,
    NotEnoughPermissions,
)

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
        self.refuse_team = False
        self.teams = SimpleNamespace(add_user_to_team=self._add_to_team)
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
        # Set to fail creating a bot, or every listing of bots, with this.
        self.create_fails: Exception | None = None
        self.lookups_fail: Exception | None = None
        # How long a rename's update takes to answer once Mattermost applied it.
        self.rename_answer_seconds = 0.0

    def _add_to_team(self, team_id: str, body: dict[str, Any]) -> None:
        if self.refuse_team:
            raise NotEnoughPermissions("You do not have the appropriate permissions.")
        self.added.append(("team", body["user_id"]))

    def _respond(
        self, method: str, endpoint: str, options: dict[str, Any] | None
    ) -> Any:
        if method == "get" and endpoint.startswith("/bots?") and self.lookups_fail:
            raise self.lookups_fail
        if method == "post" and endpoint == "/bots" and self.create_fails:
            raise self.create_fails
        if method == "post" and endpoint == "/bots" and self.created_elsewhere:
            raise InvalidOrMissingParameters(
                "An account with that username already exists."
            )
        if method == "get" and endpoint.startswith("/bots?") and self.created_elsewhere:
            if self.listed_after_lookups > 0:
                self.listed_after_lookups -= 1
                return []
            return [self.created_elsewhere]
        if method == "get" and endpoint.startswith("/bots?"):
            # A lookup issued while a rename is being answered sees it applied.
            time.sleep(self.rename_answer_seconds / 4)
        if method == "post" and endpoint.endswith("/enable"):
            return {}
        if method == "put" and endpoint.startswith("/bots/") and options:
            for bot in self._bots:
                if bot["user_id"] == endpoint.removeprefix("/bots/"):
                    bot.update(options)
            if "username" in options:
                time.sleep(self.rename_answer_seconds)
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
    admin.lookups_fail = requests.HTTPError("Mattermost is down")

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


def _known(adapter: MattermostAdapter, name: str) -> None:
    adapter._agent_bots[name] = {
        "bot_id": f"bot-{name}",
        "user_id": f"bot-{name}",
        "username": name,
    }


def test_one_agent_whose_bot_cannot_be_looked_up_leaves_the_others_added(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, admin = _adapter([], listening=True)
    _known(adapter, "b")
    _known(adapter, "c")
    admin.lookups_fail = requests.HTTPError("Mattermost is down")

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.add_agents_to_channel("channel-1", ["a", "b", "c"])

    with caplog.at_level(logging.ERROR):
        _run(_go())

    assert [entry for entry in admin.added if entry[0] == "channel-1"] == [
        ("channel-1", "bot-b"),
        ("channel-1", "bot-c"),
    ]
    assert any("Mattermost bot of agent 'a'" in r.message for r in caplog.records)


def test_a_refused_team_add_still_tries_the_channel() -> None:
    """The bot may be on the team already, and the bridge's account may not
    be allowed to invite to it."""
    adapter, admin = _adapter([], listening=True)
    _known(adapter, "b")
    admin.refuse_team = True

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.add_agents_to_channel("channel-1", ["b"])

    _run(_go())

    assert admin.added == [("channel-1", "bot-b")]


def test_a_creation_failure_other_than_a_refusal_is_raised_at_once() -> None:
    adapter, admin = _adapter([], listening=True)
    admin.create_fails = NotEnoughPermissions("no permission to create bots")

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    with pytest.raises(NotEnoughPermissions):
        _run(_go())
    lookups = [r for r in admin.requests if r[1].startswith("/bots?")]
    assert len(lookups) == 1, "only the look before creating"


def test_a_failed_lookup_after_a_refusal_says_both() -> None:
    adapter, admin = _adapter([], listening=True)
    admin.created_elsewhere = dict(_CREATED_ELSEWHERE)
    # The look before creating finds nothing; every one after it fails.
    admin.listed_after_lookups = 1
    original = admin._respond

    def respond(method: str, endpoint: str, options: Any) -> Any:
        if endpoint.startswith("/bots?") and admin.listed_after_lookups == 0:
            raise requests.HTTPError("Mattermost is down")
        return original(method, endpoint, options)

    admin._respond = respond  # type: ignore[method-assign]

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    with pytest.raises(RuntimeError, match="already exists.*Mattermost is down"):
        _run(_go())


def test_the_admin_bot_lookup_failing_at_start_is_said_and_not_fatal(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, admin = _adapter([], listening=True)
    admin.lookups_fail = requests.HTTPError("Mattermost is down")

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter._ensure_admin_bot()

    with caplog.at_level(logging.ERROR):
        _run(_go())

    assert adapter._admin_bot_id is None
    assert any("Switch Admin bot" in r.message for r in caplog.records)


def test_a_channel_add_does_not_revive_a_deactivated_bot() -> None:
    """An agent deleted with its bot deactivated, still named by a stale room
    membership, stays gone. Registering it again revives the bot."""
    deactivated = {**_CREATED_ELSEWHERE, "delete_at": 1}
    adapter, admin = _adapter([deactivated], listening=True)

    async def _channel() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.add_agents_to_channel("channel-1", ["helper"])

    _run(_channel())

    assert admin.added == []
    assert admin.bodies("post", "/bots/bot-elsewhere/enable") == []

    async def _register() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())

    _run(_register())

    assert len(admin.bodies("post", "/bots/bot-elsewhere/enable")) == 1


def test_a_channel_add_during_a_rename_does_not_set_the_bot_up_twice() -> None:
    """The rename has moved the bot to its new username on Mattermost but not
    yet in this process; a channel add for the new name must wait for it
    rather than adopt the bot a second time, with a second token and socket
    delivering every event twice."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=True)
    admin.rename_answer_seconds = 0.2
    renamed = AgentIdentity(
        agent_id="agent-1", name="helper2", description="helps", display_name=None
    )

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.create_agent_identity(_identity())
        rename = asyncio.create_task(adapter.rename_agent_identity("helper", renamed))
        await asyncio.sleep(0.05)
        await adapter.add_agents_to_channel("channel-1", ["helper2"])
        await rename

    _run(_go())

    assert len(admin.bodies("post", "/users/bot-elsewhere/tokens")) == 1
    assert set(adapter._agent_bots) == {"helper2"}
    assert ("channel-1", "bot-elsewhere") in admin.added


@pytest.mark.parametrize("known", [True, False])
def test_a_quiet_copy_follows_a_rename_without_creating_a_bot(known: bool) -> None:
    """The holder renames the bot in place, perhaps after this copy hears of
    the rename: the copy moves its record to the new name, and never makes a
    second account under it."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=False)
    renamed = AgentIdentity(
        agent_id="agent-1", name="helper2", description="helps", display_name=None
    )

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        if known:
            await adapter.create_agent_identity(_identity())
        await adapter.rename_agent_identity("helper", renamed)

    _run(_go())

    assert admin.bodies("post", "/bots") == []
    assert adapter._agent_bots["helper2"]["user_id"] == "bot-elsewhere"
    assert "helper" not in adapter._agent_bots
    assert adapter._bot_id_to_username["bot-elsewhere"] == "helper2"


def test_a_message_relayed_before_the_bot_is_set_up_here_posts_as_the_bot(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A process that takes the bridge over sets its agents' bots up in the
    background while its workspace consumer already relays, so the first
    message it relays can be for an agent whose bot it has not set up yet.
    The bot is set up then, and the message posted as the agent rather than
    as the admin account."""
    adapter, admin = _adapter([dict(_CREATED_ELSEWHERE)], listening=True)
    posted_with: list[Any] = []

    async def create_posts(
        driver: Any, channel_id: str, content: str, thread_root_id: str | None
    ) -> str:
        posted_with.append(driver)
        return "post-1"

    adapter._create_posts = create_posts  # type: ignore[method-assign]

    async def _go() -> str | None:
        adapter._main_loop = asyncio.get_running_loop()
        return await adapter.send_message("channel-1", "helper", "hello")

    with caplog.at_level(logging.ERROR):
        assert _run(_go()) == "post-1"

    assert posted_with == [adapter._bot_drivers["helper"]]
    assert posted_with[0] is not admin
    assert adapter._agent_bots["helper"]["user_id"] == "bot-elsewhere"
    assert "No Mattermost driver" not in caplog.text


def _posting_with(adapter: MattermostAdapter) -> list[Any]:
    posted_with: list[Any] = []

    async def create_posts(
        driver: Any, channel_id: str, content: str, thread_root_id: str | None
    ) -> str:
        posted_with.append(driver)
        return f"post-{len(posted_with)}"

    adapter._create_posts = create_posts  # type: ignore[method-assign]
    return posted_with


def test_a_failed_bot_lookup_on_a_send_posts_as_the_admin_account(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Mattermost fails the bot listing right after a hand-over: the message
    is still posted, as the admin account, and both failures are said."""
    adapter, admin = _adapter([], listening=True)
    admin.lookups_fail = requests.HTTPError("Mattermost is down")
    posted_with = _posting_with(adapter)

    async def _go() -> str | None:
        adapter._main_loop = asyncio.get_running_loop()
        return await adapter.send_message("channel-1", "helper", "hello")

    with caplog.at_level(logging.WARNING):
        assert _run(_go()) == "post-1"

    assert posted_with == [admin]
    assert "Could not set up the Mattermost bot of agent 'helper'" in caplog.text
    assert "No Mattermost driver found for sender 'helper'" in caplog.text


def test_an_agent_with_no_bot_is_not_looked_up_on_every_send() -> None:
    adapter, admin = _adapter([], listening=True)
    posted_with = _posting_with(adapter)

    def lookups() -> int:
        return sum(
            1
            for method, endpoint, _ in admin.requests
            if method == "get" and endpoint.startswith("/bots?")
        )

    async def _go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.send_message("channel-1", "helper", "one")
        looked = lookups()
        assert looked > 0
        await adapter.send_message("channel-1", "helper", "two")
        assert lookups() == looked

    _run(_go())
    assert posted_with == [admin, admin]
