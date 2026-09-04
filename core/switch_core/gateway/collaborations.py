from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeInstallLink,
    DirectoryUser,
)
from switch_core.db.models import CollaborationBridge, ExternalUser, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.dependencies import (
    get_bridge_store,
    get_collab_lifecycle,
    get_external_user_store,
    get_room_service,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    BridgeCreateRequest,
    BridgeDetail,
    BridgeTypeInfo,
    BridgeUpdateRequest,
    ClaimIdentityRequest,
    DirectorySearchResponse,
    DirectoryUserSummary,
    ExternalUserSummary,
    IdentityClaimant,
)
from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

router = APIRouter()


async def _home_url(
    bridge_id: str, collab_lifecycle: CollaborationBridgeLifecycleService
) -> str | None:
    """Link that opens the bridge's workspace in its messaging app, built by
    the live adapter. None when the bridge is not running or the platform has
    no such link — the same "offer it only when it works" rule the per-room
    channel deeplink follows."""
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        return None
    try:
        return await adapter.home_deeplink()
    except Exception:
        logger.warning(
            "Failed to build home deeplink for bridge %s", bridge_id, exc_info=True
        )
        return None


async def _install_links(
    bridge_id: str, collab_lifecycle: CollaborationBridgeLifecycleService
) -> list[BridgeInstallLink]:
    """One-click "add the app to a chat" links, built by the live adapter.
    Empty when the bridge is not running or its platform has none — the same
    "offer it only when it works" rule as the home link."""
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        return []
    try:
        return await adapter.install_links()
    except Exception:
        logger.warning(
            "Failed to build install links for bridge %s", bridge_id, exc_info=True
        )
        return []


async def _install_note(
    bridge_id: str, collab_lifecycle: CollaborationBridgeLifecycleService
) -> str | None:
    """What the install links do not cover, in the platform's own terms. None
    when the bridge is not running or the platform has nothing to add."""
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        return None
    try:
        return await adapter.install_note()
    except Exception:
        logger.warning(
            "Failed to build the install note for bridge %s", bridge_id, exc_info=True
        )
        return None


async def _detail(
    bridge: CollaborationBridge,
    *,
    room_count: int,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    is_default: bool | None = None,
) -> BridgeDetail:
    """One place every response shape is built, so a new field cannot reach
    some endpoints and miss others. `is_default` overrides the stored value for
    a caller that just changed it in the same request."""
    return BridgeDetail(
        bridge_id=bridge.id,
        bridge_type=bridge.type,
        display_name=bridge.display_name,
        status=bridge.status,
        agent_greetings_enabled=bridge.agent_greetings_enabled,
        is_default=bridge.is_default if is_default is None else is_default,
        room_count=room_count,
        created_at=str(bridge.created_at),
        home_url=await _home_url(bridge.id, collab_lifecycle),
        install_links=await _install_links(bridge.id, collab_lifecycle),
        install_note=await _install_note(bridge.id, collab_lifecycle),
        channel_creation_supported=collab_lifecycle.supports_channel_creation(
            bridge.type
        ),
        channel_creation_enabled=bridge.channel_creation_enabled,
        directory_search_supported=collab_lifecycle.supports_directory_search(
            bridge.type
        ),
    )


