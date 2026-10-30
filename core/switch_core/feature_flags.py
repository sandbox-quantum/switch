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

# Service connections: people connect outside services (GitHub's grants,
# Atlassian, Google Workspace, Datadog and the rest of the catalog) and grant
# them to their agents. With it off, the routes for connections, sign-ins,
# keys and grants (`/gateway/service-connections`, `/gateway/agents/{id}/
# service-grants`, `/agents/{id}/service-grants` and `service-tokens`) are not
# mounted: agent hosts read that as no grants, and Console and the dashboard
# show no services but GitHub's link, as before connections. GitHub's own
# connect routes stay.
SERVICE_CONNECTIONS = "service_connections"

# Follow the conversation: a person's message that mentions nobody reaches an
# agent when it is a reply in a thread the agent is taking part in, the next
# message in an exchange the agent has just answered, or a message in a room
# whose main agent it is (`delivery/conversation.py`). With it off such
# messages reach nobody, as before.
FOLLOW_THE_CONVERSATION = "follow_the_conversation"

# Agent chats in Switch Console: accepted for old configs; always on.
AGENT_CHATS = "agent_chats"

# switch-buddy: each person's own assistant, which Switch Console creates on
# their computer at the end of its first run. Core serves the built-in
# switch-buddy template only with it on (and agent management, which the
# buddy runs as), and Console offers the buddy only on a server that turns it
# on, so a server without the template is never asked to make one.
SWITCH_BUDDY = "switch_buddy"

# Group chats in Switch Console: accepted for old configs; always on.
GROUP_CHATS = "group_chats"

# Every flag the server recognises.
KNOWN_FEATURE_FLAGS: frozenset[str] = frozenset(
    {
        ECOSYSTEM_SHOW_OWNERS,
        SWITCH_CLOUD,
        HOSTED_AGENTS,
        AGENT_MANAGEMENT,
        SERVICE_CONNECTIONS,
        FOLLOW_THE_CONVERSATION,
        AGENT_CHATS,
        SWITCH_BUDDY,
        GROUP_CHATS,
    }
)
