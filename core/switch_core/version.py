"""switch-core's own release version (CHOO-1865).

The version is declared once, in `core/pyproject.toml`, and reaches the running
process through installed distribution metadata. There is deliberately no
second copy: a `__version__` constant beside pyproject would be one more thing
to keep in step by hand, which is the drift this ticket exists to end.

An artifact's semver says *where it is* — which release you are running. It
says nothing about whether it can talk to anything; that is what the contract
revisions in `switch_core.artifacts` are for. The two move independently and
must never be derived from one another.

When the version cannot be read it is reported as `None`, meaning *unknown*,
and a warning is logged. It is never replaced with a placeholder string:
"0.0.0" or "unknown" would read downstream as a version somebody chose, and
the whole point of this work is that unknown must never render as fine.
"""

import logging
from functools import lru_cache
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from typing import Any

from switch_core.artifacts import contract_range

logger = logging.getLogger(__name__)

DISTRIBUTION_NAME = "switch-core"

# Internal to switch-core: it describes the database this process talks to, and
# no external client can act on it. Excluded from every externally facing
# response as a rule the code enforces rather than one reviewers must remember.
INTERNAL_CONTRACTS = frozenset({"db-schema"})


@lru_cache(maxsize=1)
def switch_core_version() -> str | None:
    """Return the running switch-core release, or None when unknown.

    None means the distribution metadata is absent — switch-core is running
    from a source tree that was never installed. Callers must surface that as
    unknown rather than substituting a value.
    """
    try:
        return distribution_version(DISTRIBUTION_NAME)
    except PackageNotFoundError:
        logger.warning(
            "No installed distribution metadata for %r, so switch-core cannot "
            "report its own version. Clients will see it as unknown. This "
            "usually means the package was added to the path rather than "
            "installed.",
            DISTRIBUTION_NAME,
        )
        return None


def server_declaration(*contracts: str) -> dict[str, Any]:
    """What this server says about itself, for the named contracts only.

    Every caller passes just the contracts its credential entitles it to see,
    so an agent token never learns about the gateway and vice versa. Version
    disclosure is authenticated everywhere; there is no anonymous surface.

    `version` is null when switch-core cannot read its own version. Null means
    unknown and must be rendered as such — never as current.
    """
    leaking = INTERNAL_CONTRACTS.intersection(contracts)
    if leaking:
        raise ValueError(
            f"{sorted(leaking)} are internal to switch-core and must not appear "
            "in a response to any external client"
        )
    return {
        "version": switch_core_version(),
        "contracts": {
            name: {
                "speaks": contract_range(name, "switch-core").speaks,
                "accepts": contract_range(name, "switch-core").accepts,
            }
            for name in contracts
        },
    }
