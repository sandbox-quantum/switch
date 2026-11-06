from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.authz import (
    Principal,
    admin_by_own_membership,
    administers_tenant,
    can,
    can_change_workspace_member,
    can_delete_api_key,
    can_delete_room_document,
    can_delete_workspace,
    can_manage,
    can_unlink_from_room,
    owns,
    require,
    require_manage,
    require_visibility_change,
    validate_visibility_pair,
)


def _resource(
    *, owner_id, read_visibility="private", write_visibility="private"
) -> SimpleNamespace:
    return SimpleNamespace(
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )


ADMIN = Principal("u-admin", True)
ALICE = Principal("u-alice", False)
ANON = Principal(None, False)


class TestCan:
    def test_admin_may_do_anything(self) -> None:
        # Even on a fully private resource owned by someone else.
        res = _resource(owner_id="u-bob")
        assert can(ADMIN, "read", res)
        assert can(ADMIN, "write", res)
        assert can(ADMIN, "delete", res)

    def test_owner_may_do_anything(self) -> None:
        res = _resource(owner_id="u-alice")
        assert can(ALICE, "read", res)
        assert can(ALICE, "write", res)
        assert can(ALICE, "delete", res)

    def test_non_owner_read_follows_read_visibility(self) -> None:
        assert can(ALICE, "read", _resource(owner_id="u-bob", read_visibility="public"))
        assert not can(
            ALICE, "read", _resource(owner_id="u-bob", read_visibility="private")
        )

    def test_non_owner_write_follows_write_visibility(self) -> None:
        res = _resource(
            owner_id="u-bob", read_visibility="public", write_visibility="public"
        )
        assert can(ALICE, "write", res)
        # Publicly readable but write-protected: read yes, write no.
        ro = _resource(
            owner_id="u-bob", read_visibility="public", write_visibility="private"
        )
        assert can(ALICE, "read", ro)
        assert not can(ALICE, "write", ro)

    def test_delete_never_granted_via_visibility(self) -> None:
        # Fully public room, but a non-owner still cannot delete it.
        res = _resource(
            owner_id="u-bob", read_visibility="public", write_visibility="public"
        )
        assert not can(ALICE, "delete", res)

    def test_null_owner_is_not_owned_by_anonymous_principal(self) -> None:
        # The None-guard: a null-owner private resource is not "owned" by a
        # principal whose id is also None.
        res = _resource(owner_id=None, read_visibility="private")
        assert not can(ANON, "read", res)
        # ...but a public null-owner resource is still readable.
        assert can(ANON, "read", _resource(owner_id=None, read_visibility="public"))


class TestRequire:
    def test_passes_silently_when_allowed(self) -> None:
        require(ALICE, "read", _resource(owner_id="u-alice"))

    def test_raises_permission_error_when_denied(self) -> None:
        with pytest.raises(PermissionError):
            require(ALICE, "write", _resource(owner_id="u-bob"))


class TestCanManage:
    def test_owner_may_manage(self) -> None:
        assert can_manage(ALICE, "u-alice")

    def test_admin_may_manage_anything(self) -> None:
        assert can_manage(ADMIN, "u-bob")
        assert can_manage(ADMIN, None)

    def test_non_owner_may_not_manage(self) -> None:
        assert not can_manage(ALICE, "u-bob")

    def test_null_owner_not_managed_by_anonymous(self) -> None:
        assert not can_manage(ANON, None)

    def test_require_manage_raises_when_denied(self) -> None:
        with pytest.raises(PermissionError):
            require_manage(ALICE, "u-bob")
        require_manage(ALICE, "u-alice")  # owner — no raise


class TestAdministersTenant:
    """`administers_tenant` is the one function allowed to turn a role into
    the admin bit (`authz.py` module docstring) — the operator bypass and the
    per-tenant `admin` membership role, combined."""

    def test_operator_administers_regardless_of_tenant_role(self) -> None:
        assert administers_tenant(
            is_operator=True, tenant_role=None, organization_role=None
        )
        assert administers_tenant(
            is_operator=True, tenant_role="member", organization_role=None
        )

    def test_admin_membership_administers(self) -> None:
        assert administers_tenant(
            is_operator=False, tenant_role="admin", organization_role=None
        )

    def test_owner_is_no_longer_an_admin_role(self) -> None:
        """`owner` merged into `admin`; a stray `owner` string must not
        grant anything."""
        assert not administers_tenant(
            is_operator=False, tenant_role="owner", organization_role=None
        )

    def test_plain_member_does_not_administer(self) -> None:
        assert not administers_tenant(
            is_operator=False, tenant_role="member", organization_role=None
        )

    def test_no_membership_does_not_administer(self) -> None:
        assert not administers_tenant(
            is_operator=False, tenant_role=None, organization_role=None
        )

    def test_organization_admin_administers_every_workspace_of_it(self) -> None:
        for tenant_role in (None, "member", "admin"):
            assert administers_tenant(
                is_operator=False,
                tenant_role=tenant_role,
                organization_role="org_admin",
            )

    def test_organization_member_is_no_more_than_their_workspace_role(self) -> None:
        assert not administers_tenant(
            is_operator=False, tenant_role="member", organization_role="member"
        )
        assert administers_tenant(
            is_operator=False, tenant_role="admin", organization_role="member"
        )


