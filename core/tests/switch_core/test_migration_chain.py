"""The migration chain is well-formed.

The test suite builds its schema with `Base.metadata.create_all`, so nothing
else here ever loads the migrations — a duplicated revision id or a second
head passes every other test and only fails on a real deployment. These are
cheap enough to run everywhere and catch exactly that class of mistake.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

_CORE = Path(__file__).resolve().parents[2]
_VERSIONS = _CORE / "switch_core" / "migrations" / "versions"

_REVISION_RE = re.compile(r'^revision: str = "([^"]+)"', re.MULTILINE)


def _script_directory() -> ScriptDirectory:
    config = Config(str(_CORE / "alembic.ini"))
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def test_revision_ids_are_unique() -> None:
    """Two files declaring the same revision id make the graph ambiguous.

    Read from the files rather than through Alembic: Alembic resolves the
    collision itself and the duplicate would go unnoticed here.
    """
    by_revision: dict[str, list[str]] = defaultdict(list)
    for path in _VERSIONS.glob("*.py"):
        match = _REVISION_RE.search(path.read_text())
        if match is not None:
            by_revision[match.group(1)].append(path.name)

    duplicates = {rev: files for rev, files in by_revision.items() if len(files) > 1}
    assert not duplicates, f"duplicate migration revision ids: {duplicates}"


def test_single_head() -> None:
    """Two heads mean `alembic upgrade head` is ambiguous and deployment fails."""
    heads = _script_directory().get_heads()
    assert len(heads) == 1, f"expected exactly one migration head, got {heads}"


def test_every_down_revision_exists() -> None:
    """A migration pointing at a revision that was renamed or removed breaks
    the walk, and does so only when the chain is actually replayed.

    A merge revision names several parents, so compare against
    `_all_down_revisions`, which is a tuple either way.
    """
    script = _script_directory()
    known = {revision.revision for revision in script.walk_revisions()}
    dangling = {
        revision.revision: tuple(
            parent for parent in revision._all_down_revisions if parent not in known
        )
        for revision in script.walk_revisions()
        if any(parent not in known for parent in revision._all_down_revisions)
    }
    assert not dangling, f"migrations pointing at unknown parents: {dangling}"


def test_filename_matches_revision_id() -> None:
    """The `<revision>_<slug>.py` convention is what makes a duplicate visible
    in a directory listing; a file whose name has drifted from its id hides
    one."""
    mismatched: dict[str, str] = {}
    for path in _VERSIONS.glob("*.py"):
        match = _REVISION_RE.search(path.read_text())
        if match is None:
            continue
        revision = match.group(1)
        if not path.name.startswith(f"{revision}_"):
            mismatched[path.name] = revision
    assert not mismatched, (
        f"migration filenames disagree with their revision ids: {mismatched}"
    )
