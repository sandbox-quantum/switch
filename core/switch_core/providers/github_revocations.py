import asyncio
import logging

from switch_core.providers.github import GitHubConnections

logger = logging.getLogger(__name__)


async def revoke_oauth(github: GitHubConnections, token: str) -> str | None:
    try:
        async with asyncio.timeout(8):
            await github.revoke(token)
    except Exception as error:
        logger.error(
            "GitHub user token revocation failed: error_type=%s", type(error).__name__
        )
        return "GitHub could not revoke the old sign-in. Revoke it in your GitHub settings."
    return None
