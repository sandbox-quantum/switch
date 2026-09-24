"""An approval request as the platform renderers draw it.

The renderers take the session contract's `SnapshotRequest`, so a row is
translated into one rather than each of the five platforms learning a second
shape. What a row does not carry is filled in plainly: the request is its own
turn, and it is at revision 1 while open and 2 once settled.
"""

from __future__ import annotations

from typing import get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.db.models import (
    ApprovalRequest,
    ApprovalRequestPost,
    Client,
    CollaborationBridge,
    ExternalUser,
    User,
)
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalOption,
    ApprovalResult,
    DecidedBy,
    RequestSettled,
    SnapshotRequest,
    Surface,
)

_SURFACES: frozenset[str] = frozenset(get_args(Surface))


def approval_request(
    row: ApprovalRequest, decided_by: DecidedBy | None
) -> SnapshotRequest:
    settled: RequestSettled | None = None
    if row.state == "answered":
        assert row.answer is not None
        settled = RequestSettled(
            type="request.settled",
            request_id=row.request_id,
            revision=2,
            outcome="answered",
            command_id=None,
            result=ApprovalResult(kind="approval", option_id=row.answer),
        )
    elif row.state in ("expired", "closed"):
        settled = RequestSettled(
            type="request.settled",
            request_id=row.request_id,
            revision=2,
            outcome="expired" if row.state == "expired" else "cancelled",
            command_id=None,
            result=None,
        )
    return SnapshotRequest(
        request_id=row.request_id,
        turn_id=row.request_id,
        revision=1 if row.state == "open" else 2,
        state={
            "open": "open",
            "answered": "resolved",
            "expired": "resolved",
            "closed": "closed",
        }[row.state],
        content=ApprovalContent(
            kind="approval",
            title=row.question,
            detail=None,
            options=[
                ApprovalOption(
                    option_id=option["id"],
                    label=option["label"],
                    decision=option["decision"],
                )
                for option in row.options
            ],
        ),
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        result=settled,
        decided_by=decided_by if row.state == "answered" else None,
    )


async def answerer_of(
    db: AsyncSession, row: ApprovalRequest, bridge_id: str
) -> tuple[DecidedBy | None, str | None]:
    """Who answered, and their handle on `bridge_id` when they answered from it.

    The handle is only ever this bridge's: naming someone by an account on the
    platform they did not answer from would say they answered where they did not.
    """
    answered_by = row.answered_by
    if row.state != "answered" or answered_by is None:
        return None, None
    if answered_by.startswith("user:"):
        user = await db.get(User, answered_by.removeprefix("user:"))
        return (
            DecidedBy(
                actor_id=user.name if user is not None else answered_by,
                surface="console",
                command_id=row.request_id,
            ),
            None,
        )
    found = (
        await db.execute(
            select(
                ExternalUser.bridge_id,
                ExternalUser.external_user_id,
                CollaborationBridge.type,
            )
            .join(Client, Client.id == ExternalUser.client_id)
            .join(CollaborationBridge, CollaborationBridge.id == ExternalUser.bridge_id)
            .where(Client.matrix_user_id == answered_by)
            .limit(1)
        )
    ).first()
    if found is None or found.type not in _SURFACES:
        return (
            DecidedBy(
                actor_id=answered_by, surface="switch-web", command_id=row.request_id
            ),
            None,
        )
    return (
        DecidedBy(actor_id=answered_by, surface=found.type, command_id=row.request_id),
        found.external_user_id if found.bridge_id == bridge_id else None,
    )


def approval_card(
    row: ApprovalRequest,
    post: ApprovalRequestPost,
    *,
    decided_by: DecidedBy | None,
    responder_external_id: str | None,
) -> RequestCard:
    return RequestCard(
        approval_request(row, decided_by),
        RequestReference(token=post.token, handle=post.handle),
        responder_external_id=responder_external_id,
    )
