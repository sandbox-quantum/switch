"""switch-buddy tells people which control to press in Switch Console and the
Gateway by quoting its label. When an app renames a control, buddy goes on
sending people after a button that no longer exists, so every label it quotes
is listed here and must still be in the apps' source."""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[4]
_BUDDY = _REPO / "core" / "switch_core" / "official_templates" / "switch-buddy"
_BUDDY_FILES = ("AGENT.md", "PLAYBOOK.md")
_UI_ROOTS = (
    _REPO / "console" / "apps" / "switch-console-desktop" / "src" / "renderer",
    _REPO / "gateway" / "src",
)

# Every Console or Gateway control label switch-buddy's AGENT.md and
# PLAYBOOK.md quote: after a control verb, as the text of a link into Switch
# Console, or in its table of Console pages.
QUOTED_UI_LABELS = frozenset(
    {
        "Anyone",
        "Bypass permissions",
        "Connect a messaging app",
        "Connector apps",
        "Connectors",
        "Messaging apps",
        "Set up",
        "Start device",
        "Switch cloud",
        "Use your own app instead",
        "Who can talk to your agent",
    }
)

# Phrases the extraction below finds that are not a control's label.
NOT_A_LABEL = {
    "Add a new agent": "describes the page the link opens; its button says Add agent",
    "my settings": "buddy's own settings page, named as buddy speaks of it",
    "the server's home": "describes the page the link opens, which has no such title",
    "the server's page": "describes the page the link opens, which has no such title",
    "your agents": "describes the page the link opens, which has no such title",
}

_CONTROL_VERB = (
    r"\b(?:press|choose|pick|open|click|select|tap|turn on|under)\s+(?:the\s+)?"
)
_AFTER_A_VERB = re.compile(
    _CONTROL_VERB + r'(?:\*{1,2}([^*]+?)\*{1,2}|"([^"]+)")', re.IGNORECASE
)
_CONSOLE_LINK = re.compile(r"\[([^\]]+)\]\(switchdash://[^)]*\)")


def _buddy_text(name: str) -> str:
    return " ".join((_BUDDY / name).read_text(encoding="utf-8").split())


@cache
def _ui_source() -> str:
    """The apps' own source, without their tests, which quote labels too."""
    texts = []
    for root in _UI_ROOTS:
        for path in sorted(root.rglob("*.ts*")):
            if path.suffix not in (".ts", ".tsx"):
                continue
            if "tests" in path.relative_to(root).parts or ".test." in path.name:
                continue
            texts.append(path.read_text(encoding="utf-8"))
    return "\n".join(texts)


def _in_source(label: str, source: str) -> bool:
    """Whether `label` is a whole string literal or JSX text in `source`."""
    pattern = r"(?:['\"`>]|^)[ \t]*" + re.escape(label) + r"[ \t]*(?:['\"`<]|\$\{|$)"
    return re.search(pattern, source, re.MULTILINE) is not None


def _quoted_phrases(text: str) -> set[str]:
    phrases = {star or quote for star, quote in _AFTER_A_VERB.findall(text)}
    return phrases | set(_CONSOLE_LINK.findall(text))


def _files_quoting(phrase: str) -> list[str]:
    return [name for name in _BUDDY_FILES if phrase in _buddy_text(name)]


@pytest.mark.parametrize("label", sorted(QUOTED_UI_LABELS))
def test_every_label_switch_buddy_quotes_is_in_the_apps(label: str) -> None:
    quoted_in = _files_quoting(label)
    assert quoted_in, (
        f"{label!r} is in QUOTED_UI_LABELS but neither switch-buddy file quotes it any more: remove it"
    )
    found = _in_source(label, _ui_source())
    assert found, (
        f"switch-buddy ({' and '.join(quoted_in)}) quotes the control label {label!r}, "
        "but no string literal or JSX text in Switch Console or the Gateway says it. "
        "Change switch-buddy to the label the app shows now, and update QUOTED_UI_LABELS."
    )


@pytest.mark.parametrize("name", _BUDDY_FILES)
def test_every_control_switch_buddy_names_is_inventoried(name: str) -> None:
    unlisted = sorted(
        phrase
        for phrase in _quoted_phrases(_buddy_text(name))
        if phrase not in QUOTED_UI_LABELS and phrase not in NOT_A_LABEL
    )
    assert not unlisted, (
        f"switch-buddy's {name} names {unlisted} as a control (after a verb such as "
        "press or choose, or as a link into Switch Console). Add each to "
        "QUOTED_UI_LABELS if the app shows it as a label, or to NOT_A_LABEL with why not."
    )


def test_every_phrase_not_a_label_is_still_quoted() -> None:
    stale = sorted(phrase for phrase in NOT_A_LABEL if not _files_quoting(phrase))
    assert not stale, (
        f"no switch-buddy file quotes {stale} any more: remove from NOT_A_LABEL"
    )
