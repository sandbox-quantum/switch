"""A Discord thread made for a message is named from its text as people read
it, never from the raw mention markup Discord stores."""

from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.collaboration.discord.adapter import _thread_title


def test_mentions_read_as_names_and_unresolved_ones_are_dropped() -> None:
    resolved = SimpleNamespace(clean_content="@writer draft the launch notes")
    assert _thread_title(resolved) == "@writer draft the launch notes"
    unresolved = SimpleNamespace(clean_content="<@&123456> <#99>  please   look <@!42>")
    assert _thread_title(unresolved) == "please look"
    assert _thread_title(SimpleNamespace(clean_content="x" * 80)) == "x" * 60
    assert _thread_title(SimpleNamespace(clean_content="<@&1>")) == ""
