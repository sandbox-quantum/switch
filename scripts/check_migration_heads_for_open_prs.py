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

Instead this reads `revision`/`down_revision` out of the file's syntax tree:
`ast.parse` builds the tree without running a line of it, and the two
right-hand sides go through `ast.literal_eval` — never `eval`, so each must be
a literal (a string, `None`, or a tuple of strings) or parsing raises instead
of running anything. `test_revision_ids_are_unique` reads `revision` in the
same spirit, for the same reason, on a smaller scale; this applies it to the
whole graph. Nothing here is executed, so nothing here needs a database, a
Python environment for the project, or the `alembic` library itself.

The tree rather than a regex because an assignment is not a line: a merge
revision's `down_revision` tuple may be spread over several, and a pattern
anchored to end-of-line hands `ast.literal_eval` half an expression.

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
PR_LIST_LIMIT = 1000

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

_WANTED_ASSIGNMENTS = ("revision", "down_revision")


class RevisionProblem(Exception):
    """A file under `versions/` that cannot be read as a migration.

    Raised rather than allowed to surface as a `KeyError` or a `SyntaxError`
    so the sweep can report *which file* is unreadable, on the PR that
    introduced it, instead of dying with a traceback halfway through.
    """


class RevisionFile:
    __slots__ = ("filename", "revision", "parents")

    def __init__(self, filename: str, revision: str, parents: tuple[str, ...]) -> None:
        self.filename = filename
        self.revision = revision
        self.parents = parents


def _assigned_literals(filename: str, text: str) -> dict[str, object]:
    """The module-level `revision` / `down_revision` literals, from the tree.

    `ast.parse` builds a syntax tree and runs nothing, and `ast.literal_eval`
    on a node only ever produces a literal (or raises) -- it cannot call a
    function, access an attribute, or execute a statement. Both are safe to
    point at a file nobody has reviewed.

    Reading assignments off the tree rather than out of the text is also what
    makes a multi-line `down_revision` tuple -- the shape a merge revision
    grows into once it has more than a couple of parents -- parse like any
    other.
    """
    try:
        tree = ast.parse(text, filename=filename)
    except SyntaxError as exc:
        raise RevisionProblem(f"{filename}: is not valid Python: {exc}") from exc

    values: dict[str, object] = {}
    for node in tree.body:
        targets: list[str] = []
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
            value = node.value  # None for a bare `x: str` annotation
        if value is None:
            continue
        for name in targets:
            if name not in _WANTED_ASSIGNMENTS:
                continue
            try:
                values[name] = ast.literal_eval(value)
            except ValueError as exc:
                raise RevisionProblem(
                    f"{filename}: {name} is not a literal: {exc}"
                ) from exc
    return values


def parse_revision_file(filename: str, text: str) -> RevisionFile:
    """Extract `revision`/`down_revision` from a migration file's text."""
    values = _assigned_literals(filename, text)
    if "revision" not in values:
        raise RevisionProblem(
            f"{filename}: no module-level `revision` assignment -- "
            "every file under versions/ must be a migration"
        )
    revision = values["revision"]
    if not isinstance(revision, str):
        raise RevisionProblem(
            f"{filename}: revision is not a string literal: {revision!r}"
        )
    down = values.get("down_revision")
    if down is None:
        parents: tuple[str, ...] = ()
    elif isinstance(down, str):
        parents = (down,)
    elif isinstance(down, tuple) and all(isinstance(p, str) for p in down):
        parents = down  # a merge revision's tuple of parents
    else:
        raise RevisionProblem(
            f"{filename}: down_revision is neither a string, a tuple of strings, nor None: {down!r}"
        )
    return RevisionFile(filename, revision, parents)


def read_base_revisions() -> list[RevisionFile]:
    return [
        parse_revision_file(path.name, path.read_text())
        for path in sorted(VERSIONS_DIR.glob("*.py"))
    ]