@router.get("/types")
async def list_bridge_types(
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[BridgeTypeInfo]:
    return [
        BridgeTypeInfo(
            key=t,
            config_schema=collab_lifecycle.get_config_schema(t),
            channel_creation_supported=collab_lifecycle.supports_channel_creation(t),
            directory_search_supported=collab_lifecycle.supports_directory_search(t),
        )
        for t in collab_lifecycle.get_registered_types()
    ]


@router.post("")
async def create_bridge(
    req: BridgeCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only: a bridge is an unowned, workspace-wide integration holding
    # platform secrets, so there is no owner to scope to (unlike connectors,
    # whose authz is owner-or-admin) — registering one is an admin action.
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    try:
        bridge = await collab_lifecycle.register(
            bridge_type=req.bridge_type,
            display_name=req.display_name,
            connection_config=dict(req.connection_config),
            channel_creation_enabled=req.channel_creation_enabled,
        )
    except BridgeCredentialError as exc:
        # The platform's own words, verbatim — it knows what is wrong with the
        # credentials and we do not.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    is_default = bridge.is_default
    if req.set_as_default:
        await bridge_store.set_default(session, bridge.id)
        await session.commit()
        is_default = True

    return await _detail(
        bridge, room_count=0, collab_lifecycle=collab_lifecycle, is_default=is_default
    )


@router.post("/{bridge_id}/default")
async def set_default_bridge(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    """Nominate a bridge as the instance default, demoting the previous one."""
    try:
        bridge = await bridge_store.set_default(session, bridge_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await session.commit()

    rooms = await room_store.get_by_bridge(session, bridge_id)
    return await _detail(
        bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
    )


@router.get("")
async def list_bridges(
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[BridgeDetail]:
    bridges = await bridge_store.get_all(session)

    details = []
    for bridge in bridges:
        rooms = await room_store.get_by_bridge(session, bridge.id)
        details.append(
            await _detail(
                bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
            )
        )

    return details


@router.patch("/{bridge_id}")
async def update_bridge(
    bridge_id: str,
    payload: BridgeUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only for the same reason as registering one: a bridge is an unowned,
    # workspace-wide integration, so there is no owner to scope mutation to.
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    if (
        payload.channel_creation_enabled
        and not collab_lifecycle.supports_channel_creation(bridge.type)
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{bridge.type} cannot create channels from Switch, so this "
                "connection cannot be allowed to. Create the chat on the "
                "platform and add the bot to it; Switch adopts it as a room."
            ),
        )

    if payload.agent_greetings_enabled is not None:
        bridge = await bridge_store.set_agent_greetings_enabled(
            session, bridge_id, payload.agent_greetings_enabled
        )
    if payload.channel_creation_enabled is not None:
        bridge = await bridge_store.set_channel_creation_enabled(
            session, bridge_id, payload.channel_creation_enabled
        )
    if payload.connection_config is not None:
        merged = {**(bridge.connection_config or {}), **payload.connection_config}
        try:
            collab_lifecycle.validate_connection_config(bridge.type, merged)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        bridge = await bridge_store.merge_connection_config(
            session, bridge_id, dict(payload.connection_config)
        )
    await session.commit()

    # A running adapter holds the config it was built with, so a change only
    # takes effect on restart. Doing it here means enabling something is the
    # whole operation rather than a change that quietly does nothing until the
    # next deploy.
    if payload.connection_config is not None:
        await collab_lifecycle.restart(bridge_id)
    rooms = await room_store.get_by_bridge(session, bridge_id)
    return await _detail(
        bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
    )


@router.get("/{bridge_id}/users")
async def list_bridge_users(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[ExternalUserSummary]:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    users = await external_user_store.get_by_bridge(session, bridge_id)
    claims = await external_user_store.claimant_ids_for(session, [u.id for u in users])
    names = await _user_names(session, user_store, claims)
    return [
        ExternalUserSummary(
            id=u.id,
            bridge_id=u.bridge_id,
            external_user_id=u.external_user_id,
            external_username=u.external_username,
            claimed_by=_claimants(claims.get(u.id, []), names),
        )
        for u in users
    ]


async def _user_names(
    session: AsyncSession,
    user_store: UserStore,
    claims: dict[str, list[str]],
) -> dict[str, str]:
    """Display names for every Switch user appearing in these claims.

    Resolved in one pass over the user table rather than a lookup per
    claimant: a bridge's user list is otherwise N+1 in the number of claims.
    """
    wanted = {uid for ids in claims.values() for uid in ids}
    if not wanted:
        return {}
    return {u.id: u.name for u in await user_store.get_all(session) if u.id in wanted}


def _claimants(user_ids: list[str], names: dict[str, str]) -> list[IdentityClaimant]:
    def label(user_id: str) -> str:
        return names.get(user_id) or user_id

    return [
        IdentityClaimant(user_id=user_id, user_name=label(user_id))
        for user_id in sorted(user_ids, key=lambda uid: label(uid).lower())
    ]


@router.get("/{bridge_id}/directory")
async def search_bridge_directory(
    bridge_id: str,
    query: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> DirectorySearchResponse:
    """Find someone on a messaging platform so they can be claimed.

    Switch only records someone as an `ExternalUser` once they have spoken, so
    a freshly connected workspace has nobody to pick from. Asking the platform
    instead is what makes claiming an identity possible before you have ever
    posted.

    Platforms with no searchable directory — Telegram, where a bot can only see
    who has spoken to it — fall back to exactly that: the accounts Switch has
    already seen on this bridge. The response says which of the two answered, so
    the caller can explain why the list is narrower rather than presenting a
    partial answer as a whole one. It is a smaller list, not an error: refusing
    outright would leave owner-only addressing unusable on those platforms even
    for someone Switch knows perfectly well.
    """
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        raise HTTPException(
            status_code=409,
            detail="Bridge is not running — start it before searching its directory",
        )

    known = {
        u.external_user_id: u
        for u in await external_user_store.get_by_bridge(session, bridge_id)
    }

    source: Literal["directory", "known"] = "directory"
    note: str | None = None
    try:
        found = await adapter.search_directory_users(query)
    except NotImplementedError as e:
        source = "known"
        note = str(e)
        found = _known_as_directory_users(known.values(), query)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    claims = await external_user_store.claimant_ids_for(
        session, [u.id for u in known.values()]
    )
    names = await _user_names(session, user_store, claims)
    return DirectorySearchResponse(
        source=source,
        note=note,
        users=[
            DirectoryUserSummary(
                external_user_id=person.external_user_id,
                username=person.username,
                display_name=person.display_name,
                email=person.email,
                known_external_user_id=(
                    known[person.external_user_id].id
                    if person.external_user_id in known
                    else None
                ),
                claimed_by=(
                    _claimants(claims.get(known[person.external_user_id].id, []), names)
                    if person.external_user_id in known
                    else []
                ),
            )
            for person in found
        ],
    )


def _known_as_directory_users(
    known: Iterable[ExternalUser], query: str
) -> list[DirectoryUser]:
    """The accounts Switch has already seen, shaped like a directory answer.

    Substring rather than prefix matching, because this list is what someone
    falls back to when the platform cannot be searched, and being unable to
    find yourself there is the end of the road. No email: an account is
    recorded from a message, which carries no address.
    """
    needle = query.strip().casefold()
    if not needle:
        return []
    return sorted(
        (
            DirectoryUser(
                external_user_id=u.external_user_id,
                username=u.external_username,
                display_name=u.external_username,
                email=None,
            )
            for u in known
            if needle in u.external_username.casefold()
        ),
        key=lambda u: u.display_name.casefold(),
    )


async def _require_directory_account(
    collab_lifecycle: CollaborationBridgeLifecycleService,
    *,
    bridge_id: str,
    external_user_id: str,
    username: str,
) -> None:
    """Raise unless the platform's directory really lists this account.

    This is an existence check, not an ownership one — anyone may claim any
    real account, deliberately. What it prevents is provisioning a Matrix
    puppet for an id that came from nowhere: the claim body is user-supplied,
    and the row it creates is permanent.

    Only reached for an account Switch has never seen. One it has recorded is
    already proof the account exists, and the caller claims it without asking
    the platform — which is the only path open on a platform whose directory
    cannot be searched.
    """
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        raise HTTPException(
            status_code=409,
            detail="Bridge is not running — cannot look this account up",
        )
    try:
        candidates = await adapter.search_directory_users(username)
    except NotImplementedError as e:
        raise HTTPException(
            status_code=501,
            detail=(
                f"{e} — so this account cannot be linked before it has been "
                "seen. Send one message in the workspace, then link it."
            ),
        ) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    if not any(c.external_user_id == external_user_id for c in candidates):
        raise HTTPException(
            status_code=404,
            detail=(
                f"No account {username!r} with that id exists on this "
                "workspace's directory"
            ),
        )


@router.post("/{bridge_id}/identities")
async def claim_bridge_identity(
    bridge_id: str,
    payload: ClaimIdentityRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> ExternalUserSummary:
    """Claim a platform identity for a Switch user (CHOO-2137).

    This is what makes owner-only addressing enforceable: until the person
    behind a Slack or Mattermost account is known to be a particular Switch
    user, an owner-scoped rule can never recognise them.

    Claiming one for someone else is an admin action; claiming one for
    yourself is not. Claims are **not exclusive** — several Switch users may
    claim the same account, and each is then recognised as themselves on it.
    An exclusive claim would let whoever got there first keep the real person
    from ever being recognised by their own agents, so a second claim is
    ordinary rather than a conflict.
    """
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    target_user_id = payload.user_id or user.id
    if target_user_id != user.id and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only an admin may claim a messaging identity for another user",
        )
    if await user_store.get(session, target_user_id) is None:
        raise HTTPException(status_code=404, detail="Switch user not found")

    external_user = await external_user_store.get_by_external_id(
        session, bridge_id, payload.external_user_id
    )
    if external_user is None:
        # Nobody has seen this person speak yet, which is the normal case right
        # after connecting a workspace. Provision the identity now rather than
        # making them post something first — but only once the platform agrees
        # the account exists. Provisioning mints a Matrix puppet, so taking the
        # request's word for it would let any signed-in user conjure accounts
        # for people who do not exist.
        await _require_directory_account(
            collab_lifecycle,
            bridge_id=bridge_id,
            external_user_id=payload.external_user_id,
            username=payload.username,
        )
        bridge_core = collab_lifecycle.get(bridge_id)
        if bridge_core is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Bridge is not running — start it before claiming an "
                    "identity Switch has not seen yet"
                ),
            )
        try:
            external_user = await bridge_core.ensure_external_user(
                external_user_id=payload.external_user_id,
                external_username=payload.username,
            )
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        session.expire_all()
        external_user = await external_user_store.get_by_external_id(
            session, bridge_id, payload.external_user_id
        )
        if external_user is None:
            raise HTTPException(
                status_code=500,
                detail="Identity was provisioned but could not be read back",
            )

    await external_user_store.claim(session, external_user, target_user_id)
    await session.commit()

    return await _identity_summary(
        session, external_user_store, user_store, external_user
    )


async def _identity_summary(
    session: AsyncSession,
    external_user_store: ExternalUserStore,
    user_store: UserStore,
    external_user: ExternalUser,
) -> ExternalUserSummary:
    claims = {
        external_user.id: await external_user_store.claimant_ids(
            session, external_user.id
        )
    }
    names = await _user_names(session, user_store, claims)
    return ExternalUserSummary(
        id=external_user.id,
        bridge_id=external_user.bridge_id,
        external_user_id=external_user.external_user_id,
        external_username=external_user.external_username,
        claimed_by=_claimants(claims[external_user.id], names),
    )


@router.delete("/{bridge_id}/identities/{external_user_row_id}")
async def release_bridge_identity(
    bridge_id: str,
    external_user_row_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    user_id: str | None = None,
) -> ExternalUserSummary:
    """Drop a claim on a platform account — your own, or someone else's if you
    are an admin. Anyone else's claim on the same account is left standing."""
    external_user = await external_user_store.get(session, external_user_row_id)
    if external_user is None or external_user.bridge_id != bridge_id:
        raise HTTPException(status_code=404, detail="Identity not found")

    target_user_id = user_id or user.id
    if target_user_id != user.id and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only an admin may release another user's messaging identity",
        )

    released = await external_user_store.release(session, external_user, target_user_id)
    if not released:
        # Deleting nothing and reporting success would make a mistyped user id
        # look like an unlink that worked.
        raise HTTPException(
            status_code=404,
            detail="That user has no claim on this messaging account",
        )
    await session.commit()
    return await _identity_summary(
        session, external_user_store, user_store, external_user
    )


@router.delete("/{bridge_id}")
async def delete_bridge(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only: deleting a bridge cascades into deleting every room on it, so
    # this is the most destructive operation on the router.
    _user: Annotated[User, Depends(require_admin)],
) -> dict[str, bool]:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    rooms = await room_store.get_by_bridge(session, bridge_id)
    for room in rooms:
        await room_service.delete_room(room.id)

    await collab_lifecycle.remove(bridge_id)
    return {"ok": True}
