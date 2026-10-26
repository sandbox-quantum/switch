"""The IRC adapter against a scripted IRC server on localhost.

Everything is driven at the transport: the adapter dials a real socket, and
the fake server (`irc_fakes.FakeIrcd`) answers the way a network would.
"""

from __future__ import annotations

import asyncio
import ssl
from collections.abc import AsyncIterator
from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.bridges.collaboration.irc import adapter as irc_adapter
from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcConnectionConfig,
)
from switch_core.bridges.collaboration.irc.client import (
    IrcClient,
    IrcRegistrationError,
    IrcSettings,
    TokenBucket,
)
from switch_core.bridges.collaboration.irc.protocol import BOLD, parse_line
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS

from .irc_fakes import FakeIrcd


class Recorder:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.user_joins: list[InboundUserJoin] = []
        self.app_joins: list[InboundAppJoin] = []
        self.seen = asyncio.Event()

    async def _keep(self, into: list[Any], item: Any) -> None:
        into.append(item)
        self.seen.set()

    async def on_message(self, m: InboundMessage) -> None:
        await self._keep(self.messages, m)

    async def on_command(self, c: InboundCommand) -> None:
        await self._keep(self.commands, c)

    async def on_agent_joined(self, _: Any) -> None:
        return None

    async def on_user_joined(self, j: InboundUserJoin) -> None:
        await self._keep(self.user_joins, j)

    async def on_app_joined(self, j: InboundAppJoin) -> None:
        await self._keep(self.app_joins, j)

    async def until(self, check: Any, timeout: float = 5) -> None:
        async def wait() -> None:
            while not check():
                self.seen.clear()
                await self.seen.wait()

        await asyncio.wait_for(wait(), timeout)


def make_config(**overrides: Any) -> IrcConnectionConfig:
    values: dict[str, Any] = {"server": "irc.example.test", "nickname": "switch-bot"}
    values.update(overrides)
    return IrcConnectionConfig.model_validate(values)


@pytest.fixture
async def ircd() -> AsyncIterator[FakeIrcd]:
    async with FakeIrcd() as server:
        yield server


async def started(ircd: FakeIrcd, rec: Recorder, **config: Any) -> IrcAdapter:
    adapter = IrcAdapter(
        config=make_config(**config),
        opener=ircd.opener,
        bucket=TokenBucket(burst=1000, interval=0.001),
    )
    await adapter.start(
        rec.on_message,
        rec.on_command,
        rec.on_agent_joined,
        rec.on_user_joined,
        rec.on_app_joined,
    )
    return adapter


# ── Registration and config ────────────────────────────────────────────────


