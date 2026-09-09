"""Gateway routes for a session's room association.

The one way an association is made in v1. It is here rather than on the agent
bridge because the actor has to be a signed-in person the server can hold to a
permission, and the agent bridge authenticates hosts.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal
from switch_core.db.models import User
from switch_core.db.stores.session_room_association_store import (
    SessionAlreadyAssociated,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_session,
    get_session_association_service,
)
from switch_core.gateway.schemas import (
    SessionAssociationRequest,
    SessionAssociationResponse,
)
from switch_core.session_association import SessionAssociationService

router = APIRouter()


@router.post("/v1/sessions/{session_id}/room")
async def associate_session_with_room(
    session_id: str,
    payload: SessionAssociationRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    associations: Annotated[
        SessionAssociationService, Depends(get_session_association_service)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> SessionAssociationResponse:
    principal = Principal(user.id, user.role == "admin")
    try:
        association = await associations.grant(
            session, session_id, payload.room_id, principal
        )
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except SessionAlreadyAssociated as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await session.commit()
    return SessionAssociationResponse(
        session_id=association.session_id,
        room_id=association.room_id,
        source=association.source,
        granted_by_actor_id=association.granted_by_actor_id,
    )
