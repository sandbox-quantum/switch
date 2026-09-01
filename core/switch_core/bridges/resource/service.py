from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import (
    Principal,
    can,
    can_manage,
    require,
    validate_visibility_pair,
)
from switch_core.bridges.resource.events import ResourceLoadEntry
from switch_core.bridges.resource.registry import (
    BUILTIN_REFERENCE_TYPES,
    ReferenceTypeSpec,
    is_builtin_type,
    validate_reference_value,
)
from switch_core.db.models import (
    Document,
    Package,
    Reference,
    ReferenceType,
    Room,
    RoomGroup,
)
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore

logger = logging.getLogger(__name__)

ROOM_DOCUMENT_MAX_CONTENT_BYTES = 1_048_576

REFERENCE_TYPE_SLUG_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,62}$")


@dataclass(frozen=True)
class ReferenceTypeView:
    """One entry of the resolution list — a type a principal may pick.

    Built-ins report ``owner_id=None``. Visibility is deliberately absent: the
    picker needs the owner label and the built-in marker, and nothing else.
    """

    spec: ReferenceTypeSpec
    owner_id: str | None
    is_builtin: bool


@dataclass(frozen=True)
class ReferenceTypeRow:
    """One entry of the management list — a database row the principal manages."""

    row: ReferenceType
    shadowed_by_builtin: bool


