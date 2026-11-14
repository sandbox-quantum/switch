"""Discord rooms follow who can see their channel.

Discord has no channel membership: someone is in a channel when they are in the
server and allowed to see it. These tests pin how the bridge follows that, and
that it stays within Discord's limits on the shared connection:

- live member changes move people in or out of bridged channels' rooms only;
- one read of a guild's members answers for all its bridged channels;
- without the members intent, a room's people are checked in batches, and a
  wrong empty answer never empties a room;
- permission changes re-check only the rooms they affect;
- bursts are gathered, role-less updates dropped, background reads paced.
"""

from __future__ import annotations

import asyncio
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.discord import adapter as adapter_module
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient
from switch_core.bridges.collaboration.discord.members import (
    GuildChangeBatcher,
    GuildMemberChange,
    MemberReadQueue,
    PermissionChangeBatcher,
    RoleChangeFilter,
)
from switch_core.bridges.collaboration.install_service import WebhookTarget
from switch_core.bridges.collaboration.models import InboundUserJoin, InboundUserLeave

GUILD_ID = 42


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Member:
    def __init__(self, user_id: int, name: str, *, bot: bool = False) -> None:
        self.id = user_id
        self.name = name
        self.bot = bot


class _Perms:
    def __init__(self, view_channel: bool) -> None:
        self.view_channel = view_channel


class _Channel:
    """A channel that the people in `viewers` can see."""

    def __init__(self, channel_id: int, viewers: set[int]) -> None:
        self.id = channel_id
        self.name = f"chan-{channel_id}"
        self.viewers = viewers

    def permissions_for(self, member: Any) -> _Perms:
        return _Perms(member.id in self.viewers)


class _Guild:
    def __init__(
        self, channels: list[_Channel], members: list[_Member], member_count: int = 0
    ) -> None:
        self.id = GUILD_ID
        self.channels = {c.id: c for c in channels}
        self.members = members
        self.member_count = member_count or len(members)
        self.chunks = 0
        self.queries: list[list[int]] = []
        self.fetches: list[int] = []
        self.chunk_error: Exception | None = None
        self.fetch_errors: dict[int, Exception] = {}

    def get_channel(self, channel_id: int) -> _Channel | None:
        return self.channels.get(channel_id)

    async def chunk(self, *, cache: bool = True) -> list[_Member]:
        assert cache is False
        self.chunks += 1
        if self.chunk_error is not None:
            raise self.chunk_error
        return list(self.members)

    async def query_members(
        self, *, user_ids: list[int], limit: int, cache: bool
    ) -> list[_Member]:
        assert len(user_ids) <= 100 and cache is False
        self.queries.append(list(user_ids))
        wanted = set(user_ids)
        return [m for m in self.members if m.id in wanted]

    async def fetch_member(self, user_id: int) -> _Member:
        self.fetches.append(user_id)
        if user_id in self.fetch_errors:
            raise self.fetch_errors[user_id]
        for member in self.members:
            if member.id == user_id:
                return member
        raise _not_found()


def _not_found(code: int = 10007) -> discord.NotFound:
    response = type("_R", (), {"status": 404, "reason": "Not Found"})()
    return discord.NotFound(response, {"code": code, "message": "Unknown Member"})  # type: ignore[arg-type]


class _Client:
    def __init__(self, guild: _Guild) -> None:
        self._guild = guild

    def get_guild(self, guild_id: int) -> _Guild | None:
        return self._guild if guild_id == GUILD_ID else None


def _connection(guild: _Guild, *, members_intent: bool) -> DiscordConnection:
    intents = discord.Intents.none()
    intents.members = members_intent
    connection = DiscordConnection(
        bot_token="t", intents=intents, command_guild_id=None, cache_members=False
    )
    connection._client = _Client(guild)  # type: ignore[assignment]
    return connection


class _Bridge:
    """The bridge core's side: bridged channels, joins, leaves, resyncs."""

    def __init__(self, bridged: set[str]) -> None:
        self.bridged = bridged
        self.joins: list[tuple[str, str]] = []
        self.quiet: list[bool] = []
        self.leaves: list[tuple[str, str]] = []
        self.resyncs: list[list[str]] = []

    async def joined(self, join: InboundUserJoin) -> None:
        self.joins.append((join.channel_id, join.external_user_id))
        self.quiet.append(join.quiet)

    async def left(self, leave: InboundUserLeave) -> None:
        self.leaves.append((leave.channel_id, leave.external_user_id))


