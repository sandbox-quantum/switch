"""The migration Job's command, and the console script behind it.

The Helm pre-upgrade Job names a command as a string in a template no Python
import ever touches, so a rename on either side breaks the deploy rather than
the build — and breaks it at the point where a release is already half applied.
These tie the two together.

Why the Job runs `switch-migrate` rather than `alembic upgrade head` at all:
the entry point wraps the upgrade in the boot advisory lock, so the Job and a
restarting replica cannot both apply DDL, and reissues the runtime role's
grants afterwards, without which the tables the migration just created are
unreadable by the pods the release then rolls.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATE_JOB = (
    REPO_ROOT / "deploy/remote/helm/switch/templates/switch-core/migrate-job.yaml"
)
DEPLOYMENT = (
    REPO_ROOT / "deploy/remote/helm/switch/templates/switch-core/deployment.yaml"
)
CORE_PYPROJECT = REPO_ROOT / "core/pyproject.toml"

ENTRY_POINT = "switch-migrate"


def _commands(template: Path) -> list[list[str]]:
    matches = re.findall(
        r"^\s*command: (\[.*\])$", template.read_text(), flags=re.MULTILINE
    )
    assert matches, f"no container command found in {template}"
    return [re.findall(r'"([^"]+)"', match) for match in matches]


def _job_command() -> list[str]:
    (command,) = _commands(MIGRATE_JOB)
    return command


def _console_scripts() -> dict[str, str]:
    with CORE_PYPROJECT.open("rb") as handle:
        return tomllib.load(handle)["project"]["scripts"]


def test_the_job_runs_the_migration_entry_point() -> None:
    assert _job_command() == [ENTRY_POINT]


def test_the_server_pods_init_container_runs_it_too() -> None:
    # The serving container is not given the owner credentials, so the
    # migration it no longer runs at boot has to run here, before it starts.
    assert [ENTRY_POINT] in _commands(DEPLOYMENT)


def test_the_entry_point_is_installed_by_the_package() -> None:
    # The image installs the project, so anything declared here lands on PATH
    # in the same container the Job runs — and anything not declared does not.
    assert _console_scripts()[ENTRY_POINT] == "switch_core.main:migrate"


def test_the_entry_point_resolves_to_a_callable() -> None:
    module_path, _, attribute = _console_scripts()[ENTRY_POINT].partition(":")
    module = __import__(module_path, fromlist=[attribute])

    assert callable(getattr(module, attribute))
