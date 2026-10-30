from __future__ import annotations

from types import SimpleNamespace

from switch_core.delivery.recipient import (
    _CONNECTED_NOT_LIVE_MESSAGE,
    _UNAVAILABLE_MESSAGES,
    AgentRecipient,
    _offline_owner_message,
    _passive_message,
    _start_from_console_message,
)

"""The reply an auto_session agent gives when it is addressed and nothing is
there to bring it online (CHOO-2344).

It used to say "I don't have a session connected to this room", which names a
symptom rather than the cause: an auto_session agent is started by Switch
Console watching on its OWNER's machine, so reaching this reply means the app
is not running. Nobody else in the room can fix that.
"""


def _meta() -> SimpleNamespace:
    return SimpleNamespace(
        room_id="room-uuid",
        name="Some Room",
        bridge_id="bridge-1",
        channel_type="channel_private",
    )


def _agent(connection_model: str, metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id="agent-1",
        name="cc-bug-fixing",
        metadata_=metadata,
        integration_profile={"connection_model": connection_model},
    )


def _auto_session_claude_agent() -> SimpleNamespace:
    return _agent(
        "auto_session",
        {
            "known_agent_type": "claude-code",
            "known_agent_options": {"auto_session": True, "repo_dir": "/srv/work"},
        },
    )


def _client(owner_handle: str | None) -> SimpleNamespace:
    async def _owner_handle_in(
        _session: object, _agent: object, _bridge_id: object
    ) -> str | None:
        return owner_handle

    return SimpleNamespace(owner_handle_in=_owner_handle_in)


async def _reply(
    client: SimpleNamespace, agent: SimpleNamespace, **kwargs: object
) -> str:
    return await AgentRecipient._unavailable_reply(
        client,
        None,
        _meta(),
        agent,
        "louisa",
        **kwargs,  # type: ignore[arg-type]
    )


class TestOfflineOwnerMessage:
    def test_owner_leads_and_is_the_one_asked(self) -> None:
        msg = _offline_owner_message("ownerhandle", "louisa")
        # The owner is first, because they are the only person who can act.
        assert msg.startswith("@ownerhandle — ")
        assert "Open Switch Console" in msg
        # The asker is named as the reason, not given an instruction.
        assert "@louisa needs me" in msg

    def test_never_says_session(self) -> None:
        # Which process is attached to which room is Switch's business, not
        # something to put in front of a reader in a chat channel.
        msg = _offline_owner_message("ownerhandle", "louisa")
        assert "session" not in msg.lower()
        assert "I'm not online in this room" in msg

    def test_unmentionable_owner_still_names_who_must_act(self) -> None:
        # No claimed account on this platform → nobody to tag. The message must
        # not read as something the room at large can resolve.
        msg = _offline_owner_message(None, "louisa")
        assert not msg.startswith("@ownerhandle")
        assert "**My owner needs to open Switch Console**" in msg
        assert "@louisa needs me" in msg
        assert "session" not in msg.lower()

    def test_owner_asking_their_own_agent_is_not_named_twice(self) -> None:
        # The common case. "@louisa — … and @louisa needs me" reads as a stutter.
        msg = _offline_owner_message("louisa", "louisa")
        assert msg.count("@louisa") == 1
        assert "needs me" not in msg
        assert msg.startswith("@louisa — I'm not online in this room. ")

    def test_offers_no_terminal_command(self) -> None:
        # A CLI started by hand gets none of the Switch tools, so the reply
        # must not suggest one.
        msg = _offline_owner_message("ownerhandle", "louisa")
        assert "```" not in msg
        assert "Open Switch Console" in msg


