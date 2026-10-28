"""Renaming an agent's Mattermost bot.

The bot's username is the agent's routing handle, so a rename has to move it.
Renaming the same account keeps its channel memberships, posts and token, and
everything this adapter keys by name (its bot record, its driver, the bot id
lookup the member list and the bot's own socket read) has to follow, or the
agent keeps answering to its old name.
"""

from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    AgentIdentityConflict,
)
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from tests.switch_core.bridges.collaboration.test_bridge_agent_display_names import (
    _agent,
    _bridge,
    _mattermost_identity_adapter,
    _MattermostAdmin,
    _run,
)


def _identity(name: str, display_name: str | None = None) -> AgentIdentity:
    return AgentIdentity(
        agent_id="agent-1",
        name=name,
        description="a Switch agent",
        display_name=display_name,
    )


class _Admin(_MattermostAdmin):
    """The display-name fake, plus the user and channel lookups a rename and
    the member list reach."""

    def __init__(self, bots: list[dict[str, Any]]) -> None:
        super().__init__(bots, "full_name")
        self.users_by_name: dict[str, list[dict[str, Any]]] = {}
        self.channel_members: list[dict[str, Any]] = []
        self.users = SimpleNamespace(
            get_users_by_usernames=lambda names: [
                user for name in names for user in self.users_by_name.get(name, [])
            ]
        )
        self.channels = SimpleNamespace(
            get_channel_members=lambda channel_id: self.channel_members
        )

    def _respond(
        self, method: str, endpoint: str, options: dict[str, Any] | None
    ) -> Any:
        # Mattermost applies a bot update, so a later lookup by username sees it.
        if method == "put" and endpoint.startswith("/bots/") and options:
            bot_id = endpoint.removeprefix("/bots/")
            for bot in self._bots:
                if bot["user_id"] == bot_id:
                    bot.update(options)
        return super()._respond(method, endpoint, options)


class _RecordingBot:
    """A bot driver that hands its websocket handler to the test, so the test
    can feed it an event as Mattermost would."""

    def __init__(self) -> None:
        self.handler: Any = None
        self.ready = threading.Event()

    def login(self) -> None:
        return None

    def init_websocket(self, handler: Any) -> None:
        """As `mattermostdriver.Driver.init_websocket`: synchronous, running
        the thread's current event loop while the socket is open."""
        self.handler = handler
        self.ready.set()
        asyncio.get_event_loop().run_until_complete(asyncio.Event().wait())


def _adapter(
    bridge: CollaborationCore, bots: list[dict[str, Any]] | None = None
) -> tuple[MattermostAdapter, _Admin]:
    adapter, _ = _mattermost_identity_adapter(bridge, [], "full_name")
    admin = _Admin(bots or [])
    adapter._admin_driver = admin  # type: ignore[assignment]
    return adapter, admin


def _rename_display(bridge: CollaborationCore, name: str, label: str | None) -> None:
    """What the agent row reads as after the rename: the bridge resolves the
    label by the agent's current name."""
    bridge._agent_store._agents = {name: _agent(name, label)}  # type: ignore[attr-defined]