def test_irc_is_registered_as_a_platform() -> None:
    entry = next(p for p in PLATFORMS if p.key == "irc")
    assert entry.adapter is IrcAdapter and entry.config is IrcConnectionConfig
    described = IrcAdapter.describe("irc")
    assert described.display_name == "IRC"


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"nickname": "9lives"}, "not a valid IRC nickname"),
        ({"server": "ircs://irc.libera.chat:6697"}, "hostname alone"),
        ({"channels": "#ops, deploys"}, "Not channel names: deploys"),
        ({"sasl_username": "bot"}, "both the SASL username"),
        ({"tls": False, "port": 6667, "server_password": "pw"}, "in the clear"),
    ],
)
def test_config_refuses_what_cannot_work(
    overrides: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        make_config(**overrides)


def test_config_normalises_channel_list() -> None:
    config = make_config(channels="#ops  #deploys,#Ops2")
    assert config.channel_list() == ["#ops", "#deploys", "#Ops2"]


def test_outbound_url_and_exclusive_resource_name_the_server() -> None:
    raw: dict[str, object] = {
        "server": "irc.libera.chat",
        "port": 6697,
        "nickname": "acme",
    }
    assert IrcAdapter.outbound_urls(raw) == ["https://irc.libera.chat:6697"]
    assert (
        IrcAdapter.exclusive_resource(raw) == "the IRC nickname acme on irc.libera.chat"
    )


def test_classify_failure() -> None:
    assert IrcAdapter.classify_failure(IrcRegistrationError("no")) == "auth_failed"
    assert (
        IrcAdapter.classify_failure(ssl.SSLCertVerificationError()) == "config_invalid"
    )
    assert IrcAdapter.classify_failure(ValueError()) is None


async def test_verify_credentials_reports_the_servers_refusal(ircd: FakeIrcd) -> None:
    ircd.password = "right"
    raw = {
        "server": "127.0.0.1",
        "port": ircd.port,
        "tls": False,
        "nickname": "switch-bot",
    }
    with pytest.raises(BridgeCredentialError, match="password is wrong"):
        await IrcAdapter.verify_credentials(raw)


async def test_verify_credentials_accepts_a_working_server(ircd: FakeIrcd) -> None:
    raw = {"server": "127.0.0.1", "port": ircd.port, "tls": False, "nickname": "bot"}
    await IrcAdapter.verify_credentials(raw)
    quits = await ircd.wait_for("QUIT")
    assert quits


async def test_verify_credentials_names_an_unreachable_server() -> None:
    raw = {"server": "127.0.0.1", "port": 1, "tls": False, "nickname": "bot"}
    with pytest.raises(BridgeCredentialError, match="Could not connect to 127.0.0.1:1"):
        await IrcAdapter.verify_credentials(raw)


# ── The client's handshake ─────────────────────────────────────────────────


def settings(**overrides: Any) -> IrcSettings:
    values: dict[str, Any] = {
        "host": "irc.example.test",
        "port": 6697,
        "tls": False,
        "nickname": "switch-bot",
        "username": "switch",
    }
    values.update(overrides)
    return IrcSettings(**values)


async def _noop(_: Any) -> None:
    return None


async def test_sasl_login_and_capabilities(ircd: FakeIrcd) -> None:
    ircd.sasl_account = ("acme", "s3cret")
    client = IrcClient(
        settings(sasl_username="acme", sasl_password="s3cret"),
        _noop,
        opener=ircd.opener,
    )
    await client.connect(timeout=5)
    try:
        assert {"sasl", "message-tags", "account-tag"} <= client.caps
        assert any(line.startswith("AUTHENTICATE ") for line in ircd.lines)
    finally:
        await client.close()


async def test_sasl_failure_is_a_registration_error(ircd: FakeIrcd) -> None:
    ircd.sasl_account = ("acme", "s3cret")
    client = IrcClient(
        settings(sasl_username="acme", sasl_password="wrong"), _noop, opener=ircd.opener
    )
    with pytest.raises(IrcRegistrationError, match="SASL login failed"):
        await client.connect(timeout=5)


async def test_sasl_refused_when_the_server_does_not_offer_it(ircd: FakeIrcd) -> None:
    ircd.caps = "message-tags"
    client = IrcClient(
        settings(sasl_username="acme", sasl_password="pw"), _noop, opener=ircd.opener
    )
    with pytest.raises(IrcRegistrationError, match="does not offer SASL"):
        await client.connect(timeout=5)


async def test_taken_nickname_is_retried_with_a_suffix(ircd: FakeIrcd) -> None:
    ircd.taken_nicks = {"switch-bot"}
    client = IrcClient(settings(), _noop, opener=ircd.opener)
    await client.connect(timeout=5)
    try:
        assert client.nick == "switch-bot_"
    finally:
        await client.close()


async def test_client_answers_ping(ircd: FakeIrcd) -> None:
    client = IrcClient(settings(), _noop, opener=ircd.opener)
    await client.connect(timeout=5)
    try:
        await ircd.push("PING :token-1")
        assert await ircd.wait_for("PONG token-1")
    finally:
        await client.close()


async def test_token_bucket_paces_after_the_burst() -> None:
    now = [0.0]
    waits: list[float] = []

    async def sleep(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    bucket = TokenBucket(burst=3, interval=2.0, clock=lambda: now[0], sleep=sleep)
    for _ in range(5):
        await bucket.take()
    assert waits == [2.0, 2.0]


# ── Inbound ────────────────────────────────────────────────────────────────


async def test_start_joins_configured_channels_and_bridges_them(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#Ops, #deploys")
    try:
        await rec.until(lambda: len(rec.app_joins) == 2)
        assert [j.channel_id for j in rec.app_joins] == ["#ops", "#deploys"]
        assert rec.app_joins[0].channel_name == "#Ops"
    finally:
        await adapter.stop()


async def test_channel_message_becomes_an_inbound_message(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(
            f"@msgid=m1;account=alice-acct :alice!a@h PRIVMSG #Ops :{BOLD}hi{BOLD} all"
        )
        await rec.until(lambda: rec.messages)
        m = rec.messages[0]
        assert (m.channel_id, m.channel_type, m.channel_name) == (
            "#ops",
            "channel_public",
            "#Ops",
        )
        assert (m.sender_id, m.sender_name) == ("alice-acct", "alice")
        assert (m.content, m.message_ref) == ("**hi** all", "m1")
    finally:
        await adapter.stop()


async def test_sender_falls_back_to_the_nick_and_ref_is_minted(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":bob!b@h PRIVMSG #ops :hello")
        await rec.until(lambda: rec.messages)
        assert rec.messages[0].sender_id == "bob"
        assert rec.messages[0].message_ref.startswith("irc:")
    finally:
        await adapter.stop()


async def test_own_messages_and_ctcp_are_ignored_but_actions_kept(
    ircd: FakeIrcd,
) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":switch-bot!u@h PRIVMSG #ops :echoed back")
        await ircd.push(":bob!b@h PRIVMSG #ops :\x01VERSION\x01")
        await ircd.push(":bob!b@h PRIVMSG #ops :\x01ACTION waves\x01")
        await rec.until(lambda: rec.messages)
        assert [m.content for m in rec.messages] == ["_bob waves_"]
    finally:
        await adapter.stop()


async def test_bang_command_becomes_an_inbound_command(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":bob!b@h PRIVMSG #ops :!invite-agent reviewer now")
        await rec.until(lambda: rec.commands)
        c = rec.commands[0]
        assert (c.command, c.args, c.channel_id) == (
            "invite-agent",
            "reviewer now",
            "#ops",
        )
        assert rec.messages == []
    finally:
        await adapter.stop()


async def test_private_message_is_a_direct_room(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":Bob!b@h PRIVMSG switch-bot :psst")
        await rec.until(lambda: rec.messages)
        m = rec.messages[0]
        assert (m.channel_id, m.channel_type, m.channel_name) == (
            "bob",
            "direct",
            "Bob",
        )
    finally:
        await adapter.stop()


async def test_addressing_an_agent_irc_style_mentions_it(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await adapter.create_agent_identity(
            AgentIdentity(
                agent_id="a1", name="reviewer", description="", display_name=None
            )
        )
        await ircd.push(":bob!b@h PRIVMSG #ops :Reviewer: look at #12")
        await ircd.push(":bob!b@h PRIVMSG #ops :stranger: not an agent")
        await rec.until(lambda: len(rec.messages) == 2)
        assert [m.content for m in rec.messages] == [
            "@reviewer look at #12",
            "stranger: not an agent",
        ]
    finally:
        await adapter.stop()


async def test_someone_joining_is_a_user_join(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":carol!c@h JOIN #ops")
        await rec.until(lambda: rec.user_joins)
        j = rec.user_joins[0]
        assert (j.channel_id, j.external_username) == ("#ops", "carol")
    finally:
        await adapter.stop()


async def test_invite_brings_the_channel_in(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await ircd.push(":carol!c@h INVITE switch-bot #team")
        await rec.until(lambda: rec.app_joins)
        assert rec.app_joins[0].channel_id == "#team"
    finally:
        await adapter.stop()


async def test_kick_stops_the_bridge_rejoining(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        await ircd.push(":op!o@h KICK #ops switch-bot :bye")
        await ircd.push("PING :sync")
        await ircd.wait_for("PONG sync")
        assert "#ops" not in adapter._wanted
    finally:
        await adapter.stop()


# ── Outbound ───────────────────────────────────────────────────────────────


async def test_send_prefixes_the_agent_and_renders_markdown(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        ref = await adapter.send_message(
            "#ops", "deployer", adapter.translate_outbound("**Shipped** v2")
        )
        assert ref is not None and ref.startswith("irc:")
        sent = await ircd.wait_for("PRIVMSG #ops")
        assert (
            parse_line(sent[0]).params[1]
            == f"{BOLD}deployer{BOLD}: {BOLD}Shipped{BOLD} v2"
        )
    finally:
        await adapter.stop()


async def test_long_messages_are_split_inside_the_line_limit(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        body = " ".join(f"word{i}" for i in range(400))
        await adapter.send_message("#ops", "writer", body)
        sent = await ircd.wait_for("PRIVMSG #ops", count=2)
        await asyncio.sleep(0.05)
        sent = [line for line in ircd.lines if line.startswith("PRIVMSG #ops")]
        relayed_prefix = len(":switch-bot!" + "u" * 10 + "@" + "h" * 63 + " ")
        assert all(len(line.encode()) + 2 + relayed_prefix <= 512 for line in sent)
        words = " ".join(parse_line(line).params[1].split(": ", 1)[1] for line in sent)
        assert words.split() == body.split()
    finally:
        await adapter.stop()


async def test_send_to_an_unjoined_channel_joins_first(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        await adapter.send_message("#later", "agent", "hi")
        await ircd.wait_for("PRIVMSG #later")
        joins = [i for i, line in enumerate(ircd.lines) if line == "JOIN #later"]
        msgs = [
            i for i, line in enumerate(ircd.lines) if line.startswith("PRIVMSG #later")
        ]
        assert joins and joins[0] < msgs[0]
    finally:
        await adapter.stop()


async def test_edit_and_delete_are_no_ops(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        before = len(ircd.lines)
        await adapter.update_message("#ops", "irc:1", "new")
        await adapter.delete_message("#ops", "irc:1")
        assert len(ircd.lines) == before
    finally:
        await adapter.stop()


async def test_typing_uses_the_ircv3_tag(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        await adapter.send_typing("#ops", "agent", True)
        assert await ircd.wait_for("@+typing=active TAGMSG #ops")
    finally:
        await adapter.stop()


async def test_a_quiet_copy_hands_sends_to_the_holder(ircd: FakeIrcd) -> None:
    relayed: list[dict[str, str]] = []
    quiet = IrcAdapter(config=make_config(), opener=ircd.opener)
    quiet.set_listening(False)
    quiet.set_holder_relay(relayed.append)
    rec = Recorder()
    await quiet.start(
        rec.on_message,
        rec.on_command,
        rec.on_agent_joined,
        rec.on_user_joined,
        rec.on_app_joined,
    )
    assert ircd.connections == 0
    await quiet.send_message("#ops", "agent", "hi")
    assert relayed == [
        {"kind": "send", "channel": "#ops", "sender": "agent", "content": "hi"}
    ]
    holder = await started(ircd, rec)
    try:
        await holder.receive_relayed(relayed[0])
        assert await ircd.wait_for("PRIVMSG #ops")
    finally:
        await holder.stop()


async def quiet_copy(
    ircd: FakeIrcd, rec: Recorder, relayed: list[dict[str, str]]
) -> IrcAdapter:
    """A second pod's copy of the bridge: it never connects, and hands the
    holder what only the holder can do."""
    quiet = IrcAdapter(config=make_config(), opener=ircd.opener)
    quiet.set_listening(False)
    quiet.set_holder_relay(relayed.append)
    await quiet.start(
        rec.on_message,
        rec.on_command,
        rec.on_agent_joined,
        rec.on_user_joined,
        rec.on_app_joined,
    )
    return quiet


async def test_a_quiet_copy_creates_channels_through_the_holder(
    ircd: FakeIrcd,
) -> None:
    relayed: list[dict[str, str]] = []
    rec = Recorder()
    quiet = await quiet_copy(ircd, rec, relayed)
    holder = await started(ircd, rec)
    try:
        channel_id = await quiet.create_channel(
            "Release Planning!", "Plan v3", channel_type="channel_private"
        )
        # The same id the holder would have answered with.
        assert channel_id == "#release-planning"
        assert ircd.connections == 1
        assert relayed == [
            {
                "kind": "create",
                "channel": "#release-planning",
                "topic": "Plan v3",
                "channel_type": "channel_private",
            }
        ]
        await holder.receive_relayed(relayed[0])
        assert await ircd.wait_for("JOIN #release-planning")
        assert await ircd.wait_for("MODE #release-planning +is")
        assert await ircd.wait_for("TOPIC #release-planning :Plan v3")
        # Made by Switch, so no room is made a second time from the join.
        assert not rec.app_joins
    finally:
        await holder.stop()


async def test_a_relayed_create_leaves_someones_channel_alone(
    ircd: FakeIrcd,
) -> None:
    ircd.members["#ops"] = ["alice"]
    relayed: list[dict[str, str]] = []
    rec = Recorder()
    quiet = await quiet_copy(ircd, rec, relayed)
    holder = await started(ircd, rec)
    try:
        assert await quiet.create_channel("ops", "") == "#ops"
        # The holder refuses as it would have for itself, and does not raise
        # into the signal bus that carried the request.
        await holder.receive_relayed(relayed[0])
        assert await ircd.wait_for("PART #ops")
    finally:
        await holder.stop()


async def test_a_quiet_copy_invites_through_the_holder(ircd: FakeIrcd) -> None:
    relayed: list[dict[str, str]] = []
    rec = Recorder()
    quiet = await quiet_copy(ircd, rec, relayed)
    holder = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        failed = await quiet.add_users_to_channel(
            "#ops", ["dave", "erin", "not a nick"], ["d1", "e1", "x y"]
        )
        # Only the nicknames IRC could never invite fail; the rest go on.
        assert failed == ["x y"]
        assert relayed == [{"kind": "invite", "channel": "#ops", "nicks": "dave\nerin"}]
        await holder.receive_relayed(relayed[0])
        assert await ircd.wait_for("INVITE dave #ops")
        assert await ircd.wait_for("INVITE erin #ops")
    finally:
        await holder.stop()


async def test_a_quiet_copy_with_nobody_to_invite_relays_nothing(
    ircd: FakeIrcd,
) -> None:
    relayed: list[dict[str, str]] = []
    quiet = await quiet_copy(ircd, Recorder(), relayed)
    assert await quiet.add_users_to_channel("#ops", ["not a nick"], ["x y"]) == ["x y"]
    assert await quiet.add_users_to_channel("dave", ["dave"], ["d1"]) == ["d1"]
    assert relayed == []


async def test_a_quiet_copy_hands_subscriptions_to_the_holder(
    ircd: FakeIrcd,
) -> None:
    relayed: list[dict[str, str]] = []
    rec = Recorder()
    quiet = await quiet_copy(ircd, rec, relayed)
    holder = await started(ircd, rec)
    try:
        await quiet.ensure_channel_subscriptions(
            [("#bound", "channel_public"), ("dave", "direct"), ("#two", "group")]
        )
        assert relayed == [{"kind": "join", "channels": "#bound\n#two"}]
        await holder.receive_relayed(relayed[0])
        assert await ircd.wait_for("JOIN #bound")
        assert await ircd.wait_for("JOIN #two")
        # Wanted on the holder now, so a reconnect joins them again.
        assert {"#bound", "#two"} <= set(holder._wanted)
        # Nothing to hand over when no channel is bound.
        await quiet.ensure_channel_subscriptions([("dave", "direct")])
        assert len(relayed) == 1
    finally:
        await holder.stop()


async def test_the_holder_ignores_a_relayed_request_it_does_not_know(
    ircd: FakeIrcd,
) -> None:
    rec = Recorder()
    holder = await started(ircd, rec)
    try:
        before = len(ircd.lines)
        await holder.receive_relayed({"kind": "mystery"})
        assert len(ircd.lines) == before
    finally:
        await holder.stop()


async def test_sending_while_disconnected_says_so() -> None:
    adapter = IrcAdapter(config=make_config())
    with pytest.raises(BridgeOperationError, match="not connected"):
        await adapter.send_message("#ops", "agent", "hi")


# ── Channels ───────────────────────────────────────────────────────────────


async def test_create_channel_in_an_empty_channel(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        channel_id = await adapter.create_channel(
            "Release Planning!", "Plan v3", channel_type="channel_private"
        )
        assert channel_id == "#release-planning"
        assert await ircd.wait_for("TOPIC #release-planning :Plan v3")
        assert "MODE #release-planning +is" in ircd.lines
        # The room is being created by the caller; the join must not make another.
        assert rec.app_joins == []
    finally:
        await adapter.stop()


async def test_create_channel_will_not_take_over_someones_channel(
    ircd: FakeIrcd,
) -> None:
    ircd.members["#ops"] = ["alice"]
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        with pytest.raises(BridgeOperationError, match="already exists"):
            await adapter.create_channel("ops", "")
        assert await ircd.wait_for("PART #ops")
    finally:
        await adapter.stop()


async def test_create_channel_reports_a_refused_join(ircd: FakeIrcd) -> None:
    ircd.refusals["#locked"] = "473"
    rec = Recorder()
    adapter = await started(ircd, rec)
    try:
        with pytest.raises(BridgeOperationError, match="invite-only"):
            await adapter.create_channel("locked", "")
    finally:
        await adapter.stop()


async def test_add_users_invites_them(ircd: FakeIrcd) -> None:
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await rec.until(lambda: rec.app_joins)
        failed = await adapter.add_users_to_channel(
            "#ops", ["dave", "not a nick"], ["d1", "x y"]
        )
        assert failed == ["x y"]
        assert await ircd.wait_for("INVITE dave #ops")
    finally:
        await adapter.stop()


async def test_channel_types() -> None:
    adapter = IrcAdapter(config=make_config())
    assert await adapter.get_channel_type("#ops") == "channel_public"
    assert await adapter.get_channel_type("bob") == "direct"


# ── Staying connected ──────────────────────────────────────────────────────


async def test_reconnects_and_rejoins_after_the_link_drops(
    ircd: FakeIrcd, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(irc_adapter, "RECONNECT_FIRST", 0.01)
    rec = Recorder()
    adapter = await started(ircd, rec, channels="#ops")
    try:
        await adapter.ensure_channel_subscriptions([("#bound", "channel_public")])
        await ircd.wait_for("JOIN #bound")
        await ircd.drop()
        await ircd.wait_for("JOIN #bound", count=2)
        assert ircd.connections == 2
        assert len(await ircd.wait_for("JOIN #ops", count=2)) == 2
    finally:
        await adapter.stop()
