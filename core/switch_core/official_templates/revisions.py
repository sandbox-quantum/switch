"""The revisions of the templates that come with Switch.

``revisions.json`` beside each template's files lists every revision of it
released, oldest first. Each entry is a fingerprint of the documents the
template served at that revision (``document``) and of every value it set on
each agent it creates, by key (``agents``). Agents created before installs
were recorded are matched against the ``agents`` fingerprints of every
revision, so an old buddy nobody changed is recognised as the revision it
came from.

Revisions are recorded when Switch is released, with the other versions
(RELEASING.md), never by whoever changes a template: a revision is what a
release shipped. Between releases, a changed template is served under its
last recorded revision, and the agents it already made are not updated until
a release records the next one. To record one for every template whose files
changed::

    just record-template-revisions

``check`` says which templates changed since their last revision; the
release workflow runs it on a release tag and stops the release when any did.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml

from switch_core.official_templates import _SHIPPED, REVISIONS_FILE, document_in
from switch_core.template_installs import fingerprint, fingerprints, render_agents

_HERE = Path(__file__).parent

# What the agents are rendered with to fingerprint what a revision sets on
# them. An official template's agent values do not depend on who runs it, so
# any inputs give the same fingerprints; a test holds them to that.
SAMPLE_INPUTS: dict[str, Any] = {"agent_name": "sample"}
SAMPLE_BUILTINS: dict[str, str] = {
    "$creator": "sample",
    "$creator_email": "sample@example.com",
    "$date": "2000-01-01",
    "$timestamp": "0",
}


def entry_for(folder: Path) -> dict[str, Any]:
    """What a revision records of the template in `folder`, as it is now."""
    managed = document_in(folder, agent_management=True)
    console = document_in(folder, agent_management=False)
    agents = render_agents(managed, _inputs_for(managed), SAMPLE_BUILTINS)
    return {
        "document": fingerprint(managed + "\n---\n" + console),
        "agents": {key: fingerprints(fields) for key, fields in agents.items()},
    }


def _inputs_for(document: str) -> dict[str, Any]:
    """The sample inputs the document declares: one with no `agent_name`
    param is rendered without it."""
    params = yaml.safe_load(document).get("params") or {}
    return {name: value for name, value in SAMPLE_INPUTS.items() if name in params}


def recorded(slug: str) -> list[dict[str, Any]]:
    path = _HERE / slug / REVISIONS_FILE
    if not path.exists():
        return []
    return list(json.loads(path.read_text(encoding="utf-8"))["revisions"])


def stale(slug: str) -> bool:
    """Whether the template's files no longer serve its last revision."""
    revisions = recorded(slug)
    if not revisions:
        return True
    last = revisions[-1]
    return {k: last[k] for k in ("document", "agents")} != entry_for(_HERE / slug)


def record(slug: str) -> int:
    """Add a revision for what the template's files serve now, unless the
    last one already is; return the revision they serve."""
    revisions = recorded(slug)
    if revisions and not stale(slug):
        return int(revisions[-1]["revision"])
    revision = len(revisions) + 1
    revisions.append({"revision": revision, **entry_for(_HERE / slug)})
    write(slug, revisions)
    return revision


def write(slug: str, revisions: list[dict[str, Any]]) -> None:
    path = _HERE / slug / REVISIONS_FILE
    path.write_text(
        json.dumps({"revisions": revisions}, indent=2) + "\n", encoding="utf-8"
    )


def record_all() -> dict[str, int]:
    """Record a revision for every official template whose files changed
    since its last one; return the revision each one recorded."""
    return {
        shipped.slug: record(shipped.slug)
        for shipped in _SHIPPED
        if stale(shipped.slug)
    }


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "record":
        print(f"{argv[1]}: revision {record(argv[1])}")
        return 0
    if argv == ["record-all"]:
        recorded_now = record_all()
        for slug, revision in recorded_now.items():
            print(f"{slug}: recorded revision {revision}")
        if not recorded_now:
            print("No official template changed since its last revision.")
        return 0
    if argv == ["check"]:
        out = [shipped.slug for shipped in _SHIPPED if stale(shipped.slug)]
        for slug in out:
            print(
                f"{slug} changed since its last revision: run "
                "`just record-template-revisions` and commit the result with "
                "the release's version bump (RELEASING.md)"
            )
        return 1 if out else 0
    print(
        "usage: revisions record-all | revisions record <slug> | revisions check",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