class ResourceService:
    """Business logic for References, Documents, and Packages.

    Used by:
      - Gateway endpoints (user-facing CRUD + attach/detach)
      - MCP server (assembling the on-connect payload, listing room resources)
      - ResourceManagerClient (resolving load_request events from the DB)
    """

    def __init__(
        self,
        *,
        reference_store: ReferenceStore,
        reference_type_store: ReferenceTypeStore,
        document_store: DocumentStore,
        package_store: PackageStore,
        room_link_store: RoomLinkStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._references = reference_store
        self._reference_types = reference_type_store
        self._documents = document_store
        self._packages = package_store
        self._room_links = room_link_store
        self._session_factory = session_factory

    # ── Helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _reference_to_payload(ref: Reference) -> dict[str, Any]:
        return {
            "id": ref.id,
            "type": ref.type,
            "name": ref.name,
            "description": ref.description,
            "instructions": ref.instructions,
            "value": ref.value,
        }

    @staticmethod
    def _document_metadata(doc: Document) -> dict[str, Any]:
        return {
            "id": doc.id,
            "name": doc.name,
            "description": doc.description,
            "instructions": doc.instructions,
            "scope": "room" if doc.room_id is not None else "global",
            "created_by_agent_id": doc.created_by_agent_id,
        }

    # ── Reference types ───────────────────────────────────────────────────

    @staticmethod
    def _row_to_spec(row: ReferenceType) -> ReferenceTypeSpec:
        return ReferenceTypeSpec(
            type=row.type,
            display_name=row.display_name,
            instructions=row.instructions,
            value_hint=row.value_hint,
        )

    async def _resolve_specs(
        self, session: AsyncSession, slugs: set[str]
    ) -> dict[str, tuple[ReferenceTypeSpec, Literal["builtin", "user"]]]:
        """Resolve ``slugs`` to their specs, built-in winning any collision.

        Unresolvable slugs are simply absent from the result; the two public
        resolvers below differ in what they do about that. No visibility filter
        — see decision 3: a reference already in a room carries its type's
        metadata to every agent there.
        """
        resolved: dict[str, tuple[ReferenceTypeSpec, Literal["builtin", "user"]]] = {}
        for row in await self._reference_types.get_many(session, sorted(slugs)):
            resolved[row.type] = (self._row_to_spec(row), "user")
        for slug in slugs:
            builtin = BUILTIN_REFERENCE_TYPES.get(slug)
            if builtin is not None:
                resolved[slug] = (builtin, "builtin")
        return resolved

    async def list_reference_types_for_principal(
        self, session: AsyncSession, *, user_id: str | None, is_admin: bool
    ) -> list[ReferenceTypeView]:
        """The resolution list: every built-in plus every row the principal may
        read, one entry per slug, a built-in winning a collision."""
        rows = (
            await self._reference_types.list_all(session)
            if is_admin
            else await self._reference_types.list_for_user(session, user_id)
        )
        views: dict[str, ReferenceTypeView] = {
            row.type: ReferenceTypeView(
                spec=self._row_to_spec(row), owner_id=row.owner_id, is_builtin=False
            )
            for row in rows
        }
        for slug, spec in BUILTIN_REFERENCE_TYPES.items():
            views[slug] = ReferenceTypeView(spec=spec, owner_id=None, is_builtin=True)
        return [views[slug] for slug in sorted(views)]

    async def list_owned_reference_types(
        self, session: AsyncSession, *, user_id: str, is_admin: bool
    ) -> list[ReferenceTypeRow]:
        """The management list: database rows only, never built-ins.

        A principal manages the rows it owns; an admin manages every row, per
        ``can_manage``. A row shadowed by a built-in stays here, and stays
        editable and deletable, flagged rather than hidden.
        """
        rows = (
            await self._reference_types.list_all(session)
            if is_admin
            else await self._reference_types.list_for_user(session, user_id)
        )
        principal = Principal(user_id, is_admin)
        return [
            ReferenceTypeRow(row=row, shadowed_by_builtin=is_builtin_type(row.type))
            for row in sorted(rows, key=lambda r: r.type)
            if can_manage(principal, row.owner_id)
        ]

    async def resolve_display_names(
        self, session: AsyncSession, slugs: set[str]
    ) -> dict[str, str]:
        """Slug → display name, with unresolvable slugs omitted so the caller
        can map a miss to ``None``."""
        resolved = await self._resolve_specs(session, slugs)
        return {slug: spec.display_name for slug, (spec, _) in resolved.items()}

    async def resolve_types_for_payload(
        self, session: AsyncSession, slugs: set[str]
    ) -> dict[str, dict[str, Any]]:
        """Slug → agent-facing type entry, for the on-connect payload.

        An unresolvable slug is present and flagged ``missing`` rather than
        dropped: an agent holding a reference of that type must be told its
        instructions are absent instead of silently receiving none.
        """
        resolved = await self._resolve_specs(session, slugs)
        payload: dict[str, dict[str, Any]] = {}
        for slug in sorted(slugs):
            entry = resolved.get(slug)
            if entry is None:
                logger.error(
                    "Reference type '%s' is not registered on this instance; "
                    "references of that type are served without instructions",
                    slug,
                )
                payload[slug] = {
                    "type": slug,
                    "display_name": slug,
                    "instructions": (
                        f"The reference type '{slug}' is not registered on this "
                        "Switch instance, so no instructions are available for it. "
                        "Say so rather than guessing at how to use the reference."
                    ),
                    "origin": "unknown",
                    "missing": True,
                }
                continue
            spec, origin = entry
            payload[slug] = spec.to_public_dict(origin=origin)
        return payload

    async def resolve_type_for_principal(
        self, session: AsyncSession, type_: str, *, user_id: str | None, is_admin: bool
    ) -> ReferenceTypeSpec:
        """Resolve the type a principal is picking, raising if it cannot.

        A type the principal cannot read is *unknown*, not forbidden, and the
        error enumerates only the slugs the principal can already see —
        otherwise it is an oracle for other users' private type names.
        """
        views = await self.list_reference_types_for_principal(
            session, user_id=user_id, is_admin=is_admin
        )
        by_slug = {view.spec.type: view.spec for view in views}
        spec = by_slug.get(type_)
        if spec is None:
            raise ValueError(
                f"Unknown reference type '{type_}'. Known: {sorted(by_slug)}"
            )
        return spec

    async def create_reference_type(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        type: str,
        display_name: str,
        instructions: str,
        value_hint: str,
        read_visibility: str,
        write_visibility: str,
    ) -> ReferenceType:
        if REFERENCE_TYPE_SLUG_PATTERN.fullmatch(type) is None:
            raise ValueError(
                f"Invalid reference type '{type}': must match "
                "^[a-z][a-z0-9_]{1,62}$ (lowercase letters, digits and "
                "underscores, starting with a letter, 2-63 characters)"
            )
        if is_builtin_type(type):
            raise ValueError(f"'{type}' is a built-in reference type")
        validate_visibility_pair(read_visibility, write_visibility)
        reference_type = ReferenceType(
            type=type,
            owner_id=owner_id,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            display_name=display_name,
            instructions=instructions,
            value_hint=value_hint,
        )
        return await self._reference_types.create(session, reference_type)

    async def update_reference_type(
        self,
        session: AsyncSession,
        type_: str,
        *,
        user_id: str,
        is_admin: bool,
        display_name: str | None = None,
        instructions: str | None = None,
        value_hint: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> ReferenceType:
        reference_type = await self._reference_types.get(session, type_)
        if reference_type is None:
            raise ValueError(f"Reference type not found: {type_}")
        require(Principal(user_id, is_admin), "write", reference_type)
        validate_visibility_pair(
            read_visibility
            if read_visibility is not None
            else reference_type.read_visibility,
            write_visibility
            if write_visibility is not None
            else reference_type.write_visibility,
        )
        return await self._reference_types.update_fields(
            session,
            type_,
            display_name=display_name,
            instructions=instructions,
            value_hint=value_hint,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
        )

    async def delete_reference_type(
        self,
        session: AsyncSession,
        type_: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> None:
        reference_type = await self._reference_types.get(session, type_)
        if reference_type is None:
            raise ValueError(f"Reference type not found: {type_}")
        require(Principal(user_id, is_admin), "delete", reference_type)
        in_use = await self._reference_types.count_references_of_type(session, type_)
        if in_use:
            raise ValueError(
                f"Reference type '{type_}' is used by {in_use} reference(s) "
                "and cannot be deleted"
            )
        await self._reference_types.delete(session, type_)

    async def log_builtin_shadowing(self, session: AsyncSession) -> None:
        """Report every stored type a built-in shadows.

        The built-in wins resolution, so such a row's references silently start
        serving different instructions — a semantic change that must be visible
        to an operator.
        """
        for row in await self._reference_types.list_all(session):
            if is_builtin_type(row.type):
                logger.error(
                    "Reference type '%s' (owner %s) is shadowed by a built-in of "
                    "the same slug; the built-in's instructions are served instead",
                    row.type,
                    row.owner_id,
                )

    # ── On-connect / list helpers ─────────────────────────────────────────

    async def list_room_resources(
        self, session: AsyncSession, room_id: str
    ) -> dict[str, Any]:
        refs = await self._references.list_for_room(session, room_id)
        docs = await self._documents.list_for_room(session, room_id)
        packages = await self._packages.list_for_room(session, room_id)

        package_payloads = []
        all_types: set[str] = {r.type for r in refs}
        for pkg in packages:
            pkg_ref_ids = await self._packages.list_reference_ids_for_package(
                session, pkg.id
            )
            pkg_doc_ids = await self._packages.list_document_ids_for_package(
                session, pkg.id
            )
            pkg_refs: list[Reference] = []
            for rid in pkg_ref_ids:
                r = await self._references.get(session, rid)
                if r is not None:
                    pkg_refs.append(r)
                    all_types.add(r.type)
            pkg_docs = await self._documents.get_many(session, pkg_doc_ids)
            package_payloads.append(
                {
                    "id": pkg.id,
                    "name": pkg.name,
                    "description": pkg.description,
                    "instructions": pkg.instructions,
                    "references": [self._reference_to_payload(r) for r in pkg_refs],
                    "documents": [self._document_metadata(d) for d in pkg_docs],
                }
            )

        linked_rows = await self._room_links.list_outbound(session, room_id)
        linked_rooms = [
            {
                "target_room_id": rid,
                "target_room_name": name,
                "target_room_description": desc,
                "label": label,
            }
            for rid, name, desc, label in linked_rows
        ]

        return {
            "reference_types": await self.resolve_types_for_payload(session, all_types),
            "references": [self._reference_to_payload(r) for r in refs],
            "documents": [self._document_metadata(d) for d in docs],
            "packages": package_payloads,
            "linked_rooms": linked_rooms,
        }

    # ── Load (called by the resource manager handler) ─────────────────────

    async def load_documents(
        self, session: AsyncSession, room_id: str, document_ids: list[str]
    ) -> list[ResourceLoadEntry]:
        """Fetch documents that are attached to ``room_id``. Raises if any
        requested id is missing or not attached (fail-loud per CLAUDE.md)."""
        if not document_ids:
            return []
        attached = set(await self._documents.list_ids_for_room(session, room_id))
        attached.update(
            await self._packages.list_document_ids_for_room(session, room_id)
        )
        missing = [d for d in document_ids if d not in attached]
        if missing:
            raise ValueError(f"Documents not attached to room {room_id}: {missing}")
        docs = await self._documents.get_many(session, document_ids)
        by_id = {d.id: d for d in docs}
        absent = [d for d in document_ids if d not in by_id]
        if absent:
            raise ValueError(f"Documents do not exist: {absent}")
        return [
            ResourceLoadEntry(
                id=d.id, name=d.name, description=d.description, content=d.content
            )
            for d in (by_id[i] for i in document_ids)
        ]

    # ── Reference CRUD (gateway) ──────────────────────────────────────────

    async def create_reference(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        is_admin: bool,
        read_visibility: str,
        write_visibility: str,
        type: str,
        name: str,
        description: str,
        instructions: str,
        value: dict[str, Any],
    ) -> Reference:
        await self.resolve_type_for_principal(
            session, type, user_id=owner_id, is_admin=is_admin
        )
        normalised_value = validate_reference_value(value)
        validate_visibility_pair(read_visibility, write_visibility)
        ref = Reference(
            owner_id=owner_id,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            type=type,
            name=name,
            description=description,
            instructions=instructions,
            value=normalised_value,
        )
        return await self._references.create(session, ref)

    async def get_reference_for_user(
        self,
        session: AsyncSession,
        reference_id: str,
        user_id: str,
        *,
        is_admin: bool = False,
    ) -> Reference:
        ref = await self._references.get(session, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        require(Principal(user_id, is_admin), "read", ref)
        return ref

    async def list_references_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[Reference]:
        return await self._references.list_for_user(session, user_id)

    async def update_reference(
        self,
        session: AsyncSession,
        reference_id: str,
        *,
        user_id: str,
        is_admin: bool,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
        value: dict[str, Any] | None = None,
    ) -> Reference:
        ref = await self._references.get(session, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        require(Principal(user_id, is_admin), "write", ref)
        # Validate the *resulting* visibility pair (partial updates must not
        # leave a writable-but-unreadable resource).
        validate_visibility_pair(
            read_visibility if read_visibility is not None else ref.read_visibility,
            write_visibility if write_visibility is not None else ref.write_visibility,
        )
        normalised_value = (
            validate_reference_value(value) if value is not None else None
        )
        return await self._references.update_fields(
            session,
            reference_id,
            name=name,
            description=description,
            instructions=instructions,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            value=normalised_value,
        )

    async def delete_reference(
        self,
        session: AsyncSession,
        reference_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> list[str]:
        ref = await self._references.get(session, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        require(Principal(user_id, is_admin), "delete", ref)
        return await self._references.delete(session, reference_id)

    async def attach_reference_to_room(
        self,
        session: AsyncSession,
        room_id: str,
        reference_id: str,
        *,
        user_id: str,
        is_admin: bool = False,
    ) -> None:
        ref = await self._references.get(session, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        require(Principal(user_id, is_admin), "read", ref)
        await self._references.attach_to_room(session, room_id, reference_id)

    async def detach_reference_from_room(
        self, session: AsyncSession, room_id: str, reference_id: str
    ) -> None:
        await self._references.detach_from_room(session, room_id, reference_id)

    async def list_room_references(
        self, session: AsyncSession, room_id: str
    ) -> list[Reference]:
        return await self._references.list_for_room(session, room_id)

    async def get_reference_attached_counts(
        self, session: AsyncSession, reference_ids: list[str]
    ) -> dict[str, int]:
        return await self._references.get_attached_counts(session, reference_ids)

    async def list_rooms_for_reference(
        self, session: AsyncSession, reference_id: str
    ) -> list[tuple[str, str]]:
        return await self._references.list_rooms_for_reference(session, reference_id)

    # ── Room links (gateway) ──────────────────────────────────────────────

    async def list_linked_rooms_for_room(
        self, session: AsyncSession, source_room_id: str
    ) -> list[dict[str, Any]]:
        rows = await self._room_links.list_outbound(session, source_room_id)
        return [
            {
                "target_room_id": rid,
                "target_room_name": name,
                "target_room_description": desc,
                "label": label,
            }
            for rid, name, desc, label in rows
        ]

    async def get_room_link_graph(self, session: AsyncSession) -> dict[str, Any]:
        """Return every room + every directed link in a single payload, for
        the full-graph view in the frontend.

        Each room carries its `group_id`, and the flattened group tree is
        returned under `groups` so the frontend can colour rooms by their
        top-level ancestor group.
        """
        result = await session.execute(
            select(Room.id, Room.name, Room.description, Room.group_id)
        )
        rooms = [
            {"id": rid, "name": name, "description": desc, "group_id": gid}
            for rid, name, desc, gid in result.all()
        ]
        link_rows = await self._room_links.list_all(session)
        links = [
            {"source_room_id": s, "target_room_id": t, "label": lbl}
            for s, t, lbl in link_rows
        ]
        group_result = await session.execute(
            select(
                RoomGroup.id,
                RoomGroup.name,
                RoomGroup.color,
                RoomGroup.parent_group_id,
            )
        )
        groups = [
            {"id": gid, "name": name, "color": color, "parent_group_id": parent}
            for gid, name, color, parent in group_result.all()
        ]
        return {"rooms": rooms, "links": links, "groups": groups}

    async def list_inbound_linked_rooms(
        self, session: AsyncSession, target_room_id: str
    ) -> list[dict[str, Any]]:
        rows = await self._room_links.list_inbound(session, target_room_id)
        return [
            {
                "source_room_id": rid,
                "source_room_name": name,
                "source_room_description": desc,
                "label": label,
            }
            for rid, name, desc, label in rows
        ]

    async def attach_linked_room(
        self,
        session: AsyncSession,
        *,
        source_room_id: str,
        target_room_id: str,
        label: str,
    ) -> dict[str, Any]:
        if source_room_id == target_room_id:
            raise ValueError("A room cannot link to itself")
        if not label.strip():
            raise ValueError("label must not be empty")
        # Verify both rooms exist; the FK would catch it but we want a clean
        # 404-shaped error from the gateway, not a raw IntegrityError.
        source = await session.get(Room, source_room_id)
        if source is None:
            raise LookupError(f"Source room not found: {source_room_id}")
        target = await session.get(Room, target_room_id)
        if target is None:
            raise LookupError(f"Target room not found: {target_room_id}")
        if await self._room_links.exists(session, source_room_id, target_room_id):
            raise ValueError(f"Room {source_room_id} already links to {target_room_id}")
        await self._room_links.attach(session, source_room_id, target_room_id, label)
        return {
            "target_room_id": target.id,
            "target_room_name": target.name,
            "target_room_description": target.description,
            "label": label,
        }

    async def detach_linked_room(
        self,
        session: AsyncSession,
        *,
        source_room_id: str,
        target_room_id: str,
    ) -> bool:
        return await self._room_links.detach(session, source_room_id, target_room_id)

    # ── Document CRUD (gateway) ───────────────────────────────────────────

    async def create_document(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        read_visibility: str,
        write_visibility: str,
        name: str,
        description: str,
        instructions: str,
        content: str,
    ) -> Document:
        validate_visibility_pair(read_visibility, write_visibility)
        doc = Document(
            owner_id=owner_id,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            name=name,
            description=description,
            instructions=instructions,
            content=content,
        )
        return await self._documents.create(session, doc)

    async def get_document_for_user(
        self,
        session: AsyncSession,
        document_id: str,
        user_id: str,
        *,
        is_admin: bool = False,
    ) -> Document:
        doc = await self._documents.get(session, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        require(Principal(user_id, is_admin), "read", doc)
        return doc

    async def list_documents_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[Document]:
        return await self._documents.list_for_user(session, user_id)

    async def update_document(
        self,
        session: AsyncSession,
        document_id: str,
        *,
        user_id: str,
        is_admin: bool,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
        content: str | None = None,
    ) -> Document:
        doc = await self._documents.get(session, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        require(Principal(user_id, is_admin), "write", doc)
        validate_visibility_pair(
            read_visibility if read_visibility is not None else doc.read_visibility,
            write_visibility if write_visibility is not None else doc.write_visibility,
        )
        return await self._documents.update_fields(
            session,
            document_id,
            name=name,
            description=description,
            instructions=instructions,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            content=content,
        )

    async def delete_document(
        self,
        session: AsyncSession,
        document_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> list[str]:
        doc = await self._documents.get(session, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        require(Principal(user_id, is_admin), "delete", doc)
        return await self._documents.delete(session, document_id)

    async def attach_document_to_room(
        self,
        session: AsyncSession,
        room_id: str,
        document_id: str,
        *,
        user_id: str,
        is_admin: bool = False,
    ) -> None:
        doc = await self._documents.get(session, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        if doc.room_id is not None:
            raise ValueError(
                f"Document {document_id} is room-scoped and cannot be attached "
                "to another room"
            )
        require(Principal(user_id, is_admin), "read", doc)
        await self._documents.attach_to_room(session, room_id, document_id)

    async def detach_document_from_room(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> None:
        await self._documents.detach_from_room(session, room_id, document_id)

    async def list_room_documents(
        self, session: AsyncSession, room_id: str
    ) -> list[Document]:
        return await self._documents.list_for_room(session, room_id)

    async def get_document_attached_counts(
        self, session: AsyncSession, document_ids: list[str]
    ) -> dict[str, int]:
        return await self._documents.get_attached_counts(session, document_ids)

    async def list_rooms_for_document(
        self, session: AsyncSession, document_id: str
    ) -> list[tuple[str, str]]:
        return await self._documents.list_rooms_for_document(session, document_id)

    # ── Room-scoped documents (agent-created via MCP) ─────────────────────

    async def create_room_document(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        agent_id: str,
        owner_id: str | None,
        name: str,
        description: str,
        instructions: str,
        content: str,
    ) -> Document:
        if not name.strip():
            raise ValueError("name must not be empty")
        if len(content.encode("utf-8")) > ROOM_DOCUMENT_MAX_CONTENT_BYTES:
            raise ValueError(f"content exceeds {ROOM_DOCUMENT_MAX_CONTENT_BYTES} bytes")
        if await self._documents.exists_room_scoped_name(session, room_id, name):
            raise ValueError(
                f"A room-scoped document named {name!r} already exists in this room"
            )
        # Owner is the creating agent's owner, so it behaves like any other
        # owned resource; room-scoped docs are private (in-room access is
        # governed by room membership, and the authorship check below).
        doc = Document(
            owner_id=owner_id,
            room_id=room_id,
            created_by_agent_id=agent_id,
            read_visibility="private",
            write_visibility="private",
            name=name,
            description=description,
            instructions=instructions,
            content=content,
        )
        return await self._documents.create(session, doc)

    async def create_room_document_for_user(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        owner_id: str,
        name: str,
        description: str,
        instructions: str,
        content: str,
    ) -> Document:
        """Create a room-scoped document on behalf of a user (no creating
        agent). Mirrors ``create_room_document`` but sets
        ``created_by_agent_id=None``; used by user-facing flows like
        YAML provisioning where there is no acting agent."""
        if not name.strip():
            raise ValueError("name must not be empty")
        if len(content.encode("utf-8")) > ROOM_DOCUMENT_MAX_CONTENT_BYTES:
            raise ValueError(f"content exceeds {ROOM_DOCUMENT_MAX_CONTENT_BYTES} bytes")
        if await self._documents.exists_room_scoped_name(session, room_id, name):
            raise ValueError(
                f"A room-scoped document named {name!r} already exists in this room"
            )
        doc = Document(
            owner_id=owner_id,
            room_id=room_id,
            created_by_agent_id=None,
            read_visibility="private",
            write_visibility="private",
            name=name,
            description=description,
            instructions=instructions,
            content=content,
        )
        return await self._documents.create(session, doc)

    async def update_room_document(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        agent_id: str,
        document_id: str,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        content: str | None = None,
    ) -> Document:
        doc = await self._documents.get_room_scoped(session, room_id, document_id)
        if doc is None:
            raise ValueError(
                f"Room-scoped document {document_id} not found in room {room_id}"
            )
        if doc.created_by_agent_id != agent_id:
            raise PermissionError(
                f"Agent {agent_id} did not create document {document_id}"
            )
        if name is not None:
            if not name.strip():
                raise ValueError("name must not be empty")
            if await self._documents.exists_room_scoped_name(
                session, room_id, name, exclude_id=document_id
            ):
                raise ValueError(
                    f"A room-scoped document named {name!r} already exists in this room"
                )
        if (
            content is not None
            and len(content.encode("utf-8")) > ROOM_DOCUMENT_MAX_CONTENT_BYTES
        ):
            raise ValueError(f"content exceeds {ROOM_DOCUMENT_MAX_CONTENT_BYTES} bytes")
        return await self._documents.update_fields(
            session,
            document_id,
            name=name,
            description=description,
            instructions=instructions,
            content=content,
        )

    async def delete_room_document(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        agent_id: str,
        document_id: str,
    ) -> None:
        doc = await self._documents.get_room_scoped(session, room_id, document_id)
        if doc is None:
            raise ValueError(
                f"Room-scoped document {document_id} not found in room {room_id}"
            )
        if doc.created_by_agent_id != agent_id:
            raise PermissionError(
                f"Agent {agent_id} did not create document {document_id}"
            )
        await self._documents.delete(session, document_id)

    async def delete_room_document_by_user(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        document_id: str,
    ) -> None:
        """Gateway escape hatch: a user with access to the room can delete a
        room-scoped document regardless of which agent created it."""
        doc = await self._documents.get_room_scoped(session, room_id, document_id)
        if doc is None:
            raise ValueError(
                f"Room-scoped document {document_id} not found in room {room_id}"
            )
        await self._documents.delete(session, document_id)

    async def get_room_scoped_document(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> Document:
        doc = await self._documents.get_room_scoped(session, room_id, document_id)
        if doc is None:
            raise ValueError(
                f"Room-scoped document {document_id} not found in room {room_id}"
            )
        return doc

    async def get_room_scoped_document_or_none(
        self, session: AsyncSession, room_id: str, document_id: str
    ) -> Document | None:
        return await self._documents.get_room_scoped(session, room_id, document_id)

    # ── Reverse lookups (for ref/doc list responses) ──────────────────────

    async def get_packages_for_references(
        self, session: AsyncSession, reference_ids: list[str]
    ) -> dict[str, list[str]]:
        return await self._packages.get_packages_for_references(session, reference_ids)

    async def get_packages_for_documents(
        self, session: AsyncSession, document_ids: list[str]
    ) -> dict[str, list[str]]:
        return await self._packages.get_packages_for_documents(session, document_ids)

    async def list_packages_for_reference(
        self, session: AsyncSession, reference_id: str
    ) -> list[str]:
        return await self._packages.list_packages_for_reference(session, reference_id)

    async def list_packages_for_document(
        self, session: AsyncSession, document_id: str
    ) -> list[str]:
        return await self._packages.list_packages_for_document(session, document_id)

    # ── Package CRUD ──────────────────────────────────────────────────────

    async def create_package(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        read_visibility: str,
        write_visibility: str,
        name: str,
        description: str,
        instructions: str,
    ) -> Package:
        validate_visibility_pair(read_visibility, write_visibility)
        pkg = Package(
            owner_id=owner_id,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
            name=name,
            description=description,
            instructions=instructions,
        )
        return await self._packages.create(session, pkg)

    async def get_package_for_user(
        self,
        session: AsyncSession,
        package_id: str,
        user_id: str,
        *,
        is_admin: bool = False,
    ) -> Package:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "read", pkg)
        return pkg

    async def list_packages_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[Package]:
        return await self._packages.list_for_user(session, user_id)

    async def update_package(
        self,
        session: AsyncSession,
        package_id: str,
        *,
        user_id: str,
        is_admin: bool,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> Package:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "write", pkg)
        validate_visibility_pair(
            read_visibility if read_visibility is not None else pkg.read_visibility,
            write_visibility if write_visibility is not None else pkg.write_visibility,
        )
        return await self._packages.update_fields(
            session,
            package_id,
            name=name,
            description=description,
            instructions=instructions,
            read_visibility=read_visibility,
            write_visibility=write_visibility,
        )

    async def delete_package(
        self,
        session: AsyncSession,
        package_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> list[str]:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "delete", pkg)
        return await self._packages.delete(session, package_id)

    async def attach_package_to_room(
        self,
        session: AsyncSession,
        room_id: str,
        package_id: str,
        *,
        user_id: str,
        is_admin: bool = False,
    ) -> None:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "read", pkg)
        await self._packages.attach_to_room(session, room_id, package_id)

    async def detach_package_from_room(
        self, session: AsyncSession, room_id: str, package_id: str
    ) -> None:
        await self._packages.detach_from_room(session, room_id, package_id)

    async def list_room_packages(
        self, session: AsyncSession, room_id: str
    ) -> list[Package]:
        return await self._packages.list_for_room(session, room_id)

    async def get_package_attached_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        return await self._packages.get_attached_counts(session, package_ids)

    async def get_package_reference_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        return await self._packages.get_reference_counts(session, package_ids)

    async def get_package_document_counts(
        self, session: AsyncSession, package_ids: list[str]
    ) -> dict[str, int]:
        return await self._packages.get_document_counts(session, package_ids)

    async def list_rooms_for_package(
        self, session: AsyncSession, package_id: str
    ) -> list[tuple[str, str]]:
        return await self._packages.list_rooms_for_package(session, package_id)

    # ── Package membership ────────────────────────────────────────────────

    async def list_package_references(
        self, session: AsyncSession, package_id: str
    ) -> list[Reference]:
        ids = await self._packages.list_reference_ids_for_package(session, package_id)
        out: list[Reference] = []
        for rid in ids:
            r = await self._references.get(session, rid)
            if r is not None:
                out.append(r)
        return out

    async def list_package_documents(
        self, session: AsyncSession, package_id: str
    ) -> list[Document]:
        ids = await self._packages.list_document_ids_for_package(session, package_id)
        return await self._documents.get_many(session, ids)

    async def add_reference_to_package(
        self,
        session: AsyncSession,
        package_id: str,
        reference_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> None:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "write", pkg)
        ref = await self._references.get(session, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        # The package owner must be able to read the reference being added.
        if not can(Principal(pkg.owner_id, False), "read", ref):
            raise PermissionError(
                f"Package owner cannot include private reference {reference_id}"
            )
        await self._packages.add_reference(session, package_id, reference_id)

    async def remove_reference_from_package(
        self,
        session: AsyncSession,
        package_id: str,
        reference_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> list[tuple[str, str]]:
        """Returns rooms that would lose visibility of the reference."""
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "write", pkg)
        affected = await self._packages.list_rooms_for_packages_containing_reference(
            session, package_id, reference_id
        )
        await self._packages.remove_reference(session, package_id, reference_id)
        return affected

    async def add_document_to_package(
        self,
        session: AsyncSession,
        package_id: str,
        document_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> None:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "write", pkg)
        doc = await self._documents.get(session, document_id)
        if doc is None:
            raise ValueError(f"Document not found: {document_id}")
        if doc.room_id is not None:
            raise ValueError(
                f"Document {document_id} is room-scoped and cannot be added to a package"
            )
        if not can(Principal(pkg.owner_id, False), "read", doc):
            raise PermissionError(
                f"Package owner cannot include private document {document_id}"
            )
        await self._packages.add_document(session, package_id, document_id)

    async def remove_document_from_package(
        self,
        session: AsyncSession,
        package_id: str,
        document_id: str,
        *,
        user_id: str,
        is_admin: bool,
    ) -> list[tuple[str, str]]:
        pkg = await self._packages.get(session, package_id)
        if pkg is None:
            raise ValueError(f"Package not found: {package_id}")
        require(Principal(user_id, is_admin), "write", pkg)
        affected = await self._packages.list_rooms_for_packages_containing_document(
            session, package_id, document_id
        )
        await self._packages.remove_document(session, package_id, document_id)
        return affected
