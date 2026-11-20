"""`switch-hosted-migration`'s own checks, before anything touches the
database: v2 must be on, `--operator` must be on the operators list, and the
copy report must be exactly its four counts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from switch_core import hosted_migration_cli as cli


def _report(tmp_path: Path, body: object) -> Path:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(body))
    return path


def test_a_copy_report_is_exactly_its_keys(tmp_path: Path) -> None:
    report = cli.read_copy_report(
        _report(
            tmp_path,
            {
                "machine_id": "m-1",
                "workspaces": ["t-1"],
                "files": 3,
                "bytes": 10,
                "symlinks_skipped": 1,
                "refused": 2,
                "checksum_mismatches": 0,
                "source_volume_id": "vol-0123456789abcdef0",
                "seconds": 5,
            },
        )
    )
    assert report.machine_id == "m-1" and report.workspaces == ("t-1",)
    assert (report.files, report.bytes, report.symlinks_skipped) == (3, 10, 1)
    assert (report.refused, report.checksum_mismatches, report.seconds) == (2, 0, 5)
    assert report.source_volume_id == "vol-0123456789abcdef0"


@pytest.mark.parametrize(
    "body",
    [
        {"machine_id": "m-1", "workspaces": ["t-1"], "files": 3, "bytes": 10},
        {
            "machine_id": "m-1",
            "workspaces": "t-1",
            "files": 3,
            "bytes": 10,
            "symlinks_skipped": 0,
        },
        {
            "machine_id": "m-1",
            "files": 3,
            "bytes": 10,
            "symlinks_skipped": 0,
            "names": ["a"],
        },
        {"machine_id": 7, "files": 3, "bytes": 10, "symlinks_skipped": 0},
        ["m-1", 3, 10, 0],
    ],
)
def test_anything_else_is_refused(tmp_path: Path, body: object) -> None:
    with pytest.raises(cli.CommandError):
        cli.read_copy_report(_report(tmp_path, body))


def test_a_report_too_large_to_be_counts_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    path.write_text(" " * (cli.MAX_REPORT_BYTES + 1))
    with pytest.raises(cli.CommandError, match="too large"):
        cli.read_copy_report(path)


def test_the_operator_must_be_on_the_list(tmp_path: Path) -> None:
    listed = tmp_path / "operators.json"
    listed.write_text(json.dumps({"operators": ["op-1"]}))
    listed.chmod(0o600)
    config = SimpleNamespace(visibility_operators_path=str(listed))
    cli._require_operator(config, "op-1")  # type: ignore[arg-type]
    with pytest.raises(cli.CommandError, match="operators list"):
        cli._require_operator(config, "someone-else")  # type: ignore[arg-type]


async def test_with_v2_off_nothing_runs() -> None:
    config = SimpleNamespace(hosted_box_provisioning=False)
    arguments = argparse.Namespace(command="plan", person="u-1")
    with pytest.raises(cli.CommandError, match="v2 is off"):
        await cli._run(config, arguments)  # type: ignore[arg-type]
