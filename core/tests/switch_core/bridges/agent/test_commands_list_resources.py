"""`!list-references` and `!list-documents` list what the room's packages bring
as well as what is attached to the room directly, since agents in the room
are sent both.

Their links into the dashboard, and `!room-url`'s, name the room's workspace
(`?workspace=`): a link that names none opens in whichever workspace the
reader's browser used last, where the item is not found."""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.commands import (
    _cmd_list_documents,
    _cmd_list_references,
    _cmd_room_url,
)

DASHBOARD = "https://switch.example.test"
TENANT = "tenant-of-the-room"


def _ref(ref_id: str, name: str, type_: str = "github") -> SimpleNamespace:
    return SimpleNamespace(id=ref_id, name=name, type=type_, description="")


def _doc(doc_id: str, name: str, room_id: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id=doc_id,
        name=name,
        description="",
        room_id=room_id,
        created_by_agent_id=None,
    )


def _build_client(
    *,
    direct_refs: Sequence[Any] = (),
    direct_docs: Sequence[Any] = (),
    packages: Sequence[tuple[str, list[Any], list[Any]]] = (),
    frontend_base_url: str | None = None,
) -> tuple[SimpleNamespace, list[str]]:
    """A fake client for a room with `direct_*` attached to it and `packages`
    given as (name, references, documents)."""
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

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _send_message(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _refs_for_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(direct_refs)

    async def _ref_get(_session, ref_id):  # type: ignore[no-untyped-def]
        return all_refs.get(ref_id)

    async def _docs_for_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(direct_docs)

    async def _docs_get_many(_session, ids):  # type: ignore[no-untyped-def]
        # Reversed, as the store promises no order.
        return [all_docs[i] for i in reversed(ids) if i in all_docs]

    async def _pkgs_for_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(pkgs)

    async def _pkg_ref_ids(_session, pkg_id):  # type: ignore[no-untyped-def]
        return [r.id for r in by_pkg[pkg_id].refs]

    async def _pkg_doc_ids(_session, pkg_id):  # type: ignore[no-untyped-def]
        return [d.id for d in by_pkg[pkg_id].docs]

    client = SimpleNamespace(
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        send_message=_send_message,
        reply_command=_send_message,
        _frontend_base_url=frontend_base_url,
        tenant_id=TENANT,
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


_ROOM = SimpleNamespace(room_id="!r:x")


def _event(command: str) -> SimpleNamespace:
    return SimpleNamespace(command=command, args="", thread_id=None)


class TestListReferences:
    async def test_lists_a_reference_that_only_a_package_brings(self) -> None:
        client, posted = _build_client(
            packages=[("Payments service context", [_ref("r1", "payments-repo")], [])]
        )
        await _cmd_list_references(client, _ROOM, _event("list-references"), False)
        assert posted == [
            "**References in this room:**\n"
            "- **payments-repo** _(github, via Payments service context)_"
        ]

    async def test_direct_first_and_an_item_in_both_shown_once_as_direct(
        self,
    ) -> None:
        shared = _ref("r1", "shared-repo")
        client, posted = _build_client(
            direct_refs=[shared],
            packages=[
                ("Pkg A", [shared, _ref("r2", "a-repo")], []),
                ("Pkg B", [_ref("r2", "a-repo"), _ref("r3", "b-board", "jira")], []),
            ],
        )
        await _cmd_list_references(client, _ROOM, _event("list-references"), False)
        assert posted[0].splitlines() == [
            "**References in this room:**",
            "- **shared-repo** _(github)_",
            "- **a-repo** _(github, via Pkg A, Pkg B)_",
            "- **b-board** _(jira, via Pkg B)_",
        ]

    async def test_none_from_either_source(self) -> None:
        client, posted = _build_client(packages=[("Empty", [], [])])
        await _cmd_list_references(client, _ROOM, _event("list-references"), False)
        assert posted == ["No references in this room."]


class TestListDocuments:
    async def test_lists_documents_packages_bring_after_direct_ones(self) -> None:
        shared = _doc("d1", "Runbook")
        client, posted = _build_client(
            direct_docs=[shared],
            packages=[
                (
                    "Payments service context",
                    [],
                    [shared, _doc("d2", "Glossary"), _doc("d3", "Oncall")],
                )
            ],
        )
        await _cmd_list_documents(client, _ROOM, _event("list-documents"), False)
        assert posted[0].splitlines() == [
            "**Internal documents in this room:**",
            "- **Runbook**",
            "- **Glossary** _(via Payments service context)_",
            "- **Oncall** _(via Payments service context)_",
        ]

    async def test_none_from_either_source(self) -> None:
        client, posted = _build_client()
        await _cmd_list_documents(client, _ROOM, _event("list-documents"), False)
        assert posted == ["No internal documents in this room."]


class TestLinksNameTheWorkspace:
    async def test_a_reference_link(self) -> None:
        client, posted = _build_client(
            direct_refs=[_ref("r1", "payments-repo")], frontend_base_url=DASHBOARD
        )
        await _cmd_list_references(client, _ROOM, _event("list-references"), False)
        assert (
            f"[payments-repo]({DASHBOARD}/resources/references/r1?workspace={TENANT})"
            in posted[0]
        )

    async def test_document_links(self) -> None:
        client, posted = _build_client(
            direct_docs=[_doc("d1", "Runbook"), _doc("d2", "Notes", room_id="room-1")],
            frontend_base_url=DASHBOARD,
        )
        await _cmd_list_documents(client, _ROOM, _event("list-documents"), False)
        assert (
            f"[Runbook]({DASHBOARD}/resources/documents/d1?workspace={TENANT})"
            in posted[0]
        )
        assert (
            f"[Notes]({DASHBOARD}/rooms/room-1/documents/d2?workspace={TENANT})"
            in posted[0]
        )

    async def test_the_room_url(self) -> None:
        client, posted = _build_client(frontend_base_url=DASHBOARD)
        await _cmd_room_url(client, _ROOM, _event("room-url"), False)
        assert posted == [f"Room URL: {DASHBOARD}/rooms/room-1?workspace={TENANT}"]
