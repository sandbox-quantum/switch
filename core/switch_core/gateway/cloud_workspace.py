"""Where a Switch cloud machine keeps an agent's workspace on its disk."""


def worktree_path(agent_id: str, repository: str | None) -> str:
    """The agent's worktree: of `repository` (its `owner/name`) on the
    agent's own branch, or a fresh workspace when it works in none."""
    if repository is None:
        return f"/data/worktrees/{agent_id}/workspace"
    return f"/data/worktrees/{agent_id}/{repository.lower()}"
