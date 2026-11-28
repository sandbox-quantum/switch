from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.irc.adapter import IrcAdapter
from switch_core.bridges.collaboration.irc.config import IrcConnectionConfig
from switch_core.bridges.collaboration.irc.markup import plain, render, split_lines
from switch_core.bridges.collaboration.irc.protocol import build, fold, parse


@pytest.mark.parametrize(
    ("mapping", "equivalent"),
    [("ascii", False), ("rfc1459", True), ("strict-rfc1459", True)],
)
def test_channel_names_follow_the_networks_case_mapping(mapping, equivalent):
    assert (fold("#Ops[Prod]", mapping) == fold("#ops{prod}", mapping)) is equivalent


def test_strict_rfc1459_keeps_caret_and_tilde_distinct():
    assert fold("a^", "strict-rfc1459") != fold("a~", "strict-rfc1459")
    assert fold("a^", "rfc1459") == fold("a~", "rfc1459")


def test_tag_escaping_and_trailing_parameters():
    line = parse(
        r"@account=alice;label=a\sb\:c\\d :bob!u@h PRIVMSG #room :hello : there"
        + "\r\n"
    )
    assert line.tags == {"account": "alice", "label": "a b;c\\d"}
    assert line.nick == "bob"
    assert line.params == ("#room", "hello : there")
    assert parse("PING :").params == ("",)


@pytest.mark.parametrize(
    "value", ["hello\r\nJOIN #other", "hello\x00there", "hello\nQUIT"]
)
def test_outbound_lines_refuse_command_injection(value):
    with pytest.raises(ValueError):
        build("PRIVMSG", "#room", value)


def test_line_limit_counts_utf8_bytes_and_crlf():
    assert len(build("PRIVMSG", "#r", "x" * 498)) == 512
    with pytest.raises(ValueError):
        build("PRIVMSG", "#r", "x" * 499)


def test_unicode_splitting_preserves_content_and_code_indentation():
    text = "    " + "🙂" * 100
    chunks = split_lines(text, 50)
    assert "".join(chunks) == text
    assert all(len(chunk.encode()) <= 50 for chunk in chunks)
    assert chunks[0].startswith("    ")


def test_formatting_and_links_are_readable_on_irc():
    assert plain("\x0304red\x0f \x02bold\x02") == "red bold"
    assert (
        render("**hello** [docs](https://example.com)\n```py\n    x = 1\n```")
        == "hello docs (https://example.com)\n    x = 1"
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"server": "https://irc.example.com"},
        {"nick": "bad nick"},
        {"channels": "not-a-channel"},
        {"tls": False, "account_password": "fixture-only"},
        {"tls": False, "server_password": "fixture-only"},
        {"account_password": "fixture\x00only"},
    ],
)
def test_invalid_connections_fail_before_a_socket_is_opened(changes):
    with pytest.raises(ValidationError):
        IrcConnectionConfig.model_validate(
            {"server": "irc.example.com", "nick": "switch", **changes}
        )


def test_derived_case_mapping_is_hidden_and_credentials_are_masked():
    schema = IrcConnectionConfig.model_json_schema()
    assert "network_case_mapping" not in schema["properties"]
    config = IrcConnectionConfig(
        server="irc.example.com", nick="switch", account_password="fixture-only"
    )
    assert "fixture-only" not in repr(config)
    assert config.tls is True


def test_bot_claim_is_stable_before_and_after_case_mapping_discovery():
    config = {"server": "irc.example.com", "nick": "switch[bot]"}
    assert IrcAdapter.claimed_workspace(config) == IrcAdapter.claimed_workspace(
        {**config, "network_case_mapping": "ascii"}
    )
    authenticated = {
        **config,
        "account": "switch-bot",
        "account_password": "fixture-only",
    }
    assert IrcAdapter.claimed_workspace(authenticated) == IrcAdapter.claimed_workspace(
        {**authenticated, "nick": "other-nick"}
    )


def test_labeled_lines_count_the_tag_in_the_irc_byte_limit():
    label = "a" * 32
    with pytest.raises(ValueError):
        build("PRIVMSG", "#r", "x" * 470, label=label)
    assert len(build("PRIVMSG", "#r", "x" * 440, label=label)) <= 512
