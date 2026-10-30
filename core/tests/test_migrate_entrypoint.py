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

import contextlib
import re
import tomllib
from pathlib import Path

from switch_core import main

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATE_JOB = (
    REPO_ROOT / "deploy/remote/helm/switch/templates/switch-core/migrate-job.yaml"
)
DEPLOYMENT = (
    REPO_ROOT / "deploy/remote/helm/switch/templates/switch-core/deployment.yaml"
)
HELPERS = REPO_ROOT / "deploy/remote/helm/switch/templates/_helpers.tpl"
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


def test_neither_migration_container_is_given_the_teams_app() -> None:
    # Both load a full SwitchConfig, and neither mounts the federated token
    # the serving container presents to Microsoft: given the Teams app's
    # settings, TEAMS_APP_FEDERATED_TOKEN_FILE would name a missing file and
    # the config would refuse to load, so the release could never migrate.
    assert '"omitTeamsApp" true' in MIGRATE_JOB.read_text()
    init_env = re.search(
        r'command: \["switch-migrate"\]\n\s*env:\n\s*(.*)$',
        DEPLOYMENT.read_text(),
        flags=re.MULTILINE,
    )
    assert init_env is not None
    assert '"omitTeamsApp" true' in init_env.group(1)
    guard = re.search(
        r"^(\{\{-? if .*\}\})\n- name: TEAMS_APP_CLIENT_ID$",
        HELPERS.read_text(),
        flags=re.MULTILINE,
    )
    assert guard is not None
    assert "(not .omitTeamsApp)" in guard.group(1)


def test_the_entry_point_is_installed_by_the_package() -> None:
    # The image installs the project, so anything declared here lands on PATH
    # in the same container the Job runs — and anything not declared does not.
    assert _console_scripts()[ENTRY_POINT] == "switch_core.main:migrate"


def test_the_entry_point_resolves_to_a_callable() -> None:
    module_path, _, attribute = _console_scripts()[ENTRY_POINT].partition(":")
    module = __import__(module_path, fromlist=[attribute])

    assert callable(getattr(module, attribute))


async def test_an_older_release_finds_nothing_to_migrate_on_a_newer_schema(
    monkeypatch,
) -> None:
    """During a rolling deploy or a rollback, the older release's migrate step
    meets a head it has no file for. When only expand-only revisions lie
    between, it exits cleanly instead of failing the pod's init container."""
    calls: list[str] = []

    @contextlib.asynccontextmanager
    async def no_lock(config):
        yield

    async def ahead(config, alembic_cfg) -> bool:
        return True

    def upgrade(*args) -> None:
        calls.append("upgrade")

    async def grant(config) -> None:
        calls.append("grant")

    monkeypatch.setattr(main, "boot_lock", no_lock)
    monkeypatch.setattr(main, "_schema_ahead", ahead)
    monkeypatch.setattr(main.alembic_command, "upgrade", upgrade)
    monkeypatch.setattr(main, "_prepare_database", grant)

    await main._migrate_and_grant(object())  # type: ignore[arg-type]

    assert calls == []
