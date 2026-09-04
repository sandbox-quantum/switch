from __future__ import annotations

from collections.abc import Mapping


class SlackAgentGroupDirectory:
    """Agent user group id → agent name, pooled across every Slack workspace.

    A workspace bot token lists only that workspace's user groups, so each
    bridge mints and learns its own group per agent. An Enterprise Grid
    composer does not respect that boundary: it offers an agent's group from a
    sibling workspace in the same org, so a mention can arrive at one bridge
    carrying an id that only another bridge has ever seen. Slack has no call
    that resolves a user group by id, which leaves the bridge that created it
    as the only place its meaning exists.

    Contributions are kept per workspace so a bridge reloading or shutting down
    withdraws its own without disturbing anyone else's.
    """

    def __init__(self) -> None:
        self._by_workspace: dict[str, dict[str, str]] = {}

    def replace(self, workspace_id: str, agent_names: Mapping[str, str]) -> None:
        """Publish a workspace's whole set, dropping what it published before."""
        self._by_workspace[workspace_id] = dict(agent_names)

    def add(self, workspace_id: str, group_id: str, agent_name: str) -> None:
        self._by_workspace.setdefault(workspace_id, {})[group_id] = agent_name

    def discard(self, workspace_id: str, group_id: str) -> None:
        self._by_workspace.get(workspace_id, {}).pop(group_id, None)

    def forget(self, workspace_id: str) -> None:
        self._by_workspace.pop(workspace_id, None)

    def resolve(self, group_id: str) -> str | None:
        for groups in self._by_workspace.values():
            agent_name = groups.get(group_id)
            if agent_name is not None:
                return agent_name
        return None
