"""The template registry's HTTP surface.

Two rules shape the whole of this module. A stored document is returned exactly
as it arrived — nothing here parses, validates or reformats it — and the
catalogue is shared, so ownership decides who may change a template rather than
who may see it.

"Shared" means shared within the tenant. Nothing here says so, and that is
deliberate: row-level security draws that boundary in the database, and a
second copy of it in these queries would be a second answer to a question
already answered — agreeing right up until the day it did not.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import (
    Action,
    Principal,
    can,
    can_manage,
    require,
    require_manage,
    validate_visibility_pair,
)
from switch_core.config import SwitchConfig
from switch_core.content_disposition import content_disposition
from switch_core.db.models import Template, User
from switch_core.db.stores.template_store import (
    TemplateListing,
    TemplateNameTaken,
    TemplateStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.feature_flags import AGENT_MANAGEMENT, SWITCH_BUDDY
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_config,
    get_session,
    get_template_store,
    get_user_store,
)
from switch_core.gateway.schemas import (
    TemplateCreateRequest,
    TemplateDeleteResponse,
    TemplateDetail,
    TemplateFinding,
    TemplateSummary,
    TemplateUpdateRequest,
    TemplateValidateRequest,
    TemplateValidateResponse,
)
from switch_core.official_templates import (
    OfficialTemplate,
    is_official,
    matches,
    official_template,
    official_templates,
)
from switch_core.telemetry import emit_safely
from switch_core.telemetry.ages import age_days
from switch_core.template_lint import lint_template


def _kind(value: str | None) -> str:
    """A template's kind as the catalogue spells it.

    The column is free text, so only the three the product uses are named and
    an operator's own kind reports as `other`.
    """
    return value if value in ("room", "group", "agent") else "other"


router = APIRouter()


def _size_bytes(content: str) -> int:
    """What the document weighs on the wire, not how many characters it has."""
    return len(content.encode("utf-8"))


def _summary(
    row: TemplateListing, owner_name: str | None, principal: Principal
) -> TemplateSummary:
    return TemplateSummary(
        id=row.id,
        owner_id=row.owner_id,
        owner_name=owner_name,
        name=row.name,
        description=row.description,
        kind=row.kind,
        read_visibility=row.read_visibility,
        write_visibility=row.write_visibility,
        can_edit=can(principal, "write", row),
        can_manage=can_manage(principal, row.owner_id),
        version=row.version,
        size_bytes=row.size_bytes,
        created_at=str(row.created_at),
        updated_at=str(row.updated_at),
    )


def _official_detail(template: OfficialTemplate) -> TemplateDetail:
    return TemplateDetail(
        id=template.id,
        owner_id=None,
        owner_name="Switch",
        name=template.name,
        description=template.description,
        kind=template.kind,
        read_visibility=template.read_visibility,
        write_visibility=template.write_visibility,
        official=True,
        can_edit=False,
        can_manage=False,
        version=template.version,
        size_bytes=_size_bytes(template.content),
        created_at="",
        updated_at="",
        content=template.content,
    )


def _official_or_none(
    template_id: str, config: SwitchConfig
) -> OfficialTemplate | None:
    """The official template an ``official:`` id names, or a 404 for one
    this release does not ship; None for any other id."""
    if not is_official(template_id):
        return None
    template = official_template(
        template_id,
        config.feature_flags[AGENT_MANAGEMENT],
        config.feature_flags[SWITCH_BUDDY],
    )
    if template is None:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        )
    return template


async def readable_template(
    template_id: str,
    session: AsyncSession,
    store: TemplateStore,
    user: User,
    is_admin: bool,
    config: SwitchConfig,
) -> Template | OfficialTemplate:
    """A template the caller may read, official or saved; 404 otherwise."""
    official = _official_or_none(template_id, config)
    if official is not None:
        return official
    return await _load_for("read", session, store, template_id, user, is_admin)


def _refuse_official(template_id: str) -> None:
    if is_official(template_id):
        raise HTTPException(
            status_code=403,
            detail=(
                "This template comes with Switch, so nobody can change or delete it. "
                "Save your own copy under another name to change it."
            ),
        )


def _detail(
    template: Template, owner_name: str | None, principal: Principal
) -> TemplateDetail:
    return TemplateDetail(
        id=template.id,
        owner_id=template.owner_id,
        owner_name=owner_name,
        name=template.name,
        description=template.description,
        kind=template.kind,
        read_visibility=template.read_visibility,
        write_visibility=template.write_visibility,
        can_edit=can(principal, "write", template),
        can_manage=can_manage(principal, template.owner_id),
        version=template.version,
        size_bytes=_size_bytes(template.content),
        created_at=str(template.created_at),
        updated_at=str(template.updated_at),
        content=template.content,
    )


async def _owner_names(
    session: AsyncSession, user_store: UserStore, owner_ids: set[str]
) -> dict[str, str]:
    names: dict[str, str] = {}
    for owner_id in owner_ids:
        owner = await user_store.get(session, owner_id)
        if owner is not None:
            names[owner_id] = owner.name
    return names


async def _owner_name(
    session: AsyncSession, user_store: UserStore, owner_id: str
) -> str | None:
    owner = await user_store.get(session, owner_id)
    return owner.name if owner is not None else None


def _require_storable(content: str) -> None:
    """Refuse a document no consumer could ever provision.

    Only the checker's blocking findings — not YAML, empty, not a mapping —
    are refused here. Everything else it says is advice the caller is free to
    ignore, because the format keeps moving and this check has been wrong
    about a valid document before.

    Enforced on the API rather than only in the form, so the two cannot
    disagree and a `curl` cannot walk past a rule the dashboard applies.
    """
    result = lint_template(content)
    if result.blocked:
        raise HTTPException(
            status_code=422,
            detail="; ".join(f.message for f in result.errors if f.blocking),
        )


def _require_within_size_limit(content: str, config: SwitchConfig) -> None:
    size = _size_bytes(content)
    if size > config.template_max_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Template is {size} bytes, over the {config.template_max_bytes}-byte "
                "limit for this server."
            ),
        )


async def _load_for(
    action: Action,
    session: AsyncSession,
    store: TemplateStore,
    template_id: str,
    user: User,
    is_admin: bool,
) -> Template:
    """Fetch a template, refusing unless the caller may ``action`` it.

    A private template the caller may not read is reported as not found,
    so the listing and the detail route agree on what exists for them.
    """
    template = await store.get(session, template_id)
    if template is None:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        )
    principal = Principal(user.id, is_admin)
    try:
        require(principal, "read", template)
    except PermissionError as e:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        ) from e
    if action != "read":
        try:
            require(principal, action, template)
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
    return template


def _require_visibility(read_visibility: str, write_visibility: str) -> None:
    try:
        validate_visibility_pair(read_visibility, write_visibility)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/templates")
async def list_templates(
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    q: Annotated[str | None, Query()] = None,
    kind: Annotated[str | None, Query()] = None,
    owner_id: Annotated[str | None, Query()] = None,
) -> list[TemplateSummary]:
    """Browse the catalogue. `q` matches name or description, case-insensitively."""
    rows = await template_store.list_all(
        session,
        viewer_id=user.id,
        is_admin=is_admin,
        query=q,
        kind=kind,
        owner_id=owner_id,
    )
    names = await _owner_names(session, user_store, {r.owner_id for r in rows})
    principal = Principal(user.id, is_admin)
    # The ones that come with Switch first, as nobody's own.
    official = (
        []
        if owner_id
        else [
            TemplateSummary(**_official_detail(t).model_dump(exclude={"content"}))
            for t in official_templates(
                config.feature_flags[AGENT_MANAGEMENT],
                config.feature_flags[SWITCH_BUDDY],
            )
            if matches(t, q, kind)
        ]
    )
    return official + [_summary(r, names.get(r.owner_id), principal) for r in rows]


@router.post("/templates", status_code=201)
async def create_template(
    req: TemplateCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> TemplateDetail:
    _require_within_size_limit(req.content, config)
    _require_storable(req.content)
    _require_visibility(req.read_visibility, req.write_visibility)
    try:
        template = await template_store.create(
            session,
            Template(
                owner_id=user.id,
                name=req.name,
                description=req.description,
                kind=req.kind,
                content=req.content,
                read_visibility=req.read_visibility,
                write_visibility=req.write_visibility,
            ),
        )
    except TemplateNameTaken as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await session.commit()
    # What the template provisions, not what it is called. A template that
    # brings rooms and agents with it is a different thing from one that
    # carries neither, and that shape is reportable where the name is not.
    emit_safely(
        current_telemetry(), "template_created", {"template_kind": _kind(req.kind)}
    )
    return _detail(
        template,
        await _owner_name(session, user_store, user.id),
        Principal(user.id, is_admin),
    )


@router.post("/templates/validate")
async def validate_template(
    req: TemplateValidateRequest,
    _user: Annotated[User, Depends(get_current_user)],
) -> TemplateValidateResponse:
    """Check a document without storing it.

    Declared above `/templates/{template_id}` so the literal path wins; FastAPI
    matches in declaration order and would otherwise read "validate" as an id.

    Advisory by design. It never asks whether this is a room, a group or
    something newer — the registry holds documents in shapes this server may
    not know, and upload does not consult this at all.
    """
    result = lint_template(req.content)
    return TemplateValidateResponse(
        ok=result.ok,
        blocked=result.blocked,
        errors=[
            TemplateFinding(
                code=f.code,
                message=f.message,
                subject=f.subject,
                blocking=f.blocking,
            )
            for f in result.errors
        ],
        warnings=[
            TemplateFinding(
                code=f.code,
                message=f.message,
                subject=f.subject,
                blocking=f.blocking,
            )
            for f in result.warnings
        ],
    )


@router.get("/templates/{template_id}")
async def get_template(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> TemplateDetail:
    official = _official_or_none(template_id, config)
    if official is not None:
        return _official_detail(official)
    template = await _load_for(
        "read", session, template_store, template_id, user, is_admin
    )
    return _detail(
        template,
        await _owner_name(session, user_store, template.owner_id),
        Principal(user.id, is_admin),
    )


@router.get("/templates/{template_id}/content", response_model=None)
async def get_template_content(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    """The stored document itself, byte for byte, with no envelope around it."""
    template: Template | OfficialTemplate | None = _official_or_none(
        template_id, config
    )
    if template is None:
        template = await _load_for(
            "read", session, template_store, template_id, user, is_admin
        )
    return Response(
        content=template.content.encode("utf-8"),
        media_type="application/x-yaml",
        headers={
            "Content-Disposition": content_disposition(
                "attachment", f"{template.name}.yaml", "template"
            ),
            # The bytes are whatever someone uploaded, so a browser must not be
            # talked into sniffing them into something it will render.
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.patch("/templates/{template_id}")
async def patch_template(
    template_id: str,
    req: TemplateUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> TemplateDetail:
    _refuse_official(template_id)
    current = await _load_for(
        "write", session, template_store, template_id, user, is_admin
    )
    principal = Principal(user.id, is_admin)
    changes_access = req.read_visibility is not None or req.write_visibility is not None
    if changes_access:
        # Who may see or change a template is decided by its owner or an
        # admin, not by an editor: an open template must not be closed, or
        # opened wider, by someone who may only edit its document.
        try:
            require_manage(principal, current.owner_id)
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        _require_visibility(
            current.read_visibility
            if req.read_visibility is None
            else req.read_visibility,
            current.write_visibility
            if req.write_visibility is None
            else req.write_visibility,
        )

    def still_allowed(locked: Template) -> None:
        # Checked again on the locked row: the owner may have closed the
        # template since the check above.
        require(principal, "write", locked)
        if changes_access:
            require_manage(principal, locked.owner_id)

    if req.content is not None:
        # Not held across linting (up to 1 MiB of YAML); the update re-checks under lock.
        await session.commit()
        _require_within_size_limit(req.content, config)
        _require_storable(req.content)
    try:
        template = await template_store.update_fields(
            session,
            template_id,
            name=req.name,
            description=req.description,
            kind=req.kind,
            content=req.content,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            guard=still_allowed,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except TemplateNameTaken as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        # The row was there for the ownership check a moment ago, so this is a
        # delete that landed in between — gone, not in conflict.
        raise HTTPException(status_code=404, detail=str(e)) from e
    await session.commit()
    return _detail(
        template,
        await _owner_name(session, user_store, template.owner_id),
        Principal(user.id, is_admin),
    )


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> TemplateDeleteResponse:
    _refuse_official(template_id)
    template = await _load_for(
        "delete", session, template_store, template_id, user, is_admin
    )
    kind, age = _kind(template.kind), age_days(template.created_at)
    try:
        await template_store.delete(session, template_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    await session.commit()
    emit_safely(
        current_telemetry(),
        "template_deleted",
        {"template_kind": kind, "age_days": age},
    )
    return TemplateDeleteResponse(deleted_id=template_id)
