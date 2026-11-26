"""The tests a machine's search is split into, so `pytest -n` runs them side
by side: Hypothesis runs one test's examples one after another.

A machine's main test takes a `shard` (parametrized in `conftest.py`), runs
its share of the examples (`Shard.of`), and says what it reached
(`Shard.reached`). Each shard searches from its own seed, and keeps what it
found under its own id in `.hypothesis`.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from hypothesis import settings

# How many tests each machine's search is split into, by profile.
SHARDS = {"ci": 1, "nightly": 4}

# Where each shard leaves what it reached, for the session to judge together.
# Made by the controlling process and inherited by the xdist workers.
REACHED_DIR = "SWITCH_PROPERTIES_REACHED_DIR"


@dataclass(frozen=True)
class Shard:
    """One of the tests a machine's search is split into."""

    test: str
    index: int
    count: int

    def of(self, whole: settings) -> settings:
        """`whole`, with this shard's share of its examples."""
        return settings(whole, max_examples=math.ceil(whole.max_examples / self.count))

    def reached(self, coverage: Mapping[str, int], should_reach: Iterable[str]) -> None:
        """Under `nightly`, that the search reached everything it should. A
        machine split into shards is judged over all of them together once
        the session ends, since one shard's share of the examples may miss
        what the others reach."""
        if settings.get_current_profile_name() != "nightly":
            return
        should = list(should_reach)
        if self.count == 1:
            unreached = [what for what in should if coverage.get(what, 0) == 0]
            assert not unreached, (
                f"the run never reached {unreached}; it reached {dict(coverage)}"
            )
            return
        digest = hashlib.sha256(self.test.encode()).hexdigest()[:16]
        name = f"{digest}-{self.index}.json"
        (Path(os.environ[REACHED_DIR]) / name).write_text(
            json.dumps(
                {
                    "test": self.test,
                    "count": self.count,
                    "should_reach": should,
                    "reached": dict(coverage),
                }
            )
        )
