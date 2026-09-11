from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.stores.stored_template_store import StoredTemplateStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.schemas import StoredTemplateDetail, StoredTemplateSummary

router = APIRouter()

_store = StoredTemplateStore()


@router.get("")
async def list_templates(
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[object, Depends(get_current_user)],
    kind: str | None = None,
) -> list[StoredTemplateSummary]:
    templates = await _store.list_all(session, kind=kind)
    return [
        StoredTemplateSummary(
            id=t.id,
            name=t.name,
            description=t.description,
            kind=t.kind,
            creator=t.creator,
            repo_url=t.repo_url,
            sources=t.sources,
            is_bundled=t.is_bundled,
            created_at=str(t.created_at),
        )
        for t in templates
    ]


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[object, Depends(get_current_user)],
) -> StoredTemplateDetail:
    template = await _store.get(session, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return StoredTemplateDetail(
        id=template.id,
        name=template.name,
        description=template.description,
        kind=template.kind,
        definition=template.definition,
        creator=template.creator,
        repo_url=template.repo_url,
        sources=template.sources,
        is_bundled=template.is_bundled,
        created_at=str(template.created_at),
    )
