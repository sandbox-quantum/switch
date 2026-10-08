"""Where a Switch cloud machine keeps an agent's workspace on its disk."""


def worktree_path(agent_id: str) -> str:
    """The agent's workspace, which starts empty: the agent clones what it
    needs into it."""
    return f"/data/worktrees/{agent_id}/workspace"
