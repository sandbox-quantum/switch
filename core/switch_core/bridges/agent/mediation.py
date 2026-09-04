"""Whether an agent may use the tool or model it is about to use.

Two checks, both a lookup against what the agent has attached. They used to be
reached by posting a Matrix event into a room and waiting up to ten seconds for
an answer that was computed in the same process — see the commit that moved
them here for why that was not doing anything a function call does not.

Post-invocation mediation is not here, because there is nothing to decide: the
`post_tool_result` and `post_llm_response` hooks exist as places to inspect
what came back, and today they inspect nothing. Adding a check to them means
adding it here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.agent_store import AgentStore

# What a caller gets back. `proceed` is the only verdict that lets the call
# happen; anything else carries a reason, because a refusal a user cannot act
# on is barely better than a crash.
PROCEED = "proceed"
BLOCKED = "blocked"


class Verdict(NamedTuple):
    verdict: str
    reason: str | None

    @staticmethod
    def proceed() -> Verdict:
        return Verdict(PROCEED, None)

    @staticmethod
    def blocked(reason: str) -> Verdict:
        return Verdict(BLOCKED, reason)


class MediationService:
    """Decides pre-invocation mediation from what the agent has attached."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        agent_store: AgentStore,
    ) -> None:
        self._session_factory = session_factory
        self._agent_store = agent_store

    async def tool_access(self, agent_id: str, tool_name: str) -> Verdict:
        async with self._session_factory() as session:
            tools = await self._agent_store.get_tools(session, agent_id)
        if any(tool.name == tool_name for tool in tools):
            return Verdict.proceed()
        return Verdict.blocked(
            f"Agent {agent_id} does not have tool '{tool_name}' attached"
        )

    async def model_access(self, agent_id: str, model_name: str) -> Verdict:
        async with self._session_factory() as session:
            models = await self._agent_store.get_models(session, agent_id)
        if any(model.name == model_name for model in models):
            return Verdict.proceed()
        return Verdict.blocked(
            f"Agent {agent_id} does not have model '{model_name}' attached"
        )
