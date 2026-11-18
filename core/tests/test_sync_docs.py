"""Docs sync preserves the last complete snapshot when rendering fails."""

import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "sync_docs.py"


def _run_sync(
    source: Path, dest: Path, *options: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--source",
            str(source),
            "--dest",
            str(dest),
            *options,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def docs_tree(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "source"
    (source / "switch-rooms").mkdir(parents=True)
    (source / "docs.json").write_text(
        json.dumps(
            {
                "navigation": {
                    "products": [
                        {"product": "Switch Rooms", "pages": ["switch-rooms/example"]}
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    dest = tmp_path / "output" / "official"
    dest.mkdir(parents=True)
    (dest / "last-good.md").write_text("published snapshot\n", encoding="utf-8")
    return source, dest


@pytest.mark.parametrize("malformed_source", [False, True])
def test_failed_sync_keeps_the_existing_snapshot(
    docs_tree: tuple[Path, Path], malformed_source: bool
) -> None:
    source, dest = docs_tree
    if malformed_source:
        (source / "docs.json").write_text("{", encoding="utf-8")

    result = _run_sync(source, dest)

    assert result.returncode != 0
    assert "Wrote" not in result.stdout
    assert list(dest.iterdir()) == [dest / "last-good.md"]
    assert (dest / "last-good.md").read_text(encoding="utf-8") == "published snapshot\n"


def test_complete_sync_replaces_snapshot_and_check_does_not_write(
    docs_tree: tuple[Path, Path],
) -> None:
    source, dest = docs_tree
    (source / "switch-rooms" / "example.mdx").write_text(
        "# Fresh page\n", encoding="utf-8"
    )

    assert _run_sync(source, dest, "--check").returncode == 1
    assert (dest / "last-good.md").exists()
    result = _run_sync(source, dest)
    assert result.returncode == 0, result.stderr
    assert not (dest / "last-good.md").exists()
    assert "Fresh page" in (dest / "example.md").read_text(encoding="utf-8")
    assert (dest / "TOC.md").is_file()
    assert _run_sync(source, dest, "--check").returncode == 0


def test_failed_promotion_restores_the_previous_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replace_snapshot = runpy.run_path(str(SCRIPT))["replace_snapshot"]
    dest = tmp_path / "official"
    fresh = tmp_path / "fresh"
    backup = tmp_path / "backup"
    for path in (dest, fresh):
        path.mkdir()
    (dest / "last-good.md").write_text("previous version", encoding="utf-8")

    rename = Path.rename

    def reject_promotion(path: Path, target: Path) -> Path:
        if path == fresh:
            raise OSError("fixture promotion failure")
        return rename(path, target)

    monkeypatch.setattr(Path, "rename", reject_promotion)
    with pytest.raises(OSError, match="fixture promotion failure"):
        replace_snapshot(dest, fresh, backup)

    assert (dest / "last-good.md").read_text(encoding="utf-8") == "previous version"
    assert not backup.exists()
