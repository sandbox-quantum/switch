from __future__ import annotations

import copy
import itertools

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from test_controller import KEY_ARN, config

from switch_hosted_controller.config import ConfigError
from switch_hosted_controller.kms_grants import KmsGrants, grant_name
from switch_hosted_controller.store import MachineStore

ROLE_ARN = "arn:aws:iam::123456789012:role/worker-1"
CONTEXT = {
    "switch:tenant": "tenant-test",
    "switch:owner_id": "owner-test",
    "switch:controller_id": "00000000-0000-4000-8000-0000000000c1",
}


class FakeKms:
    """KMS grants as the controller sees them: named CreateGrant is idempotent per terms."""

    def __init__(self, page_size: int = 100):
        self.grants: list[dict] = []
        self.calls: list[str] = []
        self.revoked: list[str] = []
        self.hidden: set[str] = set()
        self.page_size = page_size
        self._ids = itertools.count(1)
        self._tokens = itertools.count(1)

    def create_grant(self, KeyId, GranteePrincipal, Operations, Constraints, Name):
        self.calls.append("create_grant")
        terms = {
            "KeyId": KeyId,
            "GranteePrincipal": GranteePrincipal,
            "Operations": list(Operations),
            "Constraints": copy.deepcopy(Constraints),
            "Name": Name,
        }
        for grant in self.grants:
            if {key: grant[key] for key in terms} == terms:
                return {"GrantId": grant["GrantId"], "GrantToken": self._token()}
        grant_id = f"grant-{next(self._ids):04d}"
        self.grants.append({"GrantId": grant_id, **terms})
        return {"GrantId": grant_id, "GrantToken": self._token()}

    def list_grants(self, KeyId, GranteePrincipal, Limit, Marker=None):
        self.calls.append("list_grants")
        assert Limit == 100
        visible = [
            copy.deepcopy(grant)
            for grant in self.grants
            if grant["KeyId"] == KeyId
            and grant["GranteePrincipal"] == GranteePrincipal
            and grant["GrantId"] not in self.hidden
        ]
        start = int(Marker or 0)
        page = visible[start : start + self.page_size]
        more = start + self.page_size < len(visible)
        response: dict = {"Grants": page, "Truncated": more}
        if more:
            response["NextMarker"] = str(start + self.page_size)
        return response

    def revoke_grant(self, KeyId, GrantId):
        self.calls.append("revoke_grant")
        before = len(self.grants)
        self.grants = [grant for grant in self.grants if grant["GrantId"] != GrantId]
        if len(self.grants) == before:
            raise ClientError({"Error": {"Code": "NotFoundException"}}, "RevokeGrant")
        self.revoked.append(GrantId)

    def _token(self) -> str:
        return f"SYNTHETIC-GRANT-TOKEN-{next(self._tokens):04d}"


@pytest.fixture
def store(tmp_path):
    cfg = config(tmp_path)
    result = MachineStore(cfg.state_db_path, cfg.fingerprint())
    yield result
    result.close()


def test_grant_name_is_per_slot_generation():
    assert grant_name("slot-1", 7) == "switch-slot-1-g7"


