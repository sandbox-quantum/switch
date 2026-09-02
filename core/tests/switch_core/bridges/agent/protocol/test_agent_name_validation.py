"""What an agent identifier may be.

`name` is the machine identifier: it is addressed, mentioned, derived into
subagent names, and used as the Matrix display name every bridge matches on.
The shape it accepts is therefore load-bearing, and pinned here so a widening
(a space, an uppercase letter) has to be a deliberate edit to this file rather
than a side effect of loosening the pattern.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.protocol.service import _VALID_NAME_RE


@pytest.mark.parametrize(
    "name",
    [
        "switchdev",
        "a",
        "9",
        "switch-dev",
        "switch_dev",
        "switch.dev",
        "claude-code.reviewer",
        "agent2",
    ],
)
def test_accepts_lowercase_identifiers(name: str) -> None:
    assert _VALID_NAME_RE.match(name) is not None


@pytest.mark.parametrize(
    "name",
    [
        "",
        "Switch Dev",
        "SwitchDev",
        "switch dev",
        "-switch",
        "_switch",
        ".switch",
        "switch/dev",
        "switch:dev",
        "switch@dev",
        "switch\ndev",
        "switch\tdev",
        " switchdev",
        "switchdev ",
        "switchdev\n",
        "switch-dev\n",
        "switchdev\r",
        "swítchdev",
    ],
)
def test_rejects_anything_else(name: str) -> None:
    assert _VALID_NAME_RE.match(name) is None
