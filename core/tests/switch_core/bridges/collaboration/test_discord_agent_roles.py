"""The mentionable Discord role that makes an agent's name autocomplete.

An agent is not a Discord member — one bot serves all of them — so nothing
Discord knows about carries an agent's name, and `@` in the composer never
offers one. A role is the one handle a bot can mint that does appear there. It
is left empty and permissionless: it exists to be completable, and mentioning
it notifies nobody.

The awkward part is that a Discord role carries no metadata, so there is
nowhere to record that a role is ours. These pin down what follows from that.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)

GUILD_ID = 900


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeResponse:
    status = 403
    reason = "Forbidden"


class _FakeRole:
    def __init__(
        self,
        role_id: int,
        name: str,
        *,
        members: list[object] | None = None,
        guild: _FakeGuild | None = None,
    ) -> None:
        self.id = role_id
        self.name = name
        self.members = members or []
        self._guild = guild

    async def delete(self, *, reason: str | None = None) -> None:
        assert self._guild is not None
        if self._guild.delete_error is not None:
            raise self._guild.delete_error
        self._guild.roles.remove(self)
        self._guild.deleted.append(self.id)


class _FakeGuild:
    def __init__(self, roles: list[_FakeRole] | None = None) -> None:
        self.id = GUILD_ID
        self.roles = roles or []
        for role in self.roles:
            role._guild = self
        self.created: list[dict[str, Any]] = []
        self.deleted: list[int] = []
        self.create_error: Exception | None = None
        self.delete_error: Exception | None = None
        self._next_id = 1000

    def get_role(self, role_id: int) -> _FakeRole | None:
        return next((r for r in self.roles if r.id == role_id), None)

    async def create_role(self, **kwargs: Any) -> _FakeRole:
        if self.create_error is not None:
            raise self.create_error
        self.created.append(kwargs)
        self._next_id += 1
        role = _FakeRole(self._next_id, kwargs["name"], guild=self)
        self.roles.append(role)
        return role


class _FakeClient:
    def __init__(self, guild: _FakeGuild) -> None:
        self._guild = guild
        self.user = object()

    def get_guild(self, guild_id: int) -> _FakeGuild | None:
        return self._guild if guild_id == self._guild.id else None


def _adapter(guild: _FakeGuild, *, agent_roles: bool = True) -> DiscordAdapter:
    made = DiscordAdapter(
        config=DiscordConnectionConfig(
            bot_token="token", guild_id=str(GUILD_ID), agent_roles=agent_roles
        )
    )
    made._client = _FakeClient(guild)  # type: ignore[assignment]
    return made


def _http(code: int) -> discord.HTTPException:
    error = discord.HTTPException(_FakeResponse(), "no")
    error.code = code
    return error


# ── Provisioning ─────────────────────────────────────────────────────────────


def test_an_agent_gets_a_mentionable_role_of_its_own() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert len(guild.created) == 1
    made = guild.created[0]
    assert made["name"] == "flint-tracker"
    assert made["mentionable"] is True


def test_the_role_carries_no_permissions_and_is_not_hoisted() -> None:
    # It exists to be completable. Anything else it granted would be a
    # privilege nobody asked for, attached to a name people will mention.
    guild = _FakeGuild()
    adapter = _adapter(guild)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    made = guild.created[0]
    assert made["permissions"] == discord.Permissions.none()
    assert made["hoist"] is False


def test_provisioning_the_same_agent_twice_makes_one_role() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))
    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert len(guild.created) == 1


def test_nothing_is_created_when_the_setting_is_off() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild, agent_roles=False)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert guild.created == []


# ── Roles made by hand ───────────────────────────────────────────────────────


def test_a_role_already_named_for_the_agent_is_adopted() -> None:
    """Where the bot may not manage roles, making one by hand is the only way
    to use this — so a role whose name is exactly an agent's is taken to be
    that agent's rather than duplicated."""
    guild = _FakeGuild([_FakeRole(7, "flint-tracker")])
    adapter = _adapter(guild)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert guild.created == []
    assert adapter._agent_role_ids["flint-tracker"] == 7


def test_a_similarly_named_role_is_not_captured() -> None:
    # The match has to be exact: a server's own role must never be taken over
    # by an agent that happens to be named nearby.
    guild = _FakeGuild([_FakeRole(7, "Flint Trackers")])
    adapter = _adapter(guild)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert len(guild.created) == 1


