#!/usr/bin/env python3
"""Re-check the migration chain for open PRs against the just-updated base.

`core/tests/switch_core/test_migration_chain.py` already asserts the chain has
one head, and `actions/checkout` already runs it against the merge-preview
commit (`refs/pull/<n>/merge`) rather than the PR's raw branch tip — so a PR
that adds a migration is tested against the base as it looked when the PR's
own CI last ran.

That is not the same moment as "right before merge". Two PRs opened off the
same parent can each see one head, go green, and sit open. If the first one
merges and nothing pushes a new commit to the second, GitHub does not re-run
its CI just because its target moved — the merge-preview ref updates on
GitHub's side, but the check recorded against the PR's head commit does not.
The second PR still shows the old green result and can merge on it, and only
then does the chain end up with two heads (CHOO-2689; see PRs #404 and #426,
fixed by hand with merge revisions `b47e0c39a1f5` and `c81f4a06d2b7`).

This script runs on every push to main that touches the migrations directory
— i.e. right after a new head lands — and re-checks every other open,
same-repo PR that also touches migrations: it reads that PR's added revision
files alongside the base as it now stands and reports whether the combination
still has exactly one head, posting the outcome as a commit status on the
PR's own head commit. A PR that would create a second head goes red
immediately, without needing a new commit or its own CI run.

Deliberately does not use Alembic here, and imports no revision file. The
obvious way to compute a revision graph is `alembic.script.ScriptDirectory`,
which is what the real test file uses — but it builds the graph by
*importing* every file under `versions/`, running whatever module-level code
that file contains. That is fine for the file under review in a PR's own CI:
by the time this repo's checkout step fetches it, it's the PR's own code
being tested. It stops being fine here: this job's input is a file from some
*other* open pull request that nobody has approved, this repo is public so
anyone can open one, and the job runs on a push to main holding a token that
can write commit statuses. Importing an unreviewed file to compute a graph
would hand that token's holder's code execution to whoever opened the PR.

Instead this reads `revision`/`down_revision` straight out of the file text
with a regex and `ast.literal_eval` — never `eval`, so the value must be a
literal (a string, `None`, or a tuple of strings) or parsing raises instead of
running anything. `test_revision_ids_are_unique` already reads `revision` the
same way, for the same reason, on a smaller scale; this applies it to the
whole graph. Nothing here is executed, so nothing here needs a database, a
Python environment for the project, or the `alembic` library itself.

It shells out to `gh` (for PR discovery and posting statuses) and `git` (to
read a PR's files without checking them out or running them), both already
present on GitHub-hosted runners.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSIONS_DIR = REPO_ROOT / "core" / "switch_core" / "migrations" / "versions"
VERSIONS_PATH = "core/switch_core/migrations/versions"
STATUS_CONTEXT = "migration-heads-on-merge"

# The repository is never named in an argument list: `gh` takes it from the
# checkout, and its `{owner}/{repo}` placeholder fills it in for an API path.
# That leaves two values reaching `git` or `gh` that come from outside this
# script — a tracked path from `git ls-tree`, and a commit id from `gh` — and
# both are matched against a pattern first. Nothing runs through a shell, so
# this is not about metavariables; it is about a leading dash, which `git`
# would read as an option rather than a path.
SAFE_VERSION_PATH_RE = re.compile(
    rf"\A{re.escape(VERSIONS_PATH)}/[A-Za-z0-9._-]+\.py\Z"
)
SAFE_SHA_RE = re.compile(r"\A[0-9a-f]{7,40}\Z")

# Matches the two assignments Alembic's revision template generates, with or
# without the type annotation it has carried across template versions
# (`revision = ...`, `revision: str = ...`, `down_revision: str | None = ...`,
# `down_revision: str | Sequence[str] | None = ...`). Only the right-hand side
# is captured and handed to `ast.literal_eval`.
_ASSIGNMENT_RE = re.compile(
    r"^(revision|down_revision)\s*(?::[^=\n]+)?=\s*(.+)$", re.MULTILINE
)


class RevisionFile:
    __slots__ = ("filename", "revision", "parents")

    def __init__(self, filename: str, revision: str, parents: tuple[str, ...]) -> None:
        self.filename = filename
        self.revision = revision
        self.parents = parents


def parse_revision_file(filename: str, text: str) -> RevisionFile:
    """Extract `revision`/`down_revision` from a migration file's text.

    `ast.literal_eval` only ever produces a literal (or raises) -- it cannot
    call a function, access an attribute, or run a statement, so this is safe
    to point at a file nobody has reviewed.
    """
    values: dict[str, object] = {}
    for match in _ASSIGNMENT_RE.finditer(text):
        name, rhs = match.group(1), match.group(2).strip()
        values[name] = ast.literal_eval(rhs)
    revision = values["revision"]
    assert isinstance(revision, str), (
        f"{filename}: revision is not a string literal: {revision!r}"
    )
    down = values.get("down_revision")
    if down is None:
        parents: tuple[str, ...] = ()
    elif isinstance(down, str):
        parents = (down,)
    elif isinstance(down, tuple):
        parents = down  # a merge revision's tuple of parents
    else:
        raise TypeError(
            f"{filename}: down_revision is neither a string, tuple, nor None: {down!r}"
        )
    return RevisionFile(filename, revision, parents)


def read_base_revisions() -> list[RevisionFile]:
    return [
        parse_revision_file(path.name, path.read_text())
        for path in sorted(VERSIONS_DIR.glob("*.py"))
    ]


def run(
    *args: str, cwd: Path = REPO_ROOT, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args), cwd=cwd, check=check, capture_output=True, text=True
    )


def open_prs_touching_migrations() -> list[dict[str, Any]]:
    """Open pull requests that add or change a migration.

    No `--repo`: `gh` resolves it from the checkout this runs in, which keeps
    the repository out of the argument list entirely.
    """
    listing = run(
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,headRefOid",
    )
    candidates = []
    for pr in json.loads(listing.stdout):
        diff = run("gh", "pr", "diff", str(pr["number"]), "--name-only")
        if any(line.startswith(VERSIONS_PATH) for line in diff.stdout.splitlines()):
            candidates.append(pr)
    return candidates


def fetch_pr_revisions(pr_number: int) -> list[RevisionFile]:
    """The revision files as they stand on the PR's own head, read as text.

    Fetched straight from the PR's head ref rather than a merge -- the
    versions directory only ever gains files, so a plain union with the
    base's current revisions is the merge result for the purpose these checks
    care about, and it skips every non-migration conflict a real merge could
    raise. `git show` only ever prints a blob's content; nothing here writes
    the file to disk or runs it.
    """
    run("git", "fetch", "--depth=1", "origin", f"refs/pull/{pr_number}/head")
    listing = run(
        "git", "ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", VERSIONS_PATH
    )
    revisions = []
    for path in listing.stdout.splitlines():
        if not SAFE_VERSION_PATH_RE.match(path):
            continue
        content = run("git", "show", f"FETCH_HEAD:{path}")
        revisions.append(parse_revision_file(Path(path).name, content.stdout))
    return revisions


def describe_chain_problem(revisions: list[RevisionFile]) -> str:
    """The three graph assertions in test_migration_chain.py, over a plain
    list of (revision, parents) pairs instead of an Alembic graph.

    Returns an empty string if the chain is well-formed, otherwise a
    description of what is wrong.
    """
    by_revision: dict[str, list[str]] = {}
    for rev in revisions:
        by_revision.setdefault(rev.revision, []).append(rev.filename)
    duplicates = {rev: files for rev, files in by_revision.items() if len(files) > 1}
    if duplicates:
        return f"duplicate migration revision ids: {duplicates}"

    known = set(by_revision)
    dangling = {
        rev.revision: [parent for parent in rev.parents if parent not in known]
        for rev in revisions
        if any(parent not in known for parent in rev.parents)
    }
    if dangling:
        return f"migrations pointing at unknown parents: {dangling}"

    all_parents = {parent for rev in revisions for parent in rev.parents}
    heads = [rev.revision for rev in revisions if rev.revision not in all_parents]
    if len(heads) != 1:
        return f"expected exactly one migration head, got {heads}"

    return ""


def post_status(sha: str, state: str, description: str, run_url: str) -> None:
    if not SAFE_SHA_RE.match(sha):
        raise ValueError(f"not a commit id: {sha!r}")
    run(
        "gh",
        "api",
        # `{owner}` and `{repo}` are gh's own placeholders, filled from the
        # checkout — not f-string fields.
        f"repos/{{owner}}/{{repo}}/statuses/{sha}",
        "-f",
        f"state={state}",
        "-f",
        f"context={STATUS_CONTEXT}",
        "-f",
        f"description={description}",
        "-f",
        f"target_url={run_url}",
    )


def check_pr(
    pr: dict[str, Any], base_revisions: list[RevisionFile], run_url: str
) -> bool:
    number = pr["number"]
    sha = pr["headRefOid"]
    combined = base_revisions + fetch_pr_revisions(int(number))
    problem = describe_chain_problem(combined)
    passed = not problem
    if passed:
        description = "Migration chain stays single-headed if this PR merges now"
    else:
        description = "Merging this PR now would break the migration chain -- rebase onto the latest main"
        print(
            f"::error::PR #{number} would break the migration chain if merged now: {problem}"
        )
    post_status(str(sha), "success" if passed else "failure", description, run_url)
    return passed


def main() -> int:
    run_url = os.environ["RUN_URL"]
    prs = open_prs_touching_migrations()
    if not prs:
        print("No open PRs touch the migrations directory.")
        return 0
    base_revisions = read_base_revisions()
    results = [check_pr(pr, base_revisions, run_url) for pr in prs]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
