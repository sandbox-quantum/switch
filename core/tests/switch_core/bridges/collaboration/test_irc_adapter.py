from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest

from switch_core.bridges.collaboration.adapter import RequestCard, RichContentFailed
from switch_core.bridges.collaboration.irc import adapter as irc_adapter_module
from switch_core.bridges.collaboration.irc.adapter import IrcAdapter
from switch_core.bridges.collaboration.irc.client import IrcClient
from switch_core.bridges.collaboration.irc.config import IrcConnectionConfig
from switch_core.bridges.collaboration.irc.protocol import parse
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

from .irc_server import WireServer
from .test_session_neutral_forms import REFERENCE, _approval, _option
from .test_session_settled_cards import _settled


@pytest.fixture
async def wire(monkeypatch):
    monkeypatch.setenv("OUTBOUND_ALLOWED_PRIVATE_HOSTS", "127.0.0.1/32")
    server = await WireServer().start()
    yield server
    await server.stop()


async def start_adapter(wire, *, listening=True, channels="#room", mapping=None):
    adapter = IrcAdapter(
        config=IrcConnectionConfig(
            server="127.0.0.1",
            port=wire.port,
            tls=False,
            nick="switch",
            channels=channels,
            network_case_mapping=mapping,
        )
    )
    adapter.set_listening(listening)
    adapter.set_outbound_policy(OutboundPolicy.parse("127.0.0.1/32"))
    callbacks = [AsyncMock() for _ in range(5)]
    await adapter.start(*callbacks)
    return adapter, callbacks


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)


async def test_normal_entry_points_relay_messages_and_commands(wire):
    adapter, callbacks = await start_adapter(wire)
    try:
        await wire.emit(
            "@account=alice;msgid=inbound-1 :bob!u@h PRIVMSG #room :@coder hello"
        )
        await wire.emit(
            "@account=alice;msgid=inbound-2 :bob!u@h PRIVMSG #room :!agents"
        )
        await until(lambda: callbacks[0].call_count == callbacks[1].call_count == 1)
        message = callbacks[0].call_args.args[0]
        assert message.sender_id == "account:alice"
        assert message.sender_name == "bob"
        assert message.message_ref == "inbound-1"
        assert message.channel_type == "channel_public"
        assert callbacks[1].call_args.args[0].command == "agents"
        assert await adapter.send_message("#room", "coder", "hello")
        sent = [line for line in wire.received if line.command == "PRIVMSG"]
        assert sent[-1].params == ("#room", "<coder> hello")
        await asyncio.sleep(0.02)
        assert callbacks[0].call_count == 1
    finally:
        await adapter.stop()


async def test_private_channel_mode_is_known_before_app_join_callback(wire):
    wire.modes["#room"] = "+nts"
    adapter, callbacks = await start_adapter(wire)
    try:
        await until(lambda: callbacks[4].call_count == 1)
        assert callbacks[4].call_args.args[0].channel_type == "channel_private"
        assert await adapter.get_channel_type("#room") == "channel_private"
        corrected = AsyncMock()
        adapter.set_channel_type_handler(corrected)
        await wire.emit(":operator!u@h MODE #room :-s")
        await until(lambda: corrected.call_count == 1)
        assert corrected.call_args.args == ("#room", "channel_public")
    finally:
        await adapter.stop()


async def test_invitation_uses_verified_current_nick_and_rejects_an_impostor(wire):
    wire.accounts = {"bob": "alice", "alice": "someone_else"}
    adapter, _ = await start_adapter(wire)
    try:
        await wire.emit("@account=alice;msgid=known-user :bob!u@h PRIVMSG #room :hello")
        await until(lambda: "alice" in adapter.client.account_nicks)
        assert (
            await adapter.add_users_to_channel("#room", ["alice"], ["account:alice"])
            == []
        )
        invites = [line for line in wire.received if line.command == "INVITE"]
        assert invites[-1].params == ("bob", "#room")
        assert await adapter.add_users_to_channel(
            "#room", ["alice"], ["account:unknown"]
        ) == ["account:unknown"]
        assert await adapter.add_users_to_channel(
            "#room", ["alice"], ["nick:alice"]
        ) == ["nick:alice"]
    finally:
        await adapter.stop()


