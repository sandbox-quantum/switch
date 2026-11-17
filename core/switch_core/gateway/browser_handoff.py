"""Opening a dashboard page in the person's own browser, already signed in.

Switch Console holds a session of its own and never hands it over. It asks
for a sign-in link instead (`POST /auth/handoff`): a one-time code, good for
60 seconds, bound to the person and to Console's session. The code travels in
the link's fragment (`/auth/handoff#code=…`), which a browser never sends to a
server, so it lands in no access log and no Referer. The dashboard's page
reads it, drops it from the address, and redeems it
(`POST /auth/handoff/redeem`) for a session of the browser's own: a new
session id, Console's workspace, and Console's sign-in time and session
version, so it never outlives Console's session and ends with "Sign out of
all devices". Signing out of Console's session signs it out too
(`auth.sign_out_session`); signing out in the browser leaves Console's
alone. `POST /auth/handoff/peek` tells the page whose link it is
before spending it, so a browser signed in as someone else asks first.

Peek and redeem take no session, and are checked against the server's own
origins whether or not they carry one (`origin_check.SIGN_IN_PATHS`), as
signing in is: a foreign page must not sign a browser in to someone else's
account. Nothing here logs a code.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.browser_handoff_store import (
    MINT_WINDOW,
    BrowserHandoffRateLimited,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    BROWSER_HANDOFFS,
    SignedIn,
    get_current_user,
    new_session_id,
    session_auth_time,
    session_id_of,
    session_signed_out,
    set_session_cookie,
    signed_in_user,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.ui import is_page

logger = logging.getLogger(__name__)

router = APIRouter()

# The dashboard page a link opens, which redeems its code.
HANDOFF_PAGE = "/auth/handoff"

EXPIRED_DETAIL = (
    "This sign-in link has expired or was already used. Open the page again "
    "from Switch Console."
)
ENDED_DETAIL = (
    "Switch Console was signed out after it made this sign-in link. Sign in again."
)

_NEXT_MAX_LENGTH = 2048
# A code is 43 characters; anything far longer is no code, and is refused
# before it is hashed.
_CODE_MAX_LENGTH = 256


class MintHandoffBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # The dashboard page to open once signed in: a path on the dashboard,
    # with any query and fragment.
    next: str


class HandoffCodeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(max_length=_CODE_MAX_LENGTH)


class MintedHandoffResponse(BaseModel):
    # Where on the dashboard to open the browser, code in the fragment.
    path: str
    expires_at: datetime


class HandoffPerson(BaseModel):
    name: str
    email: str


class HandoffPeekResponse(BaseModel):
    name: str
    email: str
    workspace_name: str | None
    # Whoever this browser is signed in as already, if anyone.
    signed_in_as: HandoffPerson | None
    same_person: bool


class HandoffRedeemResponse(BaseModel):
    next: str


def checked_next(value: str) -> str:
    """`value` if it is one of the dashboard's pages on this origin, so a
    link can never send the browser anywhere else; otherwise 400 saying why.

    Control characters are refused along with the rest: a browser drops a tab
    or a newline from an address, so `/\\t/evil.example` would arrive as
    `//evil.example`, another host.
    """

    def refused(reason: str) -> HTTPException:
        return HTTPException(status_code=400, detail=f"next {reason}")

    if len(value) > _NEXT_MAX_LENGTH:
        raise refused(f"is longer than {_NEXT_MAX_LENGTH} characters")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise refused("contains a control character")
    if not value.startswith("/") or value.startswith("//"):
        raise refused("must be a path on the dashboard, starting with a single /")
    if "\\" in value:
        raise refused("contains a backslash")
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        raise refused("names a scheme or a host")
    if not is_page(parts.path):
        raise refused(f"is not one of the dashboard's pages: {parts.path}")
    return value


def _expired() -> HTTPException:
    return HTTPException(status_code=410, detail=EXPIRED_DETAIL)


@router.post("/auth/handoff", status_code=201)
async def mint_handoff(
    body: MintHandoffBody,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> MintedHandoffResponse:
    """A one-time link that opens `next` in a browser signed in as the
    caller, in the workspace this session is in. The browser's session can
    never outlive this one: it takes this one's sign-in time."""
    next_path = checked_next(body.next)
    # Read before the rollback below, which expires the row.
    user_id = user.id
    try:
        minted = await BROWSER_HANDOFFS.mint(
            session,
            user_id=user_id,
            workspace_claim=request.state.tenant_id,
            next_path=next_path,
            auth_time=session_auth_time(request),
            session_version=user.session_version,
            console_sid=session_id_of(request),
        )
    except BrowserHandoffRateLimited as refusal:
        await session.rollback()
        logger.warning(
            "Refused a browser sign-in link for user %s: %s", user_id, refusal
        )
        raise HTTPException(
            status_code=429,
            detail="Too many sign-in links in the last minute. Try again shortly.",
            headers={"Retry-After": str(int(MINT_WINDOW.total_seconds()))},
        ) from None
    await session.commit()
    return MintedHandoffResponse(
        path=f"{HANDOFF_PAGE}#code={minted.code}", expires_at=minted.expires_at
    )


