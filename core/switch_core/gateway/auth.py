from __future__ import annotations

import datetime
from typing import Annotated

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Action, Principal, require
from switch_core.config import SwitchConfig
from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.dependencies import get_config, get_session, get_user_store
from switch_core.logging_context import bind_log_context

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24


def hash_password(password: str) -> str:
    result: bytes = bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    return result.decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    # OIDC-provisioned users have no local password hash — password login must
    # fail cleanly for them rather than raising.
    if password_hash is None:
        return False
    result: bool = bcrypt.checkpw(password.encode(), password_hash.encode())
    return result


def create_jwt(user_id: str, email: str, role: str, secret_key: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "exp": datetime.datetime.now(datetime.UTC)
        + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.datetime.now(datetime.UTC),
    }
    return jwt.encode(payload, secret_key, algorithm=JWT_ALGORITHM)


def set_session_cookie(
    response: Response, user: User, secret_key: str, secure: bool
) -> None:
    """Mint the switch_auth session cookie for an authenticated user.

    Shared by password login and the OIDC callback so the session contract
    stays identical regardless of how the user proved their identity.

    `secure` gates the Secure flag: True on HTTPS deployments so the JWT is
    never sent over plain HTTP, False for local dev served over http://.
    """
    token = create_jwt(user.id, user.email, user.role, secret_key)
    response.set_cookie(
        key="switch_auth",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=86400,
        path="/",
    )


def decode_jwt(token: str, secret_key: str) -> dict:
    try:
        return jwt.decode(token, secret_key, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def get_current_user(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> User:
    token = request.cookies.get("switch_auth")
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_jwt(token, config.jwt_secret_key)
    user = await user_store.get(session, payload["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    # Unbound by RequestContextMiddleware when the request ends: its reset
    # restores the context to what it was before the request, discarding this.
    bind_log_context(user_id=user.id)
    return user


async def require_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_room_access(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    action: Action,
) -> Room:
    """Load a room (404 if missing) and authorize `action` for `user`,
    raising HTTP 403 if denied.

    Shared chokepoint for gateway routers that mutate a room they receive by
    id (attaching references, linking rooms, …) so they cannot operate on a
    room the caller lacks access to. Mirrors the protocol layer's
    ``_require_room_action``.
    """
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    try:
        require(Principal(user.id, user.role == "admin"), action, room)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return room