class TestCanUnlinkFromRoom:
    def test_those_taking_part_and_admins_may(self) -> None:
        assert can_unlink_from_room(ALICE, takes_part=True)
        assert can_unlink_from_room(ADMIN, takes_part=False)

    def test_anyone_else_may_not(self) -> None:
        assert not can_unlink_from_room(ALICE, takes_part=False)
        assert not can_unlink_from_room(ANON, takes_part=False)


class TestCanDeleteRoomDocument:
    def test_its_creator_the_room_owner_and_an_admin_may(self) -> None:
        assert can_delete_room_document(
            ALICE, room_owner_id="u-bob", document_owner_id="u-alice"
        )
        assert can_delete_room_document(
            ALICE, room_owner_id="u-alice", document_owner_id="u-bob"
        )
        assert can_delete_room_document(
            ADMIN, room_owner_id="u-bob", document_owner_id="u-carol"
        )

    def test_anyone_else_may_not(self) -> None:
        assert not can_delete_room_document(
            ALICE, room_owner_id="u-bob", document_owner_id="u-carol"
        )

    def test_a_missing_owner_matches_nobody(self) -> None:
        # The None-guard is load-bearing, as in `can`: an unowned document
        # in an unowned room is not "owned" by a principal with no id.
        assert not can_delete_room_document(
            ANON, room_owner_id=None, document_owner_id=None
        )


class TestValidateVisibilityPair:
    @pytest.mark.parametrize(
        "read,write",
        [("private", "private"), ("public", "private"), ("public", "public")],
    )
    def test_accepts_valid_pairs(self, read: str, write: str) -> None:
        validate_visibility_pair(read, write)

    def test_rejects_writable_but_unreadable(self) -> None:
        with pytest.raises(ValueError, match="read_visibility=public"):
            validate_visibility_pair("private", "public")

    @pytest.mark.parametrize(
        "read,write",
        [("hidden", "private"), ("public", "secret")],
    )
    def test_rejects_invalid_enum(self, read: str, write: str) -> None:
        with pytest.raises(ValueError, match="expected public|private"):
            validate_visibility_pair(read, write)


class TestRequireVisibilityChange:
    """Changing who may see or edit a resource is its owner's or an admin's,
    like a room's; write access alone does not reach it."""

    def _open(self) -> SimpleNamespace:
        return _resource(
            owner_id="u-owner", read_visibility="public", write_visibility="public"
        )

    def test_a_writer_may_not_change_visibility(self) -> None:
        with pytest.raises(PermissionError, match="owner or a workspace admin"):
            require_visibility_change(ALICE, self._open(), "private", None, "reference")
        with pytest.raises(PermissionError):
            require_visibility_change(ALICE, self._open(), None, "private", "package")

    def test_a_writer_may_send_the_current_visibility_back(self) -> None:
        require_visibility_change(ALICE, self._open(), "public", "public", "reference")
        require_visibility_change(ALICE, self._open(), None, None, "reference")

    def test_the_owner_and_an_admin_may_change_it(self) -> None:
        owner = Principal("u-owner", False)
        require_visibility_change(owner, self._open(), "private", "private", "package")
        require_visibility_change(ADMIN, self._open(), "private", "private", "package")


class TestOwns:
    def test_only_the_owner_owns_it_whatever_their_role(self) -> None:
        assert owns(ALICE, "u-alice")
        assert not owns(ADMIN, "u-alice")

    def test_a_missing_owner_matches_nobody(self) -> None:
        assert not owns(ANON, None)


class TestCanChangeWorkspaceMember:
    def test_an_admin_may_change_a_member_themselves_included(self) -> None:
        assert can_change_workspace_member(
            administers=True, member_is_organization_admin=False
        )

    def test_a_member_may_not(self) -> None:
        assert not can_change_workspace_member(
            administers=False, member_is_organization_admin=False
        )

    def test_nobody_may_change_an_organization_admins_row_here(self) -> None:
        assert not can_change_workspace_member(
            administers=True, member_is_organization_admin=True
        )


class TestAdminByOwnMembership:
    def test_only_an_admin_membership_is(self) -> None:
        assert admin_by_own_membership("admin")
        assert not admin_by_own_membership("member")
        assert not admin_by_own_membership(None)


class TestCanDeleteWorkspace:
    def test_an_admin_member_may_delete_it(self) -> None:
        assert can_delete_workspace(tenant_role="admin", is_default=False)

    @pytest.mark.parametrize("tenant_role", ["member", None])
    def test_no_one_else_may_whatever_else_they_administer(
        self, tenant_role: str | None
    ) -> None:
        # An organization admin, or the operator, holds no admin row here.
        assert not can_delete_workspace(tenant_role=tenant_role, is_default=False)

    def test_nobody_may_delete_the_default_workspace(self) -> None:
        assert not can_delete_workspace(tenant_role="admin", is_default=True)


class TestCanDeleteApiKey:
    def test_the_owner_may_delete_their_own_key(self) -> None:
        assert can_delete_api_key(ALICE, "u-alice", an_agent_signs_in_with_it=False)

    def test_not_one_an_agent_still_signs_in_with(self) -> None:
        assert not can_delete_api_key(ALICE, "u-alice", an_agent_signs_in_with_it=True)

    def test_not_someone_elses_even_as_an_admin(self) -> None:
        assert not can_delete_api_key(ADMIN, "u-alice", an_agent_signs_in_with_it=False)
