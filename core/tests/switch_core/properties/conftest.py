"""Hypothesis settings for the property tests.

`ci` is what a pull request runs; `nightly` searches far longer and keeps what
it finds in `.hypothesis` so the next run replays it first. Choose with
`HYPOTHESIS_PROFILE`. A failure prints a seed and the shrunk sequence of steps.
"""

from __future__ import annotations

import os

from hypothesis import HealthCheck, settings
from hypothesis.database import DirectoryBasedExampleDatabase

# No deadline: a step waits on real locks and a real database.
_common = {
    "deadline": None,
    "suppress_health_check": [HealthCheck.too_slow, HealthCheck.data_too_large],
    "print_blob": True,
}

# Both profiles say what they do about the example database and about
# randomness: Hypothesis loads its own `ci` profile when `CI` is set, which
# registers no database and derandomizes, and a profile registered here would
# otherwise inherit that.
settings.register_profile(
    "ci",
    max_examples=25,
    stateful_step_count=20,
    database=None,
    derandomize=True,
    **_common,
)
settings.register_profile(
    "nightly",
    max_examples=1000,
    stateful_step_count=30,
    database=DirectoryBasedExampleDatabase(".hypothesis/examples"),
    derandomize=False,
    **_common,
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "ci"))
