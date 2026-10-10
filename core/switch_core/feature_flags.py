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

# Switch Cloud. Core has nothing of its own behind it; clients read it.
SWITCH_CLOUD = "switch_cloud"

# Cloud machines: one machine per user, run by Switch, that agents can be
# placed on. The flag offers them; whether this server can run them is its
# hosted settings (HOSTED_LAUNCH_CAPACITY and the controller config), and a
# server that cannot says so when one is claimed.
HOSTED_AGENTS = "hosted_agents"

# Agent management: managed agents, the machines and agent controllers that
# run them, and the controller-facing routes under /v1/management and
# /v1/controllers. With it off none of those routes are mounted.
AGENT_MANAGEMENT = "agent_management"

# Every flag the server recognises.
KNOWN_FEATURE_FLAGS: frozenset[str] = frozenset(
    {ECOSYSTEM_SHOW_OWNERS, SWITCH_CLOUD, HOSTED_AGENTS, AGENT_MANAGEMENT}
)
