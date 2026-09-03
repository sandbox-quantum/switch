"""The gateway's reference-type routes, exercised as coroutines against real
Postgres, plus the two things only a client can show: the list route's 401 and
the `extra="forbid"` 422 on PATCH.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Reference, User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_resource_service,
    get_session,
    get_user_store,
)
from switch_core.gateway.references import (
    create_reference,
    create_reference_type,
    delete_reference_type,
    get_reference,
    list_owned_reference_types,
    list_reference_types,
    list_references,
    patch_reference_type,
    router,
)
from switch_core.gateway.schemas import (
    ReferenceCreateRequest,
    ReferenceTypeCreateRequest,
    ReferenceTypeUpdateRequest,
)

_USER_STORE = UserStore()
_REFERENCE_STORE = ReferenceStore()


def _resource_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ResourceService:
    return ResourceService(
        reference_store=_REFERENCE_STORE,
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _make_user(session: AsyncSession, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.invalid", role=role)
    session.add(user)
    await session.flush()
    return user


def _create_request(slug: str, **overrides: str) -> ReferenceTypeCreateRequest:
    body: dict[str, str] = {
        "type": slug,
        "display_name": slug.replace("_", " ").title(),
        "instructions": f"Use the {slug} links as {slug} material.",
        "value_hint": f"Paste {slug} links.",
        "read_visibility": "private",
        "write_visibility": "private",
    }
    body.update(overrides)
    return ReferenceTypeCreateRequest(**body)


# ── Route ordering ─────────────────────────────────────────────────────────


class TestRouteOrdering:
    """FastAPI matches in declaration order, so ordering here is behaviour.

    A `/references/{reference_id}` declared first would answer every
    reference-type request, and `/reference-types/{type}` declared first would
    treat `owned` as a slug. Both mistakes surface as a puzzling 404.
    """

    def test_reference_type_routes_precede_the_reference_id_route(self) -> None:
        paths = [r.path for r in router.routes]  # type: ignore[attr-defined]
        greedy = paths.index("/references/{reference_id}")
        type_paths = [
            i
            for i, p in enumerate(paths)
            if p.startswith("/references/reference-types")
        ]
        assert type_paths, "no /references/reference-types routes are registered"
        assert max(type_paths) < greedy

    def test_owned_precedes_the_slug_route(self) -> None:
        paths = [r.path for r in router.routes]  # type: ignore[attr-defined]
        assert paths.index("/references/reference-types/owned") < paths.index(
            "/references/reference-types/{type}"
        )


# ── Client-only behaviours ─────────────────────────────────────────────────


async def _stub_session() -> AsyncIterator[None]:
    yield None


class _RefusingResourceService:
    """Enough service to prove the PATCH route ran, and nothing more."""

    async def update_reference_type(self, *args: object, **kwargs: object) -> None:
        raise ValueError("Reference type not found: notion")


def _app() -> FastAPI:
    """An app whose dependencies are overridden on the instance.

    Deliberately not `init_dependencies`: that populates a process-global with
    no teardown and would leak real services into every later test. The stubs
    must exist even where nothing touches them, because FastAPI resolves every
    sub-dependency before the endpoint runs.
    """
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = _stub_session
    app.dependency_overrides[get_user_store] = lambda: None
    app.dependency_overrides[get_config] = lambda: None
    app.dependency_overrides[get_resource_service] = lambda: None
    return app


def _anonymous_client() -> TestClient:
    return TestClient(_app())


def _authenticated_client() -> TestClient:
    """Signed in, so a request gets as far as body validation.

    A dependency raising 401 aborts resolution before FastAPI has collected the
    body errors, so the anonymous client answers 401 to a malformed body too
    and cannot show a 422 at all.
    """
    app = _app()
    app.dependency_overrides[get_current_user] = lambda: User(
        name="alice", email="alice@example.invalid", role="user"
    )
    app.dependency_overrides[get_resource_service] = _RefusingResourceService
    return TestClient(app)


class TestClientBehaviours:
    def test_listing_types_now_requires_authentication(self) -> None:
        response = _anonymous_client().get("/references/reference-types")
        assert response.status_code == 401
        assert response.json() == {"detail": "Not authenticated"}

    def test_patch_carrying_type_is_422(self) -> None:
        """The slug is immutable, so a body naming it is rejected outright
        rather than silently ignored."""
        response = _authenticated_client().patch(
            "/references/reference-types/notion",
            json={"type": "notion2", "display_name": "Notion"},
        )
        assert response.status_code == 422

    def test_patch_without_type_reaches_the_route(self) -> None:
        # Same client, same route, body minus the forbidden field: it reaches
        # the service and gets that stub's 404, so the 422 above is
        # `extra="forbid"` doing its job and not a broken route.
        response = _authenticated_client().patch(
            "/references/reference-types/notion",
            json={"display_name": "Notion"},
        )
        assert response.status_code == 404


# ── CRUD against real Postgres ─────────────────────────────────────────────


class TestReferenceTypeCrudRoutes:
    async def test_create_then_list_and_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")

            created = await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )
            assert created.type == "notion"
            assert created.owner_id == alice.id
            assert created.owner_name == "alice"
            assert created.is_builtin is False
            assert created.shadowed_by_builtin is False
            assert created.value_schema["properties"]["urls"]

            listed = await list_reference_types(session, svc, _USER_STORE, alice)
            by_slug = {t.type: t for t in listed}
            assert "notion" in by_slug
            assert by_slug["notion"].owner_name == "alice"
            assert by_slug["github"].is_builtin is True
            assert by_slug["github"].owner_id is None
            assert by_slug["github"].owner_name is None
            assert by_slug["github"].value_hint

            owned = await list_owned_reference_types(session, svc, _USER_STORE, alice)
            assert [t.type for t in owned] == ["notion"]

    async def test_a_private_type_is_invisible_to_another_user(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            bob = await _make_user(session, "bob")
            await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )

            listed = await list_reference_types(session, svc, _USER_STORE, bob)

            assert "notion" not in {t.type for t in listed}
            assert (
                await list_owned_reference_types(session, svc, _USER_STORE, bob) == []
            )

    async def test_invalid_slug_is_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")

            with pytest.raises(HTTPException) as exc:
                await create_reference_type(
                    _create_request("Notion"), session, svc, _USER_STORE, alice
                )

            assert exc.value.status_code == 400

    async def test_builtin_slug_is_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")

            with pytest.raises(HTTPException) as exc:
                await create_reference_type(
                    _create_request("github"), session, svc, _USER_STORE, alice
                )

            assert exc.value.status_code == 400
            assert "built-in" in exc.value.detail

    async def test_duplicate_slug_is_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )

            with pytest.raises(HTTPException) as exc:
                await create_reference_type(
                    _create_request("notion"), session, svc, _USER_STORE, alice
                )

            assert exc.value.status_code == 400
            assert "already exists" in exc.value.detail

    async def test_patch_updates_and_a_non_owner_is_403(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            bob = await _make_user(session, "bob")
            await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )

            updated = await patch_reference_type(
                "notion",
                ReferenceTypeUpdateRequest(display_name="Notion Workspace"),
                session,
                svc,
                _USER_STORE,
                alice,
            )
            assert updated.display_name == "Notion Workspace"

            with pytest.raises(HTTPException) as exc:
                await patch_reference_type(
                    "notion",
                    ReferenceTypeUpdateRequest(display_name="Hijacked"),
                    session,
                    svc,
                    _USER_STORE,
                    bob,
                )
            assert exc.value.status_code == 403

    async def test_patch_of_an_unknown_slug_is_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")

            with pytest.raises(HTTPException) as exc:
                await patch_reference_type(
                    "never_registered",
                    ReferenceTypeUpdateRequest(display_name="x"),
                    session,
                    svc,
                    _USER_STORE,
                    alice,
                )

            assert exc.value.status_code == 404

    async def test_delete_removes_an_unused_type(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )

            response = await delete_reference_type("notion", session, svc, alice)

            assert response.deleted_type == "notion"
            assert (
                await list_owned_reference_types(session, svc, _USER_STORE, alice) == []
            )

    async def test_delete_of_a_type_in_use_is_409(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not the 404 every other ValueError on a by-slug route gets: the type
        exists and the caller may delete it, the request just conflicts with
        live data."""
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            await create_reference_type(
                _create_request("notion"), session, svc, _USER_STORE, alice
            )
            await create_reference(
                ReferenceCreateRequest(
                    type="notion",
                    name="Handbook",
                    description="d",
                    instructions="",
                    value={"urls": ["https://notion.example.invalid/handbook"]},
                ),
                session,
                svc,
                _USER_STORE,
                alice,
            )

            with pytest.raises(HTTPException) as exc:
                await delete_reference_type("notion", session, svc, alice)

            assert exc.value.status_code == 409
            assert "cannot be deleted" in exc.value.detail


