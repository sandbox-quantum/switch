"""Who reads what is in a private reference, document or package.

As the documentation has it: its owner and the workspace's admins; whoever
may read a room it is attached to, since attaching shares it; and whoever may
read a package its owner put it in. What was wrong:

- A package handed out everything in it, so someone else's item, readable
  when it was added and private since, went to every reader of the package,
  and its owner could re-share it with the whole workspace by making the
  package public. Now a package shares only what its owner put in it of
  theirs (`can_read_in_package`); anything else private in it is withheld.
- The lists hid others' private items from admins while the detail routes
  gave them out. Now an admin's lists hold them too, whole.
- `can_read` said false while the contents came with the row. Now it is true
  wherever the contents come, and the item's own page then opens too, and
  false only where they are withheld.

The route coroutines are called directly against real Postgres, as in
`test_room_resource_permissions`.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Principal
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Document, Package, Reference, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.documents import (
    get_document,
    get_room_document,
    list_documents,
    list_room_documents,
)
from switch_core.gateway.packages import (
    get_package,
    list_package_documents,
    list_package_references,
    list_packages,
    list_room_packages,
)
from switch_core.gateway.references import (
    get_reference,
    list_references,
    list_room_references,
)
from switch_core.gateway.schemas import DocumentSummary, ReferenceDetail

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()
_AGENT_STORE = AgentStore()

SECRET_URL = "https://github.com/example/secret-repo"
SECRET = "secret-instructions"


def _svc(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _reference(
    svc: ResourceService, session: AsyncSession, owner: User, name: str, read: str
) -> Reference:
    return await svc.create_reference(
        session,
        owner_id=owner.id,
        is_admin=False,
        read_visibility=read,
        write_visibility="private",
        type="github",
        name=name,
        description="",
        instructions=SECRET,
        value={"urls": [SECRET_URL]},
        created_by_kind="user",
    )


async def _document(
    svc: ResourceService, session: AsyncSession, owner: User, name: str, read: str
) -> Document:
    return await svc.create_document(
        session,
        owner_id=owner.id,
        read_visibility=read,
        write_visibility="private",
        name=name,
        description="",
        instructions=SECRET,
        content=SECRET,
    )


@dataclass
class _World:
    """`member` made a package and put two things in it: `theirs`, someone
    else's reference and document (`other` made them public, and private
    after they went in), and `own`, their own private reference and
    document. The package was private, and `member` then made it public.
    `reader` is a third member, and `admin` administers the workspace."""

    other: User
    member: User
    reader: User
    admin: User
    package: Package
    theirs_ref: Reference
    theirs_doc: Document
    own_ref: Reference
    own_doc: Document


async def _world(session: AsyncSession, svc: ResourceService) -> _World:
    other = await _user(session, "other")
    member = await _user(session, "member")
    reader = await _user(session, "reader")
    admin = await _user(session, "admin")
    theirs_ref = await _reference(svc, session, other, "theirs", "public")
    theirs_doc = await _document(svc, session, other, "theirs", "public")
    own_ref = await _reference(svc, session, member, "own", "private")
    own_doc = await _document(svc, session, member, "own", "private")
    package = await svc.create_package(
        session,
        owner_id=member.id,
        read_visibility="private",
        write_visibility="private",
        name="kit",
        description="",
        instructions=SECRET,
    )
    for ref in (theirs_ref, own_ref):
        await svc.add_reference_to_package(
            session, package.id, ref.id, user_id=member.id, is_admin=False
        )
    for doc in (theirs_doc, own_doc):
        await svc.add_document_to_package(
            session, package.id, doc.id, user_id=member.id, is_admin=False
        )
    await svc.update_reference(
        session,
        theirs_ref.id,
        user_id=other.id,
        is_admin=False,
        read_visibility="private",
    )
    await svc.update_document(
        session,
        theirs_doc.id,
        user_id=other.id,
        is_admin=False,
        read_visibility="private",
    )
    await svc.update_package(
        session, package.id, user_id=member.id, is_admin=False, read_visibility="public"
    )
    await session.commit()
    return _World(
        other, member, reader, admin, package, theirs_ref, theirs_doc, own_ref, own_doc
    )


def _honest(rows: list[ReferenceDetail] | list[DocumentSummary]) -> None:
    """`can_read` says whether what is in each row came with it."""
    for row in rows:
        assert row.can_read == (row.instructions is not None), row


async def _package_rows(
    session: AsyncSession, svc: ResourceService, w: _World, user: User, admin: bool
) -> dict[str, tuple[bool, object]]:
    refs = await list_package_references(
        w.package.id, session, svc, _USER_STORE, user, admin
    )
    docs = await list_package_documents(
        w.package.id, session, svc, _USER_STORE, _AGENT_STORE, user, admin
    )
    _honest(refs)
    _honest(docs)
    return {
        **{f"ref:{r.name}": (r.can_read, r.value) for r in refs},
        **{f"doc:{d.name}": (d.can_read, d.instructions) for d in docs},
    }


async def test_a_package_shares_its_owners_own_items_and_withholds_anyone_elses(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        w = await _world(session, svc)
        shared = {
            "ref:own": (True, {"urls": [SECRET_URL]}),
            "doc:own": (True, SECRET),
        }
        withheld = {"ref:theirs": (False, None), "doc:theirs": (False, None)}

        # Making the package public re-shares nothing of someone else's, not
        # even with the package's own owner.
        for user in (w.reader, w.member):
            assert await _package_rows(session, svc, w, user, False) == {
                **shared,
                **withheld,
            }
        # Its owner and admins still read it, through the package too.
        for user, admin in ((w.other, False), (w.admin, True)):
            rows = await _package_rows(session, svc, w, user, admin)
            assert rows["ref:theirs"] == (True, {"urls": [SECRET_URL]})

        # What the package shares opens on its own page; what it withholds
        # does not.
        opened = await get_reference(
            w.own_ref.id, session, svc, _USER_STORE, w.reader, False
        )
        assert (opened.can_read, opened.instructions) == (True, SECRET)
        for user in (w.reader, w.member):
            with pytest.raises(HTTPException) as refused:
                await get_reference(
                    w.theirs_ref.id, session, svc, _USER_STORE, user, False
                )
            assert refused.value.status_code == 403
            with pytest.raises(HTTPException) as refused:
                await get_document(
                    w.theirs_doc.id,
                    session,
                    svc,
                    _USER_STORE,
                    _AGENT_STORE,
                    user,
                    False,
                )
            assert refused.value.status_code == 403


async def test_an_agent_is_given_a_package_by_the_same_rule(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        w = await _world(session, svc)
        room = Room(
            transport_room_id="!kit-room:test",
            name="kit-room",
            description="",
            owner_id=w.member.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.flush()
        await svc.attach_package_to_room(
            session, room.id, w.package.id, user_id=w.member.id
        )
        await session.commit()

        reader = Principal(w.reader.id, False)
        payload = await svc.list_room_resources(session, room.id, reader)
        [kit] = payload["packages"]
        assert kit["instructions"] == SECRET
        assert {r["name"]: r.get("withheld", False) for r in kit["references"]} == {
            "own": False,
            "theirs": True,
        }
        assert {d["name"]: d.get("withheld", False) for d in kit["documents"]} == {
            "own": False,
            "theirs": True,
        }
        theirs = next(r for r in kit["references"] if r["name"] == "theirs")
        assert "value" not in theirs and "instructions" not in theirs

        loaded = await svc.load_documents(session, room.id, [w.own_doc.id], reader)
        assert [entry.content for entry in loaded] == [SECRET]
        with pytest.raises(PermissionError):
            await svc.load_documents(session, room.id, [w.theirs_doc.id], reader)
        # Its owner's agent still loads it.
        owners = await svc.load_documents(
            session, room.id, [w.theirs_doc.id], Principal(w.other.id, False)
        )
        assert [entry.content for entry in owners] == [SECRET]


async def test_an_admins_lists_hold_others_private_items_whole_as_their_pages_do(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        w = await _world(session, svc)
        hidden = await svc.create_package(
            session,
            owner_id=w.other.id,
            read_visibility="private",
            write_visibility="private",
            name="others-kit",
            description="",
            instructions=SECRET,
        )
        await session.commit()

        refs = await list_references(session, svc, _USER_STORE, w.admin, True)
        _honest(refs)
        assert {r.name: r.value for r in refs} == {
            "theirs": {"urls": [SECRET_URL]},
            "own": {"urls": [SECRET_URL]},
        }
        docs = await list_documents(
            session, svc, _USER_STORE, _AGENT_STORE, w.admin, True
        )
        _honest(docs)
        assert {d.name: d.instructions for d in docs} == {
            "theirs": SECRET,
            "own": SECRET,
        }
        packages = await list_packages(session, svc, _USER_STORE, w.admin, True)
        assert {p.name: (p.can_read, p.instructions) for p in packages} == {
            "kit": (True, SECRET),
            "others-kit": (True, SECRET),
        }
        for ref in (w.theirs_ref, w.own_ref):
            detail = await get_reference(
                ref.id, session, svc, _USER_STORE, w.admin, True
            )
            assert (detail.can_read, detail.can_edit, detail.value) == (
                True,
                True,
                {"urls": [SECRET_URL]},
            )
        package = await get_package(hidden.id, session, svc, _USER_STORE, w.admin, True)
        assert package.instructions == SECRET

        # A member's lists hold their own and the public ones, as their pages
        # open them: someone else's private one is in neither.
        listed = await list_references(session, svc, _USER_STORE, w.reader, False)
        assert listed == []
        with pytest.raises(HTTPException) as refused:
            await get_package(hidden.id, session, svc, _USER_STORE, w.reader, False)
        assert refused.value.status_code == 403


async def test_a_room_shares_what_is_attached_and_says_so(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        w = await _world(session, svc)
        room = Room(
            transport_room_id="!open-room:test",
            name="open-room",
            description="",
            owner_id=w.other.id,
            read_visibility="public",
            write_visibility="private",
        )
        session.add(room)
        await session.flush()
        await svc.attach_reference_to_room(
            session, room.id, w.theirs_ref.id, user_id=w.other.id
        )
        await svc.attach_document_to_room(
            session, room.id, w.theirs_doc.id, user_id=w.other.id
        )
        hidden = await svc.create_package(
            session,
            owner_id=w.other.id,
            read_visibility="private",
            write_visibility="private",
            name="others-kit",
            description="",
            instructions=SECRET,
        )
        await svc.attach_package_to_room(
            session, room.id, hidden.id, user_id=w.other.id
        )
        await session.commit()

        refs = await list_room_references(
            room.id, session, svc, _ROOM_STORE, _USER_STORE, w.reader, False
        )
        _honest(refs)
        assert [(r.can_read, r.value) for r in refs] == [(True, {"urls": [SECRET_URL]})]
        docs = await list_room_documents(
            room.id,
            session,
            svc,
            _USER_STORE,
            _AGENT_STORE,
            _ROOM_STORE,
            w.reader,
            False,
        )
        _honest(docs)
        assert [d.can_read for d in docs] == [True]
        doc = await get_room_document(
            room.id,
            w.theirs_doc.id,
            session,
            svc,
            _USER_STORE,
            _AGENT_STORE,
            _ROOM_STORE,
            w.reader,
            False,
        )
        assert (doc.can_read, doc.content) == (True, SECRET)
        packages = await list_room_packages(
            room.id, session, svc, _ROOM_STORE, _USER_STORE, w.reader, False
        )
        assert [(p.can_read, p.instructions) for p in packages] == [(True, SECRET)]

        # What the room shares opens on its own page for whoever reads it.
        opened = await get_reference(
            w.theirs_ref.id, session, svc, _USER_STORE, w.reader, False
        )
        assert opened.value == {"urls": [SECRET_URL]}
        package = await get_package(
            hidden.id, session, svc, _USER_STORE, w.reader, False
        )
        assert package.can_read is True
