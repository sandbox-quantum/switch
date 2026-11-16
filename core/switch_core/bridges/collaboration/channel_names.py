"""Channel names made from room names, on platforms whose channel names are slugs."""

from __future__ import annotations

import re

_RUNS_OF_DASHES = re.compile(r"-{2,}")


def tidy_slug(slug: str, limit: int) -> str:
    """`slug` with each run of dashes made one and none left at either end,
    cut to `limit` characters: "switch---code-review" reads "switch-code-review"."""
    return _RUNS_OF_DASHES.sub("-", slug).strip("-")[:limit].rstrip("-")
