from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.authz import (
    Principal,
    administers_tenant,
    can,
    can_manage,
    require,
    require_manage,
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
    per-tenant `owner`/`admin` membership role, combined."""

    def test_operator_administers_regardless_of_tenant_role(self) -> None:
        assert administers_tenant(is_operator=True, tenant_role=None)
        assert administers_tenant(is_operator=True, tenant_role="member")

    def test_owner_or_admin_membership_administers(self) -> None:
        assert administers_tenant(is_operator=False, tenant_role="owner")
        assert administers_tenant(is_operator=False, tenant_role="admin")

    def test_plain_member_does_not_administer(self) -> None:
        assert not administers_tenant(is_operator=False, tenant_role="member")

    def test_no_membership_does_not_administer(self) -> None:
        assert not administers_tenant(is_operator=False, tenant_role=None)


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
