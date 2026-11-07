"""The IRC adapter itself: config defaults and masking, declared capability
limits, failure classification, inbound dispatch (addressing, `!commands`,
own-echo, JOIN), and the disclosed degradation `update_message` /
`delete_message` use since IRC has no real edit or delete.
"""

from __future__ import annotations

import ssl

import pytest

from switch_core.bridges.collaboration.irc.adapter import (
    IRCAdapter,
    IRCConnectionConfig,
)
from switch_core.bridges.collaboration.irc.protocol import parse_line
from switch_core.bridges.collaboration.models import ChannelCreationUnsupported


def _config(**overrides: object) -> IRCConnectionConfig:
    base = dict(host="irc.example.net", nick="switchbot", channels=["#switch"])
    base.update(overrides)
    return IRCConnectionConfig(**base)  # type: ignore[arg-type]


def test_config_defaults_to_tls_with_verification_on() -> None:
    config = _config()
    assert config.use_tls is True
    assert config.verify_tls is True
    assert config.port == 6697


def test_sasl_and_server_password_fields_are_auto_masked_by_name() -> None:
    # Console masks any field whose name contains "token", "password",
    # "secret", "api_key", "private_key" or "credential" — asserted here so
    # a rename of either field silently loses that protection.
    schema = IRCConnectionConfig.model_json_schema()
    assert "password" in "sasl_password"
    assert "password" in "server_password"
    assert "sasl_password" in schema["properties"]
    assert "server_password" in schema["properties"]


def test_declares_no_channel_creation_no_directory_search() -> None:
    assert IRCAdapter.supports_channel_creation is False
    assert IRCAdapter.supports_directory_search is False


def test_keeps_quiet_unless_listening() -> None:
    assert IRCAdapter.keeps_quiet_unless_listening is True


async def test_create_channel_is_refused_not_faked() -> None:
    adapter = IRCAdapter(config=_config())
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("new-room", "topic")


def test_classify_failure_maps_tls_errors_to_network() -> None:
    assert IRCAdapter.classify_failure(ssl.SSLError("bad cert")) == "network"
    assert IRCAdapter.classify_failure(ValueError("unrelated")) is None


def test_outbound_urls_carries_the_real_host_and_port_for_the_ssrf_check() -> None:
    urls = IRCAdapter.outbound_urls(
        {"host": "irc.example.net", "nick": "b", "channels": ["#c"], "port": 6697}
    )
    assert urls == ["https://irc.example.net:6697"]


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, list[str]]] = []

    @property
    def nick(self) -> str:
        return "switchbot"

    async def send_line(self, command: str, params: list[str]) -> None:
        self.sent.append((command, params))


def _adapter_with_fake_client() -> tuple[IRCAdapter, _FakeClient]:
    adapter = IRCAdapter(config=_config())
    fake = _FakeClient()
    adapter._client = fake  # type: ignore[assignment]
    return adapter, fake


async def test_send_message_prefixes_every_line_with_the_agent_name() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.send_message("#switch", "AgentName", "hello\nworld")
    privmsgs = [p for cmd, p in fake.sent if cmd == "PRIVMSG"]
    assert len(privmsgs) == 2
    assert privmsgs[0] == ["#switch", "<AgentName> hello"]
    assert privmsgs[1] == ["#switch", "<AgentName> world"]


async def test_update_message_is_a_disclosed_follow_up_not_a_real_edit() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.update_message("#switch", "ref-1", "corrected text")
    [(_, params)] = fake.sent
    assert "edited" in params[1]
    assert "corrected text" in params[1]


async def test_delete_message_posts_a_removal_notice_rather_than_doing_nothing() -> (
    None
):
    adapter, fake = _adapter_with_fake_client()
    await adapter.delete_message("#switch", "ref-1")
    [(_, params)] = fake.sent
    assert "removed" in params[1]


async def test_send_typing_is_a_safe_no_op() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.send_typing("#switch", "AgentName", True)
    assert fake.sent == []


