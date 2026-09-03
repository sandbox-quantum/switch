from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

import switch_core.bridges.agent.commands as commands
from switch_core.bridges.agent.commands import (
    _addressed_by_first_mention,
    _cmd_run_cmd,
    _role_arg,
)
from switch_core.events import CommandEvent


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


class TestRoleArg:
    """The role to name in the output is the SECOND @token; the first targets
    the agent (see _addressed_by_first_mention)."""

    def test_no_args_returns_none(self) -> None:
        assert _role_arg("") is None

    def test_only_one_token_returns_none(self) -> None:
        # A single token is the target (agent name or role), not a role-to-name.
        assert _role_arg("@cc-bug-fixing") is None
        assert _role_arg("@manager") is None

    def test_second_token_is_the_role(self) -> None:
        assert _role_arg("@cc-bug-fixing @manager") == "manager"
        assert _role_arg("@CC-Bug-Fixing @worker") == "worker"


def _addr_client(name: str, held_role: str | None = None) -> SimpleNamespace:
    """Fake client exposing the two predicates the targeting helpers call."""

    def _tag(token: str, text: str) -> bool:
        return (
            re.search(re.escape(f"@{token}") + r"(?![A-Za-z0-9._-])", text) is not None
        )

    def _args_tag_my_name(text: str) -> bool:
        return _tag(name, text)

    async def _text_tags_my_role(_session: Any, text: str, _room_id: str) -> bool:
        return held_role is not None and _tag(held_role, text)

    async def _text_tags_my_alias(_session: Any, _text: str, _room_id: str) -> bool:
        return False

    return SimpleNamespace(
        agent=SimpleNamespace(name=name),
        session_factory=_session_factory,
        _args_tag_my_name=_args_tag_my_name,
        _text_tags_my_role=_text_tags_my_role,
        _text_tags_my_alias=_text_tags_my_alias,
    )


class TestRunCmdTargeting:
    """`_addressed_by_first_mention`: only the first @token addresses an agent;
    the second (the role to name in the output) does NOT pull in role holders."""

    async def test_first_token_name_addresses(self) -> None:
        client = _addr_client("alice")
        assert await _addressed_by_first_mention(client, "@alice @manager", "r") is True

    async def test_second_token_role_does_not_address(self) -> None:
        # bob holds manager, but manager is only the SECOND token → not addressed.
        client = _addr_client("bob", held_role="manager")
        assert (
            await _addressed_by_first_mention(client, "@alice @manager", "r") is False
        )

    async def test_first_token_role_addresses_holder(self) -> None:
        # `!run-cmd @manager` → the manager holder is addressed.
        client = _addr_client("bob", held_role="manager")
        assert await _addressed_by_first_mention(client, "@manager", "r") is True

    async def test_no_tokens_addresses_everyone(self) -> None:
        client = _addr_client("alice")
        assert await _addressed_by_first_mention(client, "", "r") is True

    async def test_other_agent_first_token_not_addressed(self) -> None:
        client = _addr_client("alice")
        assert await _addressed_by_first_mention(client, "@bob", "r") is False

    async def test_bold_mention_addresses_named_agent_only(self) -> None:
        # A bolded mention arrives as "@*alice*" (Slack mrkdwn). Emphasis markers
        # must be stripped so it still targets exactly alice — not everyone.
        assert (
            await _addressed_by_first_mention(_addr_client("alice"), "@*alice*", "r")
            is True
        )
        assert (
            await _addressed_by_first_mention(_addr_client("bob"), "@*alice*", "r")
            is False
        )


class TestResetTargeting:
    """`!reset` requires an explicit target so a bare `!reset` never resets the
    whole room; `!reset-all-agents` is the explicit fan-out to everyone."""

    async def test_bare_reset_addresses_no_one(self) -> None:
        client = _addr_client("alice")
        assert (
            await commands._addressed_by_required_first_mention(client, "", "r")
            is False
        )

    async def test_reset_first_token_addresses_named_agent(self) -> None:
        assert (
            await commands._addressed_by_required_first_mention(
                _addr_client("alice"), "@alice", "r"
            )
            is True
        )
        assert (
            await commands._addressed_by_required_first_mention(
                _addr_client("bob"), "@alice", "r"
            )
            is False
        )

    async def test_reset_first_token_role_addresses_holder(self) -> None:
        client = _addr_client("bob", held_role="manager")
        assert (
            await commands._addressed_by_required_first_mention(client, "@manager", "r")
            is True
        )

    async def test_reset_all_addresses_everyone(self) -> None:
        # No args and irrelevant args alike always fan out to every agent.
        client = _addr_client("alice")
        assert await commands._addressed_everyone(client, "", "r") is True
        assert await commands._addressed_everyone(client, "@bob", "r") is True

    def test_control_command_pairs_are_registered(self) -> None:
        # Each control command has a target-required variant and an explicit
        # "-all-agents" fan-out variant.
        for one, allv in (
            ("reset", "reset-all-agents"),
            ("compact", "compact-all-agents"),
            ("interrupt", "interrupt-all-agents"),
        ):
            assert one in commands.COMMANDS_BY_NAME
            assert allv in commands.COMMANDS_BY_NAME
            assert (
                commands.COMMANDS_BY_NAME[one].addressed
                is commands._addressed_by_required_first_mention
            )
            assert (
                commands.COMMANDS_BY_NAME[allv].addressed
                is commands._addressed_everyone
            )


