"""What Switch says on IRC: agents' messages, notices, cards, and the channels
the bot is in, as the server receives them."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from switch_core.bridges.collaboration.adapter import (
    AgentPresentation,
    ChannelNotBindable,
    RequestCard,
    TurnActivity,
)
from switch_core.bridges.collaboration.irc.adapter import IrcAdapter
from switch_core.bridges.collaboration.irc.markup import BOLD
from switch_core.bridges.collaboration.irc.protocol import MAX_LINE_BYTES
from switch_core.bridges.collaboration.models import RetireOutcome
from switch_core.bridges.collaboration.session.renderers import RequestReference
from tests.switch_core.bridges.collaboration.irc_fakes import (
    CHANNEL,
    NICK,
    FakeIrcServer,
    quick,
    started,
)
from tests.switch_core.bridges.collaboration.session_fixtures import (
    _turn,
    open_request,
)


@pytest.fixture
async def server() -> AsyncIterator[FakeIrcServer]:
    async with FakeIrcServer() as running:
        yield running


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    quick(monkeypatch)


@pytest.fixture
async def adapter(server: FakeIrcServer) -> AsyncIterator[IrcAdapter]:
    running = await started(server)

    async def presentation(name: str) -> AgentPresentation | None:
        names = {"coder": "Coder", "sneaky": "@here\x0304[x](https://e.example)\r\n"}
        if name not in names:
            return None
        return AgentPresentation(display_name=names[name], icon_url=None)

    running.set_agent_presentation_resolver(presentation)
    yield running
    await running.stop()


async def _said(server: FakeIrcServer, count: int) -> list[str]:
    await server.wait_for(lambda: len(server.said(CHANNEL)) >= count)
    return server.said(CHANNEL)


# ── Messages ─────────────────────────────────────────────────────────────────


async def test_each_line_is_headed_with_the_agents_name(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    ref = await adapter.send_message(
        CHANNEL, "coder", adapter.translate_outbound("Done.\n\n**Tests** pass.")
    )
    assert ref is not None
    assert await _said(server, 2) == [
        "<Coder> Done.",
        f"<Coder> {BOLD}Tests{BOLD} pass.",
    ]


async def test_a_display_name_cannot_colour_break_or_mention(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    await adapter.send_message(CHANNEL, "sneaky", "hi")
    (line,) = await _said(server, 1)
    assert line.endswith("> hi")
    assert "\x03" not in line and "\r" not in line
    assert "@here" not in line and "](" not in line


async def test_a_long_reply_is_split_to_fit_the_line_and_kept_in_order(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    words = " ".join(f"word{n}" for n in range(400))
    await adapter.send_message(CHANNEL, "coder", f"{words}\nüñí 🙂 " * 3)
    said = await _said(server, 8)
    source = len(f":{NICK}___!{'u' * 18}@{'h' * 63} ")
    for raw in [r.raw for r in server.received if r.line.command == "PRIVMSG"]:
        assert source + len(raw.encode()) + 2 <= MAX_LINE_BYTES
    assert all(line.startswith("<Coder> ") for line in said)
    joined = " ".join(line.removeprefix("<Coder> ") for line in said)
    assert joined.startswith("word0 word1") and "word399" in joined


async def test_a_line_break_in_a_message_is_never_a_command(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    await adapter.send_message(CHANNEL, "coder", "hi\r\nQUIT :bye\rJOIN #evil")
    said = await _said(server, 2)
    assert said == ["<Coder> hi", "<Coder> QUIT :byeJOIN #evil"]
    assert not server.sent("QUIT") and len(server.sent("JOIN")) == 1


async def test_a_notice_is_the_bot_speaking_rendered(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    ref = await adapter.admin_message(CHANNEL, "No agent called **x** here.")
    assert ref is not None
    assert await _said(server, 1) == [f"No agent called {BOLD}x{BOLD} here."]


async def test_a_person_is_answered_directly(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    await adapter.send_message("ada", "coder", "hello")
    await server.wait_for(lambda: bool(server.said("ada")))
    assert server.said("ada") == ["<Coder> hello"]


async def test_nothing_is_said_to_what_is_no_channel_or_nick(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    assert await adapter.send_message("#a,#b", "coder", "hi") is None
    assert await adapter.send_message(CHANNEL, "coder", "  \n") is None
    assert not server.said()


async def test_a_message_the_connection_cannot_take_is_not_posted(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
    await server.drop()
    # Every reconnect is refused for want of a nick.
    await server.wait_for(lambda: server.connections >= 2)
    assert await adapter.send_message(CHANNEL, "coder", "hi") is None


async def test_irc_cannot_edit_or_delete_and_says_so(
    server: FakeIrcServer, adapter: IrcAdapter, caplog: pytest.LogCaptureFixture
) -> None:
    await adapter.update_message(CHANNEL, "ref", "new text")
    await adapter.delete_message(CHANNEL, "ref")
    assert "cannot edit" in caplog.text and "cannot take a message back" in caplog.text
    assert not server.said()


# ── Cards and turns ──────────────────────────────────────────────────────────


def _card(state: str) -> RequestCard:
    request = open_request().model_copy(update={"state": state})
    return RequestCard(request, RequestReference(token="tok", handle="A7"))


async def test_a_card_is_said_with_the_handle_to_type_back(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    ref = await adapter.post_rich(CHANNEL, "coder", _card("open"))
    assert ref
    said = await _said(server, 1)
    assert all(line.startswith("<Coder> ") for line in said)
    assert "A7" in " ".join(said)
    assert "**" not in " ".join(said)


async def test_a_card_is_said_again_only_once_it_is_settled(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    async def said_so_far(mark: str) -> list[str]:
        await adapter.admin_message(CHANNEL, mark)
        await server.wait_for(lambda: server.said(CHANNEL)[-1:] == [mark])
        return [line for line in server.said(CHANNEL) if not line.startswith("--")]

    ref = await adapter.post_rich(CHANNEL, "coder", _card("open"))
    posted = await said_so_far("-- posted")
    await adapter.update_rich(CHANNEL, "coder", ref, _card("submitting"), None)
    assert await said_so_far("-- answering") == posted
    await adapter.update_rich(CHANNEL, "coder", ref, _card("resolved"), None)
    settled = await said_so_far("-- settled")
    assert len(settled) > len(posted)
    await adapter.update_rich(CHANNEL, "coder", ref, _card("resolved"), None)
    assert await said_so_far("-- redrawn") == settled


async def test_a_turns_progress_is_not_said_but_its_problem_is(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    running = TurnActivity([], _turn("running"))
    ref = await adapter.post_rich(CHANNEL, "coder", running)
    await adapter.update_rich(CHANNEL, "coder", ref, TurnActivity([], _turn()), None)
    problem = TurnActivity(
        [], _turn(), status_only=True, error_summary="The agent is offline."
    )
    await adapter.post_rich(CHANNEL, "coder", problem)
    assert await _said(server, 1) == ["<Coder> The agent is offline."]


# ── Channels ─────────────────────────────────────────────────────────────────


async def test_a_new_room_gets_a_new_channel_with_its_topic(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    channel = await adapter.create_channel(
        "Release Train!", "Ship\nit", channel_type="channel_private"
    )
    assert channel.startswith("#release-train-") and len(channel) == 19
    await server.wait_for(lambda: bool(server.sent("TOPIC")))
    assert [line.params for line in server.sent("MODE")] == [(channel, "+si")]
    assert server.sent("TOPIC")[0].params == (channel, "Ship it")
    assert server.sent("JOIN")[-1].params == (channel,)


async def test_a_long_topic_is_cut_to_fit_without_breaking_a_character(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    channel = await adapter.create_channel("notes", "é" * 400)
    await server.wait_for(lambda: bool(server.sent("TOPIC")))
    (topic,) = server.sent("TOPIC")
    assert topic.params == (channel, "é" * 150)


async def test_people_invited_to_a_new_private_channel_are_let_in(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    channel = await adapter.create_channel(
        "secrets", "", channel_type="channel_private"
    )
    await adapter.add_users_to_channel(channel, ["ada"], ["account:ada"])
    await server.wait_for(lambda: bool(server.sent("INVITE")))
    order = [r.line.command for r in server.received]
    # An invitation counts only once the channel is invite-only.
    assert order.index("MODE") < order.index("INVITE")


async def test_a_channel_that_already_exists_is_left_as_it_is(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    server.members["#theirs"] = ["@someone"]
    await adapter.ensure_channel_subscriptions([("#theirs", "channel_private")])
    await adapter.add_users_to_channel("#theirs", ["ada"], ["account:ada"])
    await server.wait_for(lambda: bool(server.sent("INVITE")))
    assert not server.sent("MODE") and not server.sent("TOPIC")


async def test_a_notice_waits_for_a_connection_rather_than_being_lost(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
    await server.drop()
    await server.wait_for(lambda: server.connections >= 2)
    assert await adapter.admin_message(CHANNEL, "back soon") is not None
    server.taken = set()
    await server.wait_for(lambda: server.said(CHANNEL) == ["back soon"])


async def test_two_rooms_with_one_name_get_two_channels(adapter: IrcAdapter) -> None:
    assert await adapter.create_channel("general", "") != await adapter.create_channel(
        "general", ""
    )


async def test_a_room_bound_to_a_channel_is_joined(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    await adapter.ensure_channel_subscriptions(
        [("#deploys", "channel_public"), ("ada", "direct")]
    )
    await server.wait_for(lambda: len(server.sent("JOIN")) == 2)
    assert server.sent("JOIN")[-1].params == ("#deploys",)


async def test_a_channel_is_bound_by_its_lowercase_name(adapter: IrcAdapter) -> None:
    await adapter.require_bindable_channel("#deploys")
    for refused in ("#Deploys", "deploys", "#a b"):
        with pytest.raises(ChannelNotBindable):
            await adapter.require_bindable_channel(refused)


async def test_people_are_invited_by_nick(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    left_out = await adapter.add_users_to_channel(
        CHANNEL,
        ["ada", "bob", "who"],
        ["account:ada", "nick:bob", "U123"],
    )
    assert left_out == ["U123"]
    await server.wait_for(lambda: len(server.sent("INVITE")) == 2)
    assert [line.params for line in server.sent("INVITE")] == [
        ("ada", CHANNEL),
        ("bob", CHANNEL),
    ]


async def test_deleting_a_room_leaves_its_channel(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    assert await adapter.retire_channel(CHANNEL) == RetireOutcome(outcome="left")
    assert await adapter.retire_channel("ada") == RetireOutcome(outcome="kept")
    await server.wait_for(lambda: bool(server.sent("PART")))
    assert server.sent("PART")[0].params[0] == CHANNEL


async def test_a_channel_left_is_not_joined_again_after_a_reconnect(
    server: FakeIrcServer, adapter: IrcAdapter
) -> None:
    await adapter.ensure_channel_subscriptions([("#deploys", "channel_public")])
    await adapter.retire_channel("#deploys")
    await server.wait_for(lambda: bool(server.sent("PART")))
    await server.drop()
    await server.wait_for(lambda: server.connections == 2 and server.open == 1)
    await server.wait_for(
        lambda: any(
            r.connection == 2 for r in server.received if r.line.command == "JOIN"
        )
    )
    (rejoined,) = [
        r.line.params[0]
        for r in server.received
        if r.line.command == "JOIN" and r.connection == 2
    ]
    assert rejoined == CHANNEL


async def test_a_channel_is_public_and_a_person_direct(adapter: IrcAdapter) -> None:
    assert await adapter.get_channel_type(CHANNEL) == "channel_public"
    assert await adapter.get_channel_type("ada") == "direct"