async def _workspace_name(
    session_factory: async_sessionmaker[AsyncSession], workspace_claim: str | None
) -> str | None:
    """The name of the workspace a link signs in to, read bound to it, as a
    workspace's row is readable only there. None for no workspace, or one
    deleted since."""
    if workspace_claim is None:
        return None
    async with tenant_session(session_factory, workspace_claim) as session:
        tenant = await session.get(Tenant, workspace_claim)
    return tenant.name if tenant is not None else None


@router.post("/auth/handoff/peek")
async def peek_handoff(
    body: HandoffCodeBody,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> HandoffPeekResponse:
    """Whose sign-in link this is, and whom this browser is signed in as
    already, without spending the link. `get_system_session`: nobody need be
    signed in, and the rows read belong to no workspace."""
    handoff = await BROWSER_HANDOFFS.peek(session, body.code)
    owner = (
        await user_store.get(session, handoff.user_id) if handoff is not None else None
    )
    if handoff is None or owner is None:
        await session.rollback()
        raise _expired()
    here = await signed_in_user(request, session, user_store, config)
    # One connection at a time: release this one before the workspace's.
    await session.commit()
    return HandoffPeekResponse(
        name=owner.name,
        email=owner.email,
        workspace_name=await _workspace_name(session_factory, handoff.workspace_claim),
        signed_in_as=(
            HandoffPerson(name=here.name, email=here.email)
            if here is not None
            else None
        ),
        same_person=here is not None and here.id == owner.id,
    )


@router.post("/auth/handoff/redeem")
async def redeem_handoff(
    body: HandoffCodeBody,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> HandoffRedeemResponse:
    """Spend a sign-in link, and sign this browser in with a session of its
    own: a new session id, the link's workspace, and the sign-in time and
    session version of the Console session that made it.

    Refused with 410 once the link was used or expired, the account is gone,
    or Console's session was signed out, or every session ended, since. A
    sign-in older than a session may live is refused with 401 as its cookie
    is made (`session_expires_at`). `get_system_session`: the browser need
    hold no session, and the rows read belong to no workspace.
    """
    browser_sid = new_session_id()
    handoff = await BROWSER_HANDOFFS.redeem(session, body.code, browser_sid=browser_sid)
    if handoff is None:
        await session.rollback()
        raise _expired()
    # Asked after the row is spent, in its transaction: a sign-out of
    # Console's session either committed before and is seen here, or is
    # waiting on this row and signs this browser out with it
    # (`auth.sign_out_session`).
    console_signed_out = await session_signed_out(session, handoff.console_sid)
    user = await user_store.get(session, handoff.user_id)
    # Spent, whatever is decided below.
    await session.commit()
    if user is None:
        raise _expired()
    if console_signed_out or user.session_version != handoff.session_version:
        raise HTTPException(status_code=410, detail=ENDED_DETAIL)
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        handoff.workspace_claim,
        SignedIn(session_id=browser_sid, at=handoff.auth_time),
    )
    if handoff.workspace_claim is not None:
        async with tenant_session(session_factory, handoff.workspace_claim) as audit:
            await record_audit_event(
                audit,
                tenant_id=handoff.workspace_claim,
                actor_user_id=user.id,
                action=AuditAction.BROWSER_HANDOFF,
                target_type="user",
                target_id=user.id,
                details={"next": handoff.next_path},
            )
            await audit.commit()
    return HandoffRedeemResponse(next=handoff.next_path)
