"""Templates that come with Switch: served on every workspace from the
package, the managed document where a template has two, never changed."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import yaml

from switch_core.agent_templates import repo_note
from switch_core.management.schemas import MAX_INSTRUCTIONS_BYTES
from switch_core.official_templates import (
    _SHIPPED,
    current_revision,
    document_in,
    official_template,
    official_templates,
    released_agent_fingerprints,
    revisions,
)
from switch_core.providers.registry import provider_ids
from switch_core.template_installs import fingerprints, render_agents
from switch_core.template_lint import lint_template

_REPO = Path(__file__).resolve().parents[3]
_PACKAGED = _REPO / "core" / "switch_core" / "official_templates"


_KNOWLEDGE = _REPO / "switch-expert" / "knowledge"
_PLAYBOOK = _PACKAGED / "switch-buddy" / "PLAYBOOK.md"


def test_the_switch_expert_copies_match_the_repository():
    """The package carries copies of switch-expert/ at the repository root;
    an edit to one side must reach the other."""
    for name in ("template.yaml", "template.console.yaml", "AGENT.md"):
        assert (_PACKAGED / "switch-expert" / name).read_text() == (
            _REPO / "switch-expert" / name
        ).read_text(), (
            f"core/switch_core/official_templates/switch-expert/{name} is stale"
        )


def test_the_server_serves_the_managed_document():
    served = official_template("official:switch-expert", switch_buddy=False)
    assert served is not None
    assert yaml.safe_load(served.content)["version"] == 2
    console = document_in(_PACKAGED / "switch-expert", agent_management=False)
    assert yaml.safe_load(console)["version"] == 1


def test_switch_expert_is_served_only_where_switch_buddy_is_not():
    """Buddy covers what the Switch expert does, so a server offers exactly
    one built-in assistant: buddy where it is served, the expert elsewhere."""
    assert [t.id for t in official_templates(switch_buddy=True)] == [
        "official:switch-buddy"
    ]
    assert official_template("official:switch-expert", switch_buddy=True) is None
    assert [t.id for t in official_templates(switch_buddy=False)] == [
        "official:switch-expert"
    ]


def test_the_knowledge_switch_buddy_reads_is_present():
    """switch-buddy reads switch-expert/knowledge/ from its clone of the
    repository at runtime; every file it is pointed at must exist."""
    for name in (
        "INDEX.md",
        "CONCEPTS.md",
        "PATTERNS.md",
        "RECIPES.md",
        "CHECKLIST.md",
        "GOTCHAS.md",
    ):
        assert (_KNOWLEDGE / name).is_file(), name
    assert (_REPO / "switch-expert" / "CORRECTIONS.md").is_file()
    instructions = (_PACKAGED / "switch-buddy" / "AGENT.md").read_text()
    assert "switch-expert/knowledge/INDEX.md" in instructions


def test_the_instructions_are_written_in_and_the_documents_are_clean():
    for switch_buddy in (True, False):
        for template in official_templates(switch_buddy):
            data = yaml.safe_load(template.content)
            agent = (
                next(iter(data["resources"].values()))
                if "resources" in data
                else data["agent"]
            )
            assert len(agent["instructions"]) > 1000
            result = lint_template(template.content)
            assert result.errors == [] and result.warnings == [], template.id


def test_every_official_template_s_instructions_fit_the_server_limit():
    """The server refuses longer agent instructions, so an AGENT.md past it
    is a template nobody can create."""
    for switch_buddy in (True, False):
        for template in official_templates(switch_buddy):
            data = yaml.safe_load(template.content)
            agents = (
                [r for r in data["resources"].values() if r["type"] == "agent"]
                if "resources" in data
                else [data["agent"]]
            )
            for agent in agents:
                # A template with a repo appends its note to the instructions.
                note = repo_note(agent["repo"]) if agent.get("repo") else ""
                size = len((agent["instructions"] + note).encode())
                assert size <= MAX_INSTRUCTIONS_BYTES, (template.id, size)


def test_switch_buddy_is_served_only_with_its_flag():
    assert [t.id for t in official_templates(switch_buddy=False)] == [
        "official:switch-expert"
    ]
    buddy = official_template("official:switch-buddy", switch_buddy=True)
    assert buddy is not None
    agent = yaml.safe_load(buddy.content)["resources"]["buddy"]
    assert agent["can_manage_agents"] is True
    assert agent["addressing"] == "owner-agents"


def test_switch_buddy_puts_itself_in_the_rooms_it_creates():
    """create_room does not add its caller, and an agent can only change a
    room it is in, so buddy is told to list itself and why."""
    instructions = " ".join(
        (_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split()
    )
    assert "put your own name in its `agent_names`" in instructions
    assert "`create_room` does not add you" in instructions
    assert "you can only change a room you are in" in instructions


def test_switch_buddy_describes_the_default_addressing():
    instructions = " ".join(
        (_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split()
    )
    assert "A new agent answers its owner and the owner's own agents" in instructions
    assert "A new agent answers only its owner" not in instructions


def test_an_unknown_official_id_is_none():
    assert official_template("official:nope", switch_buddy=True) is None


def test_a_release_records_a_revision_for_each_template_that_changed(
    tmp_path, monkeypatch
):
    """At release time, `record-all` adds a revision for each template whose
    files changed since its last one, after the ones already there, and
    leaves the others alone."""
    for shipped in _SHIPPED:
        shutil.copytree(_PACKAGED / shipped.slug, tmp_path / shipped.slug)
    monkeypatch.setattr(revisions, "_HERE", tmp_path)
    revisions.record_all()
    before = {s.slug: revisions.recorded(s.slug) for s in _SHIPPED}
    assert not any(revisions.stale(s.slug) for s in _SHIPPED)

    with (tmp_path / "switch-buddy" / "AGENT.md").open("a") as agent_md:
        agent_md.write("\nOne more thing.\n")

    assert revisions.stale("switch-buddy")
    assert not revisions.stale("switch-expert")
    assert revisions.record_all() == {"switch-buddy": len(before["switch-buddy"]) + 1}
    after = revisions.recorded("switch-buddy")
    assert after[:-1] == before["switch-buddy"]
    assert after[-1]["agents"] != before["switch-buddy"][-1]["agents"]
    assert revisions.recorded("switch-expert") == before["switch-expert"]
    assert revisions.record_all() == {}


def test_a_template_is_served_at_its_last_revision():
    buddy = official_template("official:switch-buddy", switch_buddy=True)
    assert buddy is not None
    assert buddy.version == revisions.recorded("switch-buddy")[-1]["revision"]
    assert buddy.version == current_revision("switch-buddy")


def test_what_a_revision_sets_on_its_agents_does_not_depend_on_who_runs_it():
    """Old agents are matched against the fingerprints of every revision,
    rendered with sample inputs; a person's own inputs must give the same."""
    for shipped in _SHIPPED:
        document = official_template(f"official:{shipped.slug}", True) or (
            official_template(f"official:{shipped.slug}", False)
        )
        assert document is not None
        sample = revisions.entry_for(_PACKAGED / shipped.slug)["agents"]
        inputs = {
            name: value
            for name, value in {"agent_name": "switch-buddy-zoe"}.items()
            if name in (yaml.safe_load(document.content).get("params") or {})
        }
        mine = render_agents(
            document.content,
            inputs,
            {
                "$creator": "zoe",
                "$creator_email": "zoe@example.com",
                "$date": "2026-10-26",
                "$timestamp": "1793000000",
            },
        )
        assert {k: fingerprints(v) for k, v in mine.items()} == sample, shipped.slug


