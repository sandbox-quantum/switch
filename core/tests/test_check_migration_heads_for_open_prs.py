"""Tests for scripts/check_migration_heads_for_open_prs.py, the sweep that
re-checks open PRs' migrations each time a new head lands on main.

`gh` and `git` are replaced by a fake that answers from fixed data, so these
run without a network, a token or a checkout of any PR.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_script() -> ModuleType:
    """Import the script, which is not an installed package."""
    path = REPO_ROOT / "scripts" / "check_migration_heads_for_open_prs.py"
    spec = importlib.util.spec_from_file_location(
        "check_migration_heads_for_open_prs", path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sweep = _load_script()


def _migration(revision: str, down_revision: str | None) -> str:
    return f'revision: str = "{revision}"\ndown_revision = {down_revision!r}\n'


def _in_versions(filename: str) -> str:
    return f"{sweep.VERSIONS_PATH}/{filename}"


class FakeGitHub:
    """Stands in for `run`: answers the `gh` and `git` calls the sweep makes.

    `files` maps a PR number to the paths its files endpoint lists, or to the
    error that endpoint fails with. `heads` maps a PR number to the versions
    directory on its head, as path to file text. Posted statuses are kept in
    `statuses`, by commit.
    """

    def __init__(
        self,
        open_prs: list[dict[str, Any]],
        files: dict[int, list[str] | subprocess.CalledProcessError],
        heads: dict[int, dict[str, str]],
    ) -> None:
        self.open_prs = open_prs
        self.files = files
        self.heads = heads
        self.statuses: dict[str, str] = {}
        self.fetched: int | None = None

    def __call__(
        self,
        *args: str,
        cwd: Path | None = None,
        check: bool = True,
        stdin: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if args[:3] == ("gh", "pr", "list"):
            return self._answer(args, json.dumps(self.open_prs))
        if args[:3] == ("gh", "api", "--paginate"):
            number = int(args[3].split("/")[-2])
            listed = self.files[number]
            if isinstance(listed, subprocess.CalledProcessError):
                raise listed
            return self._answer(args, "\n".join(listed))
        if args[:2] == ("git", "fetch"):
            self.fetched = int(args[-1].split("/")[2])
            return self._answer(args, "")
        if args[:2] == ("git", "ls-tree"):
            assert self.fetched is not None
            return self._answer(args, "\n".join(self.heads[self.fetched]))
        if args[:2] == ("git", "show"):
            assert self.fetched is not None
            path = args[2].removeprefix("FETCH_HEAD:")
            return self._answer(args, self.heads[self.fetched][path])
        if args[:2] == ("gh", "api") and "/statuses/" in args[2]:
            assert stdin is not None
            self.statuses[args[2].rsplit("/", 1)[1]] = json.loads(stdin)["state"]
            return self._answer(args, "{}")
        raise AssertionError(f"unexpected command: {args}")

    @staticmethod
    def _answer(args: tuple[str, ...], stdout: str) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 0, stdout, "")


def _diff_too_large(number: int) -> subprocess.CalledProcessError:
    return subprocess.CalledProcessError(
        1,
        ["gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{number}/files"],
        output="",
        stderr="HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)",
    )


def test_one_unlistable_pr_does_not_stop_the_sweep(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The incident this guards against: a PR whose files GitHub would not
    list ended the sweep before a PR racing for the same parent was flagged,
    and that PR then merged a second head.

    Both PRs must get a status: the racing one red, the unlistable one checked
    anyway and green.
    """
    base = {"a_first.py": _migration("a", None), "b_second.py": _migration("b", "a")}
    for name, text in base.items():
        (tmp_path / name).write_text(text)
    monkeypatch.setattr(sweep, "VERSIONS_DIR", tmp_path)
    monkeypatch.setenv("RUN_URL", "https://example.invalid/run")

    unlistable, racing = "1" * 40, "2" * 40
    github = FakeGitHub(
        open_prs=[
            {"number": 672, "headRefOid": unlistable},
            {"number": 593, "headRefOid": racing},
        ],
        files={672: _diff_too_large(672), 593: [_in_versions("c_racing.py")]},
        heads={
            672: {_in_versions(name): text for name, text in base.items()},
            593: {
                _in_versions("a_first.py"): base["a_first.py"],
                _in_versions("c_racing.py"): _migration("c", "a"),
            },
        },
    )
    monkeypatch.setattr(sweep, "run", github)

    assert sweep.main() == 1
    assert github.statuses == {unlistable: "success", racing: "failure"}


def test_a_pr_that_touches_no_migration_is_not_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    github = FakeGitHub(
        open_prs=[{"number": 7, "headRefOid": "3" * 40}],
        files={7: ["core/switch_core/config.py", "README.md"]},
        heads={},
    )
    monkeypatch.setattr(sweep, "run", github)

    assert sweep.open_prs_touching_migrations() == []


def test_a_file_list_cut_off_at_the_limit_is_checked_anyway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The files endpoint stops at its limit, so a PR with that many files
    and no migration among them may still have one past the cut."""
    pr = {"number": 8, "headRefOid": "4" * 40}
    github = FakeGitHub(
        open_prs=[pr],
        files={8: [f"console/file_{i}.ts" for i in range(sweep.MAX_LISTED_FILES)]},
        heads={},
    )
    monkeypatch.setattr(sweep, "run", github)

    assert sweep.open_prs_touching_migrations() == [pr]


def test_a_pr_whose_files_cannot_be_listed_is_a_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pr = {"number": 9, "headRefOid": "5" * 40}
    github = FakeGitHub(open_prs=[pr], files={9: _diff_too_large(9)}, heads={})
    monkeypatch.setattr(sweep, "run", github)

    assert sweep.open_prs_touching_migrations() == [pr]