def _adapter(
    guild: _Guild, bridged: set[str], *, members_intent: bool = True
) -> tuple[DiscordAdapter, _Bridge]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=str(GUILD_ID), event_delivery="shared")
    )
    adapter.attach_shared_connection(_connection(guild, members_intent=members_intent))
    bridge = _Bridge(bridged)
    adapter._on_user_joined = bridge.joined
    adapter.set_user_left_handler(bridge.left)
    adapter.set_member_sync_hooks(
        bridged_channels=lambda: bridge.bridged, request_sync=bridge.resyncs.append
    )
    adapter._channel_type_of = lambda channel: "channel_public"  # type: ignore[method-assign]
    return adapter, bridge


def _change(kind: str, member: _Member) -> GuildMemberChange:
    return GuildMemberChange(
        kind=kind,  # type: ignore[arg-type]
        guild_id=GUILD_ID,
        user_id=member.id,
        username=member.name,
        member=None if kind == "leave" else member,
    )


# ── Live member changes ──────────────────────────────────────────────────────


async def test_someone_joining_the_server_joins_the_bridged_channels_they_can_see() -> (
    None
):
    ann = _Member(1, "ann")
    guild = _Guild([_Channel(10, {1}), _Channel(11, set()), _Channel(12, {1})], [ann])
    # 12 is visible but has no room: nothing may create one for it.
    adapter, bridge = _adapter(guild, {"10", "11"})

    await adapter.dispatch_member_changes([_change("join", ann)])

    assert bridge.joins == [("10", "1")]
    assert bridge.leaves == []
    # Joining the server is not being added to the channel: no agent woken.
    assert bridge.quiet == [True]


async def test_someone_leaving_the_server_leaves_every_bridged_channel() -> None:
    ann = _Member(1, "ann")
    guild = _Guild([_Channel(10, set()), _Channel(11, set())], [])
    adapter, bridge = _adapter(guild, {"10", "11"})

    await adapter.dispatch_member_changes([_change("leave", ann)])

    assert sorted(bridge.leaves) == [("10", "1"), ("11", "1")]
    assert bridge.joins == []


async def test_a_role_change_moves_someone_in_and_out() -> None:
    ann = _Member(1, "ann")
    guild = _Guild([_Channel(10, {1}), _Channel(11, set())], [ann])
    adapter, bridge = _adapter(guild, {"10", "11"})

    await adapter.dispatch_member_changes([_change("update", ann)])

    assert bridge.joins == [("10", "1")]
    assert bridge.leaves == [("11", "1")]
    # Being given a role that shows the channel is announced.
    assert bridge.quiet == [False]


async def test_a_flood_of_newcomers_is_capped_per_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter_module, "_LIVE_JOINS_MAX", 2)
    people = [_Member(i, f"p{i}") for i in range(1, 6)]
    guild = _Guild([_Channel(10, {p.id for p in people})], people)
    adapter, bridge = _adapter(guild, {"10"})

    await adapter.dispatch_member_changes(
        [_change("join", p) for p in people] + [_change("leave", _Member(9, "z"))]
    )

    assert len(bridge.joins) == 2
    # Leaving is never capped.
    assert bridge.leaves == [("10", "9")]


