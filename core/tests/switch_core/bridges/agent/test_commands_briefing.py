"""`!briefing` and `!room-briefing` show the room's instructions, attached documents,
and references that a joining agent is handed."""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.commands import _cmd_briefing


def _ref(ref_id: str, name: str, type_: str = "github", instructions: str = "", value: str = "") -> SimpleNamespace:
    return SimpleNamespace(id=ref_id, name=name, type=type_, description="Ref desc", instructions=instructions, value=value)


def _doc(doc_id: str, name: str, instructions: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        id=doc_id,
        name=name,
        description="Doc desc",
        instructions=instructions,
        room_id="room-1",
        created_by_agent_id=None,
    )


def _build_client(
    *,
    instructions: str | None = None,
    direct_refs: Sequence[Any] = (),
    direct_docs: Sequence[Any] = (),
    packages: Sequence[tuple[str, list[Any], list[Any]]] = (),
) -> tuple[SimpleNamespace, list[str]]:
    posted: list[str] = []
    pkgs = [
        SimpleNamespace(id=f"pkg-{i}", name=name, refs=refs, docs=docs)
        for i, (name, refs, docs) in enumerate(packages)
    ]
    all_refs = {r.id: r for r in direct_refs}
    all_docs = {d.id: d for d in direct_docs}
    for p in pkgs:
        all_refs.update({r.id: r for r in p.refs})
        all_docs.update({d.id: d for d in p.docs})
    by_pkg = {p.id: p for p in pkgs}

    room_row = SimpleNamespace(
        id="room-1",
        name="Security Room",
        instructions=instructions,
    )

    @asynccontextmanager
    async def _session_factory():
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Security Room")

    async def _room_get(_session, _room_id):
        return room_row

    async def _send_message(_room_id, body, **_kw):
        posted.append(body)

    async def _refs_for_room(_session, _room_id):
        return list(direct_refs)

    async def _ref_get(_session, ref_id):
        return all_refs.get(ref_id)

    async def _docs_for_room(_session, _room_id):
        return list(direct_docs)

    async def _docs_get_many(_session, ids):
        return [all_docs[i] for i in reversed(ids) if i in all_docs]

    async def _pkgs_for_room(_session, _room_id):
        return list(pkgs)

    async def _pkg_ref_ids(_session, pkg_id):
        return [r.id for r in by_pkg[pkg_id].refs]

    async def _pkg_doc_ids(_session, pkg_id):
        return [d.id for d in by_pkg[pkg_id].docs]

    client = SimpleNamespace(
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        send_message=_send_message,
        reply_command=_send_message,
        _frontend_base_url=None,
        _room_store=SimpleNamespace(get=_room_get),
        _reference_store=SimpleNamespace(list_for_room=_refs_for_room, get=_ref_get),
        _document_store=SimpleNamespace(
            list_for_room=_docs_for_room, get_many=_docs_get_many
        ),
        _package_store=SimpleNamespace(
            list_for_room=_pkgs_for_room,
            list_reference_ids_for_package=_pkg_ref_ids,
            list_document_ids_for_package=_pkg_doc_ids,
        ),
        _agent_store=SimpleNamespace(get=None),
    )
    return client, posted


_ROOM = SimpleNamespace(room_id="room-1")


def _event(command: str) -> SimpleNamespace:
    return SimpleNamespace(command=command, args="", thread_id=None)


@pytest.mark.asyncio
async def test_briefing_shows_instructions_docs_and_refs():
    doc = _doc("d1", "api-spec.md", instructions="Read endpoint schemas first.")
    ref = _ref("r1", "main-repo", type_="github", instructions="Focus on src/auth.", value="sandbox-quantum/switch")
    client, posted = _build_client(
        instructions="Always run security audits before merging.",
        direct_docs=[doc],
        direct_refs=[ref],
    )

    await _cmd_briefing(client, _ROOM, _event("briefing"), False)

    assert len(posted) == 1
    output = posted[0]
    assert "**Room briefing for Security Room:**" in output
    assert "Always run security audits before merging." in output
    assert "api-spec.md" in output
    assert "Read endpoint schemas first." in output
    assert "main-repo" in output
    assert "Focus on src/auth." in output


@pytest.mark.asyncio
async def test_briefing_handles_empty_room():
    client, posted = _build_client(instructions=None)

    await _cmd_briefing(client, _ROOM, _event("room-briefing"), False)

    assert len(posted) == 1
    output = posted[0]
    assert "**Room briefing for Security Room:**" in output
    assert "_(none configured)_" in output
    assert "_(none)_" in output