def test_ensure_grant_creates_a_decrypt_grant_constrained_to_the_context(store):
    kms = boto3.client(
        "kms",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    with Stubber(kms) as stubber:
        stubber.add_response(
            "list_grants",
            {"Grants": [], "Truncated": False},
            {"KeyId": KEY_ARN, "GranteePrincipal": ROLE_ARN, "Limit": 100},
        )
        stubber.add_response(
            "create_grant",
            {"GrantId": "a" * 64, "GrantToken": "SYNTHETIC-GRANT-TOKEN-0001"},
            {
                "KeyId": KEY_ARN,
                "GranteePrincipal": ROLE_ARN,
                "Operations": ["Decrypt"],
                "Constraints": {"EncryptionContextSubset": CONTEXT},
                "Name": "switch-slot-1-g3",
            },
        )
        grant = KmsGrants(kms, KEY_ARN, store).ensure_grant("slot-1", ROLE_ARN, 3, CONTEXT)
        stubber.assert_no_pending_responses()
    assert (grant.grant_id, grant.token) == ("a" * 64, "SYNTHETIC-GRANT-TOKEN-0001")
    assert "SYNTHETIC-GRANT-TOKEN" not in repr(grant)
    record = store.grant("slot-1", 3)
    assert record is not None
    assert (record.grant_id, record.key_arn, record.grantee_arn, record.retired) == (
        "a" * 64,
        KEY_ARN,
        ROLE_ARN,
        False,
    )


def test_ensure_grant_is_idempotent_through_list_grants(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    first = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    kms.calls.clear()
    again = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    assert again == first
    assert kms.calls == ["list_grants"]
    assert len(kms.grants) == 1


def test_grant_created_but_not_recorded_is_adopted(store):
    kms = FakeKms()
    existing = kms.create_grant(
        KeyId=KEY_ARN,
        GranteePrincipal=ROLE_ARN,
        Operations=["Decrypt"],
        Constraints={"EncryptionContextSubset": CONTEXT},
        Name="switch-slot-1-g1",
    )
    store.intend_grant("slot-1", 1, KEY_ARN, ROLE_ARN)
    grant = KmsGrants(kms, KEY_ARN, store).ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    assert grant.grant_id == existing["GrantId"]
    assert len(kms.grants) == 1
    assert store.grant("slot-1", 1).grant_id == existing["GrantId"]


def test_unlisted_recorded_grant_keeps_its_first_token(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    first = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    kms.hidden.add(first.grant_id)
    again = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    assert again == first
    assert kms.calls.count("create_grant") == 2
    assert len(kms.grants) == 1


def test_same_name_grant_with_other_terms_is_replaced_and_revoked(store):
    kms = FakeKms()
    stale = kms.create_grant(
        KeyId=KEY_ARN,
        GranteePrincipal=ROLE_ARN,
        Operations=["Decrypt"],
        Constraints={
            "EncryptionContextSubset": {**CONTEXT, "switch:controller_id": "other-controller"}
        },
        Name="switch-slot-1-g1",
    )
    grant = KmsGrants(kms, KEY_ARN, store).ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    assert grant.grant_id != stale["GrantId"]
    assert kms.revoked == [stale["GrantId"]]
    assert [entry["GrantId"] for entry in kms.grants] == [grant.grant_id]
    assert kms.grants[0]["Constraints"] == {"EncryptionContextSubset": CONTEXT}


@pytest.mark.parametrize(
    "context",
    [
        {key: value for key, value in CONTEXT.items() if key != "switch:owner_id"},
        {**CONTEXT, "switch:provider": "codex"},
        {**CONTEXT, "switch:tenant": ""},
        {**CONTEXT, "switch:tenant": "has space"},
        {**CONTEXT, "switch:tenant": 7},
        ["switch:tenant"],
    ],
)
def test_invalid_context_is_refused_before_any_kms_call(store, context):
    kms = FakeKms()
    with pytest.raises(ConfigError, match="encryption context"):
        KmsGrants(kms, KEY_ARN, store).ensure_grant("slot-1", ROLE_ARN, 1, context)
    assert kms.calls == []
    assert store.grant("slot-1", 1) is None


def test_retire_older_revokes_only_earlier_generations(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    old = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    current = grants.ensure_grant("slot-1", ROLE_ARN, 2, CONTEXT)
    other = grants.ensure_grant("slot-2", "arn:aws:iam::123456789012:role/worker-2", 1, CONTEXT)

    assert grants.retire_older("slot-1", 2) == [1]

    assert kms.revoked == [old.grant_id]
    assert {entry["GrantId"] for entry in kms.grants} == {current.grant_id, other.grant_id}
    assert store.grant("slot-1", 1).retired
    assert not store.grant("slot-1", 2).retired
    kms.calls.clear()
    assert grants.retire_older("slot-1", 2) == []
    assert kms.calls == []


def test_retire_on_retain_or_delete_includes_the_current_generation(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    current = grants.ensure_grant("slot-1", ROLE_ARN, 4, CONTEXT)
    assert grants.retire_older("slot-1", 5) == [4]
    assert kms.revoked == [current.grant_id]
    assert kms.grants == []


def test_retire_revokes_a_recorded_grant_the_listing_does_not_show(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    old = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    kms.hidden.add(old.grant_id)
    assert grants.retire_older("slot-1", 2) == [1]
    assert kms.revoked == [old.grant_id]


def test_retire_sweeps_a_grant_whose_creation_outcome_was_lost(store):
    kms = FakeKms()
    store.intend_grant("slot-1", 1, KEY_ARN, ROLE_ARN)
    lost = kms.create_grant(
        KeyId=KEY_ARN,
        GranteePrincipal=ROLE_ARN,
        Operations=["Decrypt"],
        Constraints={"EncryptionContextSubset": CONTEXT},
        Name="switch-slot-1-g1",
    )
    assert KmsGrants(kms, KEY_ARN, store).retire_older("slot-1", 2) == [1]
    assert kms.revoked == [lost["GrantId"]]
    assert store.grant("slot-1", 1).retired


def test_retire_tolerates_an_already_revoked_grant(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    old = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    kms.revoke_grant(KeyId=KEY_ARN, GrantId=old.grant_id)
    assert grants.retire_older("slot-1", 2) == [1]
    assert store.grant("slot-1", 1).retired


def test_retire_raises_other_kms_errors_and_keeps_the_grant_open(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)

    def denied(KeyId, GrantId):
        raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "RevokeGrant")

    kms.revoke_grant = denied
    with pytest.raises(ClientError):
        grants.retire_older("slot-1", 2)
    assert not store.grant("slot-1", 1).retired


def test_retained_generation_running_again_gets_a_new_grant(store):
    kms = FakeKms()
    grants = KmsGrants(kms, KEY_ARN, store)
    first = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    grants.retire_older("slot-1", 2)
    second = grants.ensure_grant("slot-1", ROLE_ARN, 1, CONTEXT)
    assert second.grant_id != first.grant_id
    record = store.grant("slot-1", 1)
    assert (record.grant_id, record.retired) == (second.grant_id, False)


def test_list_grants_is_paginated(store):
    kms = FakeKms(page_size=1)
    for generation in (1, 2, 3):
        kms.create_grant(
            KeyId=KEY_ARN,
            GranteePrincipal=ROLE_ARN,
            Operations=["Decrypt"],
            Constraints={"EncryptionContextSubset": CONTEXT},
            Name=f"switch-slot-1-g{generation}",
        )
        store.intend_grant("slot-1", generation, KEY_ARN, ROLE_ARN)
    grants = KmsGrants(kms, KEY_ARN, store)
    assert grants.retire_older("slot-1", 4) == [1, 2, 3]
    assert kms.grants == []
    assert kms.calls.count("list_grants") == 3


def test_grant_of_another_key_or_grantee_for_the_same_generation_is_refused(store):
    store.intend_grant("slot-1", 1, KEY_ARN, ROLE_ARN)
    with pytest.raises(Exception, match="different key or grantee"):
        KmsGrants(FakeKms(), KEY_ARN, store).ensure_grant(
            "slot-1", "arn:aws:iam::123456789012:role/other", 1, CONTEXT
        )