def test_released_fingerprints_list_every_revision_newest_first():
    released = released_agent_fingerprints("switch-buddy")
    assert [revision for revision, _ in released] == list(
        range(current_revision("switch-buddy"), 0, -1)
    )
    assert all("buddy" in agents for _, agents in released)


def test_switch_buddy_offers_every_provider_switch_runs():
    """The template's provider param lists the providers to try in order; a
    provider added to Switch and not to it is one buddy is never created
    with outside Switch Console, which always names one."""
    template = yaml.safe_load(
        (_PACKAGED / "switch-buddy" / "template.yaml").read_text(encoding="utf-8")
    )
    assert sorted(template["params"]["provider"]["default"]) == sorted(provider_ids())


def test_switch_buddy_declares_the_inputs_switch_console_fills():
    """Switch Console fills these when it creates a buddy (create-buddy.ts),
    and the server refuses an input a template does not declare: dropping or
    renaming one stops every Console that sends it from creating a buddy."""
    template = yaml.safe_load(
        (_PACKAGED / "switch-buddy" / "template.yaml").read_text(encoding="utf-8")
    )
    assert {"agent_name", "provider", "machine"} <= set(template["params"])


def test_switch_buddy_s_icon_is_in_the_repository_where_its_link_points():
    """Every buddy any release ever created carries this link, and the chat
    apps load the picture from it: the file it names on the main branch must
    stay where it is, or every buddy's face breaks for every release at once."""
    template = yaml.safe_load(
        (_PACKAGED / "switch-buddy" / "template.yaml").read_text(encoding="utf-8")
    )
    prefix = "https://raw.githubusercontent.com/sandbox-quantum/switch/main/"
    icon_url = template["resources"]["buddy"]["icon_url"]
    assert icon_url.startswith(prefix), icon_url
    path = _REPO / icon_url.removeprefix(prefix)
    assert path.is_file(), (
        f"{path.relative_to(_REPO)} is gone, and every switch-buddy's icon links "
        "to it there. Put it back: older releases go on creating buddies with this link."
    )