class TestUnavailableReplyRouting:
    async def test_auto_session_gets_the_owner_message(self) -> None:
        msg = await _reply(_client("ownerhandle"), _auto_session_claude_agent())
        assert msg.startswith("@ownerhandle — ")
        assert "session" not in msg.lower()

    async def test_no_terminal_command_even_with_a_working_directory(self) -> None:
        msg = await _reply(_client("ownerhandle"), _auto_session_claude_agent())
        assert "```" not in msg
        assert "claude " not in msg

    async def test_a_live_session_elsewhere_still_wins(self) -> None:
        # Somewhere the asker can go right now beats asking the owner to start
        # something, so the "elsewhere" reply is left alone.
        msg = await _reply(
            _client("ownerhandle"),
            _auto_session_claude_agent(),
            other_room_names=["Hub"],
        )
        assert "**Hub**" in msg
        assert "you can ask me there" in msg
        assert "```" not in msg

    async def test_session_addressable_points_at_switch_console(self) -> None:
        agent = _agent(
            "session_addressable",
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {"repo_dir": "/srv/work"},
            },
        )
        msg = await _reply(_client("ownerhandle"), agent)
        assert "I don't have a session connected to this room." in msg
        assert "in Switch Console" in msg
        assert "```" not in msg

    async def test_auto_session_without_a_known_agent_still_answers(self) -> None:
        # Registered via `register-other`: no known-agent spec, but the owner
        # still has to open the app.
        msg = await _reply(_client("ownerhandle"), _agent("auto_session", {}))
        assert "Open Switch Console" in msg
        assert "```" not in msg

    async def test_a_passive_agent_is_not_told_it_has_no_session(self) -> None:
        # A passive agent is never live in real time, even while a session is
        # open and working, so "I don't have a session" would be wrong.
        agent = _agent(
            "session_passive",
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {"channels_enabled": False},
            },
        )
        for kwargs in ({}, {"other_room_names": ["Hub"]}):
            msg = await _reply(_client("ownerhandle"), agent, **kwargs)
            assert "I read room messages asynchronously" in msg
            assert "I don't have a session" not in msg
            # The owner is the only one who can trigger it, so they are
            # mentioned and notified.
            assert "@ownerhandle has to trigger me" in msg

    async def test_a_passive_agent_without_a_known_agent_names_its_owner(self) -> None:
        # Registered via `register-other`: no known-agent spec, same reply.
        msg = await _reply(_client("ownerhandle"), _agent("session_passive", {}))
        assert "I read room messages asynchronously" in msg
        assert "@ownerhandle has to trigger me" in msg

    async def test_a_session_here_that_is_not_live_points_at_switch_console(
        self,
    ) -> None:
        agent = _agent(
            "session_addressable",
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {"repo_dir": "/srv/work"},
            },
        )
        msg = await _reply(_client("ownerhandle"), agent, connected_not_live=True)
        assert "isn't reporting as live" in msg
        assert "@ownerhandle can restart it" in msg
        assert "in Switch Console" in msg
        assert "```" not in msg

    async def test_every_provider_names_the_room_and_its_own_sign_in(self) -> None:
        sign_in = {
            "claude-code": "claude auth login",
            "codex": "codex login",
            "opencode": "opencode auth login",
            "antigravity": "antigravity-acp --login",
            "cursor": "agent login",
            "kimi": "kimi login",
        }
        for agent_type, command in sign_in.items():
            agent = _agent(
                "session_addressable",
                {"known_agent_type": agent_type, "known_agent_options": {}},
            )
            msg = await _reply(_client("ownerhandle"), agent)
            assert "I don't have a session connected to this room." in msg, agent_type
            assert "connected to **Some Room**" in msg, agent_type
            assert "in Switch Console" in msg, agent_type
            assert f"`{command}`" in msg, agent_type
            assert "```" not in msg, agent_type

    async def test_an_always_on_known_agent_says_its_connector_is_down(self) -> None:
        # `connection_model` can be edited through the gateway. An always_on
        # agent is offline because its connector is, so it is not told to
        # start a session from Switch Console, whatever spec it registered
        # through.
        for agent_type in ("claude-code", "codex", "cursor"):
            agent = _agent(
                "always_on",
                {"known_agent_type": agent_type, "known_agent_options": {}},
            )
            msg = await _reply(_client("ownerhandle"), agent)
            assert msg == _UNAVAILABLE_MESSAGES["always_on"], agent_type

    async def test_an_always_on_agent_with_sessions_elsewhere_keeps_its_text(
        self,
    ) -> None:
        agent = _agent(
            "always_on",
            {"known_agent_type": "codex", "known_agent_options": {}},
        )
        msg = await _reply(_client("ownerhandle"), agent, other_room_names=["Hub"])
        assert msg == _UNAVAILABLE_MESSAGES["always_on"]

    async def test_an_agent_with_no_known_spec_gets_the_static_text(self) -> None:
        for model in ("always_on", "session_addressable"):
            msg = await _reply(_client("ownerhandle"), _agent(model, {}))
            assert msg == _UNAVAILABLE_MESSAGES[model], model

    async def test_an_agent_with_no_known_spec_bound_here_is_told_to_restart(
        self,
    ) -> None:
        msg = await _reply(
            _client("ownerhandle"),
            _agent("session_addressable", {}),
            connected_not_live=True,
        )
        assert msg == _CONNECTED_NOT_LIVE_MESSAGE

    async def test_an_unknown_connection_model_is_treated_as_passive(self) -> None:
        msg = await _reply(_client("ownerhandle"), _agent("not_a_model", {}))
        assert "I read room messages asynchronously" in msg