class TestStripEmphasis:
    def test_strips_bold_around_mention(self) -> None:
        assert commands._mention_tokens("@*claude-code.test-cc.jdoe*") == [
            "claude-code.test-cc.jdoe"
        ]
        assert commands._mention_tokens("@**alice**") == ["alice"]

    def test_keeps_underscore_in_names(self) -> None:
        # "_" is a valid name char and must survive stripping.
        assert commands._mention_tokens("@cc_bug_fixing") == ["cc_bug_fixing"]

    def test_bold_second_token_role_still_parsed(self) -> None:
        assert _role_arg("@*alice* @*manager*") == "manager"


def _event(args: str) -> CommandEvent:
    return CommandEvent(
        type="command",
        room_id="!m:switch.local",
        command="run-cmd",
        args=args,
        user_id="u1",
        user_name="louisa",
    )


def _fake_client(*, role_exists: bool) -> SimpleNamespace:
    sent: list[str] = []

    async def _resolve_room_meta(_matrix_room_id: str):  # type: ignore[no-untyped-def]
        return SimpleNamespace(room_id="room-1", name="Feature Room", bridge_id=None)

    async def _agent_get(_session, _agent_id):  # type: ignore[no-untyped-def]
        return None  # fall back to client.agent

    async def _get_role(_session, _room_id, name):  # type: ignore[no-untyped-def]
        return SimpleNamespace(name=name) if role_exists else None

    async def _send_message(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        sent.append(body)

    async def _owner_handle_in(_session, _agent, _bridge_id):  # type: ignore[no-untyped-def]
        # No linked owner: these cover the connect command, not the mention.
        return None

    client = SimpleNamespace(
        agent=SimpleNamespace(id="a1", name="cc-bug-fixing"),
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        _agent_store=SimpleNamespace(get=_agent_get),
        _room_role_store=SimpleNamespace(get_role=_get_role),
        send_message=_send_message,
        reply_command=_send_message,
        owner_handle_in=_owner_handle_in,
        sent=sent,
    )
    return client


def _patch_known_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Spec:
        @staticmethod
        def start_session_instructions(
            _options: Any,
            _agent: Any,
            room_name: str,
            _owner_handle: str | None,
            assume_role: str | None = None,
        ) -> str:
            prompt = f"connect to switch room {room_name}"
            if assume_role:
                prompt += f" and assume the role {assume_role}"
            return f'claude "{prompt}"'

    def _known_agent_for(_agent: Any) -> tuple[Any, Any]:
        return (_Spec, object())

    monkeypatch.setattr(commands, "known_agent_for", _known_agent_for)


class TestRunCmdRolePrompt:
    async def test_role_folded_into_prompt_when_it_exists(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_known_agent(monkeypatch)
        client = _fake_client(role_exists=True)
        await _cmd_run_cmd(
            client,
            SimpleNamespace(room_id="!m"),
            _event("@cc-bug-fixing @manager"),
            False,
        )

        assert len(client.sent) == 1
        msg = client.sent[0]
        # The role is part of the claude prompt itself, not a trailing note.
        assert (
            'claude "connect to switch room Feature Room and assume the role manager"'
            in msg
        )
        assert "⚠️" not in msg

    async def test_warns_and_omits_when_role_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_known_agent(monkeypatch)
        client = _fake_client(role_exists=False)
        await _cmd_run_cmd(
            client,
            SimpleNamespace(room_id="!m"),
            _event("@cc-bug-fixing @ghost"),
            False,
        )

        msg = client.sent[0]
        # Unknown role is left out of the prompt and flagged.
        assert "assume the role" not in msg
        assert "no role named **ghost**" in msg

    async def test_no_role_arg_plain_prompt(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_known_agent(monkeypatch)
        client = _fake_client(role_exists=True)
        await _cmd_run_cmd(
            client, SimpleNamespace(room_id="!m"), _event("@cc-bug-fixing"), False
        )

        assert client.sent == ['claude "connect to switch room Feature Room"']