def test_switch_buddy_makes_every_private_room_private_in_switch():
    """create_room defaults read and write visibility to public whatever the
    channel type, so a private onboarding room must name both as private or
    workspace nonmembers can find it and change its instructions."""
    text = (_PACKAGED / "switch-buddy" / "AGENT.md").read_text()
    items = re.split(r"\n\s*(?:- |\d+\. )", text)
    items += _PLAYBOOK.read_text().split("\n## ")
    private_rooms = [i for i in items if "channel_private" in i or "include_owner" in i]
    assert len(private_rooms) >= 3
    for item in private_rooms:
        item = " ".join(item.split())
        assert '`read_visibility` and `write_visibility` "private"' in item, item


def test_switch_buddy_has_itself_invited_to_a_chat_the_person_makes():
    """A chat the person makes holds only the agents they invite, and buddy
    must be in it to hand off there."""
    text = (_PACKAGED / "switch-buddy" / "AGENT.md").read_text()
    assert "`/invite_agent @<your-name>`" in text
    assert "`!invite-agent @<your-name>`" in text


def test_switch_buddy_tells_telegram_users_to_reply_to_the_bot():
    """Telegram privacy mode means the bot sees only commands and replies to
    its messages, so buddy must tell people to reply when mentioning agents."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    assert (
        "reply to the bot's message" in text
        or "reply to the Switch bot's message" in text
    )


def test_switch_buddy_offers_choices_in_its_question_form():
    """Switch draws a host's question form as a card with buttons on Slack and
    Discord, but only for one single-choice question, and hosts without forms
    need the choices as numbered text."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    assert "use your host's question form" in text
    assert "`AskUserQuestion`" in text
    assert "one single-choice question per form" in text
    assert "With no question form, list numbered options" in text
    # Form answers are not consent to create: the proposal is its own form.
    assert "end with a separate proposal" in text
    assert "create only after explicit confirmation" in text


def test_every_playbook_section_switch_buddy_is_pointed_at_exists():
    """switch-buddy reads the playbook from its clone of the repository when
    its instructions point at a section, so the path and each section named
    must exist as written."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    paths = re.findall(r"`switch/(\S+?PLAYBOOK\.md)`", text)
    assert paths
    for path in paths:
        assert (_REPO / path).resolve() == _PLAYBOOK.resolve(), path
    headings = set(re.findall(r"^## (.+)$", _PLAYBOOK.read_text(), re.MULTILINE))
    named = set(re.findall(r'§ "([^"]+)"', text))
    assert len(named) >= 10
    assert named - headings == set()


def test_switch_buddy_checks_the_services_an_agent_needs_before_proposing():
    """An agent created without the services its job needs guesses its way
    in, so buddy checks them first and offers the grant in the proposal."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    assert "Before proposing, check the services its job needs" in text
    assert "`get_my_context`" in text and "`set_agent_service`" in text
    assert "for a missing one, say so and link where to connect it" in text
    playbook = " ".join(_PLAYBOOK.read_text().split())
    assert "Only your owner's own agents, and only after a yes" in playbook
    assert "[Connectors](switchdash://open/connections)" in playbook


def test_switch_buddy_carries_on_without_its_playbook():
    """A fresh install may have no clone, and an older tag no playbook: that
    must pause only what needs the detail, never basic onboarding."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    assert "read it only if you need more" in text
    assert "pause only the action that needs the missing detail" in text
    assert "Never ask the person for the file" in text


def test_switch_buddy_always_tells_telegram_users_to_reply_to_the_bot():
    """In a Telegram group the bot sees only commands and replies to its own
    messages, so every Telegram walkthrough must say to reply, playbook or not."""
    text = " ".join((_PACKAGED / "switch-buddy" / "AGENT.md").read_text().split())
    assert "Every Telegram walkthrough, with or without the playbook" in text
    assert (
        "reply to a Switch bot message with the agent's exact name and their request"
        in text
    )
