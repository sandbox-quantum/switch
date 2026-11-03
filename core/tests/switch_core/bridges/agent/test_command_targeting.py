from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import switch_core.bridges.agent.commands as commands


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


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

    def test_bold_second_token_still_parsed(self) -> None:
        assert commands._mention_tokens("@*alice* @*manager*") == ["alice", "manager"]
