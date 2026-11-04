"""What a template sets on its agents, and where a run's document came from."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.db.models import Template
from switch_core.official_templates import official_template
from switch_core.template_installs import (
    InstallSource,
    fingerprint,
    record_install,
    render_agents,
    vouched_source,
)


def _buddy() -> Any:
    buddy = official_template("official:switch-buddy", True, switch_buddy=True)
    assert buddy is not None
    return buddy


def test_equal_values_have_equal_fingerprints_and_none_is_a_value():
    assert fingerprint("a") == fingerprint("a")
    assert fingerprint("a") != fingerprint("b")
    assert fingerprint(None) != fingerprint("") != fingerprint("null")


def test_an_official_document_is_recognised_word_for_word():
    source = vouched_source(
        _buddy().content, None, agent_management=True, switch_buddy=True
    )
    assert source == InstallSource(
        "official", "official:switch-buddy", "switch-buddy", _buddy().version
    )


def test_an_official_document_is_not_recognised_where_it_is_not_served():
    assert (
        vouched_source(
            _buddy().content, None, agent_management=True, switch_buddy=False
        )
        is None
    )


def test_a_changed_document_has_no_source_even_naming_its_template():
    changed = _buddy().content + "\n# mine\n"
    assert (
        vouched_source(changed, None, agent_management=True, switch_buddy=True) is None
    )
    assert (
        vouched_source(changed, _buddy(), agent_management=True, switch_buddy=True)
        is None
    )


def test_a_saved_template_is_the_source_of_its_own_document():
    saved = Template(
        id="t-1", owner_id="u", name="helper", description="", kind="agent"
    )
    saved.content = "agent: {}\n"
    saved.version = 4
    assert vouched_source(
        "agent: {}\n", saved, agent_management=True, switch_buddy=True
    ) == InstallSource("saved", "t-1", "helper", 4)


def test_agents_are_rendered_by_their_template_key():
    rendered = render_agents(_buddy().content, {"agent_name": "switch-buddy-a"}, {})
    assert list(rendered) == ["buddy"]
    assert rendered["buddy"]["icon_url"] is not None
    assert rendered["buddy"]["instructions"]


async def test_a_failure_to_record_is_logged_and_the_run_stands(caplog):
    def broken() -> Any:
        raise RuntimeError("database gone")

    plan = SimpleNamespace(
        name="switch-buddy-a",
        instructions="i",
        description="d",
        icon_url=None,
        display_name=None,
    )
    with caplog.at_level(logging.ERROR):
        await record_install(
            broken,  # type: ignore[arg-type]
            "tenant",
            owner_id="u",
            source=InstallSource("official", "official:switch-buddy", "b", 1),
            document="agent: {}\n",
            inputs={},
            builtins={},
            plans=[plan],  # type: ignore[list-item]
            created=[{"name": "switch-buddy-a", "agent_id": "a-1"}],
        )
    assert "will not be updated" in caplog.text


@pytest.mark.parametrize("created", [[], [{"name": "someone", "agent_id": "x"}]])
async def test_a_run_that_created_none_of_its_agents_records_nothing(created):
    def untouched() -> Any:
        raise AssertionError("nothing should be written")

    await record_install(
        untouched,  # type: ignore[arg-type]
        "tenant",
        owner_id="u",
        source=InstallSource("official", "official:switch-buddy", "b", 1),
        document="agent: {}\n",
        inputs={},
        builtins={},
        plans=[SimpleNamespace(name="switch-buddy-a")],  # type: ignore[list-item]
        created=created,
    )