async def test_private_creation_confirms_modes_and_suppresses_auto_adoption(wire):
    adapter, callbacks = await start_adapter(wire, channels="")
    try:
        channel = await adapter.create_channel(
            "release", "topic", channel_type="channel_private"
        )
        assert {"s", "i"} <= adapter.client.modes[channel]
        await adapter.send_message(channel, "coder", "private payload")
        assert callbacks[4].call_count == 0
        commands = [line.command for line in wire.received]
        assert commands.index("MODE") < commands.index("PRIVMSG")
    finally:
        await adapter.stop()


async def test_refused_private_modes_block_later_payloads(wire):
    wire.refuse_modes = True
    adapter, _ = await start_adapter(wire, channels="")
    try:
        with pytest.raises(BridgeOperationError, match="refused|did not confirm"):
            await adapter.create_channel("private", "", channel_type="channel_private")
        channel = next(iter(adapter.client.joined))
        assert not adapter._creating
        with pytest.raises(BridgeOperationError, match="privacy"):
            await adapter.send_message(channel, "coder", "must not reach IRC")
        assert not any(line.command == "PRIVMSG" for line in wire.received)
    finally:
        await adapter.stop()


async def test_quiet_pod_relays_create_and_send_in_order(wire):
    holder, _ = await start_adapter(wire, channels="")
    quiet, _ = await start_adapter(wire, listening=False, channels="", mapping="ascii")
    relayed = []
    quiet.set_holder_relay(relayed.append)
    try:
        assert wire.connections == 1
        channel = await quiet.create_channel(
            "release", "", channel_type="channel_private"
        )
        await quiet.send_message(channel, "coder", "private relay")
        for request in relayed:
            await holder.receive_relayed(request)
        await holder._relay_queue.join()
        assert holder.client.private(channel)
        assert any(
            line.command == "PRIVMSG" and line.params[1] == "<coder> private relay"
            for line in wire.received
        )
        assert wire.connections == 1
    finally:
        await quiet.stop()
        await holder.stop()


async def test_registration_saves_server_case_mapping_for_quiet_pods(wire):
    wire.mapping = "rfc1459"
    config = {"server": "127.0.0.1", "port": wire.port, "tls": False, "nick": "switch"}
    await IrcAdapter.verify_credentials(config)
    assert config["network_case_mapping"] == "rfc1459"
    quiet = IrcAdapter(config=IrcConnectionConfig.model_validate(config))
    assert quiet.canonical("#Ops[Prod]") == "#ops{prod}"


async def test_reconnect_rejoins_channels(wire):
    adapter, _ = await start_adapter(wire)
    try:
        wire.writers[-1].close()
        await until(
            lambda: wire.connections == 2 and adapter.client._writer is not None
        )
        await adapter.client.join("#room")
        assert await adapter.send_message("#room", "coder", "after reconnect")
    finally:
        await adapter.stop()


async def test_registration_failure_preserves_error_during_slow_tls_shutdown():
    closed = asyncio.get_running_loop().create_future()
    writer = AsyncMock()
    writer.close = lambda: None

    async def wait_closed():
        await closed

    writer.wait_closed.side_effect = wait_closed
    client = IrcClient(
        IrcConnectionConfig(server="irc.example.org", nick="switch"),
        AsyncMock(),
        AsyncMock(),
    )
    client._open = AsyncMock(return_value=(AsyncMock(), writer))
    client._register = AsyncMock(side_effect=BridgeCredentialError("refused"))
    try:
        with pytest.raises(BridgeCredentialError, match="refused"):
            await client.start()
        assert not closed.cancelled()
    finally:
        if not closed.done():
            closed.set_result(None)
        await client.stop()


