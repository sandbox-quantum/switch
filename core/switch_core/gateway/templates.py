"""The template registry's HTTP surface.

Two rules shape the whole of this module. A stored document is returned exactly
as it arrived — nothing here parses, validates or reformats it — and the
catalogue is server-wide, so ownership decides who may change a template rather
than who may see it.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, require_manage
from switch_core.config import SwitchConfig
from switch_core.db.models import Template, User
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_template_store,
    get_user_store,
)
from switch_core.gateway.schemas import (
    TemplateCreateRequest,
    TemplateDeleteResponse,
    TemplateDetail,
    TemplateSummary,
    TemplateUpdateRequest,
)

router = APIRouter()


def _size_bytes(content: str) -> int:
    """What the document weighs on the wire, not how many characters it has."""
    return len(content.encode("utf-8"))


def _summary(template: Template, owner_name: str | None) -> TemplateSummary:
    return TemplateSummary(
        id=template.id,
        owner_id=template.owner_id,
        owner_name=owner_name,
        name=template.name,
        description=template.description,
        kind=template.kind,
        version=template.version,
        size_bytes=_size_bytes(template.content),
        created_at=str(template.created_at),
        updated_at=str(template.updated_at),
    )


def _detail(template: Template, owner_name: str | None) -> TemplateDetail:
    return TemplateDetail(
        **_summary(template, owner_name).model_dump(), content=template.content
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


async def _load_for_management(
    session: AsyncSession, store: TemplateStore, template_id: str, user: User
) -> Template:
    """Fetch a template the caller is allowed to change, or fail saying why."""
    template = await store.get(session, template_id)
    if template is None:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        )
    try:
        require_manage(Principal(user.id, user.role == "admin"), template.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return template


@router.get("/templates")
async def list_templates(
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
    q: Annotated[str | None, Query()] = None,
    kind: Annotated[str | None, Query()] = None,
    owner_id: Annotated[str | None, Query()] = None,
) -> list[TemplateSummary]:
    """Browse the catalogue. `q` matches name or description, case-insensitively."""
    templates = await template_store.list_all(
        session, query=q, kind=kind, owner_id=owner_id
    )
    names = await _owner_names(session, user_store, {t.owner_id for t in templates})
    return [_summary(t, names.get(t.owner_id)) for t in templates]


@router.post("/templates", status_code=201)
async def create_template(
    req: TemplateCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> TemplateDetail:
    _require_within_size_limit(req.content, config)
    try:
        template = await template_store.create(
            session,
            Template(
                owner_id=user.id,
                name=req.name,
                description=req.description,
                kind=req.kind,
                content=req.content,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await session.commit()
    return _detail(template, await _owner_name(session, user_store, user.id))


@router.get("/templates/{template_id}")
async def get_template(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> TemplateDetail:
    template = await template_store.get(session, template_id)
    if template is None:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        )
    return _detail(template, await _owner_name(session, user_store, template.owner_id))


@router.get("/templates/{template_id}/content", response_model=None)
async def get_template_content(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """The stored document itself, byte for byte, with no envelope around it."""
    template = await template_store.get(session, template_id)
    if template is None:
        raise HTTPException(
            status_code=404, detail=f"Template not found: {template_id}"
        )
    return Response(
        content=template.content.encode("utf-8"),
        media_type="application/x-yaml",
        headers={"Content-Disposition": f'attachment; filename="{template.name}.yaml"'},
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
) -> TemplateDetail:
    await _load_for_management(session, template_store, template_id, user)
    if req.content is not None:
        _require_within_size_limit(req.content, config)
    try:
        template = await template_store.update_fields(
            session,
            template_id,
            name=req.name,
            description=req.description,
            kind=req.kind,
            content=req.content,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await session.commit()
    return _detail(template, await _owner_name(session, user_store, template.owner_id))


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> TemplateDeleteResponse:
    await _load_for_management(session, template_store, template_id, user)
    await template_store.delete(session, template_id)
    await session.commit()
    return TemplateDeleteResponse(deleted_id=template_id)
