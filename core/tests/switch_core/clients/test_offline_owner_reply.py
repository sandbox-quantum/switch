from __future__ import annotations

from types import SimpleNamespace

from switch_core.clients.agent_client import AgentClient, _offline_owner_message

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
    return await AgentClient._unavailable_reply(
        client,
        None,
        _meta(),
        agent,
        "louisa",
        **kwargs,  # type: ignore[arg-type]
    )


class TestOfflineOwnerMessage:
    def test_owner_leads_and_is_the_one_asked(self) -> None:
        msg = _offline_owner_message("ownerhandle", "louisa", "cd /x && claude …")
        # The owner is first, because they are the only person who can act.
        assert msg.startswith("@ownerhandle — ")
        assert "Open Switch Console" in msg
        # The asker is named as the reason, not given an instruction.
        assert "@louisa needs me" in msg

    def test_never_says_session(self) -> None:
        # Which process is attached to which room is Switch's business, not
        # something to put in front of a reader in a chat channel.
        msg = _offline_owner_message("ownerhandle", "louisa", "cd /x && claude …")
        assert "session" not in msg.lower()
        assert "I'm not online in this room" in msg

    def test_unmentionable_owner_still_names_who_must_act(self) -> None:
        # No claimed account on this platform → nobody to tag. The message must
        # not read as something the room at large can resolve.
        msg = _offline_owner_message(None, "louisa", "cd /x && claude …")
        assert not msg.startswith("@ownerhandle")
        assert "**My owner needs to open Switch Console**" in msg
        assert "@louisa needs me" in msg
        assert "session" not in msg.lower()

    def test_command_is_offered_as_the_alternative(self) -> None:
        msg = _offline_owner_message("ownerhandle", "louisa", "cd /x && claude go")
        assert "```\ncd /x && claude go\n```" in msg

    def test_owner_asking_their_own_agent_is_not_named_twice(self) -> None:
        # The common case. "@louisa — … and @louisa needs me" reads as a stutter.
        msg = _offline_owner_message("louisa", "louisa", "cd /x && claude …")
        assert msg.count("@louisa") == 1
        assert "needs me" not in msg
        assert msg.startswith("@louisa — I'm not online in this room. ")

    def test_no_command_leaves_no_empty_code_block(self) -> None:
        msg = _offline_owner_message("ownerhandle", "louisa", None)
        assert "```" not in msg
        assert "Open Switch Console" in msg


class TestUnavailableReplyRouting:
    async def test_auto_session_gets_the_owner_message(self) -> None:
        msg = await _reply(_client("ownerhandle"), _auto_session_claude_agent())
        assert msg.startswith("@ownerhandle — ")
        assert "session" not in msg.lower()

    async def test_the_command_names_the_agent(self) -> None:
        # A directory can hold several provisioned agents, in which case the
        # started session is asked which one it is.
        msg = await _reply(_client("ownerhandle"), _auto_session_claude_agent())
        assert "you are cc-bug-fixing" in msg
        assert "cd /srv/work && claude " in msg

    async def test_a_live_session_elsewhere_still_wins(self) -> None:
        # Somewhere the asker can go right now beats asking the owner to start
        # something, so the "elsewhere" reply is left alone.
        msg = await _reply(
            _client("ownerhandle"),
            _auto_session_claude_agent(),
            other_room_names=["Hub"],
        )
        assert "**Hub**" in msg
        assert "Open Switch Console" not in msg

    async def test_session_addressable_is_untouched(self) -> None:
        agent = _agent(
            "session_addressable",
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {"repo_dir": "/srv/work"},
            },
        )
        msg = await _reply(_client("ownerhandle"), agent)
        assert "I don't have a session connected to this room." in msg
        assert "Open Switch Console" not in msg

    async def test_auto_session_without_a_known_agent_still_answers(self) -> None:
        # Registered via `register-other`: no connect command exists, but the
        # owner still has to open the app.
        msg = await _reply(_client("ownerhandle"), _agent("auto_session", {}))
        assert "Open Switch Console" in msg
        assert "```" not in msg
