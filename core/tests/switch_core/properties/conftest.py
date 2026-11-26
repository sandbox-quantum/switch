"""Hypothesis settings for the property tests, and the shards a machine's
search is split into.

`ci` is what a pull request runs; `nightly` searches far longer and keeps what
it finds in `.hypothesis` so the next run replays it first. Choose with
`HYPOTHESIS_PROFILE`. A failure prints a seed and the shrunk sequence of steps.

Hypothesis runs one test's examples one after another, so a machine's search
under `nightly` is split into tests (`shards.py`), each running its share of
the examples from its own seed, for `pytest -n` to run side by side. What the
machine is there to reach is judged over every shard together, here, once the
session ends.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, settings

from tests.switch_core.properties.shards import REACHED_DIR, SHARDS, Shard

# No deadline: a step waits on real locks and a real database.
_common = {
    "deadline": None,
    "suppress_health_check": [HealthCheck.too_slow, HealthCheck.data_too_large],
    "print_blob": True,
}

settings.register_profile("ci", max_examples=25, stateful_step_count=20, **_common)
settings.register_profile(
    "nightly", max_examples=1000, stateful_step_count=30, **_common
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "ci"))


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "shard" not in metafunc.fixturenames:
        return
    count = SHARDS.get(settings.get_current_profile_name(), 1)
    metafunc.parametrize(
        "shard",
        [Shard(metafunc.definition.nodeid, index, count) for index in range(count)],
        ids=[f"shard{index + 1}of{count}" for index in range(count)],
    )


def _controlling(config: pytest.Config) -> bool:
    return not hasattr(config, "workerinput")


def pytest_configure(config: pytest.Config) -> None:
    if _controlling(config):
        os.environ[REACHED_DIR] = tempfile.mkdtemp(prefix="switch-reached-")


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Judge what each machine split into shards reached, over all of its
    shards. A machine with a shard that wrote nothing failed or did not run,
    and is not judged."""
    if not _controlling(session.config):
        return
    directory = Path(os.environ[REACHED_DIR])
    shards: dict[str, list[dict[str, Any]]] = {}
    for path in directory.glob("*.json"):
        record = json.loads(path.read_text())
        shards.setdefault(record["test"], []).append(record)
    shutil.rmtree(directory, ignore_errors=True)
    problems = []
    for test, records in sorted(shards.items()):
        if len(records) != records[0]["count"]:
            continue
        reached: Counter[str] = Counter()
        for record in records:
            reached.update(record["reached"])
        unreached = [what for what in records[0]["should_reach"] if reached[what] == 0]
        if unreached:
            problems.append(
                f"{test}: no shard reached {unreached}; together they reached "
                f"{dict(reached)}"
            )
    if problems:
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if reporter is not None:
            reporter.section("what the machines' shards reached", red=True)
            for problem in problems:
                reporter.line(problem)
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