async def test_anonymous_dm_gets_login_hint_without_creating_a_room(wire):
    adapter, callbacks = await start_adapter(wire)
    try:
        await wire.emit(":visitor!u@h PRIVMSG switch :hello")
        await until(lambda: any(line.command == "NOTICE" for line in wire.received))
        assert callbacks[0].call_count == callbacks[1].call_count == 0
        notice = next(line for line in wire.received if line.command == "NOTICE")
        assert notice.params[0] == "visitor"
        assert "Sign in" in notice.params[1]
    finally:
        await adapter.stop()


async def test_kick_clears_cached_membership_before_the_next_send(wire):
    adapter, _ = await start_adapter(wire)
    try:
        await wire.emit(":operator!u@h KICK #room switch :testing")
        await until(lambda: "#room" not in adapter.client.joined)
        assert adapter.client.private("#room")
        await adapter.send_message("#room", "coder", "after rejoining")
        assert sum(line.command == "JOIN" for line in wire.received) == 2
    finally:
        await adapter.stop()


async def test_server_refused_messages_and_invites_are_not_success(wire):
    wire.refuse_messages = wire.refuse_invites = True
    wire.accounts = {"alice": "alice"}
    adapter, _ = await start_adapter(wire)
    try:
        with pytest.raises(BridgeOperationError, match="refused the message"):
            await adapter.send_message("#room", "coder", "refused")
        assert await adapter.add_users_to_channel(
            "#room", ["alice"], ["account:alice"]
        ) == ["account:alice"]
    finally:
        await adapter.stop()


async def test_maximum_channel_name_and_unicode_payload_fit_relayed_lines(wire):
    channel = "#" + "r" * 199
    adapter, _ = await start_adapter(wire, channels=channel)
    try:
        text = "🙂" * 200
        await adapter.send_message(channel, "coder", text)
        sent = [line for line in wire.received if line.command == "PRIVMSG"]
        assert "".join(line.params[1].removeprefix("<coder> ") for line in sent) == text
        assert all(
            len(f":switch!u@localhost PRIVMSG {channel} :{line.params[1]}\r\n".encode())
            <= 512
            for line in sent
        )
    finally:
        await adapter.stop()


async def test_rfc1459_equivalent_wire_targets_share_one_room(wire):
    wire.mapping = "rfc1459"
    adapter, callbacks = await start_adapter(
        wire, channels="#Ops[Prod]", mapping="rfc1459"
    )
    try:
        await wire.emit(
            "@account=alice;msgid=case-1 :alice!u@h PRIVMSG #OPS{PROD} :hello"
        )
        await until(lambda: callbacks[0].call_count == 1)
        assert callbacks[0].call_args.args[0].channel_id == "#ops{prod}"
        assert await adapter.get_channel_type("#ops{prod}") == "channel_public"
    finally:
        await adapter.stop()


async def test_failed_quiet_private_creation_blocks_queued_payload(wire):
    wire.refuse_modes = True
    holder, _ = await start_adapter(wire, channels="")
    quiet, _ = await start_adapter(wire, listening=False, channels="", mapping="ascii")
    relayed = []
    quiet.set_holder_relay(relayed.append)
    try:
        channel = await quiet.create_channel(
            "release", "", channel_type="channel_private"
        )
        await quiet.send_message(channel, "coder", "must stay private")
        for request in relayed:
            await holder.receive_relayed(request)
        await holder._relay_queue.join()
        assert channel in holder._unusable_channels
        assert not any(line.command == "PRIVMSG" for line in wire.received)
    finally:
        await quiet.stop()
        await holder.stop()


