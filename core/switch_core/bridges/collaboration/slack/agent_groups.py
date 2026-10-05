from __future__ import annotations

from collections.abc import Mapping


class SlackAgentGroupDirectory:
    """Agent user group id → agent name, pooled across a tenant's Slack workspaces.

    A workspace bot token lists only that workspace's user groups, so each
    bridge mints and learns its own group per agent. An Enterprise Grid
    composer does not respect that boundary: it offers an agent's group from a
    sibling workspace in the same org, so a mention can arrive at one bridge
    carrying an id that only another bridge has ever seen. Slack has no call
    that resolves a user group by id, which leaves the bridge that created it
    as the only place its meaning exists.

    Pooled per tenant, never across them: the process runs every tenant's
    bridges, and a group another tenant's bridge minted names an agent this
    tenant cannot address. Two tenants can also connect workspaces of the same
    Grid org, so the workspace boundary alone would not keep them apart.

    Contributions are kept per workspace so a bridge reloading or shutting down
    withdraws its own without disturbing anyone else's.
    """

    def __init__(self) -> None:
        self._by_tenant: dict[str, dict[str, dict[str, str]]] = {}

    def replace(
        self, tenant_id: str, workspace_id: str, agent_names: Mapping[str, str]
    ) -> None:
        """Publish a workspace's whole set, dropping what it published before."""
        self._by_tenant.setdefault(tenant_id, {})[workspace_id] = dict(agent_names)

    def add(
        self, tenant_id: str, workspace_id: str, group_id: str, agent_name: str
    ) -> None:
        workspaces = self._by_tenant.setdefault(tenant_id, {})
        workspaces.setdefault(workspace_id, {})[group_id] = agent_name

    def discard(self, tenant_id: str, workspace_id: str, group_id: str) -> None:
        self._by_tenant.get(tenant_id, {}).get(workspace_id, {}).pop(group_id, None)

    def forget(self, tenant_id: str, workspace_id: str) -> None:
        workspaces = self._by_tenant.get(tenant_id)
        if workspaces is None:
            return
        workspaces.pop(workspace_id, None)
        if not workspaces:
            del self._by_tenant[tenant_id]

    def resolve(self, tenant_id: str, group_id: str) -> str | None:
        for groups in self._by_tenant.get(tenant_id, {}).values():
            agent_name = groups.get(group_id)
            if agent_name is not None:
                return agent_name
        return None
