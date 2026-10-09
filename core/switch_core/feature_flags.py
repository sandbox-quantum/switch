"""Registry of feature flags.

A feature flag is a named on/off switch for the whole deployment. It is set
when the server is deployed (``FEATURE_FLAGS_ENABLED``, a comma-separated list
of the flags that are on) and nobody can change it while the server runs.
Every flag not listed is off. Naming a key that is not registered here is a
startup error, so a typo cannot silently leave a flag off.

Core reads them from config. Agents read them at ``GET /agents/feature-flags``,
and Switch Console and the dashboard at ``GET /gateway/feature-flags``. Console
re-reads every server it is connected to on a schedule, keeps its own list of
the keys it acts on, and treats a key it does not know, or one the server did
not send, as off.
"""

from __future__ import annotations

# Gate the ecosystem graph's "Show owners" overlay. When OFF the graph never
# exposes owner data, so the frontend toggle has nothing to reveal.
ECOSYSTEM_SHOW_OWNERS = "ecosystem.show_owners"

# Every flag the server recognises.
KNOWN_FEATURE_FLAGS: frozenset[str] = frozenset({ECOSYSTEM_SHOW_OWNERS})
