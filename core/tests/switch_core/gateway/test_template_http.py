"""The registry over real HTTP, against real Postgres.

The other route tests call the handler coroutines directly, which skips the
part the acceptance condition is actually about: a template has to survive
being JSON-encoded onto the wire and decoded off it again. A document full of
CRLFs, tabs and multibyte characters is exactly what a careless encoding step
mangles, so it makes the trip here for real.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_template_store,
    get_user_store,
)
from switch_core.gateway.templates import router

_AWKWARD_DOCUMENT = (
    "params:\r\n"
    "  owner:\r\n"
    "    type: string\r\n"
    "room:\r\n"
    '  name: "{owner} — café ☕"   \r\n'
    "  description: |\n"
    "    tabbed:\there\n"
    "    quoted: \"double\" and 'single'\n"
    "    backslash: C:\\path\\to\\thing\n"
    "  agents: []"
)


def _config() -> SwitchConfig:
    return SwitchConfig(  # type: ignore[call-arg]
        db_host="localhost",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        matrix_server_name="test",
        agent_registration_token="t",
        jwt_secret_key="s",
        gateway_admin_email="admin@test",
        gateway_admin_password="pw",
    )


@pytest_asyncio.fixture
async def users(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[dict[str, User]]:
    """Two owners, so cross-owner listing and deletion can be exercised."""
    async with session_factory() as session:
        alice = User(name="alice", email="alice@test", role="user", password_hash="x")
        bob = User(name="bob", email="bob@test", role="user", password_hash="x")
        session.add_all([alice, bob])
        await session.commit()
        yield {"alice": alice, "bob": bob}


def _client(
    session_factory: async_sessionmaker[AsyncSession], acting_as: User
) -> httpx.AsyncClient:
    """An app with only this router mounted and its dependencies overridden.

    Driven over an in-process ASGI transport rather than `TestClient`: that one
    runs the app on an event loop of its own, and these Postgres connections
    belong to the test's loop, so the two cannot share a connection.

    Deliberately not `init_dependencies`, which populates a process-global with
    no teardown and would leak into later tests.
    """

    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_template_store] = TemplateStore
    app.dependency_overrides[get_user_store] = UserStore
    app.dependency_overrides[get_config] = _config
    app.dependency_overrides[get_current_user] = lambda: acting_as
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def _upload(client: httpx.AsyncClient, **body: object) -> dict:
    payload: dict[str, object] = {
        "name": "t",
        "description": "d",
        "kind": "room",
        "content": "room:\n  name: r\n",
    }
    payload.update(body)
    response = await client.post("/templates", json=payload)
    assert response.status_code == 201, response.text
    return response.json()  # type: ignore[no-any-return]


class TestOverTheWire:
    async def test_a_document_survives_the_round_trip_byte_for_byte(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="awkward", content=_AWKWARD_DOCUMENT)

        detail = await client.get(f"/templates/{created['id']}")
        assert detail.status_code == 200
        assert detail.json()["content"] == _AWKWARD_DOCUMENT

        raw = await client.get(f"/templates/{created['id']}/content")
        assert raw.status_code == 200
        assert raw.content.decode("utf-8") == _AWKWARD_DOCUMENT
        assert raw.headers["content-type"].startswith("application/x-yaml")

    async def test_the_raw_document_carries_no_json_envelope(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """It should be pipeable straight into a file, not unwrapped first."""
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="plain", content=_AWKWARD_DOCUMENT)

        raw = await client.get(f"/templates/{created['id']}/content")
        assert not raw.text.startswith("{")
        assert "owner_id" not in raw.text

    @pytest.mark.parametrize(
        "name",
        ["café ☕", 'has"quote', "line\r\nX-Injected: yes", "../../etc/passwd", "  "],
        ids=["non-latin1", "quote", "crlf", "traversal", "blank-ish"],
    )
    async def test_a_hostile_name_cannot_break_the_download_header(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, User],
        name: str,
    ) -> None:
        """Headers are latin-1 on the wire and the name is free text.

        Interpolated raw, a `☕` fails the response outright and a CRLF appends
        a header of the caller's choosing.
        """
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name=name, content="room:\n  name: r\n")

        raw = await client.get(f"/templates/{created['id']}/content")
        assert raw.status_code == 200
        assert raw.content == b"room:\n  name: r\n"

        disposition = raw.headers["content-disposition"]
        assert "\r" not in disposition and "\n" not in disposition
        assert "X-Injected" not in raw.headers
        # The plain filename is an ASCII skeleton; the real name rides in
        # `filename*`, percent-encoded.
        ascii_part = disposition.split(";")[1]
        assert ascii_part.strip().startswith('filename="')
        assert ascii_part.encode("latin-1")
        assert "filename*=UTF-8''" in disposition

    async def test_the_download_refuses_to_be_sniffed(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """The bytes are whatever someone uploaded, HTML included."""
        client = _client(session_factory, users["alice"])
        created = await _upload(
            client, name="sneaky", content="<script>alert(1)</script>"
        )

        raw = await client.get(f"/templates/{created['id']}/content")
        assert raw.headers["x-content-type-options"] == "nosniff"
        assert raw.headers["content-type"].startswith("application/x-yaml")

    async def test_the_two_endpoints_agree_on_a_document_s_size(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """Listing measures in Postgres, detail measures in Python.

        Two ways of counting the same bytes, so a template that reported one
        size in the catalogue and another on its own page would be the visible
        symptom of them having drifted apart.
        """
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="sized", content=_AWKWARD_DOCUMENT)
        expected = len(_AWKWARD_DOCUMENT.encode("utf-8"))

        listing = await client.get("/templates", params={"q": "sized"})
        (row,) = listing.json()
        detail = await client.get(f"/templates/{created['id']}")

        assert row["size_bytes"] == expected
        assert detail.json()["size_bytes"] == expected
        # And it is bytes, not characters — the document has multibyte text in it.
        assert expected > len(_AWKWARD_DOCUMENT)

    async def test_validate_reports_without_storing(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])

        response = await client.post(
            "/templates/validate", json={"content": "a: [unclosed\n"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is False
        assert [e["code"] for e in body["errors"]] == ["invalid_yaml"]

        # The point of it: nothing was created by asking.
        listing = await client.get("/templates")
        assert listing.json() == []

    async def test_validate_does_not_gate_upload(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """Advisory means advisory — storage stays opaque to the format."""
        client = _client(session_factory, users["alice"])
        garbage = "a: [unclosed\n"

        check = await client.post("/templates/validate", json={"content": garbage})
        assert check.json()["ok"] is False

        created = await _upload(client, name="stored-anyway", content=garbage)
        raw = await client.get(f"/templates/{created['id']}/content")
        assert raw.content.decode("utf-8") == garbage

    async def test_validate_warns_without_failing(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        response = await client.post(
            "/templates/validate",
            json={
                "content": (
                    "params:\n  owner:\n    type: string\nroom:\n  name: '{ownr}'\n"
                )
            },
        )
        body = response.json()
        assert body["ok"] is True
        assert body["errors"] == []
        assert {w["code"] for w in body["warnings"]} == {
            "undeclared_placeholder",
            "unused_param",
        }

    async def test_validate_accepts_a_shape_this_server_does_not_provision(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """A group template has no `room:` key and must not be called wrong."""
        client = _client(session_factory, users["alice"])
        response = await client.post(
            "/templates/validate",
            json={
                "content": "group:\n  name: workstream\nrooms:\n  - name: planning\n"
            },
        )
        assert response.json() == {"ok": True, "errors": [], "warnings": []}

    async def test_validate_is_not_mistaken_for_a_template_id(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """`/templates/validate` sits beside `/templates/{id}`; order decides."""
        client = _client(session_factory, users["alice"])
        response = await client.post(
            "/templates/validate", json={"content": "room: {}"}
        )
        assert response.status_code == 200
        assert "ok" in response.json()

    async def test_validate_needs_authentication_like_everything_else(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        async def _no_session() -> AsyncIterator[None]:
            yield None

        app = FastAPI()
        app.include_router(router)
        # Stubbed because FastAPI resolves every sub-dependency before the
        # endpoint runs, so `get_current_user` cannot reach its 401 without
        # them. Left real, it is the thing under test.
        app.dependency_overrides[get_session] = _no_session
        app.dependency_overrides[get_user_store] = lambda: None
        app.dependency_overrides[get_config] = _config
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as anonymous:
            response = await anonymous.post(
                "/templates/validate", json={"content": "room: {}"}
            )
        assert response.status_code in (401, 403)

    async def test_the_catalogue_shows_every_owners_templates(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        await _upload(_client(session_factory, users["alice"]), name="alice-room")
        await _upload(_client(session_factory, users["bob"]), name="bob-room")

        for who in ("alice", "bob"):
            listing = await _client(session_factory, users[who]).get("/templates")
            assert listing.status_code == 200
            assert {t["name"] for t in listing.json()} == {"alice-room", "bob-room"}

    async def test_search_narrows_the_catalogue(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        await _upload(client, name="deploy-room", description="x")
        await _upload(client, name="other", description="for DEPLOYing")
        await _upload(client, name="unrelated", description="x")

        hits = await client.get("/templates", params={"q": "deploy"})
        assert {t["name"] for t in hits.json()} == {"deploy-room", "other"}

    async def test_deleting_someone_elses_template_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        created = await _upload(
            _client(session_factory, users["alice"]), name="alice-room"
        )
        as_bob = _client(session_factory, users["bob"])

        refused = await as_bob.delete(f"/templates/{created['id']}")
        assert refused.status_code == 403

        # Still there, and still readable by the person who was refused.
        survived = await as_bob.get(f"/templates/{created['id']}")
        assert survived.status_code == 200

    async def test_an_owner_may_delete_their_own(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="alice-room")

        deleted = await client.delete(f"/templates/{created['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted_id": created["id"]}

        gone = await client.get(f"/templates/{created['id']}")
        assert gone.status_code == 404

    async def test_reusing_your_own_name_is_a_409(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        await _upload(client, name="deploy-room")

        clash = await client.post(
            "/templates",
            json={
                "name": "deploy-room",
                "description": "d",
                "kind": "room",
                "content": "room:\n  name: r\n",
            },
        )
        assert clash.status_code == 409

    async def test_two_owners_may_each_have_the_same_name(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        await _upload(_client(session_factory, users["alice"]), name="deploy-room")
        await _upload(_client(session_factory, users["bob"]), name="deploy-room")

        listing = await _client(session_factory, users["alice"]).get("/templates")
        assert len(listing.json()) == 2

    async def test_replacing_the_document_bumps_the_revision(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="t")
        assert created["version"] == 1

        updated = await client.patch(
            f"/templates/{created['id']}", json={"content": _AWKWARD_DOCUMENT}
        )
        assert updated.status_code == 200
        assert updated.json()["version"] == 2
        assert updated.json()["content"] == _AWKWARD_DOCUMENT

    async def test_an_unparseable_document_is_still_accepted(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """Storage is opaque to the format, so the door does not validate."""
        garbage = "this: is: not: valid: yaml\n\t- [unclosed"
        client = _client(session_factory, users["alice"])
        created = await _upload(
            client, name="future", kind="constellation", content=garbage
        )

        raw = await client.get(f"/templates/{created['id']}/content")
        assert raw.content.decode("utf-8") == garbage

    async def test_an_unknown_template_is_a_404_on_both_read_routes(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        client = _client(session_factory, users["alice"])
        assert (await client.get("/templates/nope")).status_code == 404
        assert (await client.get("/templates/nope/content")).status_code == 404

    @pytest.mark.parametrize(
        "body",
        [
            {"name": "", "description": "d", "kind": "room", "content": "x"},
            {"name": "t", "description": "d", "kind": "", "content": "x"},
            {"name": "t", "description": "d", "kind": "room", "content": ""},
            {"description": "d", "kind": "room", "content": "x"},
        ],
        ids=["blank-name", "blank-kind", "empty-document", "no-name"],
    )
    async def test_an_incomplete_upload_is_rejected(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, User],
        body: dict[str, str],
    ) -> None:
        client = _client(session_factory, users["alice"])
        response = await client.post("/templates", json=body)
        assert response.status_code == 422

    @pytest.mark.parametrize(
        "field,size",
        [("name", 201), ("description", 2001), ("kind", 65)],
        ids=["name", "description", "kind"],
    )
    async def test_an_oversize_label_is_rejected(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, User],
        field: str,
        size: int,
    ) -> None:
        """The document has a byte budget; the labels around it need one too.

        The columns are unbounded `Text` and nothing else in the request path
        caps a field, so without these a name is as large as the body someone
        is willing to send.
        """
        client = _client(session_factory, users["alice"])
        body = {
            "name": "t",
            "description": "d",
            "kind": "room",
            "content": "room:\n  name: r\n",
        }
        body[field] = "x" * size
        assert (await client.post("/templates", json=body)).status_code == 422

        created = await _upload(client, name="fine")
        patched = await client.patch(
            f"/templates/{created['id']}", json={field: "x" * size}
        )
        assert patched.status_code == 422

    async def test_an_upload_naming_the_owner_is_refused_outright(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """A 201 to a request that quietly did something else is worse than a 422."""
        client = _client(session_factory, users["alice"])
        response = await client.post(
            "/templates",
            json={
                "name": "smuggled",
                "description": "d",
                "kind": "room",
                "content": "room:\n  name: r\n",
                "owner_id": users["bob"].id,
            },
        )
        assert response.status_code == 422

        listing = await client.get("/templates", params={"q": "smuggled"})
        assert listing.json() == []

    async def test_a_body_naming_the_owner_is_refused_outright(
        self, session_factory: async_sessionmaker[AsyncSession], users: dict[str, User]
    ) -> None:
        """Not silently ignored — a caller trying to reassign should hear so."""
        client = _client(session_factory, users["alice"])
        created = await _upload(client, name="t")

        response = await client.patch(
            f"/templates/{created['id']}",
            json={"owner_id": users["bob"].id, "description": "x"},
        )
        assert response.status_code == 422

        unchanged = await client.get(f"/templates/{created['id']}")
        assert unchanged.json()["owner_id"] == users["alice"].id