class TestPassiveMessage:
    def test_names_the_owner_so_they_are_notified(self) -> None:
        msg = _passive_message("ownerhandle", "louisa")
        assert "@ownerhandle has to trigger me" in msg

    def test_the_owner_asking_is_called_you(self) -> None:
        msg = _passive_message("louisa", "louisa")
        assert "you have to trigger me" in msg
        assert "@louisa" not in msg

    def test_an_unlinked_owner_is_named_without_a_mention(self) -> None:
        msg = _passive_message(None, "louisa")
        assert "my owner has to trigger me" in msg
        assert "@" not in msg


class TestStartFromConsoleMessage:
    """The reply for a Console-run agent with sessions elsewhere, or a session
    here that is not live. It always points at Switch Console and never offers
    a terminal command, since a CLI started by hand gets none of the Switch
    tools."""

    @staticmethod
    def _msg(
        owner: str | None,
        asker: str,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str:
        return _start_from_console_message(
            "worker.test",
            "Payments",
            "agent login",
            owner,
            asker,
            other_room_names,
            connected_not_live,
        )

    def test_no_session_names_the_owner_room_and_sign_in(self) -> None:
        assert self._msg("cmcd", "louisa") == (
            "I don't have a session connected to this room. "
            "@cmcd can start one connected to **Payments** by opening "
            "**worker.test** in Switch Console. If Switch Console says I'm "
            "signed out, sign me in first with `agent login` on the machine I "
            "run on."
        )

    def test_the_owner_asking_is_called_you(self) -> None:
        msg = self._msg("cmcd", "cmcd")
        assert (
            "You can start one connected to **Payments** by opening "
            "**worker.test** in Switch Console." in msg
        )
        assert "@cmcd" not in msg

    def test_an_unlinked_owner_is_named_without_a_mention(self) -> None:
        msg = self._msg(None, "louisa")
        assert "My owner can start one" in msg
        assert "@" not in msg

    def test_sessions_elsewhere_are_offered_first(self) -> None:
        msg = self._msg("cmcd", "louisa", ["Hub", "Ops", "Triage"])
        assert (
            "I'm working in **Hub**, **Ops** and **Triage**, so you can ask me there."
            in msg
        )
        assert "Or @cmcd can start one connected to **Payments**" in msg
        assert "`agent login`" in msg
        assert "```" not in msg

    def test_a_session_here_that_is_not_live_asks_for_a_restart(self) -> None:
        msg = self._msg("cmcd", "cmcd", connected_not_live=True)
        assert "isn't reporting as live" in msg
        assert "You can restart it by opening **worker.test** in Switch Console." in msg
        assert "`agent login`" in msg
