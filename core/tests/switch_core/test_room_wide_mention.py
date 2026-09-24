"""The room-wide mention words: defused in text, reserved as names.

Whether a room-wide mention wakes an agent is pinned end to end in
`test_room_wide_mention_wakes_no_agent.py`, and how each platform renders one
in `bridges/collaboration/test_room_wide_mention_rendering.py`. This covers
the pieces both rest on.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.aliases import AliasError, validate_alias_format
from switch_core.db.models import Agent, ApiKey, Room
from switch_core.db.stores.room_role_store import RoomRoleStore, validate_role_name
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.room_wide_mention import (
    CODE_AND_URLS,
    defuse_mass_mention_words,
    defuse_mass_mention_words_in_prose,
    reject_reserved_mention_name,
    strip_room_wide_target,
)
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)

ZWSP = "\u200b"
RESERVED = ["everyone", "channel", "here", "all", "Everyone", "CHANNEL"]


# ── Defusing ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("@channel hi", f"@{ZWSP}channel hi"),
        ("@everyone, look", f"@{ZWSP}everyone, look"),
        ("@Here", f"@{ZWSP}Here"),
        # Mattermost strips trailing `.`, `-` and `_` before matching, so
        # `@channel.` pages the channel just as `@channel` does.
        ("ping @all.", f"ping @{ZWSP}all."),
        ("ping @channel-", f"ping @{ZWSP}channel-"),
        # Strict means everywhere: each of these pages a Mattermost channel,
        # and each got past an exemption that tried to recognise code or a
        # link the way Markdown does.
        ("[docs](https://x.com),@channel", f"[docs](https://x.com),@{ZWSP}channel"),
        ("\\`@channel\\`", f"\\`@{ZWSP}channel\\`"),
        ("x ~~~ @channel ~~~", f"x ~~~ @{ZWSP}channel ~~~"),
        ("`@here`", f"`@{ZWSP}here`"),
    ],
)
def test_the_strict_form_defuses_the_words_everywhere(text: str, expected: str) -> None:
    assert defuse_mass_mention_words(text) == expected


@pytest.mark.parametrize(
    "text", ["@allison", "@all-hands", "@everyone2", "@channels", "no mention here"]
)
def test_longer_handles_are_never_touched(text: str) -> None:
    assert defuse_mass_mention_words(text) == text
    assert defuse_mass_mention_words_in_prose(text, keep=CODE_AND_URLS) == text


@pytest.mark.parametrize(
    "text",
    [
        "`@here`",
        "```\n@all\n```",
        "~~~\nnpm i @here/sdk\n~~~",
        "https://www.npmjs.com/package/@here/harp.gl",
        "[profile](https://mastodon.social/@all)",
        "ops@here",
        "alice@here.com",
    ],
)
def test_the_prose_form_leaves_code_links_and_addresses_exact(text: str) -> None:
    assert defuse_mass_mention_words_in_prose(text, keep=CODE_AND_URLS) == text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("ping @here, please", f"ping @{ZWSP}here, please"),
        ("see https://x.io then @here", f"see https://x.io then @{ZWSP}here"),
        # Not a URL: a host starts with a letter or digit.
        ("http://@channel", f"http://@{ZWSP}channel"),
    ],
)
def test_the_prose_form_still_defuses_prose(text: str, expected: str) -> None:
    assert defuse_mass_mention_words_in_prose(text, keep=CODE_AND_URLS) == expected


def test_defusing_is_idempotent() -> None:
    once = defuse_mass_mention_words("@channel and @here")
    assert defuse_mass_mention_words(once) == once


@pytest.mark.parametrize(
    ("body", "rest"),
    [
        ("@everyone deploy at five", "deploy at five"),
        ("@everyone @scout take this", "@scout take this"),
        ("@everyone", ""),
        # Only the leading token the server wrote is taken.
        ("@everyones deploy", "@everyones deploy"),
        ("deploy @everyone", "deploy @everyone"),
    ],
)
def test_the_leading_target_is_taken_off(body: str, rest: str) -> None:
    assert strip_room_wide_target(body) == rest


# ── Reserving ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", RESERVED)
def test_reserved_names_are_refused(name: str) -> None:
    with pytest.raises(ValueError, match="reserved for room-wide mentions"):
        reject_reserved_mention_name(name, kind="Name")


@pytest.mark.parametrize("name", RESERVED)
def test_an_alias_cannot_be_a_room_wide_mention_word(name: str) -> None:
    with pytest.raises(AliasError, match="reserved"):
        validate_alias_format(name)


@pytest.mark.parametrize("name", RESERVED)
def test_a_role_cannot_be_a_room_wide_mention_word(name: str) -> None:
    with pytest.raises(ValueError, match="reserved"):
        validate_role_name(name)


@pytest.mark.parametrize("name", ["allison", "channels", "everyone2", "here-we-go"])
def test_names_that_only_start_with_one_are_fine(name: str) -> None:
    validate_alias_format(name)
    validate_role_name(name)
    reject_reserved_mention_name(name, kind="Name")


async def test_define_role_refuses_a_reserved_name(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        room = Room(matrix_room_id="!r:test", name="r", description="r")
        session.add(room)
        await session.flush()
        with pytest.raises(ValueError, match="reserved"):
            await RoomRoleStore().define_role(session, room.id, "here", "x", False)


async def test_create_room_refuses_a_reserved_alias_before_provisioning() -> None:
    # A bare service: had the check come after anything touched a store, a
    # bridge or the transport, this would fail on the missing attribute
    # instead, having left a channel and a room behind in real life.
    svc = object.__new__(RoomService)
    config = RoomCreateConfig(
        name="r", description="r", agent_names=["bot"], aliases={"bot": "here"}
    )

    with pytest.raises(AliasError, match="reserved"):
        await svc.create_room(config)


class TestAgentNames:
    async def test_a_new_agent_cannot_take_a_reserved_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner = await make_owner(session_factory)

        with pytest.raises(ValueError, match="reserved"):
            await register(svc, "everyone", owner)

    async def test_an_agent_that_already_has_one_still_reconnects(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Refusing it would disconnect something running today. A room-wide
        # mention in a room it belongs to is refused instead.
        svc = make_service(session_factory)
        owner = await make_owner(session_factory)
        await register(svc, "legacy", owner)
        async with session_factory() as session:
            agent = (
                await session.execute(select(Agent).where(Agent.name == "legacy"))
            ).scalar_one()
            agent.name = "all"
            key = await session.get(ApiKey, agent.api_key_id)
            assert key is not None
            key.label = "all"
            await session.commit()

        agent_id = await register(svc, "all", owner, overwrite=True)

        assert agent_id == agent.id