async def test_past_the_cap_people_who_lost_access_still_leave(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A role that showed a private channel taken from many people at once:
    every one of them leaves its room, cap or not."""
    monkeypatch.setattr(adapter_module, "_LIVE_JOINS_MAX", 2)
    people = [_Member(i, f"p{i}") for i in range(1, 6)]
    guild = _Guild([_Channel(10, set())], people)
    adapter, bridge = _adapter(guild, {"10"})

    await adapter.dispatch_member_changes([_change("update", p) for p in people])

    assert sorted(bridge.leaves) == [("10", str(p.id)) for p in people]


async def test_the_cap_warns_only_when_someone_was_skipped(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(adapter_module, "_LIVE_JOINS_MAX", 2)
    people = [_Member(i, f"p{i}") for i in range(1, 3)]
    guild = _Guild([_Channel(10, {p.id for p in people})], people)
    adapter, _ = _adapter(guild, {"10"})

    with caplog.at_level("WARNING"):
        await adapter.dispatch_member_changes([_change("join", p) for p in people])

    assert "at once" not in caplog.text


async def test_another_guilds_changes_are_ignored() -> None:
    ann = _Member(1, "ann")
    guild = _Guild([_Channel(10, {1})], [ann])
    adapter, bridge = _adapter(guild, {"10"})
    other = GuildMemberChange(
        kind="join", guild_id=7, user_id=1, username="ann", member=ann
    )

    await adapter.dispatch_member_changes([other])

    assert bridge.joins == []


# ── Listing a channel's members (members intent on) ─────────────────────────


async def test_one_member_read_answers_for_every_bridged_channel() -> None:
    ann, bob, bot = _Member(1, "ann"), _Member(2, "bob"), _Member(3, "b", bot=True)
    guild = _Guild([_Channel(10, {1, 3}), _Channel(11, {1, 2})], [ann, bob, bot])
    adapter, _ = _adapter(guild, {"10", "11"})

    first = await adapter.list_channel_members("10")
    second = await adapter.list_channel_members("11")

    assert first is not None and first.complete
    assert first.members == {"1": "ann"}
    assert second is not None and second.members == {"1": "ann", "2": "bob"}
    assert guild.chunks == 1


async def test_member_changes_update_the_read_rather_than_discard_it() -> None:
    ann, bob, cat = _Member(1, "ann"), _Member(2, "bob"), _Member(3, "cat")
    channel = _Channel(10, {1, 2})
    guild = _Guild([channel], [ann, bob])
    adapter, _ = _adapter(guild, {"10"})

    await adapter.list_channel_members("10")
    channel.viewers.add(3)
    await adapter.dispatch_member_changes([_change("leave", bob), _change("join", cat)])
    listing = await adapter.list_channel_members("10")

    assert listing is not None and listing.members == {"1": "ann", "3": "cat"}
    assert guild.chunks == 1


async def test_a_permission_change_makes_the_next_listing_read_again() -> None:
    guild = _Guild([_Channel(10, {1})], [_Member(1, "ann")])
    adapter, _ = _adapter(guild, {"10"})

    await adapter.list_channel_members("10")
    adapter.dispatch_permission_change(None)
    await adapter.list_channel_members("10")

    assert guild.chunks == 2


async def test_without_the_members_intent_nothing_is_listed() -> None:
    guild = _Guild([_Channel(10, {1})], [_Member(1, "ann")])
    adapter, _ = _adapter(guild, {"10"}, members_intent=False)

    assert await adapter.list_channel_members("10") is None
    assert guild.chunks == 0


async def test_a_server_too_big_to_read_whole_is_not_listed() -> None:
    guild = _Guild([_Channel(10, {1})], [_Member(1, "ann")], member_count=10**6)
    adapter, _ = _adapter(guild, {"10"})

    assert await adapter.list_channel_members("10") is None
    assert guild.chunks == 0


async def test_whether_members_can_be_listed_follows_the_same_conditions() -> None:
    small = _Guild([_Channel(10, {1})], [_Member(1, "ann")])
    big = _Guild([_Channel(10, {1})], [_Member(1, "ann")], member_count=10**6)

    listed, _ = _adapter(small, {"10"})
    no_intent, _ = _adapter(small, {"10"}, members_intent=False)
    too_big, _ = _adapter(big, {"10"})

    assert listed.can_list_channel_members("10", "channel_private") is True
    assert no_intent.can_list_channel_members("10", "channel_private") is False
    assert too_big.can_list_channel_members("10", "channel_private") is False
    # Asking reads no members.
    assert small.chunks == 0 and big.chunks == 0


async def test_a_failed_read_is_an_incomplete_listing() -> None:
    guild = _Guild([_Channel(10, {1})], [_Member(1, "ann")])
    guild.chunk_error = TimeoutError()
    adapter, _ = _adapter(guild, {"10"})

    listing = await adapter.list_channel_members("10")

    assert listing is not None
    assert listing.complete is False and listing.members == {}


# ── Checking known people (no members intent, or a big server) ──────────────


async def test_people_who_left_or_lost_sight_of_the_channel_are_gone() -> None:
    ann, bob = _Member(1, "ann"), _Member(2, "bob")
    guild = _Guild([_Channel(10, {1})], [ann, bob])
    # 3 is no longer in the server; Discord says so when asked directly.
    # 4 is not found either, but Discord would not say why: not counted.
    guild.fetch_errors[4] = discord.HTTPException(
        type("_R", (), {"status": 500, "reason": "x"})(),  # type: ignore[arg-type]
        "boom",
    )
    adapter, _ = _adapter(guild, {"10"}, members_intent=False)

    gone = await adapter.members_gone("10", ["1", "2", "3", "4"])

    assert gone == {"2", "3"}
    assert guild.queries == [[1, 2, 3, 4]]
    assert sorted(guild.fetches) == [3, 4]


async def test_people_are_asked_about_in_batches_and_the_answer_is_reused() -> None:
    people = [_Member(i, f"p{i}") for i in range(1, 251)]
    guild = _Guild([_Channel(10, {p.id for p in people}), _Channel(11, set())], people)
    adapter, _ = _adapter(guild, {"10", "11"}, members_intent=False)
    ids = [str(p.id) for p in people]

    assert await adapter.members_gone("10", ids) == set()
    assert [len(q) for q in guild.queries] == [100, 100, 50]
    # The guild's other channel needs no second round of questions.
    assert await adapter.members_gone("11", ids) == set(ids)
    assert len(guild.queries) == 3


async def test_an_empty_answer_never_turns_into_a_burst_or_an_emptied_room() -> None:
    # Discord answers the batch with nobody, although everyone is still there.
    people = [_Member(i, f"p{i}") for i in range(1, 51)]
    guild = _Guild([_Channel(10, {p.id for p in people})], people)

    async def nobody(**_: Any) -> list[_Member]:
        return []

    guild.query_members = nobody  # type: ignore[method-assign]
    adapter, _ = _adapter(guild, {"10"}, members_intent=False)

    gone = await adapter.members_gone("10", [str(p.id) for p in people])

    assert gone == set()
    assert len(guild.fetches) == adapter_module._ABSENCE_CHECKS_PER_PASS


# ── Permission changes ──────────────────────────────────────────────────────


async def test_a_channel_permission_change_rechecks_only_its_room() -> None:
    guild = _Guild([_Channel(10, set()), _Channel(11, set())], [])
    adapter, bridge = _adapter(guild, {"10", "11"})

    adapter.dispatch_permission_change({11, 99})

    assert bridge.resyncs == [["11"]]


async def test_a_role_permission_change_rechecks_every_room() -> None:
    guild = _Guild([_Channel(10, set()), _Channel(11, set())], [])
    adapter, bridge = _adapter(guild, {"10", "11"})

    adapter.dispatch_permission_change(None)

    assert bridge.resyncs == [["10", "11"]]


async def test_a_change_to_unbridged_channels_rechecks_nothing() -> None:
    guild = _Guild([_Channel(10, set())], [])
    adapter, bridge = _adapter(guild, {"10"})

    adapter.dispatch_permission_change({99})

    assert bridge.resyncs == []


# ── Keeping it cheap ─────────────────────────────────────────────────────────


def test_only_a_change_of_roles_counts() -> None:
    roles = RoleChangeFilter()

    assert roles.changed(GUILD_ID, 1, frozenset({5}))  # first sighting
    assert not roles.changed(GUILD_ID, 1, frozenset({5}))  # a nickname, say
    assert roles.changed(GUILD_ID, 1, frozenset({5, 6}))


def test_the_role_memory_is_bounded() -> None:
    roles = RoleChangeFilter(max_entries=2)
    for user_id in (1, 2, 3):
        roles.changed(GUILD_ID, user_id, frozenset())

    # 1 was forgotten, so it counts as changed: a check, never a miss.
    assert roles.changed(GUILD_ID, 1, frozenset())
    assert not roles.changed(GUILD_ID, 3, frozenset())


async def test_a_burst_of_member_changes_is_handed_on_once() -> None:
    flushed: list[tuple[int, list[GuildMemberChange]]] = []

    async def flush(guild_id: int, changes: list[GuildMemberChange]) -> None:
        flushed.append((guild_id, changes))

    batcher = GuildChangeBatcher(flush, delay=0.01)
    ann, bob = _Member(1, "ann"), _Member(2, "bob")
    batcher.add(_change("join", ann))
    batcher.add(_change("join", bob))
    batcher.add(_change("leave", ann))  # replaces ann's join
    await asyncio.sleep(0.05)

    assert len(flushed) == 1
    guild_id, changes = flushed[0]
    assert guild_id == GUILD_ID
    assert sorted((c.user_id, c.kind) for c in changes) == [(1, "leave"), (2, "join")]


async def test_a_join_then_a_role_stays_a_quiet_join() -> None:
    """A welcome bot giving a newcomer a role within the wait must not turn
    their quiet arrival into an announced one."""
    flushed: list[GuildMemberChange] = []

    async def flush(guild_id: int, changes: list[GuildMemberChange]) -> None:
        flushed.extend(changes)

    batcher = GuildChangeBatcher(flush, delay=0.01)
    ann = _Member(1, "ann")
    batcher.add(_change("join", ann))
    batcher.add(_change("update", ann))
    await asyncio.sleep(0.05)

    assert [(c.user_id, c.kind) for c in flushed] == [(1, "join")]


async def test_a_permission_change_during_a_flush_is_acted_on() -> None:
    """One arriving while the guild's last batch is being acted on found a
    task already there; it still gets one of its own once that finishes."""
    flushed: list[set[int] | None] = []
    release = asyncio.Event()

    async def flush(guild_id: int, channel_ids: set[int] | None) -> None:
        flushed.append(channel_ids)
        if len(flushed) == 1:
            await release.wait()

    batcher = PermissionChangeBatcher(flush, delay=0.01)
    batcher.add(GUILD_ID, [10])
    await asyncio.sleep(0.03)  # the first flush is now waiting
    batcher.add(GUILD_ID, [11])
    release.set()
    await asyncio.sleep(0.05)

    assert flushed == [{10}, {11}]


async def test_permission_changes_are_gathered_per_guild() -> None:
    flushed: list[tuple[int, set[int] | None]] = []

    async def flush(guild_id: int, channel_ids: set[int] | None) -> None:
        flushed.append((guild_id, channel_ids))

    batcher = PermissionChangeBatcher(flush, delay=0.01)
    batcher.add(GUILD_ID, [10])
    batcher.add(GUILD_ID, [11])
    batcher.add(7, None)
    await asyncio.sleep(0.05)

    assert sorted(flushed, key=lambda f: f[0]) == [(7, None), (GUILD_ID, {10, 11})]


async def test_background_reads_leave_headroom_for_peoples_searches() -> None:
    budget = {"left": 20}
    spent: list[int] = []

    def budget_left() -> tuple[int, float]:
        return budget["left"], 0.01

    def spend() -> None:
        spent.append(1)
        budget["left"] -= 1

    queue = MemberReadQueue(budget_left=budget_left, spend=spend, reserve=20)

    async def read() -> str:
        return "done"

    task = asyncio.create_task(queue.run(read))
    await asyncio.sleep(0.05)
    assert not task.done() and spent == []  # waiting: only the reserve is left

    budget["left"] = 25
    assert await asyncio.wait_for(task, 2) == "done"
    assert spent == [1]


async def test_background_reads_run_a_few_at_a_time() -> None:
    queue = MemberReadQueue(
        budget_left=lambda: (60, 0.0), spend=lambda: None, concurrency=2
    )
    running = 0
    most = 0

    async def read() -> None:
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.01)
        running -= 1

    await asyncio.gather(*(queue.run(read) for _ in range(6)))

    assert most == 2


# ── The connection ───────────────────────────────────────────────────────────


def test_the_shared_connection_keeps_no_member_cache() -> None:
    intents = discord.Intents.none()
    intents.members = True
    shared = DiscordConnection(
        bot_token="t", intents=intents, command_guild_id=None, cache_members=False
    )
    own = DiscordConnection(bot_token="t", intents=intents, command_guild_id=1)

    assert shared._client_options["chunk_guilds_at_startup"] is False
    assert shared._client_options["member_cache_flags"].value == 0
    assert own._client_options == {}


def test_a_member_update_is_passed_on_only_when_roles_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild = _Guild([], [])
    connection = _connection(guild, members_intent=True)
    seen: list[GuildMemberChange] = []
    connection.set_member_change_handler(seen.append)
    monkeypatch.setattr(
        discord,
        "Member",
        lambda *, data, guild, state: _Member(int(data["user"]["id"]), "ann"),
    )
    state = type("_S", (), {"_get_guild": lambda self, guild_id: guild})()

    def update(roles: list[str], *, bot: bool = False) -> None:
        connection._on_raw_member_update(
            state,
            {
                "guild_id": str(GUILD_ID),
                "user": {"id": "1", "username": "ann", "bot": bot},
                "roles": roles,
            },
        )

    update(["5"])
    update(["5"])  # a nickname change: dropped
    update(["5", "6"])
    update(["7"], bot=True)  # a bot: never a person

    assert [c.kind for c in seen] == ["update", "update"]
    assert all(c.user_id == 1 for c in seen)


def test_a_channel_overwrite_change_is_reported_with_its_channel() -> None:
    connection = _connection(_Guild([], []), members_intent=False)
    reported: list[tuple[int, list[int] | None]] = []
    connection.set_permission_change_handler(
        lambda guild_id, ids: reported.append((guild_id, ids))
    )
    guild = type("_G", (), {"id": GUILD_ID})()

    def channel(overwrites: dict[str, str]) -> Any:
        return type(
            "_C",
            (),
            {"id": 10, "guild": guild, "overwrites": overwrites, "category_id": None},
        )()

    connection._note_overwrite_change(channel({}), channel({}))
    connection._note_overwrite_change(channel({}), channel({"role": "deny"}))

    assert reported == [(GUILD_ID, [10])]


# ── The shared client ────────────────────────────────────────────────────────


class _InstallService:
    def __init__(self, adapter: DiscordAdapter) -> None:
        self.adapter = adapter
        self.calls = 0

    async def resolve_by_workspace(
        self, *, platform: str, workspace_id: str
    ) -> WebhookTarget:
        self.calls += 1
        return WebhookTarget(
            tenant_id="tenant-a",
            platform="discord",
            bridge_id="bridge-1",
            adapter=self.adapter,
        )


async def test_the_shared_client_resolves_a_guild_once_per_burst() -> None:
    ann, bob = _Member(1, "ann"), _Member(2, "bob")
    guild = _Guild([_Channel(10, {1, 2})], [ann, bob])
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=str(GUILD_ID), event_delivery="shared")
    )
    bridge = _Bridge({"10"})
    adapter._on_user_joined = bridge.joined
    adapter.set_member_sync_hooks(
        bridged_channels=lambda: bridge.bridged, request_sync=bridge.resyncs.append
    )
    adapter._channel_type_of = lambda channel: "channel_public"  # type: ignore[method-assign]
    service = _InstallService(adapter)

    async def on_connected(connection: DiscordConnection) -> None: ...

    gateway = DiscordGatewayClient(
        bot_token="t",
        message_content=False,
        members=True,
        install_service=service,  # type: ignore[arg-type]
        on_connected=on_connected,
    )
    gateway.connection._client = _Client(guild)  # type: ignore[assignment]

    gateway._member_changes.add(_change("join", ann))
    gateway._member_changes.add(_change("join", bob))
    await gateway._member_changes.drain()

    assert service.calls == 1
    assert sorted(bridge.joins) == [("10", "1"), ("10", "2")]
    gateway._member_changes.close()
    gateway._permission_changes.close()


def test_the_member_update_hook_works_on_a_real_discord_client() -> None:
    """The hook reaches into discord.py's parser table, which is not public
    API: this fails if an upgrade moves it, rather than role changes going
    unnoticed in production."""
    intents = discord.Intents.none()
    intents.guilds = True
    intents.members = True
    connection = DiscordConnection(
        bot_token="t", intents=intents, command_guild_id=None, cache_members=False
    )
    seen: list[GuildMemberChange] = []
    connection.set_member_change_handler(seen.append)
    client = discord.Client(
        intents=intents,
        member_cache_flags=discord.MemberCacheFlags.none(),
        chunk_guilds_at_startup=False,
    )
    connection._hook_member_updates(client)
    state = client._connection
    state._add_guild_from_data(
        {
            "id": str(GUILD_ID),
            "name": "g",
            "roles": [
                {
                    "id": str(GUILD_ID),
                    "name": "@everyone",
                    "permissions": "0",
                    "position": 0,
                    "color": 0,
                    "hoist": False,
                    "managed": False,
                    "mentionable": False,
                }
            ],
            "channels": [],
            "members": [],
            "member_count": 1,
        }  # type: ignore[arg-type]
    )

    state.parsers["GUILD_MEMBER_UPDATE"](
        {
            "guild_id": str(GUILD_ID),
            "roles": ["7"],
            "user": {
                "id": "1",
                "username": "ann",
                "discriminator": "0",
                "avatar": None,
                "global_name": None,
            },
            "joined_at": "2024-01-01T00:00:00+00:00",
            "nick": None,
            "deaf": False,
            "mute": False,
            "flags": 0,
        }
    )

    assert [(c.kind, c.user_id, c.username) for c in seen] == [("update", 1, "ann")]
    assert isinstance(seen[0].member, discord.Member)
