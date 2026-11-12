"""`!get-document <name or id>` allows channel participants to retrieve and view
internal room documents directly in chat."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.commands import _cmd_get_document


def _doc(doc_id: str, name: str, content: str = "", description: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        id=doc_id,
        name=name,
        content=content,
        description=description,
        room_id="room-1",
        created_by_agent_id=None,
    )


def _build_client(*, docs: list[Any] = ()) -> tuple[SimpleNamespace, list[str]]:
    posted: list[str] = []

    @asynccontextmanager
    async def _session_factory():
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _send_message(_room_id, body, **_kw):
        posted.append(body)

    async def _docs_for_room(_session, _room_id):
        return list(docs)

    async def _docs_get_many(_session, _ids):
        return []

    async def _pkgs_for_room(_session, _room_id):
        return []

    client = SimpleNamespace(
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        send_message=_send_message,
        reply_command=_send_message,
        _frontend_base_url=None,
        _document_store=SimpleNamespace(
            list_for_room=_docs_for_room, get_many=_docs_get_many
        ),
        _package_store=SimpleNamespace(
            list_for_room=_pkgs_for_room,
            list_document_ids_for_package=lambda _s, _p: [],
        ),
    )
    return client, posted


_ROOM = SimpleNamespace(room_id="room-1")


def _event(args: str) -> SimpleNamespace:
    return SimpleNamespace(command="get-document", args=args, thread_id=None)


@pytest.mark.asyncio
async def test_get_document_without_args_shows_usage():
    client, posted = _build_client()
    await _cmd_get_document(client, _ROOM, _event(""), False)
    assert len(posted) == 1
    assert "Usage: `!get-document <name or id>`" in posted[0]


@pytest.mark.asyncio
async def test_get_document_returns_content():
    doc = _doc("d1", "architecture.md", content="# Architecture\nMicroservices...", description="System design")
    client, posted = _build_client(docs=[doc])

    await _cmd_get_document(client, _ROOM, _event("architecture.md"), False)
    assert len(posted) == 1
    assert "**architecture.md**" in posted[0]
    assert "System design" in posted[0]
    assert "Microservices..." in posted[0]


@pytest.mark.asyncio
async def test_get_document_matches_by_id_or_case_insensitive():
    doc = _doc("doc-uuid-123", "Runbook.md", content="Steps to deploy")
    client, posted = _build_client(docs=[doc])

    await _cmd_get_document(client, _ROOM, _event("runbook.md"), False)
    assert len(posted) == 1
    assert "Steps to deploy" in posted[0]

    await _cmd_get_document(client, _ROOM, _event("doc-uuid-123"), False)
    assert len(posted) == 2
    assert "Steps to deploy" in posted[1]


@pytest.mark.asyncio
async def test_get_document_not_found():
    client, posted = _build_client(docs=[])
    await _cmd_get_document(client, _ROOM, _event("missing.md"), False)
    assert len(posted) == 1
    assert "Document 'missing.md' not found in this room" in posted[0]


@pytest.mark.asyncio
async def test_get_document_truncates_long_content():
    long_content = "A" * 3000
    doc = _doc("d1", "huge.txt", content=long_content)
    client, posted = _build_client(docs=[doc])

    await _cmd_get_document(client, _ROOM, _event("huge.txt"), False)
    assert len(posted) == 1
    assert "... (truncated)" in posted[0]
