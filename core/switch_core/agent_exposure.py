"""Whether anyone but an agent's owner may have it act for them."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import parse_policy
from switch_core.db.models import Agent
from switch_core.db.stores.external_user_store import ExternalUserStore


async def others_can_address(session: AsyncSession, agent: Agent) -> bool:
    """Whether someone other than the agent's owner, or an agent they don't
    own, may address it, and so have it act with what its owner granted it.

    An open policy (including none stored) does. An agent nobody owns has no
    owner to count, so this is only its policy's openness.
    """
    policy = parse_policy(agent.addressing_policy)
    if policy.is_open():
        return True
    # Counting none of the owner's identities as theirs can only widen the
    # answer, so a "no" here is final and the usual policies (owner only,
    # owner and their agents) need no read.
    if not policy.admits_others(owner_identity_ids=set()):
        return False
    identities = (
        await ExternalUserStore().get_by_user(session, agent.owner_id)
        if agent.owner_id is not None
        else []
    )
    return policy.admits_others(
        owner_identity_ids={identity.id for identity in identities}
    )
