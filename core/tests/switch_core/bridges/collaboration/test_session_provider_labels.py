"""The renderer's list of "this label already said its own scope", against the
provider adapters that write those labels.

`_scope` suppresses its "(applies for the rest of this session)" suffix only
for labels it recognises whole. That is safe exactly as long as the list is the
labels Switch actually mints — a provider given a new wording, or an existing
one reworded, silently returns the duplicate this exists to stop, and nothing
in the Python tree would notice. So the list is checked against its source.

Recognition is one-directional on purpose. Every Switch-written
`acceptForSession` label must be recognised; the renderer may also carry a
label no adapter writes today, because a label removed from a provider is
still on cards already posted.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from switch_core.bridges.collaboration.session.renderers.neutral import (
    _LABELS_STATING_THE_SESSION,
)

PROVIDERS = Path(__file__).resolve().parents[5] / "console/packages/agent-providers/src"

# The two shapes an adapter declares one in: an entry in an options list, and a
# value in a decision-keyed record.
_IN_A_LIST = re.compile(
    r"decision:\s*'acceptForSession',\s*label:\s*'([^']+)'",
)
_IN_A_RECORD = re.compile(r"acceptForSession:\s*'([^']+)'")


def _written_labels() -> dict[str, str]:
    """Every `acceptForSession` label in the provider sources, by file."""
    found: dict[str, str] = {}
    for source in sorted(PROVIDERS.rglob("*-adapter.ts")):
        for pattern in (_IN_A_LIST, _IN_A_RECORD):
            for label in pattern.findall(source.read_text()):
                found[label] = source.name
    return found


def test_the_provider_sources_are_where_this_thinks_they_are():
    """A path that stopped resolving would make every check below vacuous, and
    a renaming of the declaration would empty them just as quietly."""
    assert PROVIDERS.is_dir(), PROVIDERS
    written = _written_labels()
    assert len(written) >= 3, written


@pytest.mark.parametrize("label", sorted(_written_labels()))
def test_a_label_switch_writes_is_one_the_renderer_recognises(label: str):
    """Add a provider, or reword one, and add it here: an unrecognised label
    gets the suffix, which on Claude Code's wording is the duplicate that sent
    us here in the first place."""
    assert " ".join(label.split()).casefold() in _LABELS_STATING_THE_SESSION, (
        f"{label!r} is written by {_written_labels()[label]} but is not in "
        "_LABELS_STATING_THE_SESSION"
    )