@pytest.mark.parametrize("fails", [False, True])
async def test_history_checkpoint_waits_for_replay_and_successful_delivery(fails):
    delivered = []

    async def receive(event):
        if getattr(event, "command", None) == "PRIVMSG":
            delivered.append(event.params[1])
            if fails and event.params[1] == "old":
                raise RuntimeError("inbound store refused delivery")

    client = IrcClient(
        IrcConnectionConfig(server="irc.example.org", nick="switch"),
        AsyncMock(),
        receive,
    )
    client.caps = {
        "server-time",
        "message-tags",
        "batch",
        "draft/chathistory",
        "draft/read-marker",
    }
    sent = Mock()
    client._enqueue = sent
    dispatcher = asyncio.create_task(client._dispatch())
    try:
        await client._handle(parse(":switch!u@h JOIN :#room"))
        await client._handle(
            parse(":server MARKREAD #room timestamp=2026-01-01T00:00:00Z")
        )
        await client._handle(parse(":server BATCH +history chathistory #room"))
        await client._handle(
            parse(
                "@time=2026-01-01T00:00:03Z;account=alice :alice!u@h PRIVMSG #room :live"
            )
        )
        await client._handle(
            parse(
                "@batch=history;time=2026-01-01T00:00:01Z;account=alice :alice!u@h PRIVMSG #room :old"
            )
        )
        await client._events.join()
        assert not any(
            call.args[0] == "MARKREAD" and len(call.args) == 3
            for call in sent.call_args_list
        )
        await client._handle(parse(":server BATCH -history"))
        await client._events.join()
        checkpoints = [
            call.args
            for call in sent.call_args_list
            if call.args[0] == "MARKREAD" and len(call.args) == 3
        ]
        assert checkpoints == (
            [] if fails else [("MARKREAD", "#room", "timestamp=2026-01-01T00:00:03Z")]
        )
        assert delivered == ["live", "old"]
    finally:
        dispatcher.cancel()
        await asyncio.gather(dispatcher, return_exceptions=True)


async def test_retirement_waits_for_part_and_rebind_joins_again(wire):
    adapter, _ = await start_adapter(wire)
    try:
        assert (await adapter.retire_channel("#room")).outcome == "left"
        assert "#room" not in adapter.client.joined
        assert "#room" not in adapter.client.desired_channels
        assert (await adapter.retire_channel("#room")).outcome == "left"
        await adapter.ensure_channel_subscriptions([("#room", "channel_public")])
        assert "#room" in adapter.client.joined
    finally:
        await adapter.stop()


async def test_cancelled_queued_send_is_not_written_later():
    client = IrcClient(
        IrcConnectionConfig(server="irc.example.org", nick="switch"),
        AsyncMock(),
        AsyncMock(),
    )
    writer = AsyncMock()
    writer.write = Mock()
    client._writer = writer
    pending = client._enqueue("PRIVMSG", "#room", "cancelled")
    pending.cancel()
    sender = asyncio.create_task(client._send_queued())
    try:
        await client._outbox.join()
        writer.write.assert_not_called()
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


async def test_text_approval_cards_keep_numbered_answers_and_publish_one_outcome():
    adapter = IrcAdapter(
        config=IrcConnectionConfig(server="irc.example.org", nick="switch")
    )
    adapter.send_message = AsyncMock(return_value="card-post")
    card = RequestCard(
        request=_approval(_option("allow", "Allow once"), _option("deny", "Deny")),
        reference=REFERENCE,
    )
    ref = await adapter.post_rich("#room", "coder", card)
    text = adapter.send_message.call_args.args[2]
    assert "R42" in text and "Allow once" in text and "Deny" in text
    assert "R42 1" in text
    await adapter.update_rich("#room", "coder", ref, card, None)
    assert adapter.send_message.call_count == 1
    settled = RequestCard(request=_settled(), reference=REFERENCE)
    await adapter.update_rich("#room", "coder", ref, settled, None)
    await adapter.update_rich("#room", "coder", ref, settled, None)
    assert adapter.send_message.call_count == 2
    assert "Allow once" in adapter.send_message.call_args.args[2]


async def test_card_post_refusal_uses_the_existing_rich_failure_contract():
    adapter = IrcAdapter(
        config=IrcConnectionConfig(server="irc.example.org", nick="switch")
    )
    adapter.send_message = AsyncMock(side_effect=BridgeOperationError("refused"))
    card = RequestCard(
        request=_approval(_option("allow", "Allow once")), reference=REFERENCE
    )
    with pytest.raises(RichContentFailed, match="refused"):
        await adapter.post_rich("#room", "coder", card)