class TestRenameInPlace:
    def test_the_same_bot_takes_the_new_username_and_label(self) -> None:
        bridge = _bridge(_agent("notes-taker", "Notes Taker"))
        adapter, admin = _adapter(bridge)

        async def _go() -> list[str]:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.create_agent_identity(_identity("notes-taker", "Notes Taker"))
            _rename_display(bridge, "meeting-scribe", "Meeting Scribe")
            await adapter.rename_agent_identity(
                "notes-taker", _identity("meeting-scribe", "Meeting Scribe")
            )
            admin.channel_members = [{"user_id": "bot-notes-taker"}]
            return await adapter.get_channel_agent_names("channel-1")

        names = _run(_go())

        assert admin.bodies("put", "/bots/bot-notes-taker") == [
            {"username": "meeting-scribe", "display_name": "Meeting Scribe"}
        ]
        assert len(admin.bodies("post", "/bots")) == 1
        assert set(adapter._agent_bots) == {"meeting-scribe"}
        assert adapter._agent_bots["meeting-scribe"]["bot_id"] == "bot-notes-taker"
        assert adapter._agent_bots["meeting-scribe"]["username"] == "meeting-scribe"
        assert set(adapter._bot_drivers) == {"meeting-scribe"}
        assert adapter._bot_id_to_username["bot-notes-taker"] == "meeting-scribe"
        assert names == ["meeting-scribe"]

    def test_the_bots_open_socket_routes_under_the_new_name(self) -> None:
        """The socket started at creation keeps running through a rename; each
        event it reads has to be handled as the agent's current name."""
        bridge = _bridge(_agent("notes-taker", None))
        adapter, _admin = _adapter(bridge)
        bot = _RecordingBot()
        adapter._create_driver = lambda **kwargs: bot  # type: ignore[assignment,method-assign,return-value]
        handled: list[str] = []

        async def _record(event_data: str, agent_name: str) -> None:
            handled.append(agent_name)

        adapter._ws_handler = _record  # type: ignore[method-assign]

        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.create_agent_identity(_identity("notes-taker"))
            _rename_display(bridge, "meeting-scribe", None)
            await adapter.rename_agent_identity(
                "notes-taker", _identity("meeting-scribe")
            )

        _run(_go())
        assert bot.ready.wait(timeout=5), "the bot's socket never started"
        _run(bot.handler(json.dumps({"event": "posted"})))

        assert handled == ["meeting-scribe"]

    def test_an_untracked_bot_is_found_by_its_old_username(self) -> None:
        bridge = _bridge(_agent("meeting-scribe", "Meeting Scribe"))
        adapter, admin = _adapter(
            bridge,
            bots=[
                {
                    "user_id": "u-old",
                    "username": "notes-taker",
                    "display_name": "Notes Taker",
                }
            ],
        )

        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.rename_agent_identity(
                "notes-taker", _identity("meeting-scribe", "Meeting Scribe")
            )

        _run(_go())

        assert admin.bodies("put", "/bots/u-old") == [
            {"username": "meeting-scribe", "display_name": "Meeting Scribe"}
        ]
        assert admin.bodies("post", "/bots") == []
        assert adapter._bot_id_to_username["u-old"] == "meeting-scribe"
        # Adopted under the new name, so it gets its token and socket too.
        assert adapter._agent_bots["meeting-scribe"]["bot_id"] == "u-old"

    def test_with_no_bot_at_all_one_is_created_under_the_new_name(self) -> None:
        bridge = _bridge(_agent("meeting-scribe", "Meeting Scribe"))
        adapter, admin = _adapter(bridge)

        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.rename_agent_identity(
                "notes-taker", _identity("meeting-scribe", "Meeting Scribe")
            )

        _run(_go())

        assert admin.bodies("post", "/bots") == [
            {
                "username": "meeting-scribe",
                "display_name": "Meeting Scribe",
                "description": "Switch agent: a Switch agent",
            }
        ]
        assert set(adapter._agent_bots) == {"meeting-scribe"}


class TestCheckName:
    def _check(self, adapter: MattermostAdapter, name: str) -> None:
        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.check_agent_identity_name("agent-1", name)

        _run(_go())

    def test_a_person_holding_the_username_refuses_it(self) -> None:
        adapter, admin = _adapter(_bridge())
        admin.users_by_name["designers"] = [{"id": "human-1"}]

        with pytest.raises(AgentIdentityConflict, match="designers"):
            self._check(adapter, "designers")

    def test_a_free_username_passes(self) -> None:
        adapter, _admin = _adapter(_bridge())

        self._check(adapter, "meeting-scribe")

    def test_a_bot_of_ours_holding_it_passes(self) -> None:
        """Our own bots are not a platform clash: whether another agent has the
        name is Switch's own check, made against its rows."""
        adapter, admin = _adapter(_bridge())
        adapter._bot_id_to_username["bot-1"] = "meeting-scribe"
        admin.users_by_name["meeting-scribe"] = [{"id": "bot-1"}]

        self._check(adapter, "meeting-scribe")


class TestDisplayNameChange:
    def test_the_bot_shows_the_new_label(self) -> None:
        bridge = _bridge(_agent("notes-taker", "Notes Taker"))
        adapter, admin = _adapter(bridge)

        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.create_agent_identity(_identity("notes-taker", "Notes Taker"))
            _rename_display(bridge, "notes-taker", "Scribe")
            await adapter.update_agent_identity(_identity("notes-taker", "Scribe"))

        _run(_go())

        assert admin.bodies("put", "/bots/bot-notes-taker") == [
            {"display_name": "Scribe"}
        ]

    def test_an_agent_with_no_bot_is_left_alone(self) -> None:
        adapter, admin = _adapter(_bridge(_agent("notes-taker", "Scribe")))

        async def _go() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.update_agent_identity(_identity("notes-taker", "Scribe"))

        _run(_go())

        assert [r for r in admin.requests if r[0] == "put"] == []