class _Recorder:
    def __init__(self) -> None:
        self.messages: list[object] = []
        self.commands: list[object] = []
        self.user_joins: list[object] = []
        self.app_joins: list[object] = []

    async def on_message(self, msg: object) -> None:
        self.messages.append(msg)

    async def on_command(self, cmd: object) -> None:
        self.commands.append(cmd)

    async def on_user_joined(self, join: object) -> None:
        self.user_joins.append(join)

    async def on_app_joined(self, join: object) -> None:
        self.app_joins.append(join)


def _wired_adapter() -> tuple[IRCAdapter, _Recorder]:
    adapter = IRCAdapter(config=_config())
    rec = _Recorder()
    adapter._on_message = rec.on_message
    adapter._on_command = rec.on_command
    adapter._on_user_joined = rec.on_user_joined
    adapter._on_app_joined = rec.on_app_joined
    return adapter, rec


async def test_an_ordinary_message_is_relayed() -> None:
    adapter, rec = _wired_adapter()
    line = parse_line(":alice!a@h PRIVMSG #switch :hello agent")
    await adapter._handle_line("switchbot", line)
    assert len(rec.messages) == 1
    assert rec.messages[0].content == "hello agent"  # type: ignore[attr-defined]
    assert rec.messages[0].sender_name == "alice"  # type: ignore[attr-defined]
    assert rec.commands == []


async def test_a_bang_prefixed_message_is_dispatched_as_a_command_not_a_message() -> (
    None
):
    adapter, rec = _wired_adapter()
    line = parse_line(":alice!a@h PRIVMSG #switch :!invite-agent Grok")
    await adapter._handle_line("switchbot", line)
    assert rec.messages == []
    assert len(rec.commands) == 1
    assert rec.commands[0].command == "invite-agent"  # type: ignore[attr-defined]
    assert rec.commands[0].args == "Grok"  # type: ignore[attr-defined]


async def test_the_bots_own_echoed_message_is_ignored() -> None:
    adapter, rec = _wired_adapter()
    line = parse_line(":switchbot!s@h PRIVMSG #switch :<AgentName> hi there")
    await adapter._handle_line("switchbot", line)
    assert rec.messages == []


async def test_a_direct_message_to_the_bot_is_dropped_not_relayed_to_a_room() -> None:
    adapter, rec = _wired_adapter()
    line = parse_line(":alice!a@h PRIVMSG switchbot :hey")
    await adapter._handle_line("switchbot", line)
    assert rec.messages == []


async def test_inbound_control_codes_are_stripped_before_the_message_is_built() -> None:
    adapter, rec = _wired_adapter()
    line = parse_line(":alice!a@h PRIVMSG #switch :\x02bold\x02 text")
    await adapter._handle_line("switchbot", line)
    assert rec.messages[0].content == "bold text"  # type: ignore[attr-defined]


async def test_own_join_is_reported_as_app_joined_others_as_user_joined() -> None:
    adapter, rec = _wired_adapter()
    await adapter._handle_line("switchbot", parse_line(":switchbot!s@h JOIN #switch"))
    await adapter._handle_line("switchbot", parse_line(":alice!a@h JOIN #switch"))
    assert len(rec.app_joins) == 1
    assert len(rec.user_joins) == 1
    assert rec.user_joins[0].external_user_id == "alice"  # type: ignore[attr-defined]


async def test_two_identical_messages_get_the_same_derived_event_id_without_msgid() -> (
    None
):
    adapter, rec = _wired_adapter()
    line = parse_line(":alice!a@h PRIVMSG #switch :repeat me")
    await adapter._handle_line("switchbot", line)
    await adapter._handle_line("switchbot", line)
    assert rec.messages[0].message_ref == rec.messages[1].message_ref  # type: ignore[attr-defined]


async def test_msgid_tag_is_used_as_the_event_id_when_present() -> None:
    adapter, rec = _wired_adapter()
    line = parse_line("@msgid=abc-123 :alice!a@h PRIVMSG #switch :hi")
    await adapter._handle_line("switchbot", line)
    assert rec.messages[0].message_ref == "abc-123"  # type: ignore[attr-defined]