async def test_credential_check_refuses_private_targets_without_allowlisting(
    monkeypatch,
):
    monkeypatch.delenv("OUTBOUND_ALLOWED_PRIVATE_HOSTS", raising=False)
    with pytest.raises(OutboundURLRefused, match="not a public address"):
        await IrcAdapter.verify_credentials(
            {"server": "127.0.0.1", "nick": "switch", "tls": False}
        )


async def test_late_whois_reply_cannot_authenticate_a_later_lookup():
    client = IrcClient(
        IrcConnectionConfig(server="irc.example.org", nick="switch"),
        AsyncMock(),
        AsyncMock(),
    )
    client._enqueue = Mock()
    await client._handle(parse(":server 330 switch nickname alice :logged in"))
    lookup = asyncio.create_task(client.whois_account("nickname"))
    await asyncio.sleep(0)
    await client._handle(parse(":server 318 switch nickname :End of WHOIS"))
    assert await lookup is None


async def test_quiet_long_unicode_messages_fit_the_shared_signal_envelope(wire):
    quiet, _ = await start_adapter(wire, listening=False, channels="", mapping="ascii")
    relayed = []
    quiet.set_holder_relay(relayed.append)
    try:
        text = "🙂" * 3000
        await quiet.send_message("#room", "coder", text)
        assert len(relayed) > 1
        assert "".join(request["text"] for request in relayed) == text
        assert all(len(json.dumps(request).encode()) < 6000 for request in relayed)
        assert wire.connections == 0
    finally:
        await quiet.stop()


async def test_inviting_the_bot_joins_and_adopts_the_channel_after_modes(wire):
    adapter, callbacks = await start_adapter(wire, channels="")
    try:
        await wire.emit(":operator!u@h INVITE switch :#invited")
        await until(lambda: callbacks[4].call_count == 1)
        assert callbacks[4].call_args.args[0].channel_id == "#invited"
        assert "#invited" in adapter.client.joined
    finally:
        await adapter.stop()


async def test_quiet_operation_without_holder_route_fails_visibly(wire):
    quiet, _ = await start_adapter(wire, listening=False, channels="", mapping="ascii")
    try:
        with pytest.raises(BridgeOperationError, match="no route"):
            await quiet.send_message("#room", "coder", "hello")
    finally:
        await quiet.stop()


async def test_holder_requeues_relayed_work_after_a_transient_disconnect(monkeypatch):
    adapter = IrcAdapter(
        config=IrcConnectionConfig(server="irc.example.org", nick="switch")
    )
    adapter.client = Mock(connected=False)
    request = {
        "id": "relay-1",
        "action": "send",
        "channel": "#room",
        "text": "hello",
        "prefix": "<coder> ",
    }
    attempts = 0

    async def send_text(_channel, _text, _prefix):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise BridgeOperationError("IRC disconnected during the send")

    adapter._send_text = send_text
    monkeypatch.setattr(irc_adapter_module, "RELAY_RETRY_SECONDS", 0)
    worker = asyncio.create_task(adapter._run_relay())
    try:
        await adapter.receive_relayed(request)
        await asyncio.wait_for(adapter._relay_queue.join(), 1)
        assert attempts == 2
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)


async def test_restarting_existing_secret_channel_preserves_its_modes(wire):
    wire.modes["#room"] = "+nts"
    wire.names["#room"] = "@operator switch"
    adapter, _ = await start_adapter(wire)
    try:
        assert "#room" not in adapter.client.created_channels
        await adapter.ensure_channel_subscriptions([("#room", "channel_private")])
        assert adapter.client.modes["#room"] == set("nts")
        await adapter.send_message("#room", "coder", "private after restart")
        assert not any(
            line.command == "MODE" and len(line.params) > 1 for line in wire.received
        )
    finally:
        await adapter.stop()