def run(
    *args: str,
    cwd: Path = REPO_ROOT,
    check: bool = True,
    stdin: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a command with a fixed argument list — never a shell, never a
    string.

    `stdin` is how anything variable-length or free-text gets in. Keeping such
    values off the command line is not about shell metacharacters, which
    cannot apply here; it is that an argument list is the one place a value
    can be mistaken for an option.
    """
    return subprocess.run(
        list(args),
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        input=stdin,
    )


def open_prs_touching_migrations() -> list[dict[str, Any]]:
    """Open pull requests that add or change a migration.

    No `--repo`: `gh` resolves it from the checkout this runs in, which keeps
    the repository out of the argument list entirely.

    `--limit` is not optional. Without it `gh` stops at 30 open PRs and says
    nothing about the rest, so on a repository with more than that the PRs
    least likely to have been rechecked recently are exactly the ones silently
    skipped.
    """
    listing = run(
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        str(PR_LIST_LIMIT),
        "--json",
        "number,headRefOid",
    )
    open_prs = json.loads(listing.stdout)
    if len(open_prs) >= PR_LIST_LIMIT:
        raise RuntimeError(
            f"{len(open_prs)} open PRs reached the --limit of {PR_LIST_LIMIT}; "
            "some were not listed and would be skipped without a word"
        )
    candidates = []
    for pr in open_prs:
        diff = run("gh", "pr", "diff", str(pr["number"]), "--name-only")
        if any(line.startswith(VERSIONS_PATH) for line in diff.stdout.splitlines()):
            candidates.append(pr)
    return candidates


def fetch_pr_revisions(pr_number: int) -> list[RevisionFile]:
    """The revision files as they stand on the PR's own head, read as text.

    Fetched straight from the PR's head ref rather than a merge; `merge_preview`
    combines it with the base. This is the whole directory as the PR has it,
    shared files included, not just the ones it adds. `git show` only ever
    prints a blob's content; nothing here writes the file to disk or runs it.
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
    body = json.dumps(
        {
            "state": state,
            "context": STATUS_CONTEXT,
            "description": description,
            "target_url": run_url,
        }
    )
    run(
        "gh",
        "api",
        # `{owner}` and `{repo}` are gh's own placeholders, filled from the
        # checkout — not f-string fields.
        f"repos/{{owner}}/{{repo}}/statuses/{sha}",
        "--method",
        "POST",
        "--input",
        "-",
        stdin=body,
    )


def merge_preview(
    base_revisions: list[RevisionFile], pr_revisions: list[RevisionFile]
) -> list[RevisionFile]:
    """The versions directory as it would stand with this PR merged.

    A union keyed by filename, not a concatenation: the two sides share every
    revision that was already on main when the PR branched, and counting those
    twice reports every PR as a duplicate-id collision. The PR's copy wins,
    which is also what a merge does for a file it modifies.

    The directory only ever gains files, so this is the merge result for the
    purpose these checks care about -- and it needs no real merge, so no
    unrelated conflict can get in the way.
    """
    merged = {rev.filename: rev for rev in base_revisions}
    merged.update({rev.filename: rev for rev in pr_revisions})
    return list(merged.values())


def check_pr(
    pr: dict[str, Any], base_revisions: list[RevisionFile], run_url: str
) -> bool:
    number = pr["number"]
    sha = pr["headRefOid"]
    combined = merge_preview(base_revisions, fetch_pr_revisions(int(number)))
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


def check_pr_isolated(
    pr: dict[str, Any], base_revisions: list[RevisionFile], run_url: str
) -> bool:
    """`check_pr`, with one PR's failure kept to that PR.

    Every `gh` and `git` call here can fail on its own -- a transient API
    error, a head ref that no longer resolves -- and an unreadable file under
    `versions/` raises too. Letting any of those out would abandon the PRs not
    yet reached, with nothing on them to say so and a red job on main that
    looks exactly like a genuine finding. So each PR gets an `error` status
    naming what went wrong, and the sweep carries on.
    """
    number = pr["number"]
    try:
        return check_pr(pr, base_revisions, run_url)
    except (RevisionProblem, subprocess.CalledProcessError, OSError, ValueError) as exc:
        detail = (
            exc.stderr.strip()
            if isinstance(exc, subprocess.CalledProcessError) and exc.stderr
            else str(exc)
        )
        print(f"::error::PR #{number} could not be checked: {detail}")
        sha = str(pr.get("headRefOid", ""))
        if SAFE_SHA_RE.match(sha):
            try:
                post_status(
                    sha,
                    "error",
                    "Could not check the migration chain for this PR -- see the run log",
                    run_url,
                )
            except (subprocess.CalledProcessError, OSError) as post_exc:
                # Whatever broke the check may well be what breaks saying so.
                print(
                    f"::error::PR #{number}: could not post a status either: {post_exc}"
                )
        return False


def main() -> int:
    run_url = os.environ["RUN_URL"]
    prs = open_prs_touching_migrations()
    if not prs:
        print("No open PRs touch the migrations directory.")
        return 0
    try:
        base_revisions = read_base_revisions()
    except RevisionProblem as exc:
        # Nothing can be said about any PR while main itself is unreadable,
        # and it is main that needs fixing -- do not paint every open PR red
        # for it.
        print(f"::error::main's own migrations cannot be read: {exc}")
        return 1
    results = [check_pr_isolated(pr, base_revisions, run_url) for pr in prs]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