# ── type_display_name on ReferenceDetail ───────────────────────────────────


class TestTypeDisplayName:
    async def test_a_resolvable_slug_carries_its_display_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            await create_reference_type(
                _create_request("notion", display_name="Notion"),
                session,
                svc,
                _USER_STORE,
                alice,
            )
            created = await create_reference(
                ReferenceCreateRequest(
                    type="notion",
                    name="Handbook",
                    description="d",
                    instructions="",
                    value={"urls": ["https://notion.example.invalid/handbook"]},
                ),
                session,
                svc,
                _USER_STORE,
                alice,
            )

            assert created.type_display_name == "Notion"

            fetched = await get_reference(created.id, session, svc, _USER_STORE, alice)
            assert fetched.type_display_name == "Notion"

    async def test_an_unresolvable_slug_maps_to_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A slug with no type behind it is a real state — `references.type`
        has no foreign key and cannot have one, because built-ins are not rows.
        The row is written through the store, which validates nothing.
        """
        svc = _resource_service(session_factory)
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            await _REFERENCE_STORE.create(
                session,
                Reference(
                    owner_id=alice.id,
                    read_visibility="private",
                    write_visibility="private",
                    type="never_registered",
                    name="Orphan",
                    description="d",
                    instructions="",
                    value={"urls": ["https://example.invalid/orphan"]},
                ),
            )

            listed = await list_references(session, svc, _USER_STORE, alice)

            assert [r.type for r in listed] == ["never_registered"]
            assert listed[0].type_display_name is None