# ── Retiring an agent ────────────────────────────────────────────────────────


def test_the_role_goes_when_the_agent_does() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild)
    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    _run(adapter.remove_agent_identity("flint-tracker"))

    assert guild.deleted == [1001]


def test_a_role_people_are_wearing_is_left_alone(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A role carries no metadata, so an agent's is recognised by name alone.

    That is fine for mentioning — the worst case is a stale pill — but deleting
    on a name match could take out somebody's real role. An agent's own role
    never has members, so one that does is not ours.
    """
    guild = _FakeGuild([_FakeRole(7, "flint-tracker", members=[object()])])
    adapter = _adapter(guild)

    with caplog.at_level(logging.WARNING):
        _run(adapter.remove_agent_identity("flint-tracker"))

    assert guild.deleted == []
    assert "not ours to delete" in caplog.text


def test_removing_an_agent_that_never_had_a_role_is_quiet() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild)

    _run(adapter.remove_agent_identity("flint-tracker"))

    assert guild.deleted == []


# ── A server that cannot host them ───────────────────────────────────────────


def test_a_missing_manage_roles_permission_is_named_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    guild = _FakeGuild()
    guild.create_error = discord.Forbidden(_FakeResponse(), "missing perms")
    adapter = _adapter(guild)

    with caplog.at_level(logging.WARNING):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))
        _run(adapter.create_agent_identity("chalk-tracker", "Tracks chalk"))

    complaints = [
        r for r in caplog.records if "agent roles are unavailable" in r.getMessage()
    ]
    assert len(complaints) == 1
    assert "Manage Roles" in complaints[0].getMessage()


def test_a_server_out_of_roles_says_so_rather_than_retrying(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Discord caps a server at 250 roles, hard. Nothing about that gets better
    # by asking again, so it stops and names the cap.
    guild = _FakeGuild()
    guild.create_error = _http(30005)
    adapter = _adapter(guild)

    with caplog.at_level(logging.WARNING):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))
        _run(adapter.create_agent_identity("chalk-tracker", "Tracks chalk"))

    assert guild.created == []
    assert "250 roles" in caplog.text


def test_an_unrecognised_refusal_is_not_swallowed() -> None:
    # Latching on anything at all would turn a transient Discord outage into a
    # bridge that quietly never provisions again.
    guild = _FakeGuild()
    guild.create_error = _http(50035)
    adapter = _adapter(guild)

    with pytest.raises(discord.HTTPException):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))


# ── Translation ──────────────────────────────────────────────────────────────


def test_a_role_mention_arrives_as_the_agents_name() -> None:
    """Picking the agent from the `@` menu sends `<@&id>`, not the typed name.

    Resolving it back is what lets the rest of Switch treat it as an ordinary
    mention — the addressing layer matches on the name and knows nothing about
    Discord.
    """
    guild = _FakeGuild([_FakeRole(7, "flint-tracker")])
    adapter = _adapter(guild)

    assert adapter.translate_inbound("hey <@&7> look") == "hey @flint-tracker look"


def test_a_mention_of_a_role_we_know_nothing_about_still_reads_as_a_name() -> None:
    guild = _FakeGuild([_FakeRole(7, "moderators")])
    adapter = _adapter(guild)

    assert adapter.translate_inbound("<@&7> please") == "@moderators please"


def test_a_mention_of_a_role_that_is_gone_is_left_as_it_came() -> None:
    adapter = _adapter(_FakeGuild())

    assert adapter.translate_inbound("<@&7> please") == "<@&7> please"


def test_an_agent_name_goes_out_as_its_role_pill() -> None:
    guild = _FakeGuild()
    adapter = _adapter(guild)
    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert adapter.translate_outbound("ask @flint-tracker") == "ask <@&1001>"


def test_a_name_that_is_not_an_agents_is_not_turned_into_a_ping() -> None:
    """Only roles this bridge minted or adopted for an agent become pills.

    Anything wider and a passing "@moderators" in an agent's message becomes a
    real ping of somebody's real role.
    """
    guild = _FakeGuild([_FakeRole(7, "moderators")])
    adapter = _adapter(guild)

    assert adapter.translate_outbound("ask @moderators") == "ask @moderators"
